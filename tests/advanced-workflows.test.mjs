import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserEngine } from '../dist/browser.js';

let server, base, directory;
const artifactDirectories = new Set();
const options = { channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 2500 };
function ref(snapshot, name) {
  const item = snapshot.elements.find(item => item.name === name);
  assert.ok(item, `Missing ${name}: ${JSON.stringify(snapshot.elements)}`);
  return item.ref;
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tablaze-advanced-'));
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url?.startsWith('/storage')) {
      res.end(`<!doctype html><title>Durable storage</title><button id="save">Save durable state</button>
        <p id="status">Loading storage</p><input aria-label="Ephemeral input"><script>
        const request = indexedDB.open('fixture-db',1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => {
          const db = request.result;
          const query = db.transaction('records').objectStore('records').get('marker');
          query.onsuccess = () => {document.querySelector('#status').textContent =
            [localStorage.getItem('marker') || 'no local',document.cookie || 'no cookie',query.result || 'no idb', sessionStorage.getItem('temporary') || 'no session'].join(' | ');};
          document.querySelector('#save').onclick = () => {
            localStorage.setItem('marker','local survives');document.cookie='marker=cookie-survives;path=/';sessionStorage.setItem('temporary','session should disappear');
            const transaction = db.transaction('records','readwrite');transaction.objectStore('records').put('idb survives','marker');
            transaction.oncomplete = () => {document.querySelector('#status').textContent='Durable state saved';};
          };
        };</script>`);
      return;
    }
    res.end(`<!doctype html><title>Advanced controls</title>
      <div aria-label="Scrollable panel" style="width:220px;height:100px;overflow:auto"><div style="width:900px;height:700px">Panel content</div></div>
      <button draggable="true" id="source" style="margin-top:20px">Drag source</button>
      <button id="destination" style="margin-left:200px;width:150px;height:80px">Drop target</button>
      <input type="file" id="hidden-file" hidden><button id="choose">Choose hidden file</button>
      <p id="result">Idle</p><script>
      document.querySelector('#choose').onclick = () => document.querySelector('#hidden-file').click();
      document.querySelector('#hidden-file').onchange = async event => {document.querySelector('#result').textContent = await event.target.files[0].text();};
      document.querySelector('#source').ondragstart = event => event.dataTransfer.setData('text/plain','actual payload');
      document.querySelector('#destination').ondragover = event => event.preventDefault();
      document.querySelector('#destination').ondrop = event => {event.preventDefault(); document.querySelector('#result').textContent='Dropped '+event.dataTransfer.getData('text/plain');};
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  for (const path of artifactDirectories) await rm(path, { recursive: true, force: true });
});
async function open(t, url = base) {
  const engine = new BrowserEngine(options);
  t.after(() => engine.dispose());
  return { engine, snapshot: await engine.open(url) };
}

test('scrollable containers expose ranges and accept guarded horizontal and vertical input', async t => {
  const { engine, snapshot } = await open(t);
  const panel = snapshot.elements.find(item => item.name === 'Scrollable panel');
  assert.equal(panel.scrollable.x, true);
  assert.equal(panel.scrollable.y, true);
  const acted = await engine.act(snapshot.session_id, snapshot.snapshot_id, [
    { type: 'scroll', ref: panel.ref, direction: 'right', pixels: 130 },
    { type: 'scroll', ref: panel.ref, direction: 'down', pixels: 220 },
  ]);
  assert.equal(acted.ok, true, JSON.stringify(acted));
  const after = acted.snapshot.elements.find(item => item.name === 'Scrollable panel');
  assert.equal(after.scrollable.left, 130);
  assert.equal(after.scrollable.top, 220);
  const up = await engine.act(snapshot.session_id, acted.snapshot.snapshot_id, [{ type: 'scroll', ref: after.ref, direction: 'up', pixels: 100 }]);
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.snapshot.elements.find(item => item.name === 'Scrollable panel').scrollable.top, 120);
});

test('dragging emits the browser drop event and delivers the real data payload', async t => {
  const { engine, snapshot } = await open(t);
  const dragged = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'drag', ref: ref(snapshot, 'Drag source'), targetRef: ref(snapshot, 'Drop target') }]);
  assert.equal(dragged.ok, true, JSON.stringify(dragged));
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Dropped actual payload' }])).passed, true);
});

test('hidden file chooser transfers explicit local bytes without a hidden DOM reference', async t => {
  const { engine, snapshot } = await open(t);
  const file = join(directory, 'chooser.txt');
  await writeFile(file, 'Bytes delivered through native chooser');
  const uploaded = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'upload_chooser', ref: ref(snapshot, 'Choose hidden file'), files: [file] }]);
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Bytes delivered through native chooser' }])).passed, true);
});

test('PDF exports real private artifacts with verifiable digest and source', async t => {
  const { engine, snapshot } = await open(t);
  const pdf = await engine.pdf(snapshot.session_id, { format: 'Letter', landscape: true });
  artifactDirectories.add(dirname(pdf.path));
  const bytes = await readFile(pdf.path);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(bytes.length, pdf.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pdf.sha256);
  assert.equal(pdf.url, base + '/');
  assert.equal(pdf.tab_id, snapshot.tab_id);
  assert.equal((await stat(pdf.path)).mode & 0o777, 0o600);
  await engine.close(snapshot.session_id);
  assert.deepEqual(await readFile(pdf.path), bytes);
});

test('workspace roundtrip restores isolated durable storage, owned tabs, and active selection', async t => {
  const { engine, snapshot } = await open(t, base + '/storage');
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'no idb' }])).passed, true);
  const saved = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click', ref: ref(snapshot, 'Save durable state') }]);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Durable state saved' }])).passed, true);
  const second = await engine.tabs(snapshot.session_id, { action: 'new', url: base + '/storage?second' });
  const isolated = await engine.open(base + '/storage?isolated');
  const workspace = JSON.parse(JSON.stringify(await engine.exportWorkspace()));
  await engine.dispose();
  const restored = new BrowserEngine(options);
  t.after(() => restored.dispose());
  const result = await restored.restoreWorkspace(workspace);
  assert.notEqual(result.sessionMap[snapshot.session_id], snapshot.session_id);
  assert.equal(Object.keys(result.sessionMap).length, 2);
  const id = result.sessionMap[snapshot.session_id];
  const tabs = await restored.tabs(id, { action: 'list' });
  assert.equal(tabs.tabs.length, 2);
  assert.equal(tabs.tabs.find(tab => tab.active).url, second.url);
  assert.equal((await restored.verify(id, [{ kind: 'text', contains: 'local survives | marker=cookie-survives | idb survives | no session' }])).passed, true);
  assert.equal((await restored.verify(result.sessionMap[isolated.session_id], [{ kind: 'text', contains: 'no local | no cookie | no idb | no session' }])).passed, true);
  const stale = await restored.act(id, snapshot.snapshot_id, [{ type: 'click', ref: ref(snapshot, 'Save durable state') }]);
  assert.equal(stale.ok, false);
  assert.equal(stale.failed.error.code, 'STALE_SNAPSHOT');
});

test('workspace validation precedes navigation and failed restore rolls back owned sessions', async t => {
  const engine = new BrowserEngine(options);
  t.after(() => engine.dispose());
  const valid = { sessionId: 'old', activeTabId: 't1', storage: { cookies: [], origins: [] }, tabs: [{ tabId: 't1', url: base }] };
  await assert.rejects(engine.restoreWorkspace({ version: 1, sessions: [valid, { ...valid, sessionId: 'bad', tabs: [{ tabId: 't1', url: 'file:///etc/passwd' }] }] }), error => error.code === 'INVALID_URL');
  assert.deepEqual(engine.list(), []);
  await assert.rejects(engine.restoreWorkspace({ version: 1, sessions: [valid, { ...valid, sessionId: 'network-failure', tabs: [{ tabId: 't1', url: 'http://127.0.0.1:1/' }] }] }));
  assert.deepEqual(engine.list(), []);
  const restored = await engine.restoreWorkspace({ version: 1, sessions: [valid] });
  assert.equal(restored.snapshots.length, 1, 'engine remains usable after rollback');
  await assert.rejects(engine.restoreWorkspace({ version: 1, sessions: [] }), error => error.code === 'INVALID_ARGUMENT');
});
