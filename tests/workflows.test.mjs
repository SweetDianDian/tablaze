import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserEngine } from '../dist/browser.js';

let server, base, engine, uploadDirectory;
const artifactDirectories = new Set();
const options = { channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 2000 };
const ref = (snapshot, name) => {
  const element = snapshot.elements.find(item => item.name === name);
  assert.ok(element, `Missing ${name}`);
  return element.ref;
};
before(async () => {
  uploadDirectory = await mkdtemp(join(tmpdir(), 'tablaze-upload-test-'));
  server = createServer((req, res) => {
    if (req.url === '/report') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
      res.end('city,nights\nLisbon,3\n'); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/canvas') {
      res.end('<!doctype html><title>Canvas fixture</title><canvas style="position:absolute;left:80px;top:80px;width:200px;height:100px;background:navy" width="200" height="100" onclick="document.querySelector(\'#result\').textContent=\'Canvas activated\'"></canvas><p id="result">Canvas idle</p>'); return;
    }
    if (req.url === '/child') {
      res.end('<!doctype html><title>Child page</title><p>Popup ready</p><button>Child action</button>'); return;
    }
    if (req.url === '/second') {
      res.end('<!doctype html><title>Second page</title><p>Second destination</p>'); return;
    }
    res.end(`<!doctype html><title>Workflow fixture</title>
      <a href="/child" target="_blank">Open child</a>
      <a href="/report" download>Download report</a>
      <label>Upload document <input id="upload" type="file" multiple></label>
      <button id="confirm">Confirm action</button><button id="prompt">Prompt action</button>
      <button id="hover">Hover action</button><button id="double">Double action</button>
      <button id="remember">Remember</button><p id="result">Idle</p><p id="remembered"></p>
      <script>
      const result = document.querySelector('#result');
      document.querySelector('#upload').onchange = async event => {result.textContent = await event.target.files[0].text();};
      document.querySelector('#confirm').onclick = () => {result.textContent = confirm('Proceed?') ? 'Confirmed' : 'Dismissed';};
      document.querySelector('#prompt').onclick = () => {result.textContent = 'Answer ' + prompt('Your answer');};
      document.querySelector('#hover').onmouseenter = () => {result.textContent = 'Hovered';};
      document.querySelector('#double').ondblclick = () => {result.textContent = 'Double clicked';};
      document.querySelector('#remember').onclick = () => {localStorage.setItem('saved-marker','Remembered across restart');document.cookie='test_cookie=preserved;path=/';};
      document.querySelector('#remembered').textContent = localStorage.getItem('saved-marker') || 'Fresh state';
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  engine = new BrowserEngine(options);
});
after(async () => {
  await engine?.dispose();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  await rm(uploadDirectory, { recursive: true, force: true });
  for (const directory of artifactDirectories) await rm(directory, { recursive: true, force: true });
});
async function open(t) {
  const snapshot = await engine.open(base);
  t.after(async () => { if (engine.list().some(s => s.session_id === snapshot.session_id)) await engine.close(snapshot.session_id); });
  return snapshot;
}

test('popup tabs stay owned, switching invalidates references and last close ends session', async t => {
  const first = await open(t);
  const clicked = await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Open child') }]);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  const list = await engine.tabs(first.session_id, { action: 'list' });
  assert.equal(list.tabs.length, 2);
  const child = list.tabs.find(tab => !tab.active);
  const switched = await engine.tabs(first.session_id, { action: 'switch', tabId: child.tab_id });
  assert.equal(switched.title, 'Child page');
  const stale = await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Remember') }]);
  assert.equal(stale.failed.error.code, 'STALE_SNAPSHOT');
  await engine.tabs(first.session_id, { action: 'close', tabId: first.tab_id });
  assert.equal((await engine.tabs(first.session_id, { action: 'list' })).tabs.length, 1);
  const closed = await engine.tabs(first.session_id, { action: 'close', tabId: child.tab_id });
  assert.equal(closed.closed, true);
  assert.ok(!engine.list().some(session => session.session_id === first.session_id));
});

test('navigation and explicit tabs preserve session state and handle browser history', async t => {
  const first = await open(t);
  await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Remember') }]);
  const second = await engine.navigate(first.session_id, { action: 'goto', url: base + '/second' });
  assert.equal(second.title, 'Second page');
  const back = await engine.navigate(first.session_id, { action: 'back' });
  assert.match(back.text, /Remembered across restart/);
  assert.equal((await engine.navigate(first.session_id, { action: 'forward' })).title, 'Second page');
  assert.equal((await engine.navigate(first.session_id, { action: 'reload' })).title, 'Second page');
  const newTab = await engine.tabs(first.session_id, { action: 'new', url: base });
  assert.match(newTab.text, /Remembered across restart/);
  assert.equal(newTab.tabs.length, 2);
});

test('upload reads an explicit local fixture and download produces the actual file', async t => {
  const first = await open(t);
  const file = join(uploadDirectory, 'sample.txt');
  await writeFile(file, 'Uploaded fixture content');
  const uploaded = await engine.act(first.session_id, first.snapshot_id, [{ type: 'upload', ref: ref(first, 'Upload document'), files: [file] }]);
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Uploaded fixture content' }])).passed, true);
  const observed = await engine.snapshot(first.session_id);
  const clicked = await engine.act(first.session_id, observed.snapshot_id, [{ type: 'click', ref: ref(observed, 'Download report') }]);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  const downloads = await engine.downloads(first.session_id);
  assert.equal(downloads.downloads.length, 1);
  const completed = (await engine.downloads(first.session_id, downloads.downloads[0].id)).downloads[0];
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  artifactDirectories.add(dirname(completed.path));
  assert.equal(completed.filename, 'report.csv');
  assert.equal(await readFile(completed.path, 'utf8'), 'city,nights\nLisbon,3\n');
  assert.equal((await stat(completed.path)).mode & 0o777, 0o600);
  await engine.close(first.session_id);
  assert.equal(await readFile(completed.path, 'utf8'), 'city,nights\nLisbon,3\n', 'artifact survives session close');
});

test('native confirm and prompt use one-shot policies and disclose actual results', async t => {
  let first = await open(t);
  await engine.dialog(first.session_id, { action: 'accept' });
  const confirmed = await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Confirm action') }]);
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.dialogs[0].action, 'accept');
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Confirmed' }])).passed, true);
  first = await engine.snapshot(first.session_id);
  await engine.dialog(first.session_id, { action: 'accept', promptText: 'fixture answer' });
  assert.equal((await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Prompt action') }])).ok, true);
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Answer fixture answer' }])).passed, true);
  first = await engine.snapshot(first.session_id);
  const unarmed = await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Confirm action') }]);
  assert.equal(unarmed.ok, false);
  assert.equal(unarmed.failed.error.code, 'UNSUPPORTED_FLOW');
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Dismissed' }])).passed, true);
});

test('storage state restores cookies and localStorage across independent engine lifetimes', async t => {
  const first = await open(t);
  await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Remember') }]);
  const saved = await engine.saveState(first.session_id);
  artifactDirectories.add(dirname(saved.storage_state));
  assert.equal((await stat(saved.storage_state)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(saved), /test_cookie|saved-marker/);
  await engine.close(first.session_id);
  const other = new BrowserEngine(options);
  try {
    const restored = await other.open(base, { storageState: saved.storage_state });
    assert.match(restored.text, /Remembered across restart/);
    const restoredState = await other.saveState(restored.session_id);
    artifactDirectories.add(dirname(restoredState.storage_state));
    const disk = JSON.parse(await readFile(restoredState.storage_state, 'utf8'));
    assert.ok(disk.cookies.some(cookie => cookie.name === 'test_cookie' && cookie.value === 'preserved'));
    const isolated = await other.open(base);
    assert.match(isolated.text, /Fresh state/);
  } finally { await other.dispose(); }
});

test('hover and double-click execute guarded references, coordinates reject offscreen input', async t => {
  let snapshot = await open(t);
  assert.equal((await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'hover', ref: ref(snapshot, 'Hover action') }])).ok, true);
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Hovered' }])).passed, true);
  snapshot = await engine.snapshot(snapshot.session_id);
  assert.equal((await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'double_click', ref: ref(snapshot, 'Double action') }])).ok, true);
  assert.equal((await engine.verify(snapshot.session_id, [{ kind: 'text', contains: 'Double clicked' }])).passed, true);
  snapshot = await engine.snapshot(snapshot.session_id);
  const bad = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'click_xy', x: 50000, y: 20 }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.failed.error.code, 'INVALID_ARGUMENT');
  assert.equal(bad.failed_action_may_have_side_effects, false);
});


test('CSS-pixel screenshots support actual canvas coordinate input', async t => {
  const first = await open(t);
  const snapshot = await engine.navigate(first.session_id, { action: 'goto', url: base + '/canvas' });
  const capture = await engine.screenshot(first.session_id);
  assert.equal(capture.coordinateSpace, 'viewport-css');
  assert.equal(capture.tabId, snapshot.tab_id);
  assert.equal(capture.viewport.width, 1280);
  assert.equal(capture.viewport.height, 800);
  assert.equal((await engine.act(first.session_id, snapshot.snapshot_id, [{ type: 'click_xy', x: 120, y: 120 }])).ok, true);
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Canvas activated' }])).passed, true);
});
