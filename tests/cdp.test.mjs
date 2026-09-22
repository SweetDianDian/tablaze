import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserEngine } from '../dist/browser.js';
import { startFixture } from './fixture.mjs';

async function ownedEndpoint(profile) {
  // Chrome chooses an available port. Read only this test's unique profile;
  // never discover or attach to an existing user browser/debugging endpoint.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (/^\d+$/.test(port) && Number(port) > 0 && browserPath?.startsWith('/devtools/browser/')) {
        const endpoint = `http://127.0.0.1:${port}`;
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5_000) });
        assert.equal(response.status, 200);
        const version = await response.json();
        assert.equal(new URL(version.webSocketDebuggerUrl).pathname, browserPath,
          'The CDP endpoint must belong to the Chrome started with this temporary profile');
        return endpoint;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(25);
  }
  throw new Error('The isolated Chrome did not expose its DevToolsActivePort file');
}

test('CDP disposal closes only owned pages and preserves the independent browser and existing state', { timeout: 60_000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'tablaze-cdp-ownership-'));
  let fixture;
  let owner;
  let engine;
  t.after(async () => {
    await engine?.dispose().catch(() => {});
    await owner?.close().catch(() => {});
    await fixture?.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  fixture = await startFixture();
  owner = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined,
    timeout: 30_000,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });
  const endpoint = await ownedEndpoint(profile);

  // These pages belong to the independent test owner, not BrowserEngine.
  const existing = owner.pages()[0] ?? await owner.newPage();
  await existing.goto(`${fixture.url}/state`);
  await existing.getByRole('button', { name: 'Remember this session' }).click();
  await existing.evaluate(() => {
    sessionStorage.setItem('owner-session-marker', 'keep-this-page');
    document.title = 'Independent CDP owner';
  });
  const existingForm = await owner.newPage();
  await existingForm.goto(`${fixture.url}/`);
  await existingForm.locator('#destination').fill('Preserve this existing form');
  const originalPages = [...owner.pages()];

  engine = new BrowserEngine({ cdpUrl: endpoint, timeoutMs: 2_000 });
  const ownedPageEvent = owner.waitForEvent('page', { timeout: 10_000 });
  const observed = await engine.open(`${fixture.url}/state?owner=tablaze`);
  const ownedPage = await ownedPageEvent;
  assert.equal(observed.session_mode, 'attached_profile');
  assert.match(observed.text, /Remembered/, 'CDP attachment must observe the deliberately shared profile state');
  assert.equal(ownedPage.url(), `${fixture.url}/state?owner=tablaze`);
  assert.ok(!originalPages.includes(ownedPage), 'The service must create its own page');
  assert.equal(owner.pages().length, originalPages.length + 1);

  const ownedPageClosed = ownedPage.waitForEvent('close', { timeout: 10_000 });
  await engine.dispose();
  await ownedPageClosed;
  await engine.dispose(); // Repeated disposal must not affect the independent owner.

  assert.equal(ownedPage.isClosed(), true);
  assert.deepEqual(engine.list(), []);
  assert.equal(owner.pages().length, originalPages.length);
  for (const page of originalPages) assert.equal(page.isClosed(), false, 'An existing owner page was closed');
  assert.equal(await existing.title(), 'Independent CDP owner');
  assert.deepEqual(await existing.evaluate(() => ({
    local: localStorage.getItem('remembered'),
    session: sessionStorage.getItem('owner-session-marker'),
  })), { local: 'yes', session: 'keep-this-page' });
  assert.equal(await existingForm.locator('#destination').inputValue(), 'Preserve this existing form');

  // Live CDP and a new navigable page prove the external browser was not killed
  // or merely represented by stale handles after service disconnection.
  const versionAfter = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(versionAfter.status, 200);
  const probe = await owner.newPage();
  await probe.goto(`${fixture.url}/state`);
  assert.equal(await probe.locator('#state').innerText(), 'Remembered');
  await probe.close();
});
