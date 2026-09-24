import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { createServer as createMCPServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

let server;
let base;
let engine;
before(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Linked native listbox</title>
      <label for="lookup">Lookup code</label>
      <input id="lookup" readonly aria-controls="picker" onclick="window.opens++; document.getElementById('picker').style.display='block'; document.getElementById('picker').focus()">
      <select id="picker" size="8" style="display:none" onclick="document.getElementById('lookup').value=this.value; this.style.display='none'; window.callbacks++; document.getElementById('status').textContent='Selected '+this.value+'; callbacks '+window.callbacks">
        <option value="v0">Choice 0</option><option value="v1">Choice 1</option><option value="v2" disabled>Choice 2</option>
      </select>
      <label for="owned">Owned code</label>
      <input id="owned" readonly aria-owns="owned-picker" onclick="document.getElementById('owned-picker').style.display='block'">
      <select id="owned-picker" size="4" style="display:none" onclick="this.style.display='none'; window.ownedCallbacks++; setTimeout(() => { document.getElementById('owned').value=this.value; document.getElementById('owned-status').textContent='Owned '+this.value+'; callbacks '+window.ownedCallbacks }, 80)">
        <option value="a">Choice A</option><option value="b">Choice B</option>
      </select>
      <label for="unrelated">Unrelated code</label><input id="unrelated" readonly>
      <label for="ambiguous">Ambiguous code</label><input id="ambiguous" readonly aria-controls="picker other">
      <select id="other" size="8" style="display:none"><option value="v1">Other</option></select>
      <p id="status">Ready</p>
      <p id="owned-status">Owned ready</p>
      <script>window.opens=0;window.callbacks=0;window.ownedCallbacks=0;</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1500 });
});
after(async () => { await engine?.dispose(); await new Promise(resolve => server?.close(resolve)); });

function ref(snapshot, name) {
  const entry = snapshot.elements.find(element => element.name === name);
  assert.ok(entry, `Missing ${name}`);
  return entry.ref;
}

test('select follows a readonly input linked to a native listbox and runs the page click callback once', { timeout: 30_000 }, async t => {
  const opened = await engine.open(base);
  t.after(() => engine.close(opened.session_id));
  const input = opened.elements.find(element => element.name === 'Lookup code');
  assert.equal(input.readonly, true);
  assert.deepEqual(input.associated_listbox?.options.map(option => option.value), ['v0', 'v1', 'v2']);
  const acted = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'select', ref: input.ref, values: ['v1'] }]);
  assert.equal(acted.ok, true, JSON.stringify(acted));
  const verified = await engine.verify(opened.session_id, [{ kind: 'value', selector: '#lookup', value: 'v1' }, { kind: 'text', contains: 'Selected v1; callbacks 1' }]);
  assert.equal(verified.passed, true, JSON.stringify(verified));
});

test('unlinked, ambiguous and disabled options fail before opening or writing', { timeout: 30_000 }, async t => {
  const opened = await engine.open(base);
  t.after(() => engine.close(opened.session_id));
  for (const [name, value] of [['Unrelated code', 'v1'], ['Ambiguous code', 'v1'], ['Lookup code', 'v2']]) {
    const snapshot = await engine.snapshot(opened.session_id);
    const result = await engine.act(opened.session_id, snapshot.snapshot_id, [{ type: 'select', ref: ref(snapshot, name), values: [value] }]);
    assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.partial, false);
  }
  assert.equal((await engine.verify(opened.session_id, [{ kind: 'text', contains: 'Ready' }, { kind: 'value', selector: '#lookup', value: '' }])).passed, true);
});

test('aria-owns association waits for the page callback before reporting success', { timeout: 30_000 }, async t => {
  const opened = await engine.open(base);
  t.after(() => engine.close(opened.session_id));
  const owned = opened.elements.find(element => element.name === 'Owned code');
  assert.deepEqual(owned.associated_listbox?.options.map(option => option.value), ['a', 'b']);
  const result = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'select', ref: owned.ref, values: ['b'] }]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await engine.verify(opened.session_id, [{ kind: 'value', selector: '#owned', value: 'b' }, { kind: 'text', contains: 'Owned b; callbacks 1' }])).passed, true);
});

test('MCP tab_act selects the linked option and verifies the field in the same call', { timeout: 30_000 }, async t => {
  const runtime = createMCPServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1500 });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
  const opened = await call('tab_open', { url: base });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const input = opened.elements.find(element => element.name === 'Lookup code');
  assert.equal(input.associated_listbox.options[1].value, 'v1');
  const acted = await call('tab_act', { session_id: opened.session_id, snapshot_id: opened.snapshot_id,
    actions: [{ type: 'select', ref: input.ref, values: ['v1'] }],
    post_checks: [{ kind: 'value', ref: input.ref, value: 'v1' }, { kind: 'text', contains: 'Selected v1; callbacks 1' }] });
  assert.equal(acted.ok, true, JSON.stringify(acted));
  assert.equal(acted.verification.passed, true, JSON.stringify(acted));
});
