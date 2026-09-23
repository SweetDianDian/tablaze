import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';
import { BrowserEngine } from '../dist/browser.js';

test('page scripts are absent by default and incompatible with guarded configurations', async () => {
  const defaultRuntime = createServer();
  const connection = await connectAgentTools(defaultRuntime.server);
  try { assert.equal((await connection.client.listTools()).tools.some(tool => tool.name === 'tab_script'), false); }
  finally { await connection.close(); await defaultRuntime.dispose(); }
  assert.throws(() => new BrowserEngine({ allowPageScript: true, cdpUrl: 'http://127.0.0.1:1' }), { code: 'PAGE_SCRIPT_CONFLICT' });
  assert.throws(() => new BrowserEngine({ allowPageScript: true, navigationPolicy: { allowedOrigins: ['https://example.test'] } }), { code: 'PAGE_SCRIPT_CONFLICT' });
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const rejected = spawnSync(process.execPath, [cli, '--page-script', '--cdp-url', 'http://127.0.0.1:1'], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /--page-script cannot be combined/);
});

test('opt-in page scripts return JSON and fresh observations; an applied write followed by an error is uncertain', { timeout: 30_000 }, async t => {
  let accepted = 0;
  const http = createHttpServer((request, response) => {
    if (request.url === '/write' && request.method === 'POST') { accepted++; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted })); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Script fixture</title><p id="status">Ready</p><button>Save</button>');
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const runtime = createServer({ allowPageScript: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); await new Promise(resolve => http.close(resolve)); });
  const call = (name, args) => connection.client.callTool({ name, arguments: args });
  const catalog = (await connection.client.listTools()).tools;
  assert.equal(catalog.find(tool => tool.name === 'tab_script').annotations.readOnlyHint, false);
  const opened = (await call('tab_open', { url: `http://127.0.0.1:${http.address().port}/` })).structuredContent;
  const binding = await runtime.engine.acquireBinding(opened.session_id);
  t.after(() => binding.close());
  const script = args => call('tab_script', { session_id: opened.session_id, ...args });

  const read = (await script({ snapshot_id: opened.snapshot_id, source: 'return { title: document.title, value: input.value };', input: { value: 7 } })).structuredContent;
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.deepEqual(read.result, { title: 'Script fixture', value: 7 });
  assert.notEqual(read.snapshot.snapshot_id, opened.snapshot_id);
  await assert.rejects(binding.assertCurrent(), { code: 'BINDING_STALE' });
  const stale = (await script({ snapshot_id: opened.snapshot_id, source: 'return 1;' })).structuredContent;
  assert.equal(stale.error.code, 'STALE_SNAPSHOT');
  const syntax = (await script({ snapshot_id: read.snapshot.snapshot_id, source: 'return (' })).structuredContent;
  assert.equal(syntax.error.code, 'SCRIPT_SYNTAX');
  assert.equal(syntax.outcome_unknown, false);
  const changed = (await script({ snapshot_id: syntax.snapshot.snapshot_id, source: "document.querySelector('#status').textContent = 'Sent'; await fetch('/write', { method: 'POST' }); throw new Error('private value');" })).structuredContent;
  assert.equal(changed.error.code, 'SCRIPT_RUNTIME');
  assert.equal(changed.outcome_unknown, true);
  assert.equal(accepted, 1, 'independent server records one accepted write');
  assert.match(changed.snapshot.text, /Sent/);
  assert.doesNotMatch(JSON.stringify(changed), /private value/);
  const capped = (await script({ snapshot_id: changed.snapshot.snapshot_id, source: "return 'x'.repeat(70000);" })).structuredContent;
  assert.equal(capped.error.code, 'SCRIPT_OUTPUT_TOO_LARGE');
  assert.equal(capped.outcome_unknown, true);
});

test('timed-out script closes only its session and reports an unknown outcome', { timeout: 30_000 }, async t => {
  const http = createHttpServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Timeout</title><p>Ready</p>'); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ allowPageScript: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  t.after(async () => { await engine.dispose(); await new Promise(resolve => http.close(resolve)); });
  const opened = await engine.open(`http://127.0.0.1:${http.address().port}/`);
  const timed = await engine.script(opened.session_id, opened.snapshot_id, 'await new Promise(() => {});', null, { timeoutMs: 200 });
  assert.equal(timed.error.code, 'SCRIPT_TIMEOUT');
  assert.equal(timed.outcome_unknown, true);
  assert.equal(timed.session_closed, true);
  assert.deepEqual(engine.list(), []);
});
