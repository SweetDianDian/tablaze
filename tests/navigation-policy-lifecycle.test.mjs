import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';

const privateMarker = 'private-guard-transport-detail-must-not-escape';
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function bounded(operation, label, timeout = 1500) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, label); await delay(10); }
}

test('dispose closes its already-owned browser while policy bootstrap is still awaiting a CDP response', { timeout: 10000 }, async t => {
  const entered = deferred(), response = deferred();
  void response.promise.catch(() => {});
  const browser = new EventEmitter();
  let connected = true, closes = 0, contexts = 0, detachments = 0;
  browser.isConnected = () => connected;
  browser.newContext = async () => { contexts++; throw Error('No context should be created before policy bootstrap finishes'); };
  browser.newBrowserCDPSession = async () => ({
    async send(method) { assert.equal(method, 'Browser.getBrowserCommandLine'); entered.resolve(); return response.promise; },
    async detach() { detachments++; },
  });
  browser.close = async () => {
    if (!connected) return;
    closes++; connected = false;
    response.reject(Error(privateMarker));
    browser.emit('disconnected');
  };
  t.mock.method(chromium, 'launch', async () => browser);
  const engine = new BrowserEngine({ navigationPolicy: { allowedOrigins: ['https://fixture.invalid'] } });
  t.after(async () => { response.reject(Error(privateMarker)); await engine.dispose().catch(() => {}); });
  const opening = engine.open('https://fixture.invalid/').then(result => ({ result }), error => ({ error }));
  await bounded(entered.promise, 'The controlled bootstrap must enter its pending CDP command');
  // There is deliberately no successful bootstrap response. Only browser.close
  // releases this command, just as an owned-browser shutdown interrupts CDP RPCs.
  await bounded(engine.dispose(), 'Disposal must close the raw owned browser before waiting for policy initialization');
  assert.equal(connected, false);
  assert.equal(closes, 1);
  assert.equal(contexts, 0);
  assert.equal(detachments, 1);
  const settled = await bounded(opening, 'The opening operation must settle after disposal');
  assert.equal(settled.error?.code, 'ENGINE_CLOSED');
  assert.equal(String(settled.error?.stack).includes(privateMarker), false);
  assert.deepEqual(engine.list(), []);
});

async function realFixture(t) {
  const received = [], held = new Set(), restore = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname;
    received.push({ path: pathname, method: request.method });
    request.resume();
    if (pathname === '/held') { held.add(response); response.on('close', () => held.delete(response)); return; }
    if (pathname.startsWith('/write/')) { response.writeHead(204).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><title>Guard lifecycle fixture</title>
<button id="first">First write</button><button id="second">Second write</button><button id="tail">Tail write</button><p>Ready</p>
<script>for(const name of ['first','second','tail'])document.getElementById(name).onclick=()=>fetch('/write/'+name,{method:'POST'})</script>`);
  });
  let engine;
  t.after(async () => {
    for (const undo of restore.reverse()) undo();
    try { await engine?.dispose(); }
    finally { for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000, navigationPolicy: { allowedOrigins: [origin] } });
  const snapshot = await engine.open(origin + '/');
  const session = engine.sessions.get(snapshot.session_id);
  const guard = session.navigationGuard;
  assert.ok(guard, 'The real page must have initialized its policy guard');
  const assertHealthy = guard.assertHealthy.bind(guard);
  let failed = false;
  guard.assertHealthy = () => { if (failed) throw Error(privateMarker); return assertHealthy(); };
  restore.push(() => { guard.assertHealthy = assertHealthy; });
  return { engine, session, snapshot, origin, received, restore, failGuard() { failed = true; } };
}

test('an in-flight real navigation reports a safe policy fault instead of the transport URL/error', { timeout: 30000 }, async t => {
  const f = await realFixture(t);
  const pending = f.engine.navigate(f.snapshot.session_id, { action: 'goto', url: f.origin + '/held?private=' + privateMarker }).then(result => ({ result }), error => ({ error }));
  await until(() => f.received.some(request => request.path === '/held'), 'The real navigation must have reached its owned server before the injected fault');
  f.failGuard();
  // Abort the actual Playwright navigation after its initial policy precheck.
  // The injected guard failure models loss of protection; it does not assert
  // that a live CDP transport was lost or that such teardown is atomic.
  await f.session.page.close();
  const settled = await bounded(pending, 'Navigation must settle after its page closes');
  assert.equal(settled.error?.code, 'NAVIGATION_POLICY_FAILED');
  assert.equal(settled.result, undefined);
  assert.equal(`${settled.error?.stack} ${JSON.stringify(settled.error)}`.includes(privateMarker), false);
});

test('policy failure after a real write retains partial action evidence and skips the next mutation', { timeout: 30000 }, async t => {
  const f = await realFixture(t);
  const entry = name => { const element = f.snapshot.elements.find(item => item.name === name); assert.ok(element, name); return element.ref; };
  const first = entry('First write'), second = entry('Second write'), tail = entry('Tail write');
  const target = f.session.snapshot.refs.get(second).handle;
  const click = target.click.bind(target);
  target.click = async options => {
    const result = await click(options);
    if (!options?.trial) {
      await until(() => ['/write/first', '/write/second'].every(path => f.received.some(request => request.path === path)), 'Both business mutations must really reach their server before the fault');
      f.failGuard();
      throw Error(privateMarker);
    }
    return result;
  };
  f.restore.push(() => { target.click = click; });
  const result = await f.engine.act(f.snapshot.session_id, f.snapshot.snapshot_id, [
    { type: 'click', ref: first }, { type: 'click', ref: second }, { type: 'click', ref: tail },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.batch_complete, false);
  assert.equal(result.completed, 1);
  assert.equal(result.partial, true);
  assert.equal(result.failed_action_may_have_side_effects, true);
  assert.equal(result.failed.index, 1);
  assert.equal(result.failed.error.code, 'NAVIGATION_POLICY_FAILED');
  assert.deepEqual(result.results.map(item => item.status), ['completed', 'failed', 'skipped']);
  assert.equal(f.received.filter(request => request.path === '/write/first' && request.method === 'POST').length, 1);
  assert.equal(f.received.filter(request => request.path === '/write/second' && request.method === 'POST').length, 1);
  assert.equal(f.received.filter(request => request.path === '/write/tail').length, 0);
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
});
