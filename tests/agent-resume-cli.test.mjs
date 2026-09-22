import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseAgentCheckpoint } from '../dist/checkpoint.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const channel = process.env.TABLAZE_BROWSER_CHANNEL || 'chrome';
const call = (name, arguments_) => ({ name, arguments: arguments_ });
const latest = body => JSON.parse(body.messages.filter(message => message.role === 'tool').at(-1).content);

function launch(args, onStart) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'run', '--channel', channel, '--model', 'scripted-resume-fixture', ...args], { cwd: root, env: { ...process.env, TABLAZE_API_KEY: 'private-fixture-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${stderr}`)); }, 25_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    onStart?.(child);
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-resume-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let pageLoads = 0; let effects = 0;
  let planner = () => { throw new Error('No scripted planner installed.'); };
  let onEffect;
  const requests = []; const errors = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/effect') {
      effects++;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ effects }));
      onEffect?.(); return;
    }
    if (request.url === '/state') {
      pageLoads++;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Resume CLI fixture</title>
        <label>Draft<input id="draft" aria-label="Draft"></label><button id="save">Save once</button>
        <p id="status">Ready</p><p id="storage"></p><p id="cookie"></p><p>External effects: ${effects}</p>
        <script>
          document.querySelector('#storage').textContent = localStorage.getItem('saved') ? 'Restored storage present' : 'No saved storage';
          document.querySelector('#cookie').textContent = document.cookie.includes('tablazeResume=present') ? 'Restored cookie present' : 'No saved cookie';
          document.querySelector('#save').onclick = async () => {
            await fetch('/effect', {method: 'POST'});
            localStorage.setItem('saved', 'storage-secret-fixture');
            document.cookie = 'tablazeResume=present; path=/';
            document.querySelector('#status').textContent = 'Stored record';
          };
        </script>`);
      return;
    }
    try {
      assert.equal(request.url, '/chat/completions');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const next = await planner(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `fixture-response-${requests.length}`, model: body.model, usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, choices: [{ message: { tool_calls: [{ id: `fixture-call-${requests.length}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] } }] }));
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { 'content-type': 'application/json' }); response.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { directory, url, endpoint: `${url}/chat/completions`, requests, errors, setPlanner: value => { planner = value; }, setOnEffect: value => { onEffect = value; }, pageLoads: () => pageLoads, effects: () => effects };
}

test('separate CLI processes restore private storage and fresh sessions without replaying completed writes', { timeout: 60_000 }, async t => {
  const service = await fixture(t);
  const path = join(service.directory, 'run.json');
  let phase = 0; let oldSession; let oldEvidence; let newSession;
  service.setPlanner(async body => {
    phase++;
    if (phase === 1) return call('tab_open', { url: `${service.url}/state` });
    const previous = latest(body);
    assert.notEqual(previous.isError, true, JSON.stringify(previous));
    if (phase === 2) {
      const snapshot = previous.structuredContent; oldSession = snapshot.session_id;
      return call('tab_act', { session_id: oldSession, snapshot_id: snapshot.snapshot_id, actions: [{ type: 'fill', ref: snapshot.elements.find(item => item.name === 'Draft').ref, value: 'UNSAVED_DRAFT' }, { type: 'click', ref: snapshot.elements.find(item => item.name === 'Save once').ref }, { type: 'wait', text: 'Stored record', timeout_ms: 2_000 }] });
    }
    if (phase === 3) return call('tab_verify', { session_id: oldSession, checks: [{ kind: 'text', contains: 'Stored record' }], timeout_ms: 1_000 });
    oldEvidence = previous.toolCallId;
    return call('agent_request_input', { question: 'The record is saved. Continue after reviewing it?' });
  });
  const first = await launch(['--task', 'Save exactly one record, pause for review, then verify restored storage.', '--endpoint', service.endpoint, '--checkpoint', path, '--max-steps', '15', '--max-calls', '15', '--run-timeout-ms', '45000']);
  assert.deepEqual(service.errors, []);
  assert.equal(first.code, 2, first.stderr + first.stdout);
  assert.equal(JSON.parse(first.stdout).steps, 4);
  assert.equal(service.effects(), 1);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  parseAgentCheckpoint(saved.agent);
  assert.equal(saved.browser.sessions.length, 1);
  assert.equal(saved.browser.sessions[0].sessionId, oldSession);
  assert.ok(saved.browser.sessions[0].storage.cookies.some(cookie => cookie.name === 'tablazeResume'));
  assert.ok(saved.browser.sessions[0].storage.origins.some(origin => origin.localStorage.some(item => item.name === 'saved' && item.value === 'storage-secret-fixture')));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, 'utf8')).includes('private-fixture-key'), false);
  phase = 0;
  service.setPlanner(async body => {
    phase++;
    if (phase === 1) {
      assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes('Session mapping:')));
      const planningCheckpoint = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(planningCheckpoint.agent.phase, 'planning');
      assert.notEqual(planningCheckpoint.browser.sessions[0].sessionId, oldSession, 'The first resumed planning checkpoint already contains the new browser session IDs.');
      assert.equal(planningCheckpoint.browser.sessions[0].sessionId, planningCheckpoint.agent.lastMutationSession, 'A crash before the first resumed tool still leaves a coherent session mapping.');
      return call('agent_finish', { summary: 'Attempt an old claim.', evidence: [oldEvidence] });
    }
    if (phase === 2) {
      assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED')));
      return call('tab_list', {});
    }
    const previous = latest(body);
    assert.notEqual(previous.isError, true, JSON.stringify(previous));
    if (phase === 3) { newSession = previous.structuredContent.sessions[0].session_id; assert.notEqual(newSession, oldSession); return call('tab_snapshot', { session_id: newSession }); }
    if (phase === 4) return call('tab_verify', { session_id: newSession, checks: [{ kind: 'text', contains: 'Restored storage present' }, { kind: 'text', contains: 'Restored cookie present' }, { kind: 'text', contains: 'External effects: 1' }, { kind: 'value', selector: '#draft', value: '' }], timeout_ms: 1_000 });
    assert.equal(previous.structuredContent.passed, true);
    return call('agent_finish', { summary: 'Restored storage and the single external effect were verified.', evidence: [previous.toolCallId] });
  });
  const second = await launch(['--resume', path, '--endpoint', service.endpoint]);
  assert.deepEqual(service.errors, []);
  assert.equal(second.code, 0, second.stderr + second.stdout);
  const report = JSON.parse(second.stdout);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.steps, 9);
  assert.equal(report.tool_calls, 6);
  assert.equal(report.planner_calls, 9);
  assert.equal(report.model_usage.length, 5);
  assert.ok(report.model_usage.every(usage => usage.totalTokens === 12));
  assert.equal(service.effects(), 1, 'The original save is not replayed on resume.');
  assert.equal(service.pageLoads(), 2, 'A fresh page is restored in the second process.');
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(updated.agent.runId, saved.agent.runId);
  assert.equal(updated.browser.sessions[0].sessionId, newSession);
  assert.equal(updated.agent.lastMutationSession, newSession);
  assert.ok(updated.agent.elapsedMs > saved.agent.elapsedMs);
  assert.notEqual(report.verification[0].tool_call_id, oldEvidence);
  parseAgentCheckpoint(updated.agent);
});

