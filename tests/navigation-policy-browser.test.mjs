import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserEngine } from '../dist/browser.js';
import { compileNavigationPolicy } from '../dist/navigation-policy.js';

const channel = process.env.TABLAZE_BROWSER_CHANNEL || undefined;
const escapeHTML = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const form = action => `<!doctype html><title>Allowed form</title><form method="post" action="${action}">
<label>Name <input name="name"></label><label>Memo <textarea name="memo"></textarea></label><button>Save record</button></form>`;

async function fixture(t) {
  const requests = [], engines = [], handlerErrors = [];
  const waitingResponses = new Set();
  let allowed, denied, crossSite;
  const handler = side => async (request, response) => {
    const record = { side, method: request.method, path: new URL(request.url, 'http://fixture.invalid').pathname, body: '', cookie: request.headers.cookie ?? '', contentType: request.headers['content-type'] ?? '', destination: request.headers['sec-fetch-dest'] ?? '' };
    // Count arrival even if Chrome later cancels the body or leaves the document.
    requests.push(record);
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      record.body = Buffer.concat(chunks).toString('utf8');
      const html = text => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(text);
      const redirect = (status, location, extra = {}) => response.writeHead(status, { location, 'cache-control': 'no-store', ...extra }).end();
      if (side === 'denied') {
        if (record.path === '/data') return response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('Remote fetch received');
        if (record.path === '/image') return response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
        return html('<title>Denied document</title><p>Denied server document received</p>');
      }
      if (record.path === '/form') return html(form('/submit'));
      if (record.path === '/coordinated-form') return html(form('/submit') + '<p id="gate">Waiting for release</p><script>fetch("/wait-release").then(()=>document.querySelector("#gate").textContent="Continue form")</script>');
      if (record.path === '/wait-release') { waitingResponses.add(response); response.once('close', () => waitingResponses.delete(response)); return; }
      if (record.path === '/post-form') return html(form('/post-307'));
      if (record.path === '/post-307') return redirect(307, '/post-final');
      if (record.path === '/submit' || record.path === '/post-final') {
        const fields = new URLSearchParams(record.body);
        return html(`<title>Saved record</title><p>Saved ${escapeHTML(fields.get('name') ?? '')} / ${escapeHTML(fields.get('memo') ?? '')}</p>`);
      }
      if (record.path === '/cookie-start') return redirect(302, '/cookie-final', { 'set-cookie': 'navigation_cookie=preserved; Path=/; SameSite=Lax; HttpOnly' });
      if (record.path === '/cookie-final') return html(`<title>Cookie landing</title><p>${record.cookie.includes('navigation_cookie=preserved') ? 'Cookie received' : 'Cookie missing'}</p>`);
      if (record.path === '/redirect-one') return redirect(302, '/redirect-two');
      if (record.path === '/redirect-two') return redirect(302, denied + '/denied-document');
      if (record.path === '/signal') return response.writeHead(204).end();
      if (record.path === '/frame-host') return html(`<!doctype html><title>Cross-site child</title><p>Cross-site child ready</p><button id="redirect">Redirect child</button>
<script>document.querySelector('#redirect').onclick=async()=>{await fetch('/signal');location.href='/redirect-one'}</script>`);
      if (record.path === '/controls') return html(`<!doctype html><title>Navigation controls</title><p>Controls ready</p>
<button id="iframe">Load redirected iframe</button><button id="popup">Open redirected popup</button>
<button id="script">Script navigation</button><button id="meta">Meta navigation</button><button id="cross">Load cross-site iframe</button>
<script>
const signal=()=>fetch('/signal');
document.querySelector('#iframe').onclick=async()=>{await signal();const frame=document.createElement('iframe');frame.title='Redirected child';frame.src='/redirect-one';document.body.append(frame)};
document.querySelector('#popup').onclick=()=>{signal();window.open('/redirect-one','_blank')};
document.querySelector('#script').onclick=async()=>{await signal();location.href=${JSON.stringify(denied + '/script-document')}};
document.querySelector('#meta').onclick=async()=>{await signal();const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url='+${JSON.stringify(denied + '/meta-document')};document.head.append(meta)};
document.querySelector('#cross').onclick=async()=>{await signal();const frame=document.createElement('iframe');frame.title='Cross-site child';frame.src=${JSON.stringify(crossSite + '/frame-host')};document.body.append(frame)};
</script>`);
      if (record.path === '/resources') return html(`<!doctype html><title>Non-document resources</title><p id="status">Loading resources</p>
<script>
const image=new Image();const loaded=new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject});image.src=${JSON.stringify(denied + '/image')};document.body.append(image);
Promise.all([loaded,fetch(${JSON.stringify(denied + '/data')}).then(response=>response.text()).then(text=>{if(text!=='Remote fetch received')throw Error('Wrong fixture response')})]).then(()=>document.querySelector('#status').textContent='Resource requests complete',()=>document.querySelector('#status').textContent='Resource requests failed');
</script>`);
      return html('<title>Allowed document</title><p>Allowed document ready</p>');
    } catch (error) {
      if (!request.aborted && error?.code !== 'ECONNRESET') handlerErrors.push(error);
      response.destroy();
    }
  };
  const allowedServer = createServer(handler('allowed')), deniedServer = createServer(handler('denied'));
  const servers = [allowedServer, deniedServer];
  t.after(async () => {
    for (const response of waitingResponses) response.destroy();
    const cleanup = await Promise.allSettled(engines.map(engine => engine.dispose()));
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    assert.deepEqual(handlerErrors, [], 'The owned HTTP fixture must complete its requests normally');
    const failures = cleanup.filter(result => result.status === 'rejected');
    assert.equal(failures.length, 0, `Browser cleanup failures: ${failures.map(result => result.reason?.code ?? 'unknown').join(', ')}`);
  });
  await Promise.all(servers.map(server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); })));
  allowed = `http://127.0.0.1:${allowedServer.address().port}`;
  denied = `http://127.0.0.1:${deniedServer.address().port}`;
  crossSite = `http://localhost:${allowedServer.address().port}`;
  return {
    allowed, denied, crossSite, requests,
    releaseWaiting() { for (const response of waitingResponses) response.writeHead(200).end('continue'); },
    count: (side, pathname) => requests.filter(record => record.side === side && (!pathname || record.path === pathname)).length,
    engine(options = {}) {
      const engine = new BrowserEngine({ channel, timeoutMs: 3000, navigationPolicy: { allowedOrigins: [allowed] }, ...options });
      engines.push(engine);
      return engine;
    },
  };
}

