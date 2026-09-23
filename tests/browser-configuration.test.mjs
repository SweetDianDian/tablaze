import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { startFixture } from './fixture.mjs';

const chrome = process.env.TABLAZE_BROWSER_CHANNEL || undefined;

test('owned Chrome context applies viewport, pixel ratio and an explicit permission', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine({ channel: chrome, headless: true, viewport: { width: 900, height: 620 }, deviceScaleFactor: 2, permissions: ['geolocation'], allowPageScript: true });
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const observed = await engine.script(opened.session_id, opened.snapshot_id, "return { width: innerWidth, height: innerHeight, ratio: devicePixelRatio, geolocation: (await navigator.permissions.query({name:'geolocation'})).state };", null);
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.deepEqual(observed.result, { width: 900, height: 620, ratio: 2, geolocation: 'granted' });
});

test('browser configuration rejects invalid values and cannot alter an external CDP context', () => {
  for (const options of [
    { viewport: { width: 319, height: 600 } },
    { viewport: { width: 900.5, height: 600 } },
    { deviceScaleFactor: 0 },
    { deviceScaleFactor: Infinity },
    { permissions: ['geolocation', 'geolocation'] },
    { permissions: ['fake-permission'] },
  ]) assert.throws(() => new BrowserEngine(options), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ cdpUrl: 'http://127.0.0.1:9222', viewport: { width: 900, height: 600 } }), { code: 'BROWSER_CONFIG_CDP_UNSUPPORTED' });
});

test('CLI doctor reports explicit browser configuration and rejects malformed flags', () => {
  const output = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'doctor', '--channel', chrome || 'chromium', '--viewport', '900x620', '--device-scale-factor', '2', '--permissions', 'geolocation,notifications'], { encoding: 'utf8' }));
  assert.deepEqual(output.viewport, { width: 900, height: 620 });
  assert.equal(output.device_scale_factor, 2);
  assert.deepEqual(output.permissions, ['geolocation', 'notifications']);
  for (const flags of [
    ['--viewport', '900-620'], ['--viewport', '10x10'], ['--device-scale-factor', '5'],
    ['--permissions', 'geolocation,geolocation'], ['--permissions', 'unknown'],
    ['--cdp-url', 'http://127.0.0.1:9222', '--viewport', '900x620'],
  ]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'doctor', ...flags], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flags.join(' '));
    assert.equal(result.stdout, '');
  }
});
