import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';
import { createServer as createMcpServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

async function fixture(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, cookie: request.headers.cookie ?? '' });
    if (request.url === '/') {
      response.setHeader('Set-Cookie', 'session=Ada; Path=/; SameSite=Lax');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<label>Password <input type="password"></label><button onclick="window.open(\'/popup\', \'_blank\')">Open receipt</button>');
    } else if (request.url === '/popup') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<div id="status">Waiting</div><script>setTimeout(async () => { const r = await fetch("/api/receipt?private=should-not-appear-in-url"); document.querySelector("#status").textContent = r.ok ? "Receipt ready" : "Denied"; }, 150)</script>');
    } else if (request.url?.startsWith('/api/receipt')) {
      const accepted = request.headers.cookie?.includes('session=Ada');
      const body = JSON.stringify({ receipt: accepted ? 'WF-001' : null, authenticated: Boolean(accepted) });
      response.writeHead(accepted ? 200 : 401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    } else if (request.url === '/api/chunked') {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.write('chunk'); response.end('ed');
    } else { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(25); }
  assert.fail('Network response did not arrive');
}

test('opt-in MCP journal correlates an authenticated popup response without exposing request query or headers', { timeout: 20_000 }, async t => {
  const { url, requests } = await fixture(t);
  const runtime = createMcpServer({ captureNetwork: true, popupPolicy: 'follow-single', channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const tools = (await connection.client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('tab_network'));
  const call = async (name, args) => (await connection.client.callTool({ name, arguments: args })).structuredContent;
  const opened = await call('tab_open', { url });
  assert.equal(opened.ok, true);
  const button = opened.elements.find(element => element.name === 'Open receipt');
  assert.ok(button);
  const action = await call('tab_act', { session_id: opened.session_id, snapshot_id: opened.snapshot_id, actions: [{ type: 'click', ref: button.ref }] });
  assert.equal(action.ok, true, JSON.stringify(action));
  const receipt = await until(async () => (await call('tab_network', { session_id: opened.session_id })).records.find(record => record.url.endsWith('/api/receipt')));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.resource_type, 'fetch');
  assert.equal(receipt.content_type, 'application/json');
  assert.ok(!JSON.stringify(receipt).includes('should-not-appear'));
  assert.ok(!JSON.stringify(receipt).includes('Set-Cookie'));
  assert.ok(requests.some(item => item.url.startsWith('/api/receipt') && item.cookie.includes('session=Ada')));
  const body = await call('tab_network', { session_id: opened.session_id, response_id: receipt.response_id });
  assert.equal(body.ok, true, JSON.stringify(body));
  assert.deepEqual(JSON.parse(body.response.body), { receipt: 'WF-001', authenticated: true });
  assert.match(body.response.sha256, /^[a-f0-9]{64}$/);
  const next = await call('tab_network', { session_id: opened.session_id, after_id: receipt.response_id });
  assert.equal(next.records.some(record => record.response_id === receipt.response_id), false);
});

test('network capture is absent by default and refuses bodies without a declared bound', { timeout: 15_000 }, async t => {
  const { url } = await fixture(t);
  const defaultRuntime = createMcpServer();
  const defaultConnection = await connectAgentTools(defaultRuntime.server);
  t.after(async () => { await defaultConnection.close(); await defaultRuntime.dispose(); });
  assert.equal((await defaultConnection.client.listTools()).tools.some(tool => tool.name === 'tab_network'), false);

  const engine = new BrowserEngine({ captureNetwork: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  t.after(async () => { await engine.dispose(); });
  const opened = await engine.open(url);
  await engine.navigate(opened.session_id, { action: 'goto', url: `${url}/api/chunked` });
  const record = await until(async () => (await engine.network(opened.session_id)).records.find(item => item.url.endsWith('/api/chunked')));
  await assert.rejects(engine.network(opened.session_id, { responseId: record.response_id }), { code: 'RESPONSE_BODY_UNBOUNDED' });
});

test('attached CDP capture ignores independent Chrome pages', { timeout: 30_000 }, async t => {
  const { url } = await fixture(t);
  const profile = await mkdtemp(join(tmpdir(), 'tablaze-network-cdp-'));
  const owner = await chromium.launchPersistentContext(profile, {
    channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });
  let engine;
  t.after(async () => { await engine?.dispose(); await owner.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const port = await until(async () => {
    try { const value = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')[0]; return /^\d+$/.test(value) ? value : null; }
    catch { return null; }
  });
  assert.match(port, /^\d+$/);
  const foreign = owner.pages()[0] ?? await owner.newPage();
  await foreign.goto(url);
  engine = new BrowserEngine({ cdpUrl: `http://127.0.0.1:${port}`, captureNetwork: true });
  const opened = await engine.open(url);
  await foreign.goto(`${url}/api/chunked`);
  await engine.navigate(opened.session_id, { action: 'goto', url: `${url}/api/receipt?own=1` });
  const records = (await engine.network(opened.session_id)).records;
  assert.ok(records.some(record => record.url.endsWith('/api/receipt')));
  assert.equal(records.some(record => record.url.endsWith('/api/chunked')), false);
});

test('response bodies remain gated after a scoped credential is filled', { timeout: 15_000 }, async t => {
  const { url } = await fixture(t);
  const engine = new BrowserEngine({ captureNetwork: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined,
    secrets: { contextId: 'receipt-account', secrets: [{ name: 'password', version: '1', allowedOrigins: [url], resolve: () => 'synthetic-credential' }] } });
  t.after(async () => { await engine.dispose(); });
  const opened = await engine.open(url);
  const password = opened.elements.find(element => element.name === 'Password');
  assert.ok(password);
  const filled = await engine.act(opened.session_id, opened.snapshot_id, [{ type: 'fill_secret', ref: password.ref, secret: 'password' }]);
  assert.equal(filled.ok, true, JSON.stringify(filled));
  await engine.navigate(opened.session_id, { action: 'goto', url: `${url}/api/receipt` });
  const receipt = (await engine.network(opened.session_id)).records.find(record => record.url.endsWith('/api/receipt'));
  assert.ok(receipt);
  await assert.rejects(engine.network(opened.session_id, { responseId: receipt.response_id }), { code: 'SECRET_ARTIFACT_BLOCKED' });
});
