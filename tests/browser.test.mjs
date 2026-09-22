import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { startFixture } from './fixture.mjs';

let fixture;
let engine;
before(async () => {
  fixture = await startFixture();
  engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1_000 });
});
after(async () => { await engine?.dispose(); await fixture?.close(); });

function element(snapshot, name) {
  const match = snapshot.elements.find((entry) => entry.name === name);
  assert.ok(match, `Missing observed element ${JSON.stringify(name)}: ${JSON.stringify(snapshot.elements)}`);
  return match.ref;
}

function applyDiff(baseline, diff) {
  assert.equal(diff.baseline_snapshot_id, baseline.snapshot_id);
  assert.equal(diff.diff_scope, 'returned_elements');
  const current = new Map(baseline.elements.map((entry) => [entry.ref, entry]));
  for (const removed of diff.removed) current.delete(removed);
  for (const entry of [...diff.added, ...diff.changed]) current.set(entry.ref, entry);
  return { ...diff, elements: [...current.values()] };
}

async function open(t, path = '/') {
  const snapshot = await engine.open(`${fixture.url}${path}`);
  t.after(async () => { if (engine.list().some((session) => session.session_id === snapshot.session_id)) await engine.close(snapshot.session_id); });
  return snapshot;
}

test('hotel form batch navigates and independent checks verify real URL and DOM', { timeout: 30_000 }, async (t) => {
  const observed = await open(t);
  assert.ok(observed.snapshot_id);
  const output = await engine.act(observed.session_id, observed.snapshot_id, [
    { type: 'fill', ref: element(observed, 'Destination'), value: 'Lisbon' },
    { type: 'select', ref: element(observed, 'Nights'), values: ['3'] },
    { type: 'check', ref: element(observed, 'Free cancellation'), checked: true },
    { type: 'click', ref: element(observed, 'Search stays') },
  ]);
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.equal(output.completed, 4);
  const observedResult = await engine.snapshot(observed.session_id);
  const resultUrl = new URL(observedResult.url);
  assert.equal(resultUrl.pathname, '/results');
  assert.equal(resultUrl.searchParams.get('destination'), 'Lisbon');
  assert.equal(resultUrl.searchParams.get('nights'), '3');
  assert.equal(resultUrl.searchParams.get('flexible'), 'yes');
  const verdict = await engine.verify(observed.session_id, [
    { kind: 'url', value: `${fixture.url}/results?destination=Lisbon&nights=3&flexible=yes` },
    { kind: 'title', contains: 'Hotel results' },
    { kind: 'text', contains: '3 nights · Free cancellation' },
    { kind: 'value', selector: '#destination', value: 'Lisbon' },
    { kind: 'count', selector: '[data-hotel="casa-flora"]', value: 1 },
  ]);
  assert.equal(verdict.passed, true, JSON.stringify(verdict));
  assert.equal(verdict.checks.length, 5);

  const wrong = await engine.verify(observed.session_id, [{ kind: 'text', contains: 'A hotel that does not exist' }], 100);
  assert.equal(wrong.passed, false, 'A completed click must not imply business success');
  const extractedText = await engine.extract(observed.session_id, { kind: 'text', selector: '#results' });
  assert.match(extractedText.text, /Casa Flora/);
  const links = await engine.extract(observed.session_id, { kind: 'links' });
  assert.ok(links.items.some((item) => item.text === 'View Casa Flora' && new URL(item.href).pathname === '/hotel/casa-flora'));
  const table = await engine.extract(observed.session_id, { kind: 'table' });
  assert.ok(table.items.some((row) => row.join('|') === 'Casa Flora|Lisbon|3'));
});

test('snapshots obey budgets and do not include password or hidden values', async (t) => {
  const form = await open(t);
  assert.doesNotMatch(JSON.stringify(form), /password-fixture-secret|hidden-fixture-secret/);
  const long = await open(t, '/long');
  const compact = await engine.snapshot(long.session_id, { maxElements: 3, textLimit: 80 });
  assert.ok(compact.elements.length <= 3);
  assert.ok(compact.text.length <= 80);
  assert.equal(compact.truncated, true);
});

test('a newer snapshot rejects the older revision before input', async (t) => {
  const before = await open(t, '/lab?token=revision');
  const after = await engine.snapshot(before.session_id);
  assert.notEqual(before.snapshot_id, after.snapshot_id);
  const result = await engine.act(before.session_id, before.snapshot_id, [{ type: 'click', ref: element(before, 'Target action') }]);
  assert.equal(result.ok, false);
  assert.equal(result.failed.error.code, 'STALE_SNAPSHOT');
  assert.equal((await engine.verify(before.session_id, [{ kind: 'text', contains: 'Target count: 0' }])).passed, true);
});

