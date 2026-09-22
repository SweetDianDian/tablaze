import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-advanced-races-'));
  const engines = [];
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${request.url === '/sibling' ? 'Sibling' : 'Observed'} fixture</title>
      <button id="source" draggable="true" style="position:absolute;left:100px;top:100px;width:120px;height:80px">Drag source</button>
      <button id="destination" style="position:absolute;left:400px;top:100px;width:120px;height:80px">Drop target</button>
      <button id="chooser" style="position:absolute;left:100px;top:250px" onclick="document.querySelector('#file').click()">Choose file</button>
      <input type="file" id="file" style="display:none">
      <div id="panel" aria-label="Scrollable panel" style="position:absolute;left:650px;top:100px;width:150px;height:150px;overflow:auto"><div style="width:600px;height:600px">Panel contents</div></div>
      <script>
        window.unintendedInputs=0;
        window.uploaded='';
        document.querySelector('#source').ondragstart=e=>e.dataTransfer.setData('text/plain','source');
        document.querySelector('#destination').ondragover=e=>e.preventDefault();
        document.querySelector('#file').onchange=async e=>window.uploaded=await e.target.files[0].text();
      </script>`);
  });
  t.after(async () => {
    const artifacts = await Promise.all(engines.map(engine => engine.artifactDirectory?.catch(() => undefined)));
    await Promise.allSettled(engines.map(engine => engine.dispose()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.all([directory, ...artifacts.filter(Boolean)].map(path => rm(path, { recursive: true, force: true })));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const createEngine = () => {
    // Every engine owns its own freshly launched browser and isolated context.
    // These tests never attach to the user's browser or existing profile.
    const engine = new BrowserEngine({ channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 3000 });
    engines.push(engine);
    return engine;
  };
  return { url, directory, createEngine };
}

function ref(snapshot, name) {
  const found = snapshot.elements.find(element => element.name === name);
  assert.ok(found, `Missing observed element: ${name}`);
  return found.ref;
}

test('workspace export keeps active selection consistent when the active tab closes during storage capture', { timeout: 30000 }, async t => {
  const { url, createEngine } = await fixture(t);
  const engine = createEngine();
  const sibling = await engine.open(`${url}/sibling`);
  const observed = await engine.tabs(sibling.session_id, { action: 'new', url });
  const session = engine.sessions.get(sibling.session_id);
  const observedPage = session.page;
  const originalStorageState = session.context.storageState.bind(session.context);
  let boundaryReached = false;
  // Pause precisely at the storage await by closing the actual observed tab
  // after obtaining real browser storage, before returning that result.
  session.context.storageState = async (...args) => {
    const storage = await originalStorageState(...args);
    if (!boundaryReached) { boundaryReached = true; await observedPage.close(); }
    return storage;
  };
  const workspace = await engine.exportWorkspace();
  assert.equal(boundaryReached, true);
  assert.equal(workspace.sessions.length, 1);
  const saved = workspace.sessions[0];
  assert.equal(saved.tabs.some(tab => tab.tabId === saved.activeTabId), true, 'Export must not name the already closed active tab');
  assert.equal(saved.activeTabId, sibling.tab_id);
  assert.equal(saved.tabs.some(tab => tab.tabId === observed.tab_id), false);
  const restored = await createEngine().restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.snapshots.length, 1);
  assert.equal(restored.snapshots[0].url, `${url}/sibling`);
});

test('PDF metadata stays bound to its captured tab through asynchronous artifact persistence', { timeout: 30000 }, async t => {
  const { url, createEngine } = await fixture(t);
  const engine = createEngine();
  const sibling = await engine.open(`${url}/sibling`);
  const observed = await engine.tabs(sibling.session_id, { action: 'new', url });
  const session = engine.sessions.get(sibling.session_id);
  const observedPage = session.page;
  const originalArtifacts = engine.artifacts.bind(engine);
  let boundaryReached = false;
  // PDF generation remains real. Close its tab at the awaited artifact-directory
  // boundary, which occurs after page.pdf and the first consistency check.
  engine.artifacts = async () => {
    const path = await originalArtifacts();
    if (!boundaryReached) { boundaryReached = true; await observedPage.close(); }
    return path;
  };
  const outcome = await engine.pdf(observed.session_id).then(value => ({ value }), error => ({ error }));
  assert.equal(boundaryReached, true);
  assert.equal(session.activeTabId, sibling.tab_id);
  if (outcome.error) {
    assert.equal(outcome.error.code, 'CAPTURE_CHANGED');
  } else {
    // Either reject a changed capture, or report immutable original metadata.
    // A successful export must never attribute old bytes to the surviving tab.
    assert.equal(outcome.value.tab_id, observed.tab_id, 'PDF bytes must not be attributed to the sibling tab');
    assert.equal(outcome.value.url, `${url}/`);
    assert.equal((await readFile(outcome.value.path)).subarray(0, 5).toString(), '%PDF-');
  }
});

test('drag revalidates observed targets after asynchronous geometry reads before mouse input', { timeout: 30000 }, async t => {
  const { url, createEngine } = await fixture(t);
  const engine = createEngine();
  const snapshot = await engine.open(url);
  const session = engine.sessions.get(snapshot.session_id);
  const page = session.page;
  const sourceRef = ref(snapshot, 'Drag source');
  const source = session.snapshot.refs.get(sourceRef).handle;
  const originalBoundingBox = source.boundingBox.bind(source);
  let boundaryReached = false;
  // Return the actual old geometry, but replace the real DOM node during that
  // await. The same coordinates now hit an unobserved, side-effecting node.
  source.boundingBox = async () => {
    const box = await originalBoundingBox();
    if (!boundaryReached) {
      boundaryReached = true;
      await page.evaluate(() => {
        const old = document.querySelector('#source');
        const replacement = old.cloneNode(true);
        replacement.addEventListener('mousedown', () => window.unintendedInputs++);
        old.replaceWith(replacement);
      });
    }
    return box;
  };
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'drag', ref: sourceRef, targetRef: ref(snapshot, 'Drop target') }]);
  assert.equal(boundaryReached, true);
  assert.equal(await page.evaluate(() => window.unintendedInputs), 0, 'No mouse down may reach the replacement node');
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.completed, 0);
  assert.equal(outcome.failed.error.code, 'STALE_REFERENCE');
});

test('upload chooser revalidates its visible trigger after asynchronous local file checks', { timeout: 30000 }, async t => {
  const { url, directory, createEngine } = await fixture(t);
  const engine = createEngine();
  const snapshot = await engine.open(url);
  const page = engine.sessions.get(snapshot.session_id).page;
  const path = join(directory, 'fixture.txt');
  await writeFile(path, 'Only an explicitly observed trigger may upload these bytes.');
  const originalUploadPaths = engine.uploadPaths.bind(engine);
  let boundaryReached = false;
  engine.uploadPaths = async files => {
    const paths = await originalUploadPaths(files);
    boundaryReached = true;
    await page.evaluate(() => {
      const old = document.querySelector('#chooser');
      const replacement = old.cloneNode(true);
      replacement.addEventListener('click', () => window.unintendedInputs++);
      old.replaceWith(replacement);
    });
    return paths;
  };
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'upload_chooser', ref: ref(snapshot, 'Choose file'), files: [path] }]);
  assert.equal(boundaryReached, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed.error.code, 'STALE_REFERENCE');
  assert.equal(await page.evaluate(() => window.unintendedInputs), 0);
  assert.equal(await page.evaluate(() => window.uploaded), '');
});

test('newly discovered scroll containers retain node identity guards when replaced', { timeout: 30000 }, async t => {
  const { url, createEngine } = await fixture(t);
  const engine = createEngine();
  const snapshot = await engine.open(url);
  const page = engine.sessions.get(snapshot.session_id).page;
  const panel = snapshot.elements.find(element => element.name === 'Scrollable panel');
  assert.equal(panel.scrollable.x, true);
  assert.equal(panel.scrollable.y, true);
  await page.evaluate(() => {
    const old = document.querySelector('#panel');
    old.replaceWith(old.cloneNode(true));
  });
  const outcome = await engine.act(snapshot.session_id, snapshot.snapshot_id, [{ type: 'scroll', ref: panel.ref, direction: 'down', pixels: 100 }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failed.error.code, 'STALE_REFERENCE');
  assert.equal(await page.locator('#panel').evaluate(element => element.scrollTop), 0);
});
