import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectSecretText, projectSecretSnapshot, projectSecretExtraction, redactSecretMetadata } from '../dist/secret-projection.js';
import { compileSecretStore } from '../dist/secret-store.js';

const canary = 'CANARY_SECRET_VALUE_42';
async function redactor(...values) {
  const origin = 'https://fixture.example';
  const store = compileSecretStore({ contextId: 'fixture', secrets: values.map((value, index) => ({
    name: `secret${index}`, version: 'v1', allowedOrigins: [origin], resolve: () => value,
  })) });
  for (let index = 0; index < values.length; index++) await store.resolve(`secret${index}`, origin, origin, new AbortController().signal);
  return store;
}
const store = await redactor(canary);

test('text projection uses lookahead before clipping and never promotes its trailing content', async () => {
  assert.equal(projectSecretText('prefix ' + canary + ' suffix', 10, store), 'prefix ');
  assert.equal(projectSecretText('prefix ' + canary + ' suffix', 100, store), 'prefix [redacted] suffix');
  assert.equal(projectSecretText(canary, 0, store), '');
  const long = 'S' + 'L'.repeat(2046) + 'E';
  const raw = ('a'.repeat(200) + long.repeat(13)).slice(0, 1000 + 24576);
  const shrinking = await redactor(long);
  assert.ok(shrinking.redact(raw).slice(0, 1000).includes('L'), 'Naive redaction then clipping exposes a partial later secret');
  assert.equal(projectSecretText(raw, 1000, shrinking), 'a'.repeat(200));
});

test('raw boundaries remain exact when a secret resembles the replacement marker or overlaps another secret', async () => {
  const markerLike = await redactor('[redacted]abX');
  assert.equal(projectSecretText('[redacted]abXab', 12, markerLike), '');
  assert.equal(projectSecretText('safe [redacted]abXab', 17, markerLike), 'safe ');
  assert.equal(projectSecretText('[redacted]abXab', 13, markerLike), '[redacted]');
  const overlapping = await redactor('abc', 'bcd', 'cde');
  assert.equal(projectSecretText('safe abcde tail', 8, overlapping), 'safe ');
  assert.equal(projectSecretText('safe abcde tail', 10, overlapping), 'safe [reda');
});

test('snapshot projection covers fields, options, diffs and metadata without changing reference identity', () => {
  const cross = limit => 'x'.repeat(limit - 3) + canary;
  const entry = { ref: canary, role: canary, fingerprint: canary, name: cross(400), value: cross(1000), href: cross(2000), options: [{ value: cross(100), label: cross(100), selected: true }] };
  const raw = { session_id: canary, snapshot_id: canary, mode: 'diff', code: canary, text: cross(20), title: canary, url: cross(4000), added: [entry], changed: [entry], removed: [canary], frames: [{ frame_id: canary, name: canary, url: canary }], tabs: [{ tab_id: canary, url: canary }], scope: { selector: canary, viewport_only: true }, truncated: true, truncation: { text: true, fields: true } };
  const before = structuredClone(raw);
  const projected = projectSecretSnapshot(raw, 20, store);
  assert.deepEqual(raw, before, 'Projection must not mutate raw entries or fingerprints');
  for (const list of [projected.added, projected.changed]) {
    assert.equal(list[0].name, 'x'.repeat(397)); assert.equal(list[0].value, 'x'.repeat(997)); assert.equal(list[0].href, 'x'.repeat(1997));
    assert.equal(list[0].options[0].value, 'x'.repeat(97)); assert.equal(list[0].options[0].label, 'x'.repeat(97));
    assert.equal(list[0].ref, canary); assert.equal(list[0].role, canary); assert.equal(list[0].fingerprint, canary);
  }
  assert.equal(projected.text, 'x'.repeat(17)); assert.equal(projected.url, 'x'.repeat(3997));
  assert.equal(projected.title, '[redacted]'); assert.equal(projected.frames[0].name, '[redacted]'); assert.equal(projected.tabs[0].url, '[redacted]'); assert.equal(projected.scope.selector, '[redacted]');
  assert.equal(projected.session_id, canary); assert.equal(projected.snapshot_id, canary); assert.equal(projected.code, canary); assert.deepEqual(projected.removed, [canary]);
  assert.equal(projected.truncated, true); assert.deepEqual(projected.truncation, raw.truncation);
});