const ref = (snapshot, name) => { const element = snapshot.elements.find(item => item.name === name); assert.ok(element, `Missing fixture control ${name}`); return element.ref; };
async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
async function blockedSnapshot(engine, sessionId) {
  return until(async () => {
    try {
      const snapshot = await engine.snapshot(sessionId);
      return snapshot.navigation_policy?.enabled === true && snapshot.navigation_policy.blocked_requests >= 1 ? snapshot : false;
    } catch { return false; } // A document may be changing into Chrome's blocked-navigation page.
  }, 'the public snapshot to report an intercepted document request');
}
async function trigger(engine, snapshot, name) {
  // One input only. Navigation can invalidate the action's concluding snapshot;
  // server signals and the policy counter independently prove the attempted effect.
  try { return await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: ref(snapshot, name) }]); }
  catch { return undefined; }
}
async function assertDeniedHasNoRequests(f) {
  await delay(150); // Include the immediate browser/network completion after the interception acknowledgement.
  assert.equal(f.count('denied'), 0, 'The denied server must receive no request, including redirected document hops');
}
async function submit(engine, snapshot) {
  const result = await engine.act(snapshot.session_id, snapshot.snapshot_id, [
    { type: 'fill', ref: ref(snapshot, 'Name'), value: 'Ada & Bob' },
    { type: 'fill', ref: ref(snapshot, 'Memo'), value: 'keep + equals=' },
    { type: 'click', ref: ref(snapshot, 'Save record') },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Saved Ada & Bob / keep + equals=' }])).passed, true);
}

test('allowed native form submission preserves one POST with the actual encoded business values', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  const initial = await engine.open(f.allowed + '/form');
  await submit(engine, initial);
  const writes = f.requests.filter(record => record.path === '/submit');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[0].body, 'name=Ada+%26+Bob&memo=keep+%2B+equals%3D');
  assert.match(writes[0].contentType, /^application\/x-www-form-urlencoded/);
  assert.deepEqual((await engine.snapshot(initial.session_id)).navigation_policy, { enabled: true, blocked_requests: 0 });
  assert.equal(f.count('denied'), 0);
});

