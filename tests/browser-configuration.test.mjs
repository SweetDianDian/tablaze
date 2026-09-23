import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { networkInterfaces } from 'node:os';
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

test('owned Chrome context applies mobile, touch, screen and region settings to a real page', { timeout: 30_000 }, async t => {
  const fixture = await startFixture();
  const engine = new BrowserEngine({ channel: chrome, headless: true, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, userAgent: 'TablazeMobileFixture/1.0', locale: 'fr-FR', timezoneId: 'Europe/Paris', isMobile: true, hasTouch: true, allowPageScript: true });
  t.after(async () => { await engine.dispose(); await fixture.close(); });
  const opened = await engine.open(fixture.url);
  const observed = await engine.script(opened.session_id, opened.snapshot_id, "return { agent: navigator.userAgent, language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height], ratio: devicePixelRatio, touchPoints: navigator.maxTouchPoints, touchEvent: 'ontouchstart' in window };", null);
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.deepEqual(observed.result, { agent: 'TablazeMobileFixture/1.0', language: 'fr-FR', timezone: 'Europe/Paris', screen: [390, 844], ratio: 3, touchPoints: 1, touchEvent: true });
});

test('browser configuration rejects invalid values and cannot alter an external CDP context', () => {
  for (const options of [
    { viewport: { width: 319, height: 600 } },
    { viewport: { width: 900.5, height: 600 } },
    { deviceScaleFactor: 0 },
    { deviceScaleFactor: Infinity },
    { screen: { width: 200, height: 800 } },
    { userAgent: 'bad\nagent' },
    { locale: 'not_a_locale' },
    { timezoneId: 'Moon/Base' },
    { isMobile: 'yes' },
    { hasTouch: 1 },
    { permissions: ['geolocation', 'geolocation'] },
    { permissions: ['fake-permission'] },
  ]) assert.throws(() => new BrowserEngine(options), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => new BrowserEngine({ cdpUrl: 'http://127.0.0.1:9222', viewport: { width: 900, height: 600 } }), { code: 'BROWSER_CONFIG_CDP_UNSUPPORTED' });
  assert.throws(() => new BrowserEngine({ cdpUrl: 'http://127.0.0.1:9222', isMobile: true }), { code: 'BROWSER_CONFIG_CDP_UNSUPPORTED' });
  for (const server of ['ftp://127.0.0.1:3000', 'http://user:secret@127.0.0.1:3000', 'http://127.0.0.1:3000/private']) assert.throws(() => new BrowserEngine({ proxy: { server } }), { code: 'PROXY_CONFIG_INVALID' });
  assert.throws(() => new BrowserEngine({ cdpUrl: 'http://127.0.0.1:9222', proxy: { server: 'http://127.0.0.1:3000' } }), { code: 'PROXY_CDP_UNSUPPORTED' });
});

test('owned Chrome traffic reaches a configured HTTP proxy', { timeout: 30_000 }, async t => {
  const requests = [];
  const proxy = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Proxy target</title><p>Routed through owned proxy</p>');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ channel: chrome, headless: true, proxy: { server: `http://127.0.0.1:${proxy.address().port}` } });
  t.after(async () => { await engine.dispose(); await new Promise(resolve => proxy.close(resolve)); });
  const opened = await engine.open('http://tablaze-proxy.example.test/through-proxy');
  assert.match(opened.text, /Routed through owned proxy/);
  assert.ok(requests.some(url => url.includes('tablaze-proxy.example.test/through-proxy')), JSON.stringify(requests));
});

test('owned Chrome answers an HTTP proxy challenge without exposing the credential in page output', { timeout: 30_000 }, async t => {
  const password = 'proxy-private-sentinel';
  const expected = `Basic ${Buffer.from(`operator:${password}`).toString('base64')}`;
  let challenges = 0; let accepted = 0;
  const proxy = createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== expected) {
      challenges++;
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="Tablaze fixture"' });
      response.end();
      return;
    }
    accepted++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Authenticated proxy target</title><p>Authenticated route</p>');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ channel: chrome, headless: true, proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'operator', password } });
  t.after(async () => { await engine.dispose(); await new Promise(resolve => proxy.close(resolve)); });
  const opened = await engine.open('http://tablaze-auth-proxy.example.test/protected');
  assert.match(opened.text, /Authenticated route/);
  assert.ok(accepted >= 1);
  assert.doesNotMatch(opened.text + JSON.stringify(opened), /proxy-private-sentinel|operator/);
  assert.ok(challenges >= 1, 'The server issued a 407 challenge before accepting the authenticated request.');
});

