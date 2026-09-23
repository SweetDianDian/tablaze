import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { startFixture } from './fixture.mjs';

const pointer = '[data-tablaze-visual-pointer]';
const ref = (snapshot, name) => {
  const entry = snapshot.elements.find(item => item.name === name);
  assert.ok(entry, `Missing ${name}`);
  return entry.ref;
};

test('real actions show a non-intercepting pointer on owned pages and rejected refs do not fake a click', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, visualPointer: true });
  t.after(async () => { await engine.dispose(); await fixture.close(); });

  const stale = await engine.open(`${fixture.url}/lab?token=pointer-stale`);
  const stalePage = engine.sessions.get(stale.session_id).page;
  assert.equal(await stalePage.locator(pointer).count(), 1);
  assert.equal(await stalePage.locator(pointer).evaluate(host => host.hidden), true);
  await fixture.mutate('pointer-stale', 'replace');
  const rejected = await engine.act(stale.session_id, stale.snapshot_id, [{ type: 'click', ref: ref(stale, 'Target action') }]);
  assert.equal(rejected.failed.error.code, 'STALE_REFERENCE');
  assert.equal(await stalePage.locator(pointer).evaluate(host => host.hidden), true);
  const refreshed = await engine.snapshot(stale.session_id);
  const clicked = await engine.act(stale.session_id, refreshed.snapshot_id, [{ type: 'click', ref: ref(refreshed, 'Target action') }], { snapshot: false });
  assert.equal(clicked.ok, true);
  assert.equal(await stalePage.locator(pointer).evaluate(host => host.hasAttribute('data-mouse')), true);

  const opened = await engine.open(fixture.url);
  const page = engine.sessions.get(opened.session_id).page;
  const filled = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill', ref: ref(opened, 'Destination'), value: 'Lisbon' }], { snapshot: false });
  assert.equal(filled.ok, true, JSON.stringify(filled));
  const state = await page.evaluate(selector => {
    const host = document.querySelector(selector);
    const box = document.querySelector('#destination').getBoundingClientRect();
    const transform = getComputedStyle(host).transform;
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { hidden: host.hidden, action: host.dataset.action, events: getComputedStyle(host).pointerEvents,
      cursorVisible: getComputedStyle(host.shadowRoot.querySelector('svg .cursor')).display !== 'none', transform, hit: hit?.id };
  }, pointer);
  assert.deepEqual({ hidden: state.hidden, action: state.action, events: state.events, cursorVisible: state.cursorVisible, hit: state.hit },
    { hidden: false, action: 'fill', events: 'none', cursorVisible: false, hit: 'destination' });
  assert.notEqual(state.transform, 'none');
  const observed = await engine.snapshot(opened.session_id);
  assert.doesNotMatch(JSON.stringify(observed), /tablaze-visual-pointer|data-action="fill"/);
  await page.waitForFunction(selector => document.querySelector(selector)?.hidden === true, pointer, { timeout: 4_000 });

  const next = await engine.tabs(opened.session_id, { action: 'new', url: fixture.url });
  const newPage = engine.sessions.get(opened.session_id).page;
  assert.equal(await newPage.locator(pointer).count(), 1);
  assert.equal(await newPage.locator(pointer).evaluate(host => host.hidden), true);
  assert.equal(next.ok, true);
  await newPage.goto(fixture.url);
  assert.equal(await newPage.locator(pointer).count(), 1, 'the pointer survives a new document via page init script');
});

test('operators can disable the visual pointer', { timeout: 15_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, visualPointer: false });
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const page = engine.sessions.get(opened.session_id).page;
  assert.equal(await page.locator(pointer).count(), 0);
  const result = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill', ref: ref(opened, 'Destination'), value: 'Lisbon' }], { snapshot: false });
  assert.equal(result.ok, true);
  assert.equal(await page.locator(pointer).count(), 0);
});

test('sessions do not add a pointer by default, even when headed', { timeout: 15_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine({ headless: false, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const page = engine.sessions.get(opened.session_id).page;
  assert.equal(await page.locator(pointer).count(), 0);
  const result = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill', ref: ref(opened, 'Destination'), value: 'Lisbon' }], { snapshot: false });
  assert.equal(result.ok, true);
  assert.equal(await page.locator(pointer).count(), 0);
});