test('allowed 307 redirect preserves the original POST method and body without duplicate dispatch', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  const initial = await engine.open(f.allowed + '/post-form');
  await submit(engine, initial);
  const first = f.requests.filter(record => record.path === '/post-307');
  const final = f.requests.filter(record => record.path === '/post-final');
  assert.equal(first.length, 1); assert.equal(final.length, 1);
  assert.equal(first[0].method, 'POST'); assert.equal(final[0].method, 'POST');
  assert.equal(first[0].body, 'name=Ada+%26+Bob&memo=keep+%2B+equals%3D');
  assert.equal(final[0].body, first[0].body);
  assert.equal(final[0].contentType, first[0].contentType);
});

test('same-origin 302 processes Set-Cookie and a matching workspace restores that cookie and policy', { timeout: 45000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  const initial = await engine.open(f.allowed + '/cookie-start');
  assert.match(initial.text, /Cookie received/);
  assert.equal(f.count('allowed', '/cookie-start'), 1);
  const landing = f.requests.filter(record => record.path === '/cookie-final');
  assert.equal(landing.length, 1); assert.match(landing[0].cookie, /navigation_cookie=preserved/);
  const workspace = JSON.parse(JSON.stringify(await engine.exportWorkspace()));
  assert.equal(workspace.navigationPolicyHash, compileNavigationPolicy({ allowedOrigins: [f.allowed] }).hash);
  assert.equal(workspace.sessions[0].storage.cookies.find(cookie => cookie.name === 'navigation_cookie')?.value, 'preserved');
  await engine.dispose();
  const restored = f.engine({ navigationPolicy: { allowedOrigins: [f.allowed + '/', f.allowed], blockedOrigins: [] } });
  const result = await restored.restoreWorkspace(workspace);
  assert.notEqual(result.sessionMap[initial.session_id], initial.session_id);
  assert.match(result.snapshots[0].text, /Cookie received/);
  assert.equal(f.count('allowed', '/cookie-final'), 2);
  assert.match(f.requests.filter(record => record.path === '/cookie-final')[1].cookie, /navigation_cookie=preserved/);
  assert.equal((await restored.exportWorkspace()).navigationPolicyHash, workspace.navigationPolicyHash);
});

test('explicit open/goto/new-tab deny the other port before a request or a new tab exists', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  assert.equal(new URL(f.allowed).hostname, new URL(f.denied).hostname);
  assert.notEqual(new URL(f.allowed).port, new URL(f.denied).port);
  const invalidExecutable = f.engine({ executablePath: `/private/tmp/tablaze-no-browser-${randomUUID()}` });
  await assert.rejects(invalidExecutable.open(f.denied + '/prelaunch'), { code: 'NAVIGATION_BLOCKED' });
  const initial = await engine.open(f.allowed + '/plain');
  await assert.rejects(engine.open(f.denied + '/open'), { code: 'NAVIGATION_BLOCKED' });
  await assert.rejects(engine.navigate(initial.session_id, { action: 'goto', url: f.denied + '/goto' }), { code: 'NAVIGATION_BLOCKED' });
  await assert.rejects(engine.tabs(initial.session_id, { action: 'new', url: f.denied + '/new' }), { code: 'NAVIGATION_BLOCKED' });
  assert.equal(engine.list().length, 1);
  assert.equal((await engine.tabs(initial.session_id, { action: 'list' })).tabs.length, 1);
  assert.equal((await engine.snapshot(initial.session_id)).url, initial.url);
  const blacklisted = f.engine({ executablePath: `/private/tmp/tablaze-no-browser-${randomUUID()}`, navigationPolicy: { allowedOrigins: [f.allowed, f.denied], blockedOrigins: [f.denied] } });
  await assert.rejects(blacklisted.open(f.denied + '/blocked-precedence'), { code: 'NAVIGATION_BLOCKED' });
  await assertDeniedHasNoRequests(f);
});

test('multi-hop HTTP 302 is intercepted before the denied hop during open, goto and new-tab', { timeout: 45000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  await assert.rejects(engine.open(f.allowed + '/redirect-one'));
  assert.equal(engine.list().length, 0);
  const initial = await engine.open(f.allowed + '/plain');
  await assert.rejects(engine.navigate(initial.session_id, { action: 'goto', url: f.allowed + '/redirect-one' }));
  await assert.rejects(engine.tabs(initial.session_id, { action: 'new', url: f.allowed + '/redirect-one' }));
  assert.equal(f.count('allowed', '/redirect-one'), 3);
  assert.equal(f.count('allowed', '/redirect-two'), 3);
  await assertDeniedHasNoRequests(f);
});