test('link extraction preserves href-first raw allocation when redaction shrinks the last field', () => {
  const items = Array.from({ length: 6 }, () => ({ href: 'h'.repeat(2000), text: 't'.repeat(1000) }));
  items.push({ href: 'h'.repeat(1997) + canary, text: canary + ' lookahead only' });
  const raw = { items, truncated: true, scan_truncated: false };
  const projected = projectSecretExtraction(raw, 'links', store);
  assert.equal(projected.items.length, 7);
  assert.equal(projected.items[6].href, 'h'.repeat(1997));
  assert.equal(projected.items[6].text, '', 'Redaction must not give unused public budget to the next raw field');
  assert.equal(projected.items.reduce((sum, item) => sum + item.href.length + item.text.length, 0), 19997);
  assert.equal(projected.truncated, true); assert.equal(projected.scan_truncated, false);
  assert.ok(raw.items[6].href.includes(canary));
});

test('link text and table cells redact before their field and aggregate boundaries', () => {
  const link = projectSecretExtraction({ items: [{ href: 'https://example.test/', text: 't'.repeat(997) + canary }], truncated: true }, 'links', store);
  assert.equal(link.items[0].text, 't'.repeat(997));
  const row = Array.from({ length: 19 }, () => 'x'.repeat(1000));
  row.push('y'.repeat(997) + canary, canary);
  const table = projectSecretExtraction({ items: [row], truncated: true }, 'table', store);
  assert.equal(table.items[0][19], 'y'.repeat(997)); assert.equal(table.items[0][20], '');
  assert.equal(table.items[0].reduce((sum, cell) => sum + cell.length, 0), 19997);
});

test('short secrets cannot expand links or table cells past the aggregate public budget', async () => {
  const expanding = await redactor('x');
  const cells = Array.from({ length: 21 }, () => 'x'.repeat(500));
  const table = projectSecretExtraction({ items: [cells], truncated: false }, 'table', expanding);
  assert.equal(table.items[0].reduce((sum, cell) => sum + cell.length, 0), 20000);
  assert.equal(table.items[0][20], '');
  assert.ok(table.items[0].every(cell => cell.length <= 1000 && !cell.includes('x')));
  const links = projectSecretExtraction({ items: cells.map(text => ({ href: '/safe', text })) }, 'links', expanding);
  assert.equal(links.items.reduce((sum, item) => sum + item.href.length + item.text.length, 0), 20000);
  assert.equal(links.items.at(-1).href, '');
  assert.equal(links.items.at(-1).text, '');
});

test('expansion followed by shrinking never reallocates the original reader budget to later fields', async () => {
  const long = 'L'.repeat(1000), mixed = await redactor('x', long);
  const cells = ['x'.repeat(500), ...Array.from({ length: 19 }, () => long), 'safe'.repeat(125), 'outside'];
  const projected = projectSecretExtraction({ items: [cells] }, 'table', mixed);
  assert.equal(projected.items[0][0].length, 1000);
  assert.equal(projected.items[0][20], 'safe'.repeat(125));
  assert.equal(projected.items[0][21], '');
  assert.ok(projected.items[0].reduce((sum, cell) => sum + cell.length, 0) <= 20000);
});

test('text extraction restores the original 20000 character boundary', () => {
  const raw = { text: 'a'.repeat(19998) + canary, truncated: true, scan_truncated: false };
  const projected = projectSecretExtraction(raw, 'text', store);
  assert.equal(projected.text, 'a'.repeat(19998)); assert.equal(projected.truncated, true); assert.equal(projected.scan_truncated, false);
});

test('selected metadata is copied and recursively redacted with bounded rejection', () => {
  const raw = { url: canary, dialog: [{ message: canary }], count: 2, empty: null };
  assert.deepEqual(redactSecretMetadata(raw, store), { url: '[redacted]', dialog: [{ message: '[redacted]' }], count: 2, empty: null });
  assert.equal(raw.dialog[0].message, canary);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => redactSecretMetadata(cycle, store), /Invalid secret metadata projection/);
  assert.throws(() => redactSecretMetadata('x'.repeat(8 * 1024 * 1024 + 1), store), /projection limit/);
});

test('metadata bounds replacement expansion as well as raw input size', async () => {
  const expanding = await redactor('x');
  assert.throws(() => redactSecretMetadata('x'.repeat(900000), expanding), /projection limit/);
});
