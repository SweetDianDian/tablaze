import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(operation, message, timeoutMs = 4000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ownedEndpoint(profile) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      // Discover only the endpoint of the Chrome this test started. Never attach
      // to a user's browser, a default profile, or a well-known debugging port.
      const [port, browserPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      assert.match(port, /^\d+$/);
      assert.ok(browserPath.startsWith('/devtools/browser/'));
      const endpoint = `http://127.0.0.1:${port}`;
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(4000) });
      assert.equal(response.status, 200);
      const version = await response.json();
      assert.equal(new URL(version.webSocketDebuggerUrl).pathname, browserPath);
      return endpoint;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(25);
    }
  }
  throw new Error('The test Chrome did not expose its own debugging endpoint');
}

async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'tablaze-lifecycle-races-'));
  const streams = new Set();
  let owner, engine, externalPage;
  const server = createServer((request, response) => {
    if (request.url === '/stream') {
      streams.add(response);
      response.once('close', () => streams.delete(response));
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="unfinished.bin"',
      });
      response.write(Buffer.alloc(65536, 65));
      // Intentionally do not end: closing a session must cancel this download,
      // rather than waiting for the remote server to finish its response.
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Race fixture</title>
      <a href="/stream" download>Download forever</a>
      <button style="position:absolute;left:100px;top:100px;width:100px;height:100px"
        onclick="window.clickCount++;document.title='Wrong tab clicked'">Click target</button>
      <script>window.clickCount=0;</script>`);
  });
  t.after(async () => {
    // If an assertion exposes the original hang, release the fixture stream
    // before teardown so the failure cannot strand the browser/test process.
    for (const response of streams) response.end();
    server.closeAllConnections();
    const artifacts = await engine?.artifactDirectory?.catch(() => undefined);
    await Promise.allSettled([engine?.dispose(), owner?.close()]);
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (artifacts) await rm(artifacts, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  owner = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });
  const endpoint = await ownedEndpoint(profile);
  externalPage = owner.pages()[0] ?? await owner.newPage();
  await externalPage.goto(url);
  await externalPage.evaluate(() => {
    document.title = 'Independent owner';
    sessionStorage.setItem('external-owner-marker', 'preserve');
  });
  engine = new BrowserEngine({ cdpUrl: endpoint, timeoutMs: 1500 });
  const assertExternalAlive = async () => {
    assert.equal(externalPage.isClosed(), false);
    assert.equal(await externalPage.title(), 'Independent owner');
    assert.equal(await externalPage.evaluate(() => sessionStorage.getItem('external-owner-marker')), 'preserve');
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200, 'The independent Chrome process remains reachable');
    const probe = await owner.newPage();
    await probe.goto(url);
    assert.equal(await probe.title(), 'Race fixture');
    await probe.close();
  };
  return { engine, owner, externalPage, url, streams, assertExternalAlive };
}

test('closing a CDP session cancels its unfinished download without closing the external browser', { timeout: 30000 }, async t => {
  const { engine, url, streams, assertExternalAlive } = await fixture(t);
  const snapshot = await engine.open(url);
  const ref = snapshot.elements.find(element => element.name === 'Download forever')?.ref;
  assert.ok(ref);
  const clicked = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref }]);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  const downloads = await engine.downloads(snapshot.session_id);
  assert.equal(downloads.downloads.length, 1);
  assert.equal(downloads.downloads[0].status, 'pending');
  assert.equal(streams.size, 1, 'The remote response is still open when close begins');
  const closed = await bounded(engine.close(snapshot.session_id), 'Session close waited for an unfinished download');
  assert.equal(closed.closed, true);
  assert.equal(engine.list().length, 0);
  await engine.dispose();
  await assertExternalAlive();
});

test('a tab created after disposal begins is closed instead of escaping session ownership', { timeout: 30000 }, async t => {
  const { engine, owner, externalPage, url, assertExternalAlive } = await fixture(t);
  const snapshot = await engine.open(url);
  // TypeScript private members remain accessible in this JS regression test.
  // Delay the real newPage call at the awaited boundary, let disposal finish
  // cleanup, then create the actual Chrome page. This forces the race without
  // timing guesses or mocking browser behavior.
  const session = engine.sessions.get(snapshot.session_id);
  const originalNewPage = session.context.newPage.bind(session.context);
  const reachedBoundary = deferred();
  const releaseNewPage = deferred();
  session.context.newPage = async () => {
    reachedBoundary.resolve();
    await releaseNewPage.promise;
    return originalNewPage();
  };
  const creating = engine.tabs(snapshot.session_id, { action: 'new', url })
    .then(value => ({ value }), error => ({ error }));
  t.after(() => releaseNewPage.resolve());
  await bounded(reachedBoundary.promise, 'Tab creation did not reach its scheduling boundary');
  const ownedPage = owner.pages().find(page => page !== externalPage);
  assert.ok(ownedPage);
  const ownedPageClosed = ownedPage.waitForEvent('close');
  const disposing = engine.dispose();
  try {
    // Observe real closure through the independent client; cleanup may be
    // initialized asynchronously and must not be mistaken for an empty wait.
    await bounded(ownedPageClosed, 'Disposal did not close its existing pages');
    assert.deepEqual(owner.pages(), [externalPage]);
  } finally {
    releaseNewPage.resolve();
  }
  const result = await bounded(creating, 'Late tab creation did not settle');
  assert.equal(result.error?.code, 'SESSION_CLOSED', JSON.stringify(result.value));
  await bounded(disposing, 'Disposal did not settle after the late tab was closed');
  assert.deepEqual(engine.list(), []);
  assert.deepEqual(owner.pages(), [externalPage], 'No late-created page survives disposal');
  await assertExternalAlive();
});

test('coordinate clicks never move to a sibling tab when the observed tab closes', { timeout: 30000 }, async t => {
  const { engine, url, assertExternalAlive } = await fixture(t);
  const first = await engine.open(url);
  const session = engine.sessions.get(first.session_id);
  const sibling = session.page;
  const observed = await engine.tabs(first.session_id, { action: 'new', url });
  const observedPage = session.page;
  const originalEvaluate = observedPage.evaluate.bind(observedPage);
  let scheduledClose = false;
  // Close the real observed tab immediately after viewport evaluation but
  // before the caller can issue mouse input. Its close event switches the
  // session's active page to the sibling, reproducing the original misclick.
  observedPage.evaluate = async (...args) => {
    const result = await originalEvaluate(...args);
    if (!scheduledClose) {
      scheduledClose = true;
      await observedPage.close();
    }
    return result;
  };
  const result = await engine.act(observed.session_id, observed.snapshot_id, [{ type: 'click_xy', x: 150, y: 150 }]);
  assert.equal(scheduledClose, true, 'The tab closed at the intended input boundary');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.completed, 0);
  assert.equal(sibling.isClosed(), false, 'The sibling stays available for a fresh observation');
  assert.equal(await sibling.evaluate(() => window.clickCount), 0, 'No coordinate input reached the sibling');
  assert.equal(await sibling.title(), 'Race fixture');
  await assertExternalAlive();
});
