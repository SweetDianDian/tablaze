import assert from 'node:assert/strict';
import { createServer as createHTTPServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

let fixture, base;
const requests = new Set(), hanging = new Set();
const releases = new WeakMap();
const content = '<!doctype html><title>Cancellation fixture</title><label>Keep <input value="kept"></label><button>Noop</button><p>Ready</p>';
before(async () => {
  fixture = createHTTPServer((request, response) => {
    requests.add(request.url);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url.startsWith('/slow')) { response.write(content); hanging.add(response); response.on('close', () => hanging.delete(response)); }
    else response.end(content);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${fixture.address().port}`;
});
after(async () => { for (const response of hanging) response.end(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Fixture condition did not settle'); await delay(10); }
}
async function setup(t) {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000 });
  releases.set(engine, []);
  t.after(async () => { for (const release of releases.get(engine)) release(); await engine.dispose(); });
  return engine;
}
async function cancelled(operation, controller) {
  const rejection = assert.rejects(operation, { code: 'CANCELLED' });
  const start = Date.now(); controller.abort(); await rejection;
  assert.ok(Date.now() - start < 2000, 'Cancellation should not wait for an unresolved acquisition barrier');
}
async function boundedDispose(engine) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('dispose did not settle within its cleanup bound')), 3500); });
  try { return await Promise.race([engine.dispose(), deadline]); }
  finally { clearTimeout(timer); }
}

test('pre-cancelled open does not start a browser or create a session', async t => {
  const engine = await setup(t), controller = new AbortController(); controller.abort();
  await assert.rejects(engine.open(base, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(engine.browserPromise, undefined); assert.deepEqual(engine.list(), []);
});

test('cancellation during shared browser startup returns promptly and leaves it available', async t => {
  const engine = await setup(t), controller = new AbortController(), entered = deferred(), release = deferred();
  const original = engine.browser.bind(engine);
  engine.browser = async () => { const browser = await original(); entered.resolve(browser); await release.promise; return browser; };
  releases.get(engine).push(release.resolve);
  const operation = engine.open(base, { signal: controller.signal });
  const browser = await entered.promise;
  await cancelled(operation, controller); engine.browser = original; release.resolve();
  await until(() => engine.opening.size === 0);
  assert.deepEqual(browser.contexts(), []); assert.equal(browser.isConnected(), true);
  const next = await engine.open(base); assert.equal(next.ok, true);
});

test('a context that arrives after cancellation is closed without touching a sibling session', async t => {
  const engine = await setup(t), sibling = await engine.open(base), browser = await engine.browserPromise;
  const original = browser.newContext.bind(browser), entered = deferred(), release = deferred(), controller = new AbortController();
  browser.newContext = async options => { const context = await original(options); entered.resolve(context); await release.promise; return context; };
  releases.get(engine).push(release.resolve);
  const operation = engine.open(base, { signal: controller.signal });
  const late = await entered.promise;
  await cancelled(operation, controller); browser.newContext = original; release.resolve();
  await until(() => engine.opening.size === 0);
  assert.equal(browser.contexts().includes(late), false);
  assert.equal(engine.list().length, 1);
  assert.equal((await engine.verify(sibling.session_id, [{ kind: 'value', selector: 'input', value: 'kept' }])).passed, true);
});

test('page creation cancellation closes the owned context and any late page', async t => {
  const engine = await setup(t), sibling = await engine.open(base), browser = await engine.browserPromise;
  const original = browser.newContext.bind(browser), entered = deferred(), release = deferred(), controller = new AbortController();
  browser.newContext = async options => {
    const context = await original(options), newPage = context.newPage.bind(context);
    context.newPage = async () => { const page = await newPage(); entered.resolve({ context, page }); await release.promise; return page; };
    return context;
  };
  releases.get(engine).push(release.resolve);
  const operation = engine.open(base, { signal: controller.signal });
  const created = await entered.promise;
  await cancelled(operation, controller); browser.newContext = original; release.resolve();
  await until(() => engine.opening.size === 0);
  assert.equal(created.page.isClosed(), true); assert.equal(browser.contexts().includes(created.context), false);
  assert.deepEqual(engine.list().map(item => item.session_id), [sibling.session_id]);
});

test('navigation cancellation removes only the opening attempt and drains its resources', async t => {
  const engine = await setup(t), sibling = await engine.open(base), controller = new AbortController();
  const operation = engine.open(base + '/slow?navigation', { signal: controller.signal });
  await until(() => requests.has('/slow?navigation'));
  await cancelled(operation, controller);
  await until(() => engine.opening.size === 0);
  assert.deepEqual(engine.list().map(item => item.session_id), [sibling.session_id]);
  assert.equal((await engine.browserPromise).contexts().length, 1);
});

test('snapshot cancellation cannot register a completed late observation as a live session', async t => {
  const engine = await setup(t), sibling = await engine.open(base), entered = deferred(), release = deferred(), controller = new AbortController();
  const original = engine.snapshotInternal.bind(engine);
  engine.snapshotInternal = async (...args) => { const result = await original(...args); entered.resolve(); await release.promise; return result; };
  releases.get(engine).push(release.resolve);
  const operation = engine.open(base, { signal: controller.signal }); await entered.promise;
  await cancelled(operation, controller); engine.snapshotInternal = original; release.resolve();
  await until(() => engine.opening.size === 0);
  assert.deepEqual(engine.list().map(item => item.session_id), [sibling.session_id]);
  assert.equal((await engine.browserPromise).contexts().length, 1);
});

test('MCP tab_open propagates cancellation to the engine while sibling sessions survive', async t => {
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000 });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const sibling = await runtime.engine.open(base), controller = new AbortController();
  const operation = connection.client.callTool({ name: 'tab_open', arguments: { url: base + '/slow?mcp' } }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(operation, /abort|cancel/i);
  await until(() => requests.has('/slow?mcp')); controller.abort(); await rejection;
  await until(() => runtime.engine.opening.size === 0);
  assert.deepEqual(runtime.engine.list().map(item => item.session_id), [sibling.session_id]);
  assert.equal((await runtime.engine.browserPromise).contexts().length, 1);
});

test('CDP cancellation cleans a late owned page and leaves independent pages and browser alive', { timeout: 30000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'tablaze-open-cancel-cdp-'));
  const owner = await chromium.launchPersistentContext(profile, { channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true, args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
  let engine, releaseLate;
  t.after(async () => { releaseLate?.(); await engine?.dispose(); await owner.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  let port;
  await until(async () => { try { [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return /^\d+$/.test(port); } catch { return false; } });
  const external = owner.pages()[0]; await external.goto(base); await external.locator('input').fill('independent owner value');
  engine = new BrowserEngine({ cdpUrl: `http://127.0.0.1:${port}`, popupPolicy: 'follow-single', timeoutMs: 3000 });
  const sibling = await engine.open(base), browser = await engine.browserPromise, context = browser.contexts()[0];
  // An independent page's popup must not be adopted or followed during our action.
  const foreignPopup = owner.waitForEvent('page');
  await external.evaluate(() => setTimeout(() => window.open('/external-popup', '_blank'), 50));
  const action = await engine.act(sibling.session_id, sibling.snapshot_id, [{ type: 'click', ref: sibling.elements.find(item => item.name === 'Noop').ref }]);
  const foreign = await foreignPopup;
  assert.equal(action.replan_required, undefined); assert.equal(action.snapshot.tabs.length, 1);
  const original = context.newPage.bind(context), entered = deferred(), release = deferred(), controller = new AbortController();
  context.newPage = async () => { const page = await original(); entered.resolve(page); await release.promise; return page; };
  releaseLate = release.resolve;
  const operation = engine.open(base, { signal: controller.signal }); const late = await entered.promise;
  await cancelled(operation, controller); context.newPage = original; release.resolve();
  await until(() => engine.opening.size === 0);
  assert.equal(late.isClosed(), true); assert.equal(external.isClosed(), false); assert.equal(foreign.isClosed(), false);
  assert.equal(await external.locator('input').inputValue(), 'independent owner value');
  assert.deepEqual(engine.list().map(item => item.session_id), [sibling.session_id]);
  assert.equal(browser.isConnected(), true);
  await engine.dispose();
  assert.equal(external.isClosed(), false); assert.equal(foreign.isClosed(), false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
});

for (const phase of ['context', 'page']) test(`dispose is bounded while an isolated ${phase} acquisition has not returned`, { timeout: 15000 }, async t => {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000 });
  const first = await engine.open(base), browser = await engine.browserPromise;
  const original = browser.newContext.bind(browser), entered = deferred(), release = deferred(), controller = new AbortController();
  t.after(async () => { release.resolve(); await engine.disposalWork?.catch(() => {}); await engine.dispose().catch(() => {}); });
  browser.newContext = async options => {
    const context = await original(options);
    if (phase === 'context') { entered.resolve({ context }); await release.promise; }
    else {
      const newPage = context.newPage.bind(context);
      context.newPage = async () => { const page = await newPage(); entered.resolve({ context, page }); await release.promise; return page; };
    }
    return context;
  };
  const operation = engine.open(base, { signal: controller.signal });
  const created = await entered.promise;
  await cancelled(operation, controller);
  // Intentionally do not release acquisition before awaiting dispose.
  await assert.rejects(boundedDispose(engine), { code: 'CLEANUP_INCOMPLETE' });
  assert.equal(browser.isConnected(), false, 'Owned browser must close without waiting for acquisition');
  assert.deepEqual(engine.list(), []);
  assert.ok(engine.opening.size > 0, 'Late acquisition must remain tracked');
  assert.equal(created.page?.isClosed() ?? true, true);
  await assert.rejects(engine.snapshot(first.session_id), { code: 'ENGINE_CLOSED' });
  release.resolve(); await engine.disposalWork;
  assert.equal(engine.opening.size, 0);
});

test('dispose reports context close failures rather than claiming complete cleanup', async t => {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000 });
  t.after(() => engine.dispose().catch(() => {}));
  await engine.open(base);
  const browser = await engine.browserPromise, context = browser.contexts()[0];
  context.close = async () => { throw new Error('Controlled close RPC failure'); };
  await assert.rejects(boundedDispose(engine), { code: 'CLEANUP_INCOMPLETE' });
  assert.equal(browser.isConnected(), false);
});

