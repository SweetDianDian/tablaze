import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';

let server, url;
before(async () => {
  server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Binding fixture</title><label>Name <input value="Ada"></label><p>Ready</p><button>Save</button>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Binding operation did not settle')), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) { assert.ok(Date.now() < deadline); await delay(10); }
}
async function fixture(t) {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1500 });
  t.after(() => engine.dispose());
  const snapshot = await engine.open(url);
  return { engine, snapshot, session: engine.sessions.get(snapshot.session_id) };
}

test('binding is frozen trusted metadata; observations and DOM edits do not consume it or hold the queue', async t => {
  const { engine, snapshot, session } = await fixture(t);
  const guard = await engine.acquireBinding(snapshot.session_id);
  t.after(() => guard.close());
  assert.deepEqual(Object.keys(guard).sort(), ['assertCurrent', 'binding', 'close', 'contextKey']);
  assert.deepEqual(guard.binding, { sessionId: snapshot.session_id, tabId: snapshot.tab_id, documentEpoch: session.generations.get(session.page.mainFrame()), origin: url });
  assert.ok(Object.isFrozen(guard)); assert.ok(Object.isFrozen(guard.binding));
  assert.match(guard.contextKey, /^[a-f0-9]{64}$/);
  const sameContext = await engine.acquireBinding(snapshot.session_id);
  assert.equal(sameContext.contextKey, guard.contextKey);
  await sameContext.close();
  await bounded(engine.snapshot(snapshot.session_id));
  await bounded(engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Ready' }]));
  await session.page.locator('input').fill('Grace');
  await session.page.evaluate(() => { document.querySelector('p').textContent = 'Updated'; });
  await bounded(guard.assertCurrent());
  await guard.close(); await guard.close();
  await assert.rejects(guard.assertCurrent(), { code: 'BINDING_CLOSED' });
  assert.equal(engine.bindings.size, 0);
});

test('same-URL reload invalidates a document lease even if the cached navigation counter is delayed', async t => {
  const { engine, snapshot, session } = await fixture(t);
  const guard = await engine.acquireBinding(snapshot.session_id), frame = session.page.mainFrame();
  await session.page.reload();
  assert.equal(session.page.url(), url + '/');
  const reloaded = await engine.acquireBinding(snapshot.session_id);
  assert.notEqual(reloaded.contextKey, guard.contextKey, 'A same-URL reload produces a new context key');
  await reloaded.close();
  // Simulate delivery lag in cached navigation metadata. The real Document
  // handle must independently reject the replaced execution context.
  session.generations.set(frame, guard.binding.documentEpoch);
  await assert.rejects(guard.assertCurrent(), { code: 'BINDING_STALE' });
  await guard.close();
});

test('history routes and tab switch ABA invalidate bindings permanently', async t => {
  const { engine, snapshot, session } = await fixture(t);
  const route = await engine.acquireBinding(snapshot.session_id);
  await session.page.evaluate(() => history.pushState({}, '', '/different-route'));
  await assert.rejects(route.assertCurrent(), { code: 'BINDING_STALE' });
  const first = snapshot.tab_id;
  const current = await engine.acquireBinding(snapshot.session_id);
  assert.notEqual(current.contextKey, route.contextKey, 'A history route change produces a new context key');
  await engine.tabs(snapshot.session_id, { action: 'new', url });
  await engine.tabs(snapshot.session_id, { action: 'switch', tabId: first });
  assert.equal(session.page.url(), url + '/different-route');
  await assert.rejects(current.assertCurrent(), { code: 'BINDING_STALE' });
  const returned = await engine.acquireBinding(snapshot.session_id);
  assert.notEqual(returned.contextKey, current.contextKey, 'Switching away and back produces a new context key');
  await returned.close();
  await route.close(); await current.close();
});

test('a navigation during the asynchronous assertion cannot produce a valid stale result', async t => {
  const { engine, snapshot, session } = await fixture(t), frame = session.page.mainFrame();
  let handle;
  const original = frame.evaluateHandle.bind(frame);
  frame.evaluateHandle = async (...args) => { handle = await original(...args); return handle; };
  const guard = await engine.acquireBinding(snapshot.session_id);
  frame.evaluateHandle = original;
  const evaluate = handle.evaluate.bind(handle), entered = deferred(), release = deferred();
  handle.evaluate = async (...args) => { const result = await evaluate(...args); entered.resolve(); await release.promise; return result; };
  t.after(() => release.resolve());
  const checking = guard.assertCurrent(); const rejected = assert.rejects(checking, { code: 'BINDING_STALE' });
  await entered.promise; await session.page.reload(); release.resolve(); await rejected;
  await guard.close();
});

test('signal, explicit close, session close and engine disposal revoke leases without exposing browser handles', async t => {
  const { engine, snapshot } = await fixture(t), controller = new AbortController();
  const cancelled = await engine.acquireBinding(snapshot.session_id, { signal: controller.signal });
  controller.abort(new Error('secret abort reason'));
  await assert.rejects(cancelled.assertCurrent(), error => error.code === 'CANCELLED' && !error.message.includes('secret'));
  await cancelled.close();
  const sessionClosed = await engine.acquireBinding(snapshot.session_id);
  await engine.close(snapshot.session_id);
  await assert.rejects(sessionClosed.assertCurrent(), { code: 'BINDING_STALE' });
  const second = await engine.open(url), disposed = await engine.acquireBinding(second.session_id);
  await engine.dispose();
  await assert.rejects(disposed.assertCurrent(), { code: 'ENGINE_CLOSED' });
  await sessionClosed.close(); await disposed.close();
  assert.equal(engine.bindings.size, 0);
});

test('cancelled acquisition releases a real late Document handle without affecting the session', async t => {
  const { engine, snapshot, session } = await fixture(t), frame = session.page.mainFrame();
  const original = frame.evaluateHandle.bind(frame), entered = deferred(), release = deferred(), controller = new AbortController();
  let disposed = 0;
  frame.evaluateHandle = async (...args) => {
    const handle = await original(...args), dispose = handle.dispose.bind(handle);
    handle.dispose = async () => { disposed++; return dispose(); };
    entered.resolve(); await release.promise; return handle;
  };
  t.after(() => release.resolve());
  const acquiring = engine.acquireBinding(snapshot.session_id, { signal: controller.signal });
  const rejected = assert.rejects(acquiring, { code: 'CANCELLED' });
  await entered.promise; controller.abort(); await bounded(rejected);
  assert.equal(disposed, 0, 'Late handle has not yet reached the engine');
  release.resolve(); await until(() => engine.bindingJobs.size === 0);
  frame.evaluateHandle = original;
  assert.equal(disposed, 1); assert.equal(engine.bindings.size, 0);
  await bounded(engine.snapshot(snapshot.session_id));
});

test('pre-cancelled acquisition creates no remote handle and opaque origins are refused', async t => {
  const { engine, snapshot } = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(engine.acquireBinding(snapshot.session_id, { signal: controller.signal }), { code: 'CANCELLED' });
  await engine.tabs(snapshot.session_id, { action: 'new' });
  await assert.rejects(engine.acquireBinding(snapshot.session_id), { code: 'BINDING_ORIGIN_UNSUPPORTED' });
  assert.equal(engine.bindings.size, 0);
});

test('engine disposal revokes an in-flight acquisition and releases its late handle', async t => {
  const { engine, snapshot, session } = await fixture(t), frame = session.page.mainFrame();
  const original = frame.evaluateHandle.bind(frame), entered = deferred(), release = deferred();
  let disposed = 0;
  frame.evaluateHandle = async (...args) => {
    const handle = await original(...args), dispose = handle.dispose.bind(handle);
    handle.dispose = async () => { disposed++; return dispose(); };
    entered.resolve(); await release.promise; return handle;
  };
  t.after(() => release.resolve());
  const acquiring = engine.acquireBinding(snapshot.session_id);
  const rejected = assert.rejects(acquiring, { code: 'ENGINE_CLOSED' });
  await entered.promise;
  const disposing = engine.dispose(); await bounded(rejected);
  release.resolve(); await bounded(disposing);
  assert.equal(disposed, 1); assert.equal(engine.bindings.size, 0); assert.equal(engine.bindingJobs.size, 0);
});

test('independent CDP navigation invalidates a lease and lease cleanup leaves the external browser alive', { timeout: 30000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'tablaze-binding-cdp-'));
  const owner = await chromium.launchPersistentContext(profile, { channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, headless: true, args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'] });
  let engine;
  t.after(async () => { await engine?.dispose(); await owner.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  let port;
  await until(async () => { try { [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); return /^\d+$/.test(port); } catch { return false; } });
  const external = owner.pages()[0]; await external.goto(url);
  engine = new BrowserEngine({ cdpUrl: `http://127.0.0.1:${port}`, timeoutMs: 1500 });
  const newPage = owner.waitForEvent('page'), opened = await engine.open(url), owned = await newPage;
  const guard = await engine.acquireBinding(opened.session_id);
  await owned.goto(url + '/outside-navigation');
  await assert.rejects(guard.assertCurrent(), { code: 'BINDING_STALE' });
  await guard.close(); await engine.dispose();
  assert.equal(external.isClosed(), false); assert.equal(await external.title(), 'Binding fixture');
  assert.equal((await fetch(`http://127.0.0.1:${port}/json/version`)).status, 200);
});