test('interrupted external side effect requires explicit reconciliation before CLI restores or plans', { timeout: 60_000 }, async t => {
  const service = await fixture(t);
  const path = join(service.directory, 'interrupted.json');
  let phase = 0; let child; let oldSession;
  service.setOnEffect(() => { child.kill('SIGTERM'); });
  service.setPlanner(body => {
    phase++;
    if (phase === 1) return call('tab_open', { url: `${service.url}/state` });
    const page = latest(body).structuredContent; oldSession = page.session_id;
    return call('tab_act', { session_id: oldSession, snapshot_id: page.snapshot_id, actions: [{ type: 'click', ref: page.elements.find(item => item.name === 'Save once').ref }, { type: 'wait', text: 'A status that never appears', timeout_ms: 60_000 }], timeout_ms: 60_000 });
  });
  const first = await launch(['--task', 'Create exactly one external record.', '--endpoint', service.endpoint, '--checkpoint', path, '--run-timeout-ms', '45000'], value => { child = value; });
  assert.deepEqual(service.errors, []);
  assert.equal(first.code, 1, first.stderr + first.stdout);
  assert.equal(JSON.parse(first.stdout).status, 'cancelled', first.stderr + first.stdout);
  assert.equal(service.effects(), 1);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.agent.ambiguousCalls.length, 1);
  assert.equal(saved.agent.pendingTool.mutating, true);
  const initialRequests = service.requests.length;
  const initialLoads = service.pageLoads();
  const blocked = await launch(['--resume', path, '--endpoint', service.endpoint]);
  assert.equal(blocked.code, 2);
  assert.equal(JSON.parse(blocked.stdout).status, 'needs_input');
  assert.equal(service.requests.length, initialRequests, 'An unresolved checkpoint never calls the model.');
  assert.equal(service.pageLoads(), initialLoads, 'An unresolved checkpoint never restores a browser page.');
  phase = 0;
  service.setOnEffect(undefined);
  service.setPlanner(body => {
    phase++;
    if (phase === 1) return call('tab_list', {});
    const previous = latest(body);
    if (phase === 2) return call('tab_verify', { session_id: previous.structuredContent.sessions[0].session_id, checks: [{ kind: 'text', contains: 'External effects: 1' }], timeout_ms: 1_000 });
    return call('agent_finish', { summary: 'The existing single effect was verified without replay.', evidence: [previous.toolCallId] });
  });
  const resumed = await launch(['--resume', path, '--endpoint', service.endpoint, '--reconciled', 'Operator checked the external ledger and confirmed exactly one record exists.']);
  assert.deepEqual(service.errors, []);
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.equal(service.effects(), 1);
  assert.equal(JSON.parse(resumed.stdout).status, 'succeeded');
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(updated.agent.ambiguousCalls, []);
  assert.equal(updated.agent.pendingTool, undefined);
});

test('an exhausted saved CLI budget performs no page restoration or model request', { timeout: 30_000 }, async t => {
  const service = await fixture(t);
  const path = join(service.directory, 'exhausted.json');
  service.setPlanner(() => call('tab_open', { url: `${service.url}/state` }));
  const first = await launch(['--task', 'One step only.', '--endpoint', service.endpoint, '--checkpoint', path, '--max-steps', '1']);
  assert.equal(first.code, 1);
  assert.equal(JSON.parse(first.stdout).status, 'limit_reached');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.agent.steps, 1);
  const loads = service.pageLoads(); const requests = service.requests.length;
  const resumed = await launch(['--resume', path, '--endpoint', service.endpoint]);
  assert.equal(resumed.code, 1);
  assert.equal(JSON.parse(resumed.stdout).status, 'limit_reached');
  assert.equal(service.pageLoads(), loads);
  assert.equal(service.requests.length, requests);
  const invalid = structuredClone(saved); invalid.agent.schemaVersion = 987;
  const invalidPath = join(service.directory, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify(invalid), { mode: 0o600 });
  const rejected = await launch(['--resume', invalidPath, '--endpoint', service.endpoint]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /checkpoint/);
  assert.equal(service.pageLoads(), loads);
  assert.equal(service.requests.length, requests);
});