test('iframe redirect is blocked before its denied server receives a request and counts remain per context', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  const initial = await engine.open(f.allowed + '/controls');
  await trigger(engine, initial, 'Load redirected iframe');
  await until(() => f.count('allowed', '/signal') === 1, 'the fixture iframe trigger');
  await blockedSnapshot(engine, initial.session_id);
  assert.equal(f.count('allowed', '/redirect-one'), 1);
  assert.equal(f.count('allowed', '/redirect-two'), 1);
  const freshContext = await engine.open(f.allowed + '/plain');
  assert.deepEqual(freshContext.navigation_policy, { enabled: true, blocked_requests: 0 });
  assert.ok((await engine.snapshot(initial.session_id)).navigation_policy.blocked_requests >= 1);
  await assertDeniedHasNoRequests(f);
});

test('one context blocking a document does not interrupt a different context pending business action', { timeout: 45000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  const blocked = await engine.open(f.allowed + '/controls');
  const writing = await engine.open(f.allowed + '/coordinated-form');
  await until(() => f.count('allowed', '/wait-release') === 1, 'the independent form waiting at its server-controlled gate');
  const pending = engine.act(writing.session_id, writing.snapshot_id, [
    { type: 'wait', text: 'Continue form', timeoutMs: 10000 },
    { type: 'fill', ref: ref(writing, 'Name'), value: 'Ada & Bob' },
    { type: 'fill', ref: ref(writing, 'Memo'), value: 'keep + equals=' },
    { type: 'click', ref: ref(writing, 'Save record') },
  ]).then(result => ({ result }), error => ({ error }));
  await trigger(engine, blocked, 'Load redirected iframe');
  await blockedSnapshot(engine, blocked.session_id);
  f.releaseWaiting();
  const settled = await pending;
  assert.equal(settled.error, undefined);
  assert.equal(settled.result.ok, true, JSON.stringify(settled.result));
  assert.equal(settled.result.completed, 4);
  assert.equal(f.count('allowed', '/submit'), 1);
  assert.equal(f.requests.find(record => record.path === '/submit').body, 'name=Ada+%26+Bob&memo=keep+%2B+equals%3D');
  assert.equal((await engine.verify(writing.session_id, [{ kind: 'text', contains: 'Saved Ada & Bob / keep + equals=' }])).passed, true);
  assert.deepEqual((await engine.snapshot(writing.session_id)).navigation_policy, { enabled: true, blocked_requests: 0 });
  await assertDeniedHasNoRequests(f);
});

test('a new popup first-document redirect is blocked even before an ordinary popup snapshot exists', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine({ popupPolicy: 'stay' });
  const initial = await engine.open(f.allowed + '/controls');
  await trigger(engine, initial, 'Open redirected popup');
  await until(() => f.count('allowed', '/signal') === 1, 'the fixture popup trigger');
  await blockedSnapshot(engine, initial.session_id);
  assert.equal(f.count('allowed', '/redirect-one'), 1);
  assert.equal(f.count('allowed', '/redirect-two'), 1);
  assert.equal((await engine.tabs(initial.session_id, { action: 'list' })).tabs.find(tab => tab.active).tab_id, initial.tab_id);
  await assertDeniedHasNoRequests(f);
});

test('page script and meta refresh cannot issue an HTTP document request to a denied origin', { timeout: 45000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  for (const [index, name] of ['Script navigation', 'Meta navigation'].entries()) {
    const initial = await engine.open(f.allowed + '/controls');
    await trigger(engine, initial, name);
    await until(() => f.count('allowed', '/signal') === index + 1, `the fixture ${name} trigger`);
    await blockedSnapshot(engine, initial.session_id);
  }
  await assertDeniedHasNoRequests(f);
});