test('a replaced DOM node with an identical label is rejected', async (t) => {
  const snapshot = await open(t, '/lab?token=replaced');
  await fixture.mutate('replaced', 'replace');
  const result = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: element(snapshot, 'Target action') }]);
  assert.equal(result.ok, false);
  assert.equal(result.failed.error.code, 'STALE_REFERENCE');
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Target count: 0' }])).passed, true);
});

test('changed target semantics are rejected before a click', async (t) => {
  const snapshot = await open(t, '/lab?token=renamed');
  await fixture.mutate('renamed', 'rename');
  const result = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: element(snapshot, 'Target action') }]);
  assert.equal(result.ok, false);
  assert.equal(result.failed.error.code, 'STALE_REFERENCE');
});

test('overlay blocks input and retry requires fresh observation', async (t) => {
  const snapshot = await open(t, '/lab?token=covered');
  await fixture.mutate('covered', 'cover');
  const blocked = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: element(snapshot, 'Target action') }]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failed.error.code, 'ACTION_FAILED');
  await fixture.mutate('covered', 'uncover');
  const observed = await engine.snapshot(snapshot.session_id);
  const clicked = await engine.act(observed.session_id, observed.snapshot_id, [{ type: 'click', ref: element(observed, 'Target action') }]);
  assert.equal(clicked.ok, true);
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Target count: 1' }])).passed, true);
});

test('semantic change during actionability waiting prevents the delayed click', async (t) => {
  const snapshot = await open(t, '/lab?token=wait-race');
  await fixture.mutate('wait-race', 'cover');
  let settled = false;
  const clicking = engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: element(snapshot, 'Target action') }]);
  void clicking.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(settled, false, 'The covered control should still be waiting for actionability');
  await fixture.mutate('wait-race', 'rename-and-uncover');
  const result = await clicking;
  assert.equal(result.ok, false);
  assert.equal(result.failed.error.code, 'STALE_REFERENCE', JSON.stringify(result));
  assert.equal(result.completed, 0);
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Target count: 0' }])).passed, true);
});

test('a base URL change invalidates the observed resolved link destination', async (t) => {
  const snapshot = await open(t, '/lab?token=base-race');
  const link = snapshot.elements.find((entry) => entry.name === 'Relative destination');
  assert.ok(link);
  assert.equal(link.href, `${fixture.url}/safe/target`);
  await fixture.mutate('base-race', 'change-base');
  const result = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: link.ref }]);
  assert.equal(result.ok, false);
  assert.equal(result.failed.error.code, 'STALE_REFERENCE');
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Link count: 0' }])).passed, true);
});

test('value verification never leaks a password substituted after a field-type read', async (t) => {
  const snapshot = await open(t, '/lab?token=value-race');
  await fixture.mutate('value-race', 'arm-sensitive-race');
  const result = await engine.verify(snapshot.session_id, [{ kind: 'value', selector: '#memo', value: 'will never match' }], 250);
  assert.equal(result.passed, false);
  assert.doesNotMatch(JSON.stringify(result), /dynamic-password-must-not-leak/);
  assert.equal(result.checks[0].error?.code, 'SENSITIVE_VALUE', JSON.stringify(result));
  const after = await engine.snapshot(snapshot.session_id);
  assert.equal(after.elements.find((entry) => entry.name === 'Memo')?.value_redacted, true);
  assert.doesNotMatch(JSON.stringify(after), /dynamic-password-must-not-leak/);
});

