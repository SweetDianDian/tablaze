import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';
import { createServer as createMcpServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

const value = 'synthetic-login-N7mQ+equals=';
const ref = (snapshot, name) => {
  const entry = snapshot.elements.find(item => item.name === name);
  assert.ok(entry, `Missing observed ${name}`);
  return entry.ref;
};

async function fixture(t) {
  const state = { attempts: 0, accepted: 0, resolved: 0 };
  let otherOrigin;
  const serve = handler => new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
  const login = await serve(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/signin' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      state.attempts++;
      if (new URLSearchParams(body).get('password') !== value) { response.writeHead(403).end('Denied'); return; }
      state.accepted++;
      response.writeHead(303, { location: '/dashboard', 'set-cookie': 'session=accepted; HttpOnly; SameSite=Lax; Path=/' }).end();
      return;
    }
    if (url.pathname === '/dashboard') {
      if (!request.headers.cookie?.includes('session=accepted')) { response.writeHead(401).end('Not signed in'); return; }
      response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Account dashboard</title><main>Signed in; private task complete</main>');
      return;
    }
    if (url.pathname === '/frame-host') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Frame host</title><label>Top password <input type="password"></label><iframe src="${otherOrigin}/frame"></iframe>`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Login</title>
      <form action="/signin" method="post"><label>Password <input name="password" type="password" autocomplete="off"></label><button>Sign in</button></form>
      <p id="echo"></p><a id="echo-link" href="/later">Account details</a><label>Visible state <input id="visible" autocomplete="off"></label>
      <script>document.querySelector('[name=password]').addEventListener('input', event => {
        const secret = event.target.value;
        document.querySelector('#echo').textContent = 'Echo ' + secret;
        document.querySelector('#echo-link').href = '/later?proof=' + encodeURIComponent(secret);
        document.querySelector('#visible').value = secret;
        document.title = 'Login ' + secret;
      })</script>`);
  });
  const other = await serve((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<title>Other origin</title><label>Password <input type="password"></label>'));
  otherOrigin = other.origin;
  t.after(async () => {
    for (const { server } of [login, other]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const options = {
    headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 2_000,
    secrets: { contextId: 'synthetic-account', secrets: [{ name: 'login_password', version: '1', allowedOrigins: [login.origin], resolve: () => { state.resolved++; return value; } }] },
  };
  return { login, other, state, options };
}

test('scoped credential completes a real login and never appears in normal evidence or artifacts', { timeout: 30_000 }, async t => {
  const { login, other, state, options } = await fixture(t);
  const engine = new BrowserEngine(options);
  t.after(() => engine.dispose());
  const opened = await engine.open(login.origin + '/login');
  assert.deepEqual(opened.available_secrets, ['login_password']);
  assert.equal(state.resolved, 0);
  const filled = await engine.act(opened.session_id, opened.snapshot_id,
    [{ type: 'fill_secret', ref: ref(opened, 'Password'), secret: 'login_password' }]);
  assert.equal(filled.ok, true, JSON.stringify(filled));
  assert.equal(filled.completed, 1);
  assert.equal(state.resolved, 1);
  assert.doesNotMatch(JSON.stringify(filled), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(JSON.stringify(filled.snapshot), /\[redacted\]/);

  const text = await engine.extract(opened.session_id, { kind: 'text', selector: '#echo' });
  assert.match(text.text, /\[redacted\]/);
  assert.equal(text.text.includes(value), false);
  const verification = await engine.verify(opened.session_id, [
    { kind: 'text', contains: 'Echo' },
    { kind: 'value', selector: '#visible', value: 'different-value' },
  ], 100);
  assert.equal(verification.checks[0].pass, true);
  assert.equal(JSON.stringify(verification).includes(value), false, 'verification must not disclose echoed secret text or field values');
  await assert.rejects(engine.extractStructured(opened.session_id, {
    schema: { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'], additionalProperties: false },
    fields: [{ name: 'echo', selector: '#echo', mode: 'text' }],
  }), { code: 'SECRET_EVIDENCE_BLOCKED' });
  await assert.rejects(engine.screenshot(opened.session_id), { code: 'SECRET_ARTIFACT_BLOCKED' });
  await assert.rejects(engine.pdf(opened.session_id), { code: 'SECRET_ARTIFACT_BLOCKED' });
  await assert.rejects(engine.saveState(opened.session_id), { code: 'SECRET_ARTIFACT_BLOCKED' });

  const page = engine.sessions.get(opened.session_id).page;
  assert.equal(await page.locator('[name=password]').inputValue(), value, 'only the permitted page receives the actual value');
  await page.evaluate(secret => history.replaceState(null, '', '/login?proof=' + encodeURIComponent(secret)), value);
  assert.equal(JSON.stringify(engine.list()).includes(value), false, 'session listing must redact URLs');
  const workspace = await engine.exportWorkspace();
  assert.equal(JSON.stringify(workspace).includes(value), false);
  assert.equal(workspace.sessions[0].requiresReauthentication, true);
  assert.deepEqual(workspace.sessions[0].storage, { cookies: [], origins: [] });
  assert.ok(workspace.sessions[0].tabs.every(tab => tab.url === 'about:blank'));

  const current = await engine.snapshot(opened.session_id);
  const clicked = await engine.act(opened.session_id, current.snapshot_id, [{ type: 'click', ref: ref(current, 'Sign in') }]);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.equal(state.attempts, 1);
  assert.equal(state.accepted, 1);
  const finished = await engine.verify(opened.session_id, [{ kind: 'text', contains: 'private task complete' }]);
  assert.equal(finished.passed, true);

  const denied = await engine.open(other.origin);
  assert.deepEqual(denied.available_secrets, []);
  const before = state.resolved;
  const refused = await engine.act(denied.session_id, denied.snapshot_id,
    [{ type: 'fill_secret', ref: ref(denied, 'Password'), secret: 'login_password' }], { snapshot: false });
  assert.equal(refused.failed.error.code, 'SECRET_ORIGIN_BLOCKED');
  assert.equal(state.resolved, before, 'an origin mismatch must not call the resolver');
  assert.equal(await engine.sessions.get(denied.session_id).page.locator('input').inputValue(), '');
});

test('iframe credentials require both the frame and top-level origin to match', { timeout: 30_000 }, async t => {
  const { login, other, state, options } = await fixture(t);
  const engine = new BrowserEngine({ ...options, secrets: { contextId: 'synthetic-account', secrets: [
    { name: 'frame_only', version: '1', allowedOrigins: [other.origin], allowedTopOrigins: [login.origin], resolve: () => { state.resolved++; return value; } },
  ] } });
  t.after(() => engine.dispose());
  const opened = await engine.open(login.origin + '/frame-host');
  assert.deepEqual(opened.available_secrets, [], 'the top document cannot use a frame-only alias');
  let current = opened;
  let frame = current.frames.find(entry => entry.url === other.origin + '/frame');
  for (let attempt = 0; !frame && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    current = await engine.snapshot(opened.session_id);
    frame = current.frames.find(entry => entry.url === other.origin + '/frame');
  }
  assert.ok(frame, JSON.stringify(current.frames));
  const nested = await engine.snapshot(opened.session_id, { frameId: frame.frame_id });
  assert.deepEqual(nested.available_secrets, ['frame_only']);
  const top = await engine.snapshot(opened.session_id);
  const deniedTop = await engine.act(opened.session_id, top.snapshot_id,
    [{ type: 'fill_secret', ref: ref(top, 'Top password'), secret: 'frame_only' }], { snapshot: false });
  assert.equal(deniedTop.failed.error.code, 'SECRET_ORIGIN_BLOCKED');
  assert.equal(state.resolved, 0);
  const freshNested = await engine.snapshot(opened.session_id, { frameId: frame.frame_id });
  const allowed = await engine.act(opened.session_id, freshNested.snapshot_id,
    [{ type: 'fill_secret', ref: ref(freshNested, 'Password'), secret: 'frame_only' }], { snapshot: false });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(state.resolved, 1);
  const iframe = engine.sessions.get(opened.session_id).page.frames().find(item => item.url() === other.origin + '/frame');
  assert.equal(await iframe.locator('input').inputValue(), value);

  const otherTop = await engine.open(other.origin);
  assert.deepEqual(otherTop.available_secrets, []);
  const deniedOtherTop = await engine.act(otherTop.session_id, otherTop.snapshot_id,
    [{ type: 'fill_secret', ref: ref(otherTop, 'Password'), secret: 'frame_only' }], { snapshot: false });
  assert.equal(deniedOtherTop.failed.error.code, 'SECRET_ORIGIN_BLOCKED');
  assert.equal(state.resolved, 1);
});

test('MCP uses only the credential alias and reports login evidence without disclosing the value', { timeout: 30_000 }, async t => {
  const { login, state, options } = await fixture(t);
  const runtime = createMcpServer(options);
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const call = (name, args) => connection.client.callTool({ name, arguments: args });
  const safe = response => {
    assert.equal(JSON.stringify(response).includes(value), false, 'MCP content and structured result must omit the credential');
    return response.structuredContent;
  };

  const opened = safe(await call('tab_open', { url: login.origin + '/login' }));
  assert.deepEqual(opened.available_secrets, ['login_password']);
  const filled = safe(await call('tab_act', {
    session_id: opened.session_id, snapshot_id: opened.snapshot_id,
    actions: [{ type: 'fill_secret', ref: ref(opened, 'Password'), secret: 'login_password' }],
  }));
  assert.equal(filled.ok, true, JSON.stringify(filled));
  assert.equal(state.resolved, 1);
  assert.match(JSON.stringify(filled.snapshot), /\[redacted\]/);

  const extracted = safe(await call('tab_extract', { session_id: opened.session_id, kind: 'text', selector: '#echo' }));
  assert.match(extracted.text, /\[redacted\]/);
  const verified = safe(await call('tab_verify', {
    session_id: opened.session_id,
    checks: [{ kind: 'text', contains: 'Echo' }, { kind: 'value', selector: '#visible', value: 'not-the-secret' }],
  }));
  assert.equal(verified.checks[0].pass, true);
  const capture = safe(await call('tab_capture', { session_id: opened.session_id }));
  assert.equal(capture.error.code, 'SECRET_ARTIFACT_BLOCKED');

  const current = safe(await call('tab_snapshot', { session_id: opened.session_id }));
  const submitted = safe(await call('tab_act', {
    session_id: opened.session_id, snapshot_id: current.snapshot_id,
    actions: [{ type: 'click', ref: ref(current, 'Sign in') }],
  }));
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(state.attempts, 1);
  assert.equal(state.accepted, 1);
  const complete = safe(await call('tab_verify', { session_id: opened.session_id, checks: [{ kind: 'text', contains: 'private task complete' }] }));
  assert.equal(complete.passed, true);
});