test('an allowed localhost child of the 127.0.0.1 page retains interception through its cross-site redirect', { timeout: 45000 }, async t => {
  const f = await fixture(t), engine = f.engine({ navigationPolicy: { allowedOrigins: [f.allowed, f.crossSite] } });
  const initial = await engine.open(f.allowed + '/controls');
  await trigger(engine, initial, 'Load cross-site iframe');
  const parent = await until(async () => {
    const snapshot = await engine.snapshot(initial.session_id);
    return snapshot.frames.some(frame => frame.url === f.crossSite + '/frame-host') ? snapshot : false;
  }, 'the allowed cross-site frame to load');
  const childInfo = parent.frames.find(frame => frame.url === f.crossSite + '/frame-host');
  const child = await engine.snapshot(initial.session_id, { frameId: childInfo.frame_id });
  assert.match(child.text, /Cross-site child ready/);
  await trigger(engine, child, 'Redirect child');
  await until(() => f.count('allowed', '/signal') === 2, 'the cross-site child redirect input');
  await blockedSnapshot(engine, initial.session_id);
  assert.equal(f.count('allowed', '/frame-host'), 1);
  assert.equal(f.count('allowed', '/redirect-one'), 1);
  assert.equal(f.count('allowed', '/redirect-two'), 1);
  await assertDeniedHasNoRequests(f);
});

test('non-document fetch and image requests reach the other origin: navigation policy is not a network firewall', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine();
  const initial = await engine.open(f.allowed + '/resources');
  assert.equal((await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Resource requests complete' }], 3000)).passed, true);
  assert.equal(f.count('denied', '/data'), 1);
  assert.equal(f.count('denied', '/image'), 1);
  assert.equal(f.requests.filter(record => record.side === 'denied' && ['document', 'iframe'].includes(record.destination)).length, 0);
  assert.deepEqual((await engine.snapshot(initial.session_id)).navigation_policy, { enabled: true, blocked_requests: 0 });
});

test('workspace policy changes, missing hashes, policy removal and newly added policy reject before browser launch', async t => {
  const f = await fixture(t);
  const policy = { allowedOrigins: [f.allowed] };
  const saved = { version: 1, navigationPolicyHash: compileNavigationPolicy(policy).hash, sessions: [{ sessionId: 'saved-session', activeTabId: 't1', storage: { cookies: [], origins: [] }, tabs: [{ tabId: 't1', url: f.allowed + '/plain' }] }] };
  const { navigationPolicyHash, ...legacy } = saved;
  const cases = [
    [{ allowedOrigins: [f.denied] }, saved],
    [policy, legacy],
    [undefined, saved],
    [{}, legacy],
    [policy, { ...saved, navigationPolicyHash: 'malformed-hash' }],
  ];
  for (const [navigationPolicy, workspace] of cases) {
    const engine = f.engine({ navigationPolicy, executablePath: `/private/tmp/tablaze-no-browser-${randomUUID()}` });
    await assert.rejects(engine.restoreWorkspace(workspace), { code: 'NAVIGATION_POLICY_MISMATCH' });
    assert.deepEqual(engine.list(), []);
  }
  const matchingWithDeniedTab = f.engine({ navigationPolicy: policy, executablePath: `/private/tmp/tablaze-no-browser-${randomUUID()}` });
  await assert.rejects(matchingWithDeniedTab.restoreWorkspace({ ...saved, sessions: [{ ...saved.sessions[0], tabs: [{ tabId: 't1', url: f.denied + '/saved' }] }] }), { code: 'NAVIGATION_BLOCKED' });
  assert.deepEqual(f.requests, [], 'All workspace preflight failures must precede launch and HTTP traffic');
});

test('CDP with configured navigation policy is rejected by the constructor without a connection attempt', async t => {
  const f = await fixture(t);
  for (const navigationPolicy of [{}, { allowedOrigins: [f.allowed] }, { allowedOrigins: [] }]) {
    assert.throws(() => new BrowserEngine({ cdpUrl: f.denied + '/cdp', navigationPolicy }), { code: 'NAVIGATION_POLICY_CDP_UNSUPPORTED' });
  }
  await delay(50);
  assert.deepEqual(f.requests, []);
});

test('absent navigation policy retains ordinary browsing and does not attach a policy hash or diagnostics', { timeout: 30000 }, async t => {
  const f = await fixture(t), engine = f.engine({ navigationPolicy: undefined });
  const snapshot = await engine.open(f.denied + '/plain');
  assert.match(snapshot.text, /Denied server document received/);
  assert.equal(snapshot.navigation_policy, undefined);
  assert.equal((await engine.exportWorkspace()).navigationPolicyHash, undefined);
  assert.equal(f.count('denied', '/plain'), 1);
});
