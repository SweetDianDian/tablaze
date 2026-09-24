import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BrowserEngine } from '../dist/browser.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-state-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/model') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      const prior = body.messages.filter(message => message.role === 'tool').at(-1);
      const result = prior ? JSON.parse(prior.content) : undefined;
      const call = requests.length === 1
        ? { name: 'tab_verify', arguments: { session_id: result.structuredContent.session_id, checks: [{ kind: 'text', contains: 'Welcome back' }] } }
        : { name: 'agent_finish', arguments: { summary: 'Authenticated page verified.', evidence: [result.toolCallId] } };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }));
      return;
    }
    if (request.url === '/login') response.setHeader('Set-Cookie', 'auth=fixture-auth; Path=/; HttpOnly; SameSite=Lax');
    if (request.url === '/logout') response.setHeader('Set-Cookie', 'auth=; Path=/; Max-Age=0');
    const authenticated = request.headers.cookie?.includes('auth=fixture-auth');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<p>${request.url === '/login' || authenticated && request.url !== '/logout' ? 'Welcome back' : 'Sign in'}</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', availableFilePaths: [] });
  const opened = await bootstrap.open(`${base}/login`);
  const saved = await bootstrap.saveState(opened.session_id);
  const statePath = join(directory, 'state.json');
  await writeFile(statePath, await readFile(saved.storage_state), { mode: 0o600 });
  await bootstrap.dispose();
  return { base, statePath, directory, requests };
}

test('trusted auth state is copied into each isolated session, never exposed as a model file', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', availableFilePaths: [], storageStateFile: f.statePath });
  t.after(() => engine.dispose());
  const first = await engine.open(f.base);
  assert.match(first.text, /Welcome back/);
  assert.deepEqual(first.available_files, []);
  assert.equal(JSON.stringify(first).includes(f.statePath), false);
  const logout = await engine.open(`${f.base}/logout`);
  assert.match(logout.text, /Sign in/);
  const second = await engine.open(f.base);
  assert.match(second.text, /Welcome back/, 'New contexts each receive the trusted initial state.');
  await assert.rejects(engine.open(f.base, { storageState: join(f.directory, 'unlisted.json') }), error => error.code === 'STATE_FILE_NOT_AVAILABLE');
  await writeFile(f.statePath, JSON.stringify({ cookies: [], origins: [] }));
  const third = await engine.open(f.base);
  assert.match(third.text, /Welcome back/, 'Changing the file after configuration cannot swap the captured state.');
  const saved = await engine.exportWorkspace();
  const changed = new BrowserEngine({ availableFilePaths: [], storageStateFile: f.statePath });
  t.after(() => changed.dispose());
  await assert.rejects(changed.restoreWorkspace(saved), error => error.code === 'FILE_POLICY_MISMATCH');
});

test('state configuration rejects invalid files and attached or persistent browsers before launch', async t => {
  const f = await fixture(t);
  const bad = join(f.directory, 'bad.json');
  await writeFile(bad, '{');
  assert.throws(() => new BrowserEngine({ availableFilePaths: [], storageStateFile: 'relative.json' }), error => error.code === 'STATE_POLICY_INVALID');
  assert.throws(() => new BrowserEngine({ availableFilePaths: [], storageStateFile: bad }), error => error.code === 'STATE_POLICY_INVALID');
  assert.throws(() => new BrowserEngine({ availableFilePaths: [], storageStateFile: f.directory }), error => error.code === 'STATE_POLICY_INVALID');
  assert.throws(() => new BrowserEngine({ storageStateFile: f.statePath, cdpUrl: 'http://127.0.0.1:9222' }), error => error.code === 'STATE_POLICY_INVALID');
  assert.throws(() => new BrowserEngine({ storageStateFile: f.statePath, profileDir: f.directory }), error => error.code === 'STATE_POLICY_INVALID');
});

test('malformed cookie fields cannot leak state values through browser errors', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.statePath, JSON.stringify({ cookies: [{ name: 'auth', value: 'CANARY_STORAGE_SECRET', domain: 123, path: '/' }], origins: [] }));
  const engine = new BrowserEngine({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', availableFilePaths: [], storageStateFile: f.statePath });
  t.after(() => engine.dispose());
  await assert.rejects(engine.open(f.base), error => error.code === 'STATE_IMPORT_FAILED' && !error.message.includes('CANARY_STORAGE_SECRET') && !error.message.includes(f.statePath));
});

test('spawned CLI Agent starts authenticated without disclosing the state path to its model', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', '--task', 'Verify my authenticated page.', '--start-url', f.base, '--storage-state-file', f.statePath, '--model', 'state', '--endpoint', `${f.base}/model`, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--max-steps', '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(run.code, 0, run.stderr + run.stdout);
  assert.equal(JSON.parse(run.stdout).status, 'succeeded');
  assert.equal(run.stdout.includes(f.statePath), false);
  assert.equal(JSON.stringify(f.requests).includes(f.statePath), false);
  assert.equal(f.requests.length, 2);
});
