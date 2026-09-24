import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-file-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allowed = join(directory, 'allowed.txt');
  const blocked = join(directory, 'blocked.txt');
  await writeFile(allowed, 'Allowed fixture bytes');
  await writeFile(blocked, 'Private fixture bytes');
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/download') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="receipt.txt"' });
      response.end('Owned downloaded bytes'); return;
    }
    if (request.url === '/model') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      const prior = body.messages.filter(message => message.role === 'tool').at(-1);
      const priorResult = prior ? JSON.parse(prior.content) : undefined;
      let name, args;
      if (requests.length === 1) {
        const snapshot = priorResult.structuredContent;
        const file = body.model === 'allowed' ? snapshot.available_files[0].id : blocked;
        name = 'tab_act'; args = { session_id: snapshot.session_id, snapshot_id: snapshot.snapshot_id, actions: [{ type: 'upload', ref: snapshot.elements.find(item => item.name === 'Upload document').ref, files: [file] }] };
      } else if (body.model === 'blocked') {
        assert.equal(priorResult.structuredContent.failed.error.code, 'FILE_NOT_AVAILABLE');
        name = 'agent_fail'; args = { reason: 'The unlisted file was denied.' };
      } else if (requests.length === 2) {
        assert.equal(priorResult.structuredContent.ok, true);
        name = 'tab_verify'; args = { session_id: priorResult.structuredContent.session_id, checks: [{ kind: 'text', contains: 'Allowed fixture bytes' }] };
      } else {
        assert.equal(priorResult.structuredContent.passed, true);
        name = 'agent_finish'; args = { summary: 'Uploaded and verified.', evidence: [priorResult.toolCallId] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><label>Upload document<input type="file" id="upload"></label><a href="/download" download>Download receipt</a><p id="result">Ready</p><script>document.querySelector("#upload").onchange=async e=>{document.querySelector("#result").textContent=await e.target.files[0].text()}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, allowed, blocked, requests };
}

const ref = (snapshot, name) => snapshot.elements.find(item => item.name === name)?.ref;

test('trusted file aliases upload permitted bytes and reject an unlisted host file', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', availableFilePaths: [f.allowed] });
  t.after(() => engine.dispose());
  const first = await engine.open(f.base);
  assert.deepEqual(first.available_files.map(item => ({ id: item.id, name: item.name, source: item.source })), [{ id: 'file:1', name: 'allowed.txt', source: 'provided' }]);
  assert.equal(JSON.stringify(first).includes(f.allowed), false, 'Snapshot gives an alias without disclosing the host path.');
  const denied = await engine.act(first.session_id, first.snapshot_id, [{ type: 'upload', ref: ref(first, 'Upload document'), files: [f.blocked] }]);
  assert.equal(denied.failed.error.code, 'FILE_NOT_AVAILABLE');
  assert.equal(denied.failed_action_may_have_side_effects, false, 'The file denial occurs before any browser input.');
  assert.equal(JSON.stringify(denied).includes(f.blocked), false);
  const fresh = await engine.snapshot(first.session_id);
  const uploaded = await engine.act(first.session_id, fresh.snapshot_id, [{ type: 'upload', ref: ref(fresh, 'Upload document'), files: ['file:1'] }]);
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Allowed fixture bytes' }])).passed, true);
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Private fixture bytes' }], 100)).passed, false);
  await rename(f.allowed, `${f.allowed}.old`);
  await writeFile(f.allowed, 'Replacement private bytes');
  const afterReplacement = await engine.snapshot(first.session_id);
  const rejected = await engine.act(first.session_id, afterReplacement.snapshot_id, [{ type: 'upload', ref: ref(afterReplacement, 'Upload document'), files: ['file:1'] }]);
  assert.equal(rejected.failed.error.code, 'FILE_NOT_AVAILABLE', 'A new file at the same pathname is not the authorized inode.');
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Replacement private bytes' }], 100)).passed, false);
});

test('a completed download becomes an upload alias only in its owning session', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', availableFilePaths: [] });
  t.after(() => engine.dispose());
  const first = await engine.open(f.base);
  const clicked = await engine.act(first.session_id, first.snapshot_id, [{ type: 'click', ref: ref(first, 'Download receipt') }]);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  const listed = await engine.downloads(first.session_id);
  assert.equal(listed.downloads.length, 1);
  const completed = await engine.downloads(first.session_id, listed.downloads[0].id);
  assert.equal(completed.downloads[0].status, 'completed');
  const fresh = await engine.snapshot(first.session_id);
  const alias = `download:${completed.downloads[0].id}`;
  assert.ok(fresh.available_files.some(item => item.id === alias && item.source === 'download'));
  const second = await engine.open(f.base);
  const other = await engine.act(second.session_id, second.snapshot_id, [{ type: 'upload', ref: ref(second, 'Upload document'), files: [alias] }]);
  assert.equal(other.failed.error.code, 'FILE_NOT_AVAILABLE');
  const upload = await engine.act(first.session_id, fresh.snapshot_id, [{ type: 'upload', ref: ref(fresh, 'Upload document'), files: [alias] }]);
  assert.equal(upload.ok, true, JSON.stringify(upload));
  assert.equal((await engine.verify(first.session_id, [{ kind: 'text', contains: 'Owned downloaded bytes' }])).passed, true);
});

test('tablaze run denies host files by default and accepts an explicitly listed file', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const launch = (model, flags = []) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', '--task', 'Upload the requested file and verify the result.', '--start-url', f.base, '--model', model, '--endpoint', `${f.base}/model`, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--max-steps', '3', ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const denied = await launch('blocked');
  assert.equal(denied.code, 1, denied.stderr + denied.stdout);
  assert.equal(JSON.parse(denied.stdout).status, 'failed');
  assert.equal(denied.stdout.includes(f.blocked), false);
  f.requests.length = 0;
  const allowed = await launch('allowed', ['--available-file', f.allowed]);
  assert.equal(allowed.code, 0, allowed.stderr + allowed.stdout);
  assert.equal(JSON.parse(allowed.stdout).status, 'succeeded');
  assert.equal(allowed.stdout.includes(f.allowed), false);
});

test('checkpoint restoration cannot silently widen available host files', async t => {
  const f = await fixture(t);
  const original = new BrowserEngine({ availableFilePaths: [] });
  const expanded = new BrowserEngine({ availableFilePaths: [f.allowed] });
  t.after(async () => { await original.dispose(); await expanded.dispose(); });
  const saved = await original.exportWorkspace();
  await assert.rejects(expanded.restoreWorkspace(saved), error => error.code === 'FILE_POLICY_MISMATCH');
  const same = new BrowserEngine({ availableFilePaths: [] });
  t.after(() => same.dispose());
  const restored = await same.restoreWorkspace(saved);
  assert.deepEqual(restored.snapshots, []);
});

test('configured file policy rejects arbitrary storage-state paths but accepts its own export', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', availableFilePaths: [] });
  t.after(() => engine.dispose());
  const outside = join((await mkdtemp(join(tmpdir(), 'tablaze-external-state-'))), 'state.json');
  t.after(() => rm(join(outside, '..'), { recursive: true, force: true }));
  await writeFile(outside, JSON.stringify({ cookies: [], origins: [] }));
  await assert.rejects(engine.open(f.base, { storageState: outside }), error => error.code === 'STATE_FILE_NOT_AVAILABLE');
  const first = await engine.open(f.base);
  const saved = await engine.saveState(first.session_id);
  const restored = await engine.open(f.base, { storageState: saved.storage_state });
  assert.equal(restored.ok, true);
});
