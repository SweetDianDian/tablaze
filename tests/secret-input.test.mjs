import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';

const { installSecretBridge } = await import(process.env.TABLAZE_SECRET_INPUT_MODULE || '../dist/secret-input.js');
const secret = 'fixture-secret-N7mQ-punctuation+equals=';
let server, origin, browser;
before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Secret input fixture</title>
<input id="target"><input id="decoy"><textarea id="memo"></textarea><input id="readonly" readonly><input id="hidden" type="hidden"><input id="number" type="number"><fieldset disabled><input id="disabled"></fieldset>
<div id="editable" contenteditable></div><p>Ready</p>
${request.url === '/opaque' ? '<script>window.origin="https://forged.example"</script>' : ''}`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true });
});
after(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
async function fixture(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const key = `tablaze_${randomUUID()}`;
  await context.addInitScript(installSecretBridge, { key });
  const page = await context.newPage();
  await page.goto(origin + '/');
  return { page, key, context };
}
const probe = (page, key, selector = '#target') => page.evaluate(({ key, selector }) => window[key].probe(document.querySelector(selector)), { key, selector });
const fill = (page, key, binding, value = secret, selector = '#target') => page.evaluate(({ key, selector, binding, value }) => window[key].fill(document.querySelector(selector), { ...binding, value }), { key, selector, binding, value });

test('pre-page bridge exposes only bounded metadata and fills the original control without focusing a decoy', async t => {
  const { page, key } = await fixture(t);
  await page.evaluate(() => {
    window.focusCalls = 0; window.events = [];
    document.querySelector('#target').onfocus = () => { window.focusCalls++; document.querySelector('#decoy').focus(); };
    for (const type of ['input', 'change']) document.querySelector('#target').addEventListener(type, event => window.events.push({ type: event.type, trusted: event.isTrusted }));
    document.querySelector('#decoy').focus();
  });
  const binding = await probe(page, key);
  assert.deepEqual(Object.keys(binding).sort(), ['documentId', 'ok', 'origin', 'type']);
  assert.equal(binding.ok, true); assert.equal(binding.origin, origin); assert.equal(binding.type, 'text');
  assert.match(binding.documentId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await page.evaluate(key => window[key].context(), key), { ok: true, origin, documentId: binding.documentId });
  assert.deepEqual(await fill(page, key, binding), { ok: true, wrote: true });
  assert.deepEqual(await page.evaluate(() => ({ target: document.querySelector('#target').value, decoy: document.querySelector('#decoy').value, focus: document.activeElement.id, focusCalls: window.focusCalls, events: window.events })), {
    target: secret, decoy: '', focus: 'decoy', focusCalls: 0, events: [{ type: 'input', trusted: false }, { type: 'change', trusted: false }],
  });
  assert.equal(JSON.stringify(await probe(page, key)).includes(secret), false);
});

test('old handles fail after identical DOM replacement without filling the replacement', async t => {
  const { page, key } = await fixture(t), binding = await probe(page, key);
  const original = await page.$('#target');
  await original.evaluate(node => node.replaceWith(node.cloneNode(true)));
  const result = await original.evaluate((node, { key, binding, secret }) => window[key].fill(node, { ...binding, value: secret }), { key, binding, secret });
  assert.deepEqual(result, { ok: false, wrote: false, code: 'SECRET_TARGET_INVALID' });
  assert.equal(await page.locator('#target').inputValue(), '');
  await original.dispose();
});

test('opaque HTTP sandbox remains denied despite replacing window.origin in page script', async t => {
  const { page, key } = await fixture(t);
  await page.evaluate(src => { const iframe = document.createElement('iframe'); iframe.sandbox = 'allow-scripts'; iframe.src = src; document.body.append(iframe); }, origin + '/opaque');
  const frame = await new Promise(resolve => {
    const loaded = () => { const child = page.frames().find(frame => frame.url() === origin + '/opaque'); if (child) { page.off('framenavigated', loaded); resolve(child); } };
    page.on('framenavigated', loaded); loaded();
  });
  await frame.waitForSelector('#target');
  assert.equal(await frame.evaluate(() => window.origin), 'https://forged.example');
  assert.deepEqual(await frame.evaluate(key => window[key].context(), key), { ok: false, code: 'SECRET_ORIGIN_UNSUPPORTED' });
  assert.deepEqual(await probe(frame, key), { ok: false, code: 'SECRET_ORIGIN_UNSUPPORTED' });
  const result = await fill(frame, key, { documentId: 'forged', origin });
  assert.equal(result.ok, false); assert.equal(result.wrote, false);
  assert.equal(await frame.locator('#target').inputValue(), '');
});

test('captured native primitives withstand later prototype and global replacements', async t => {
  const { page, key } = await fixture(t), binding = await probe(page, key);
  const actual = await page.evaluate(({ key, binding, secret }) => {
    const apply = Reflect.apply, define = Object.defineProperty;
    const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const input = document.querySelector('#target'), decoy = document.querySelector('#decoy');
    let redirected = 0;
    define(HTMLInputElement.prototype, 'value', { configurable: true, get() { return 'forged'; }, set(text) { redirected++; apply(value.set, decoy, [text]); } });
    define(Node.prototype, 'ownerDocument', { configurable: true, get() { throw Error('spoofed ownerDocument'); } });
    define(Node.prototype, 'isConnected', { configurable: true, get() { return false; } });
    define(HTMLInputElement.prototype, 'type', { configurable: true, get() { return 'hidden'; } });
    define(HTMLInputElement.prototype, 'disabled', { configurable: true, get() { return true; } });
    define(HTMLInputElement.prototype, 'readOnly', { configurable: true, get() { return true; } });
    EventTarget.prototype.dispatchEvent = () => { throw Error('spoofed dispatch'); };
    Element.prototype.matches = () => { throw Error('spoofed matches'); };
    window.Event = function() { throw Error('spoofed event'); };
    window.origin = 'https://forged.example';
    Reflect.apply = () => { throw Error('spoofed apply'); };
    Object.defineProperty = () => { throw Error('spoofed define'); };
    Object.freeze = () => { throw Error('spoofed freeze'); };
    Object.getOwnPropertyDescriptor = () => { throw Error('spoofed descriptor'); };
    Object.create = () => { throw Error('spoofed create'); };
    const result = window[key].fill(input, { ...binding, value: secret });
    return { result, intended: apply(value.get, input, []), decoy: apply(value.get, decoy, []), redirected, origin: window[key].context().origin };
  }, { key, binding, secret });
  assert.deepEqual(actual, { result: { ok: true, wrote: true }, intended: secret, decoy: '', redirected: 0, origin });
});

test('bridge property and operation references cannot be replaced by page code', async t => {
  const { page, key } = await fixture(t);
  const result = await page.evaluate(key => {
    const bridge = window[key], original = bridge.fill;
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    let replaced = false;
    try { Object.defineProperty(window, key, { value: { fill() {} } }); replaced = true; } catch {}
    try { bridge.fill = () => ({ ok: true, wrote: false }); } catch {}
    return { replaced, unchanged: window[key] === bridge && bridge.fill === original, frozen: Object.isFrozen(bridge), writable: descriptor.writable, configurable: descriptor.configurable, enumerable: descriptor.enumerable };
  }, key);
  assert.deepEqual(result, { replaced: false, unchanged: true, frozen: true, writable: false, configurable: false, enumerable: false });
});

test('invalid bindings, values and unsupported or disabled controls reject before writing', async t => {
  const { page, key } = await fixture(t), binding = await probe(page, key);
  for (const value of ['', 'x'.repeat(2049), 42, null]) {
    assert.deepEqual(await fill(page, key, binding, value), { ok: false, wrote: false, code: 'SECRET_INPUT_FAILED' });
  }
  for (const changed of [{ ...binding, documentId: 'other-document' }, { ...binding, origin: 'https://other.example' }]) {
    assert.deepEqual(await fill(page, key, changed), { ok: false, wrote: false, code: 'SECRET_CONTEXT_CHANGED' });
  }
  for (const selector of ['#readonly', '#hidden', '#number', '#disabled', '#editable']) {
    assert.deepEqual(await probe(page, key, selector), { ok: false, code: 'SECRET_NOT_WRITABLE' });
    assert.deepEqual(await fill(page, key, binding, secret, selector), { ok: false, wrote: false, code: 'SECRET_NOT_WRITABLE' });
  }
  assert.equal(await page.locator('#target').inputValue(), '');
  const textarea = await probe(page, key, '#memo');
  assert.equal(textarea.type, 'textarea');
  assert.deepEqual(await fill(page, key, textarea, secret, '#memo'), { ok: true, wrote: true });
  assert.equal(await page.locator('#memo').inputValue(), secret);
});

test('an input listener detaching the filled node reports wrote=true and does not dispatch change or fill its replacement', async t => {
  const { page, key } = await fixture(t), binding = await probe(page, key);
  await page.evaluate(() => {
    window.inputs = 0; window.changes = 0; window.received = '';
    const input = document.querySelector('#target');
    input.addEventListener('input', () => { window.inputs++; window.received = input.value; const replacement = input.cloneNode(); replacement.value = ''; input.replaceWith(replacement); });
    input.addEventListener('change', () => window.changes++);
  });
  assert.deepEqual(await fill(page, key, binding), { ok: false, wrote: true, code: 'SECRET_TARGET_INVALID' });
  assert.deepEqual(await page.evaluate(() => ({ inputs: window.inputs, changes: window.changes, received: window.received, replacement: document.querySelector('#target').value })), { inputs: 1, changes: 0, received: secret, replacement: '' });
});

test('same-URL navigation generates a fresh document identity and rejects the prior binding', async t => {
  const { page, key } = await fixture(t), prior = await probe(page, key);
  await page.reload();
  const current = await probe(page, key);
  assert.equal(current.origin, prior.origin); assert.notEqual(current.documentId, prior.documentId);
  assert.deepEqual(await fill(page, key, prior), { ok: false, wrote: false, code: 'SECRET_CONTEXT_CHANGED' });
  assert.equal(await page.locator('#target').inputValue(), '');
});