test('batch preserves completed work and reports failed and skipped steps', async (t) => {
  const snapshot = await open(t, '/lab?token=partial');
  const result = await engine.act(snapshot.session_id, snapshot.snapshot_id, [
    { type: 'fill', ref: element(snapshot, 'Memo'), value: 'kept after failure' },
    { type: 'click', ref: 'never-observed' },
    { type: 'click', ref: element(snapshot, 'Tail action') },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.completed, 1);
  assert.equal(result.failed.index, 1);
  assert.deepEqual(result.results.map((entry) => entry.status), ['completed', 'failed', 'skipped']);
  const evidence = await engine.verify(snapshot.session_id, [
    { kind: 'value', selector: '#memo', value: 'kept after failure' },
    { kind: 'text', contains: 'Tail count: 0' },
  ]);
  assert.equal(evidence.passed, true, JSON.stringify(evidence));
});

test('incremental snapshots expose added and removed controls', async (t) => {
  const snapshot = await open(t, '/lab?token=diff');
  assert.equal((await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: element(snapshot, 'Add item') }], { snapshot: false })).ok, true);
  const added = await engine.snapshot(snapshot.session_id, { mode: 'diff' });
  assert.ok(added.added.some((entry) => entry.name === 'Dynamic item'));
  const withAdded = applyDiff(snapshot, added);
  const dynamicRef = element(withAdded, 'Dynamic item');
  assert.equal((await engine.act(added.session_id, added.snapshot_id, [{ type: 'click', ref: element(withAdded, 'Remove item') }], { snapshot: false })).ok, true);
  const removed = await engine.snapshot(snapshot.session_id, { mode: 'diff' });
  assert.ok(removed.removed.includes(dynamicRef));
  const withRemoved = applyDiff(withAdded, removed);
  assert.ok(!withRemoved.elements.some((entry) => entry.name === 'Dynamic item'));
  const full = await engine.snapshot(snapshot.session_id);
  assert.deepEqual(withRemoved.elements.map((entry) => entry.ref).sort(), full.elements.map((entry) => entry.ref).sort());
});

test('open shadow controls and explicitly selected frame controls execute', async (t) => {
  const snapshot = await open(t, '/lab?token=nested');
  assert.equal((await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: element(snapshot, 'Shadow action') }])).ok, true);
  const shadow = await engine.verify(snapshot.session_id, [{ kind: 'visible', selector: '#shadow-result:text-is("Shadow complete")' }]);
  assert.equal(shadow.passed, true);
  const fresh = await engine.snapshot(snapshot.session_id);
  const frame = fresh.frames.find((entry) => !entry.is_main && entry.url.endsWith('/frame'));
  assert.ok(frame, JSON.stringify(fresh.frames));
  const nested = await engine.snapshot(snapshot.session_id, { frameId: frame.frame_id });
  assert.equal((await engine.act(nested.session_id, nested.snapshot_id, [{ type: 'click', ref: element(nested, 'Frame action') }])).ok, true);
  const finalFrame = await engine.snapshot(snapshot.session_id, { frameId: frame.frame_id });
  assert.match(finalFrame.text, /Frame complete/);
});

test('sessions isolate storage and reject cross-session references', async (t) => {
  const first = await open(t, '/state');
  assert.equal((await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: element(first, 'Remember this session') }])).ok, true);
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Remembered' }])).passed, true);
  const second = await open(t, '/state');
  assert.match(second.text, /Fresh session/);
  const crossed = await engine.act(second.session_id, first.snapshot_id, [{ type: 'click', ref: element(first, 'Remember this session') }]);
  assert.equal(crossed.ok, false);
  assert.equal(crossed.failed.error.code, 'STALE_SNAPSHOT');
});

test('concurrent operations serialize within one session', async (t) => {
  const snapshot = await open(t, '/lab?token=queue');
  const acting = engine.act(snapshot.session_id, snapshot.snapshot_id, [
    { type: 'wait', text: 'Gate released', timeoutMs: 2_000 },
    { type: 'fill', ref: element(snapshot, 'Memo'), value: 'serialized result' },
  ], { snapshot: false });
  const observing = engine.snapshot(snapshot.session_id);
  await fixture.mutate('queue', 'release');
  const [result, after] = await Promise.all([acting, observing]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(after.elements.find((entry) => entry.name === 'Memo')?.value, 'serialized result');
});

test('capture contains a real JPEG and closing removes a session', async (t) => {
  const snapshot = await open(t);
  const capture = await engine.screenshot(snapshot.session_id);
  assert.equal(capture.mimeType, 'image/jpeg');
  assert.deepEqual(capture.buffer.subarray(0, 3), Buffer.from([255, 216, 255]));
  assert.deepEqual(capture.buffer.subarray(-2), Buffer.from([255, 217]));
  assert.ok(capture.buffer.length > 100);
  assert.equal(capture.url, `${fixture.url}/`);
  assert.ok(engine.list().some((session) => session.session_id === snapshot.session_id));
  await engine.close(snapshot.session_id);
  assert.ok(!engine.list().some((session) => session.session_id === snapshot.session_id));
  await assert.rejects(engine.snapshot(snapshot.session_id), /session/i);
});
