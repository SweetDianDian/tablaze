import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserEngine } from '../dist/browser.js';

let fixture, base;
const streams = new Set();
const html = nested => `<!doctype html><title>Popup policy fixture</title>
<button id="single">Open one</button><button id="multiple">Open two</button><button id="late">Open late</button>
<button id="blank">Open blank</button><button id="tail">Tail action</button><button id="background">Trigger background</button>
<p id="clicks">Clicks: 0</p><p id="tail-count">Tail: 0</p>${nested ? '' : '<iframe src="/frame"></iframe>'}
<script>
let clicks=0,tail=0; const count=()=>document.querySelector('#clicks').textContent='Clicks: '+(++clicks);
document.querySelector('#single').onclick=()=>{count();window.open('/popup','_blank')};
document.querySelector('#multiple').onclick=()=>{count();window.open('/popup?first','_blank');setTimeout(()=>window.open('/popup?second','_blank'),80)};
document.querySelector('#late').onclick=()=>{count();setTimeout(()=>window.open('/popup?late','_blank'),550)};
document.querySelector('#blank').onclick=()=>{count();const popup=window.open('about:blank','_blank');setTimeout(()=>popup.location='/popup?eventual',1000)};
document.querySelector('#tail').onclick=()=>document.querySelector('#tail-count').textContent='Tail: '+(++tail);
document.querySelector('#background').onclick=()=>fetch('/trigger-background');
</script>`;
before(async () => {
  fixture = createServer((request, response) => {
    if (request.url === '/fail-navigation') { response.destroy(); return; }
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': ready\n\n');
      streams.add(response); request.on('close', () => streams.delete(response)); return;
    }
    if (request.url === '/trigger-background') { for (const stream of streams) stream.write('data: open\n\n'); response.writeHead(204).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/background') response.end('<p>Background owned page</p><script>new EventSource("/events").onmessage=()=>window.open("/popup?background","_blank")</script>');
    else if (request.url.startsWith('/popup')) response.end('<title>Owned popup</title><p>Popup ready</p><button>Approve popup</button>');
    else response.end(html(request.url === '/frame'));
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${fixture.address().port}`;
});
after(async () => { for (const stream of streams) stream.end(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
const ref = (snapshot, name) => { const found = snapshot.elements.find(item => item.name === name); assert.ok(found, name); return found.ref; };
async function setup(t, popupPolicy) {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1000, popupPolicy });
  t.after(() => engine.dispose());
  return { engine, initial: await engine.open(base + '/') };
}
const click = (snapshot, name) => ({ type: 'click', ref: ref(snapshot, name) });

test('default stay keeps the opener active and completes remaining actions', async t => {
  const { engine, initial } = await setup(t);
  const result = await engine.act(initial.session_id, initial.snapshot_id, [click(initial, 'Open one'), click(initial, 'Tail action')]);
  assert.equal(result.ok, true); assert.equal(result.batch_complete, true);
  assert.equal(result.snapshot.tab_id, initial.tab_id);
  assert.equal(result.replan_required, undefined);
  assert.equal(result.completed, 2);
  assert.equal((await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Tail: 1' }])).passed, true);
});

test('follow-single returns popup observation and truthfully skips remaining old-ref actions', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  const result = await engine.act(initial.session_id, initial.snapshot_id, [click(initial, 'Open one'), click(initial, 'Tail action')], { snapshot: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.batch_complete, false); assert.equal(result.partial, true); assert.equal(result.replan_required, true);
  assert.equal(result.failed, null); assert.equal(result.completed, 1);
  assert.deepEqual(result.results.map(item => [item.status, item.reason]), [['completed', undefined], ['skipped', 'replan_required']]);
  assert.notEqual(result.snapshot.tab_id, initial.tab_id);
  assert.equal(result.snapshot.tab_id, result.popup_followed.tab_id);
  assert.equal(result.popup_followed.window_ms, 250);
  assert.match(result.snapshot.text, /Popup ready/);
  await engine.tabs(initial.session_id, { action: 'switch', tabId: initial.tab_id });
  assert.equal((await engine.verify(initial.session_id, [{ kind: 'text', contains: 'Clicks: 1' }, { kind: 'text', contains: 'Tail: 0' }])).passed, true);
});

test('multiple candidates are retained without choosing the first or stealing focus', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  const result = await engine.act(initial.session_id, initial.snapshot_id, [click(initial, 'Open two')]);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.batch_complete, true);
  assert.equal(result.replan_required, undefined); assert.equal(result.snapshot.tab_id, initial.tab_id);
  assert.equal(result.snapshot.tabs.length, 3);
});

test('a late popup is owned but never retroactively changes the active tab', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  const result = await engine.act(initial.session_id, initial.snapshot_id, [click(initial, 'Open late')]);
  assert.equal(result.replan_required, undefined); assert.equal(result.snapshot.tab_id, initial.tab_id);
  await delay(650);
  const tabs = await engine.tabs(initial.session_id, { action: 'list' });
  assert.equal(tabs.tabs.length, 2);
  assert.equal(tabs.tabs.find(tab => tab.active).tab_id, initial.tab_id);
});

test('a different owned background opener cannot enter the foreground action window', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  await engine.tabs(initial.session_id, { action: 'new', url: base + '/background' });
  const current = await engine.tabs(initial.session_id, { action: 'switch', tabId: initial.tab_id });
  for (let n = 0; !streams.size && n < 40; n++) await delay(25);
  assert.ok(streams.size);
  const result = await engine.act(current.session_id, current.snapshot_id, [click(current, 'Trigger background')]);
  assert.equal(result.replan_required, undefined); assert.equal(result.snapshot.tab_id, initial.tab_id);
  assert.equal(result.snapshot.tabs.length, 3, JSON.stringify(result.snapshot.tabs));
});

test('iframe-triggered unique popup is associated with the observed owning page', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  let current = initial;
  for (let n = 0; !current.frames.some(frame => frame.url === base + '/frame') && n < 40; n++) { await delay(25); current = await engine.snapshot(initial.session_id); }
  const frame = current.frames.find(frame => frame.url === base + '/frame'); assert.ok(frame);
  const nested = await engine.snapshot(initial.session_id, { frameId: frame.frame_id });
  const result = await engine.act(nested.session_id, nested.snapshot_id, [click(nested, 'Open one')]);
  assert.equal(result.replan_required, true); assert.equal(result.batch_complete, true);
  assert.equal(result.snapshot.frame_id, 'f0'); assert.match(result.snapshot.text, /Popup ready/);
});

test('about:blank popups return bounded observations without waiting for eventual navigation', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  const result = await engine.act(initial.session_id, initial.snapshot_id, [click(initial, 'Open blank')], { timeoutMs: 800 });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.replan_required, true);
  assert.equal(result.snapshot.url, 'about:blank'); assert.ok(result.elapsed_ms < 800);
});

test('popup collection consumes the existing batch deadline and never retries the input', async t => {
  const { engine, initial } = await setup(t, 'follow-single');
  const result = await engine.act(initial.session_id, initial.snapshot_id, [click(initial, 'Open one')], { timeoutMs: 100 });
  assert.equal(result.ok, false); assert.equal(result.session_closed, true); assert.equal(result.batch_complete, false);
  assert.equal(result.error.code, 'BATCH_TIMEOUT'); assert.equal(result.results.length, 1);
});

test('workspace preserves policy and old version-one records restore the stay default', async t => {
  const { engine } = await setup(t, 'follow-single');
  const workspace = await engine.exportWorkspace(); assert.equal(workspace.popupPolicy, 'follow-single');
  const restored = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined }); t.after(() => restored.dispose());
  const first = await restored.restoreWorkspace(workspace);
  const current = first.snapshots[0];
  assert.equal((await restored.act(current.session_id, current.snapshot_id, [click(current, 'Open one')])).replan_required, true);
  const legacy = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, popupPolicy: 'follow-single' }); t.after(() => legacy.dispose());
  const { popupPolicy, ...old } = workspace;
  const second = (await legacy.restoreWorkspace(old)).snapshots[0];
  const result = await legacy.act(second.session_id, second.snapshot_id, [click(second, 'Open one')]);
  assert.equal(result.replan_required, undefined); assert.equal(result.snapshot.tab_id, second.tab_id);
  assert.equal((await legacy.exportWorkspace()).popupPolicy, 'stay');
});

test('failed workspace restoration rolls back policy as well as newly owned sessions', async t => {
  const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, popupPolicy: 'stay' });
  t.after(() => engine.dispose());
  await assert.rejects(engine.restoreWorkspace({ version: 1, popupPolicy: 'follow-single', sessions: [
    { sessionId: 'saved', activeTabId: 't1', storage: { cookies: [], origins: [] }, tabs: [{ tabId: 't1', url: base + '/fail-navigation' }] },
  ] }));
  assert.deepEqual(engine.list(), []);
  assert.equal((await engine.exportWorkspace()).popupPolicy, 'stay');
});