test('owned Chrome proxy bypass sends a non-loopback local destination directly', { timeout: 30_000 }, async t => {
  const address = Object.values(networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal)?.address;
  if (!address) return t.skip('No non-loopback IPv4 address is available for a direct-route witness.');
  let proxyHits = 0; let directHits = 0;
  const direct = createServer((_request, response) => {
    directHits++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Direct target</title><p>Direct route</p>');
  });
  const proxy = createServer((_request, response) => {
    proxyHits++;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Proxy target</title><p>Proxy route</p>');
  });
  await new Promise(resolve => direct.listen(0, '0.0.0.0', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const destination = `http://${address}:${direct.address().port}/bypass`;
  const proxyServer = `http://127.0.0.1:${proxy.address().port}`;
  const throughProxy = new BrowserEngine({ channel: chrome, headless: true, proxy: { server: proxyServer } });
  const bypassed = new BrowserEngine({ channel: chrome, headless: true, proxy: { server: proxyServer, bypass: address } });
  t.after(async () => { await throughProxy.dispose(); await bypassed.dispose(); await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => direct.close(resolve)); });
  assert.match((await throughProxy.open(destination)).text, /Proxy route/);
  assert.match((await bypassed.open(destination)).text, /Direct route/);
  assert.ok(proxyHits >= 1);
  assert.ok(directHits >= 1);
});

test('owned Chrome reaches an HTTP page through a SOCKS5 proxy', { timeout: 30_000 }, async t => {
  const destinations = []; let pageRequests = 0;
  const proxy = createNetServer(socket => {
    let buffer = Buffer.alloc(0); let phase = 'greeting';
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (phase === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          assert.equal(buffer[0], 5);
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, 0]));
          phase = 'connect';
        } else if (phase === 'connect') {
          if (buffer.length < 5) return;
          assert.equal(buffer[0], 5);
          assert.equal(buffer[1], 1);
          assert.equal(buffer[3], 3, 'The proxy receives a hostname, not a locally resolved address.');
          const length = buffer[4];
          if (buffer.length < 5 + length + 2) return;
          destinations.push(buffer.subarray(5, 5 + length).toString());
          buffer = buffer.subarray(5 + length + 2);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          phase = 'http';
        } else if (phase === 'http') {
          if (!buffer.includes('\r\n\r\n')) return;
          pageRequests++;
          socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 60\r\nConnection: close\r\n\r\n<!doctype html><title>SOCKS target</title><p>SOCKS route</p>');
          phase = 'done';
          return;
        } else return;
      }
    });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const engine = new BrowserEngine({ channel: chrome, headless: true, proxy: { server: `socks5://127.0.0.1:${proxy.address().port}` } });
  t.after(async () => { await engine.dispose(); await new Promise(resolve => proxy.close(resolve)); });
  const opened = await engine.open('http://tablaze-socks.example.test/through-socks');
  assert.match(opened.text, /SOCKS route/);
  assert.ok(destinations.includes('tablaze-socks.example.test'), JSON.stringify(destinations));
  assert.ok(pageRequests >= 1);
});

test('CLI doctor reports explicit browser configuration and rejects malformed flags', () => {
  const output = JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'doctor', '--channel', chrome || 'chromium', '--viewport', '900x620', '--screen', '900x620', '--device-scale-factor', '2', '--user-agent', 'FixtureBrowser/1.0', '--locale', 'fr-FR', '--timezone', 'Europe/Paris', '--mobile', '--touch', '--permissions', 'geolocation,notifications'], { encoding: 'utf8' }));
  assert.deepEqual(output.viewport, { width: 900, height: 620 });
  assert.equal(output.device_scale_factor, 2);
  assert.deepEqual(output.screen, { width: 900, height: 620 });
  assert.equal(output.user_agent_configured, true);
  assert.equal(output.locale, 'fr-FR');
  assert.equal(output.timezone, 'Europe/Paris');
  assert.equal(output.mobile, true);
  assert.equal(output.touch, true);
  assert.deepEqual(output.permissions, ['geolocation', 'notifications']);
  const authenticated = spawnSync(process.execPath, ['dist/cli.js', 'doctor', '--channel', chrome || 'chromium', '--proxy-server', 'http://127.0.0.1:3000', '--proxy-username', 'operator', '--proxy-password-env', 'TABLAZE_TEST_PROXY_PASSWORD'], { encoding: 'utf8', env: { ...process.env, TABLAZE_TEST_PROXY_PASSWORD: 'proxy-private-sentinel' } });
  assert.equal(authenticated.status, 0, authenticated.stderr);
  assert.deepEqual(JSON.parse(authenticated.stdout).proxy, { enabled: true, protocol: 'http', has_credentials: true });
  assert.doesNotMatch(authenticated.stdout + authenticated.stderr, /proxy-private-sentinel|operator|127\.0\.0\.1:3000/);
  for (const flags of [
    ['--viewport', '900-620'], ['--viewport', '10x10'], ['--screen', '10x10'], ['--screen', '900-620'], ['--device-scale-factor', '5'],
    ['--user-agent', 'bad\nagent'], ['--locale', 'not_a_locale'], ['--timezone', 'Moon/Base'],
    ['--permissions', 'geolocation,geolocation'], ['--permissions', 'unknown'],
    ['--cdp-url', 'http://127.0.0.1:9222', '--viewport', '900x620'],
    ['--cdp-url', 'http://127.0.0.1:9222', '--mobile'],
    ['--proxy-server', 'http://user:secret@127.0.0.1:3000'], ['--proxy-bypass', 'localhost'],
    ['--cdp-url', 'http://127.0.0.1:9222', '--proxy-server', 'http://127.0.0.1:3000'],
  ]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', 'doctor', ...flags], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, flags.join(' '));
    assert.equal(result.stdout, '');
  }
});