test('dispose retains an existing session cleanup after close removes the session from its map', { timeout: 15000 }, async t => {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000 });
  const opened = await engine.open(base), browser = await engine.browserPromise;
  const context = browser.contexts()[0], close = context.close.bind(context), entered = deferred(), release = deferred();
  context.close = async () => { await close(); entered.resolve(); await release.promise; };
  t.after(async () => { release.resolve(); await engine.disposalWork?.catch(() => {}); await engine.dispose().catch(() => {}); });
  const closing = engine.close(opened.session_id); await entered.promise;
  assert.deepEqual(engine.list(), []);
  assert.equal(engine.resourceCleanup.size, 1, 'Already-started session cleanup must be tracked independently');
  await assert.rejects(boundedDispose(engine), { code: 'CLEANUP_INCOMPLETE' });
  assert.equal(browser.isConnected(), false);
  release.resolve(); await closing; await engine.disposalWork;
  assert.equal(engine.resourceCleanup.size, 0);
});

test('CDP disposal reports an unidentified pending page and closes it after late arrival', { timeout: 30000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'tablaze-open-dispose-cdp-'));
  const owner = await chromium.launchPersistentContext(profile, { channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true, args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
  let engine, releaseLate;
  t.after(async () => { releaseLate?.(); await engine?.disposalWork?.catch(() => {}); await engine?.dispose().catch(() => {}); await owner.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  let port;
  await until(async () => { try { [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return /^\d+$/.test(port); } catch { return false; } });
  const external = owner.pages()[0]; await external.goto(base); await external.locator('input').fill('external value survives');
  engine = new BrowserEngine({ cdpUrl: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
  await engine.open(base);
  const browser = await engine.browserPromise, context = browser.contexts()[0];
  const original = context.newPage.bind(context), entered = deferred(), release = deferred(), controller = new AbortController();
  context.newPage = async () => { const page = await original(); entered.resolve(page); await release.promise; return page; };
  releaseLate = release.resolve;
  const ownedPageEvent = owner.waitForEvent('page');
  const operation = engine.open(base, { signal: controller.signal });
  await entered.promise; const ownedFromIndependentClient = await ownedPageEvent;
  await cancelled(operation, controller);
  await assert.rejects(boundedDispose(engine), { code: 'CLEANUP_INCOMPLETE' });
  assert.equal(browser.isConnected(), true, 'Keep transport available for late owned-page cleanup');
  assert.equal(ownedFromIndependentClient.isClosed(), false, 'Unidentified owned page is explicitly not yet confirmed closed');
  assert.equal(external.isClosed(), false);
  assert.equal(await external.locator('input').inputValue(), 'external value survives');
  const externalDuringCleanup = await owner.newPage(); await externalDuringCleanup.goto(base + '/external-during-cleanup');
  release.resolve(); await engine.disposalWork;
  await until(() => ownedFromIndependentClient.isClosed());
  assert.equal(browser.isConnected(), false, 'Disconnect only after late owned-page cleanup');
  assert.equal(engine.opening.size, 0);
  assert.equal(external.isClosed(), false); assert.equal(externalDuringCleanup.isClosed(), false);
  assert.equal(await external.locator('input').inputValue(), 'external value survives');
  assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
});
