import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runAgent } from '../dist/agent.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const model = 'explicit-fixture-model';
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'tablaze-provider-cli-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function launch(args, env = {}, started) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, TABLAZE_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Provider CLI did not settle within 20 seconds.')); }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    started?.(child);
  });
}
async function until(predicate) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Fixture event did not arrive'); await delay(10); }
}
async function httpFixture(t, respond) {
  const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Provider CLI fixture</title><p>Ready</p>'); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ path: request.url, headers: request.headers, body });
      const value = await respond(body, request);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    } catch (error) { errors.push(error); response.writeHead(500); response.end('private fixture failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, errors };
}
async function fakeCodex(t, mode = 'human') {
  const path = await directory(t), executable = join(path, 'fake codex');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const folder = ${JSON.stringify(path)}, mode = ${JSON.stringify(mode)};
let prompt = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const args = process.argv.slice(2), output = args[args.indexOf('--output-last-message') + 1];
  fs.appendFileSync(path.join(folder, 'calls.jsonl'), JSON.stringify({ args }) + '\\n');
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  emit({ type: 'thread.started', thread_id: 'fixture-thread' }); emit({ type: 'turn.started' });
  if (mode === 'failed') {
    process.stderr.write('PRIVATE_CODEX_STDERR');
    emit({ type: 'turn.failed', error: { message: 'PRIVATE_CODEX_ERROR token=private-secret' } });
    process.exitCode = 1; return;
  }
  if (mode === 'wait') {
    fs.writeFileSync(path.join(folder, 'started'), String(process.pid));
    process.on('SIGTERM', () => {
      emit({ type: 'turn.completed', usage: { input_tokens: 17, output_tokens: 3 } });
      fs.writeFileSync(path.join(folder, 'stopped'), 'yes'); process.exit(0);
    });
    setInterval(() => {}, 1000); return;
  }
  let call = { name: 'agent_request_input', arguments_json: JSON.stringify({ question: 'Fixture needs input.' }) };
  if (mode === 'verify') {
    const marker = 'CONVERSATION_JSON\\n', after = prompt.slice(prompt.indexOf(marker) + marker.length);
    const messages = JSON.parse(after.split('\\nFUNCTION_SPECIFICATIONS_JSON\\n')[0].trim());
    const tool = messages.filter(item => item.role === 'tool').at(-1);
    const previous = tool ? JSON.parse(tool.content) : null;
    if (!previous) throw new Error('Expected start URL snapshot before planning');
    if (previous.structuredContent?.checks) call = { name: 'agent_finish', arguments_json: JSON.stringify({ summary: 'Verified fixture.', evidence: [previous.toolCallId] }) };
    else call = { name: 'tab_verify', arguments_json: JSON.stringify({ session_id: previous.structuredContent.session_id, checks: [{ kind: 'title', contains: 'Provider CLI fixture' }] }) };
  }
  const final = JSON.stringify({ tool_calls: [call] });
  fs.writeFileSync(output, final);
  emit({ type: 'item.completed', item: { id: 'fixture-message', type: 'agent_message', text: final } });
  emit({ type: 'turn.completed', usage: { input_tokens: 17, output_tokens: 3, cached_input_tokens: 2 } });
});
`;
  await writeFile(executable, script, { mode: 0o700 });
  return { path, executable, calls: async () => (await readFile(join(path, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
const base = ['run', '--task', 'Fixture only.', '--model', model];

test('provider selection preserves required explicit model and rejects mismatched options before execution', { timeout: 30_000 }, async () => {
  const cases = [
    [['--provider', 'unknown'], /--provider must/],
    [['--provider', 'codex', '--endpoint', 'http://127.0.0.1:1/unused'], /do not apply/],
    [['--provider', 'codex', '--api-key-env', 'PRIVATE_KEY'], /do not apply/],
    [['--provider', 'codex', '--max-output-tokens', '20'], /do not apply/],
    [['--provider', 'codex', '--codex-command', ' '], /nonempty executable/],
    [['--provider', 'codex', '--reasoning-effort', 'unexpected'], /--reasoning-effort must/],
    [['--provider', 'anthropic', '--codex-command', 'never-spawn'], /require --provider codex/],
    [['--provider', 'ollama', '--reasoning-effort', 'high'], /require --provider codex/],
    [['--endpoint', 'http://127.0.0.1:1/unused', '--max-output-tokens', '20'], /applies only/],
    [['--provider', 'anthropic', '--max-output-tokens', '0'], /integer/],
    [['--provider', 'ollama', '--max-output-tokens', '1000001'], /integer/],
  ];
  for (const [args, expected] of cases) { const result = await launch([...base, ...args]); assert.equal(result.code, 1); assert.match(result.stderr, expected); assert.equal(result.stdout, ''); }
  for (const provider of ['codex', 'anthropic', 'ollama']) {
    const missing = await launch(['run', '--provider', provider, '--task', 'Do not guess a model.']);
    assert.equal(missing.code, 1); assert.match(missing.stderr, /explicit --model/);
  }
  const compatible = await launch(base);
  assert.match(compatible.stderr, /requires --task \(or --resume\), --model and --endpoint/);
});

test('new provider-only options cannot start the default MCP server', { timeout: 15_000 }, async () => {
  for (const [flag, value] of [['--provider', 'codex'], ['--codex-command', 'codex'], ['--reasoning-effort', 'high'], ['--max-output-tokens', '10']]) {
    const result = await launch([flag, value]); assert.equal(result.code, 1); assert.match(result.stderr, /Agent options require the run command/);
  }
});

test('Anthropic CLI forwards its explicit model, native tool schema, key and output cap; retains real usage', { timeout: 15_000 }, async t => {
  const service = await httpFixture(t, () => ({ id: 'fixture-anthropic', type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: 'native-call', name: 'agent_request_input', input: { question: 'Fixture needs input.' } }], stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 4 } }));
  const child = await launch([...base, '--provider', 'anthropic', '--endpoint', service.url + '/v1/messages', '--api-key-env', 'PROVIDER_FIXTURE_KEY', '--max-output-tokens', '128'], { PROVIDER_FIXTURE_KEY: 'private-anthropic-key' });
  assert.equal(child.code, 2, child.stderr); const report = JSON.parse(child.stdout); assert.equal(report.status, 'needs_input');
  const request = service.requests[0]; assert.equal(request.path, '/v1/messages'); assert.equal(request.body.model, model); assert.equal(request.body.max_tokens, 128); assert.equal(request.headers['x-api-key'], 'private-anthropic-key'); assert.ok(request.body.tools.some(tool => tool.name === 'tab_verify' && tool.input_schema));
  assert.equal(report.model_usage[0].uncachedPromptTokens, 11); assert.equal(report.model_usage[0].promptTokens, undefined); assert.equal(report.model_usage[0].completionTokens, 4); assert.equal(report.model_usage[0].totalTokens, undefined);
  assert.equal((child.stdout + child.stderr).includes('private-anthropic-key'), false); assert.deepEqual(service.errors, []);
});

test('Ollama CLI uses native requests, optional num_predict and no invented token counters', { timeout: 15_000 }, async t => {
  const service = await httpFixture(t, () => ({ model, done: true, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'agent_request_input', arguments: { question: 'Fixture needs input.' } } }] } }));
  for (const cap of [undefined, '96']) {
    const child = await launch([...base, '--provider', 'ollama', '--endpoint', service.url + '/api/chat', ...(cap ? ['--max-output-tokens', cap] : [])]);
    assert.equal(child.code, 2, child.stderr); const report = JSON.parse(child.stdout); assert.equal(report.status, 'needs_input');
    const body = service.requests.at(-1).body; assert.equal(body.model, model); assert.equal(body.stream, false); assert.equal(body.options?.num_predict, cap ? 96 : undefined);
    assert.ok(body.tools.some(tool => tool.function?.name === 'tab_verify'));
    for (const usage of report.model_usage) for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) assert.equal(usage[key], undefined);
  }
  assert.deepEqual(service.errors, []);
});

test('explicit compatible provider keeps the previous endpoint and key contract', { timeout: 15_000 }, async t => {
  const service = await httpFixture(t, () => ({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Fixture needs input.' }) } }] } }] }));
  const child = await launch([...base, '--provider', 'openai-compatible', '--endpoint', service.url + '/chat/completions'], { TABLAZE_API_KEY: 'private-compatible-key' });
  assert.equal(child.code, 2, child.stderr); assert.equal(service.requests[0].headers.authorization, 'Bearer private-compatible-key'); assert.equal(service.requests[0].body.model, model); assert.deepEqual(JSON.parse(child.stdout).model_usage, []); assert.deepEqual(service.errors, []);
});

test('Codex CLI uses the chosen executable and explicit model/effort without a model endpoint', { timeout: 15_000 }, async t => {
  const fake = await fakeCodex(t);
  const child = await launch([...base, '--provider', 'codex', '--codex-command', fake.executable, '--reasoning-effort', 'high'], { TABLAZE_API_KEY: 'unused-private-key' });
  assert.equal(child.code, 2, child.stderr); const report = JSON.parse(child.stdout); assert.equal(report.question, 'Fixture needs input.');
  const [{ args }] = await fake.calls(); assert.equal(args[args.indexOf('--model') + 1], model); assert.ok(args.some(arg => /model_reasoning_effort.*high/.test(arg)));
  assert.equal(report.model_usage[0].promptTokens, 17); assert.equal(report.model_usage[0].completionTokens, 3); assert.equal(report.model_usage[0].cachedPromptTokens, 2);
  assert.equal(report.provider_diagnostics[0].status, 'completed'); assert.equal(report.provider_diagnostics[0].terminalEvent, 'turn.completed');
  assert.equal((child.stdout + child.stderr).includes('unused-private-key'), false);
});

test('Codex executable defaults to codex on PATH without inventing a reasoning setting', { timeout: 15_000 }, async t => {
  const fake = await fakeCodex(t);
  await writeFile(join(fake.path, 'codex'), await readFile(fake.executable), { mode: 0o700 });
  const child = await launch([...base, '--provider', 'codex'], { PATH: fake.path + ':' + process.env.PATH });
  assert.equal(child.code, 2, child.stderr);
  const [{ args }] = await fake.calls(); assert.equal(args[args.indexOf('--model') + 1], model); assert.equal(args.some(arg => arg.startsWith('model_reasoning_effort=')), false);
});

test('Codex failures expose fixed diagnostics without stderr, credentials or provider error text', { timeout: 15_000 }, async t => {
  const fake = await fakeCodex(t, 'failed');
  const child = await launch([...base, '--provider', 'codex', '--codex-command', fake.executable]);
  assert.equal(child.code, 1); const report = JSON.parse(child.stdout); assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'PLANNER_PROCESS_FAILED');
  assert.equal(report.provider_diagnostics[0].code, 'CODEX_TURN_FAILED'); assert.equal(report.provider_diagnostics[0].terminalEvent, 'turn.failed');
  assert.deepEqual(Object.keys(report.provider_diagnostics[0]).sort(), ['code', 'errorNotifications', 'exitCode', 'latencyMs', 'status', 'step', 'terminalEvent']);
  for (const hidden of ['PRIVATE_CODEX_STDERR', 'PRIVATE_CODEX_ERROR', 'private-secret']) assert.equal((child.stdout + child.stderr).includes(hidden), false);
});

test('Codex provider integrates start-url, actual browser verification and normal cleanup', { timeout: 30_000 }, async t => {
  const fake = await fakeCodex(t, 'verify'), service = await httpFixture(t, () => { throw new Error('Only browser GETs expected'); });
  const child = await launch([...base, '--provider', 'codex', '--codex-command', fake.executable, '--start-url', service.url, ...(process.env.TABLAZE_BROWSER_CHANNEL ? ['--channel', process.env.TABLAZE_BROWSER_CHANNEL] : []), '--run-timeout-ms', '15000']);
  assert.equal(child.code, 0, child.stderr); const report = JSON.parse(child.stdout); assert.equal(report.status, 'succeeded'); assert.equal(report.tool_calls, 2); assert.equal(report.planner_calls, 2); assert.equal(report.verification.length, 1); assert.equal(report.model_usage.length, 2); assert.equal(report.cleanup, undefined);
});

test('Codex checkpoint resume preserves prior budgets and still requires provider/model on each invocation', { timeout: 20_000 }, async t => {
  const fake = await fakeCodex(t), checkpoint = join(fake.path, 'checkpoint.json');
  const args = ['--provider', 'codex', '--codex-command', fake.executable, '--model', model];
  const first = await launch(['run', '--task', 'Pause and resume.', ...args, '--checkpoint', checkpoint]); assert.equal(first.code, 2, first.stderr);
  const second = await launch(['run', '--resume', checkpoint, ...args]); assert.equal(second.code, 2, second.stderr);
  const report = JSON.parse(second.stdout); assert.equal(report.steps, 2); assert.equal(report.planner_calls, 2); assert.equal(report.model_usage.length, 1);
});

test('bound checkpoints are rejected before any Codex process or browser restoration', { timeout: 15_000 }, async t => {
  const fake = await fakeCodex(t), checkpoint = join(fake.path, 'bound.json');
  const result = await runAgent({ task: 'Application-only task.', tools: { listTools: async () => [], callTool: async () => { throw new Error('Unused'); } }, planner: async () => ({ type: 'human_input', question: 'Continue later?' }) });
  await writeFile(checkpoint, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), agent: { ...result.checkpoint, executionIdentity: { registryHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) } }, browser: { version: 1, sessions: [] } }));
  const child = await launch(['run', '--resume', checkpoint, '--provider', 'codex', '--model', model, '--codex-command', fake.executable]);
  assert.equal(child.code, 1); assert.match(child.stderr, /bound tool registry/); await assert.rejects(fake.calls(), { code: 'ENOENT' });
});

test('SIGTERM cancels an in-flight Codex planner and terminates its child', { timeout: 20_000 }, async t => {
  const fake = await fakeCodex(t, 'wait'); let child;
  const running = launch([...base, '--provider', 'codex', '--codex-command', fake.executable], {}, value => { child = value; });
  await until(async () => { try { await readFile(join(fake.path, 'started')); return true; } catch { return false; } });
  child.kill('SIGTERM'); const result = await running;
  assert.equal(result.code, 1, result.stderr); const report = JSON.parse(result.stdout); assert.equal(report.status, 'cancelled');
  assert.equal(report.model_usage[0].promptTokens, 17); assert.equal(report.model_usage[0].completionTokens, 3);
  assert.equal(report.provider_diagnostics[0].code, 'CODEX_CANCELLED');
  await until(async () => { try { return await readFile(join(fake.path, 'stopped'), 'utf8') === 'yes'; } catch { return false; } });
});
