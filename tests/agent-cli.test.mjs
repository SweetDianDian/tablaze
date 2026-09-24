import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runAgent } from '../dist/agent.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function launch(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI did not exit within 20 seconds. stderr: ${stderr}`)); }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

async function fixture(t, planner) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/form') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Agent CLI fixture</title><label>Name<input id="name" aria-label="Name"></label><button onclick="document.querySelector(\'#status\').textContent=\'Saved record\'">Save</button><p id="status">Ready</p>');
      return;
    }
    try {
      assert.equal(request.url, '/chat/completions');
      assert.equal(request.method, 'POST');
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ body, headers: request.headers });
      const next = await planner(body, requests.length);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `scripted_${requests.length}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] } }] }));
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Scripted fixture assertion failed.' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, endpoint: `${url}/chat/completions`, requests, errors };
}

function latest(body) {
  const message = body.messages.filter(item => item.role === 'tool').at(-1);
  assert.ok(message, 'Actual CLI model request contains a preceding MCP result.');
  return JSON.parse(message.content);
}

test('run CLI completes a scripted model task through real Chrome and prints a bounded report', { timeout: 30_000 }, async t => {
  const privateTask = 'TASK_PROMPT_PRIVATE_9f783';
  const privateInput = 'FORM_INPUT_PRIVATE_4b917';
  const privateKey = 'API_KEY_PRIVATE_820ab';
  let sessionId;
  let verificationId;
  const service = await fixture(t, (body, step) => {
    assert.equal(body.model, 'scripted-cli-fixture');
    assert.equal(body.tool_choice, 'required');
    assert.ok(body.tools.some(item => item.function.name === 'tab_open'));
    if (step === 1) {
      assert.ok(body.messages.some(item => item.role === 'user' && item.content.includes(privateTask)));
      return { name: 'tab_open', arguments: { url: `${service.url}/form` } };
    }
    const result = latest(body);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    if (step === 2) {
      const snapshot = result.structuredContent;
      sessionId = snapshot.session_id;
      return { name: 'tab_act', arguments: { session_id: sessionId, snapshot_id: snapshot.snapshot_id, actions: [{ type: 'fill', ref: snapshot.elements.find(item => item.name === 'Name').ref, value: privateInput }, { type: 'click', ref: snapshot.elements.find(item => item.name === 'Save').ref }] } };
    }
    if (step === 3) {
      assert.equal(result.structuredContent.completed, 2);
      return { name: 'tab_verify', arguments: { session_id: sessionId, checks: [{ kind: 'title', contains: 'Agent CLI fixture' }, { kind: 'text', contains: 'Saved record' }], timeout_ms: 1_000 } };
    }
    assert.equal(step, 4);
    assert.equal(result.structuredContent.passed, true);
    verificationId = result.toolCallId;
    return { name: 'agent_finish', arguments: { summary: 'The form was saved and explicitly verified.', evidence: [verificationId] } };
  });
  const child = await launch(['run', '--task', `Save a record. ${privateTask}`, '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--api-key-env', 'TABLAZE_TEST_SECRET', '--max-steps', '4', '--max-calls', '3', '--run-timeout-ms', '15000'], { TABLAZE_TEST_SECRET: privateKey });
  assert.deepEqual(service.errors, [], service.errors.map(error => error.message).join('\n'));
  assert.equal(child.code, 0, child.stderr + child.stdout);
  assert.equal(child.signal, null);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.steps, 4);
  assert.equal(report.tool_calls, 3);
  assert.equal(report.verification[0].tool_call_id, verificationId);
  assert.equal(report.verification[0].session_id, sessionId);
  assert.ok(report.verification[0].checks.every(check => check.pass));
  assert.deepEqual(Object.keys(report).sort(), ['model_usage', 'planner_calls', 'reason', 'status', 'steps', 'summary', 'tool_calls', 'verification']);
  assert.equal(report.planner_calls, 4);
  assert.deepEqual(report.model_usage, [], 'A scripted provider without usage fields produces no invented token counts.');
  assert.equal(service.requests.length, 4);
  assert.ok(service.requests.every(request => request.headers.authorization === `Bearer ${privateKey}`));
  for (const secret of [privateTask, privateInput, privateKey]) assert.equal((child.stdout + child.stderr).includes(secret), false, 'Default output omits private prompts/arguments/API key.');
  for (const rawField of ['"history"', '"events"', '"arguments"', '"messages"']) assert.equal(child.stdout.includes(rawField), false);
  assert.match(child.stderr, /planning step 4/);
});

test('CLI opt-in opens the sole task URL before model planning', { timeout: 30_000 }, async t => {
  const service = await fixture(t, (body, step) => {
    const result = latest(body);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    if (step === 1) {
      assert.equal(result.structuredContent.url, `${service.url}/form`);
      return { name: 'tab_verify', arguments: { session_id: result.structuredContent.session_id, checks: [{ kind: 'title', contains: 'Agent CLI fixture' }] } };
    }
    assert.equal(step, 2);
    assert.equal(result.structuredContent.passed, true);
    return { name: 'agent_finish', arguments: { summary: 'The requested page title was verified.', evidence: [result.toolCallId] } };
  });
  const child = await launch(['run', '--task', `Inspect [this page](${service.url}/form).`, '--direct-open-task-url', '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--max-steps', '2']);
  assert.deepEqual(service.errors, [], service.errors.map(error => error.message).join('\n'));
  assert.equal(child.code, 0, child.stderr + child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'succeeded');
  assert.deepEqual([report.tool_calls, report.planner_calls, service.requests.length], [2, 2, 2]);
});

test('CLI passes a final schema to the model and returns only corrected verified data', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-output-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemaPath = join(directory, 'receipt.schema.json');
  const schema = { type: 'object', properties: { title: { type: 'string', const: 'Agent CLI fixture' } }, required: ['title'], additionalProperties: false };
  await writeFile(schemaPath, JSON.stringify(schema));
  let sessionId, verificationId;
  const service = await fixture(t, (body, step) => {
    const finish = body.tools.find(item => item.function.name === 'agent_finish').function.parameters;
    assert.ok(finish.required.includes('data'));
    assert.deepEqual(finish.properties.data, schema);
    if (step === 1) return { name: 'tab_open', arguments: { url: `${service.url}/form` } };
    const previous = latest(body);
    if (step === 2) {
      sessionId = previous.structuredContent.session_id;
      return { name: 'tab_verify', arguments: { session_id: sessionId, checks: [{ kind: 'title', contains: 'Agent CLI fixture' }] } };
    }
    if (step === 3) {
      verificationId = previous.toolCallId;
      return { name: 'agent_finish', arguments: { summary: 'Title checked.', evidence: [verificationId], data: { title: 'invented title' } } };
    }
    assert.equal(step, 4);
    assert.ok(body.messages.some(item => typeof item.content === 'string' && item.content.includes('FINAL_OUTPUT_INVALID')));
    return { name: 'agent_finish', arguments: { summary: 'Title checked.', evidence: [verificationId], data: { title: 'Agent CLI fixture' } } };
  });
  const child = await launch(['run', '--task', 'Return the verified page title.', '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--output-schema', schemaPath, '--max-steps', '4']);
  assert.deepEqual(service.errors, [], service.errors.map(error => error.message).join('\n'));
  assert.equal(child.code, 0, child.stderr + child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'succeeded');
  assert.deepEqual(report.data, { title: 'Agent CLI fixture' });
  assert.equal(report.verification[0].tool_call_id, verificationId);
  assert.equal(report.verification[0].session_id, sessionId);
});

test('CLI publishes checked partials in an incomplete report with their verification', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-partial-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemaPath = join(directory, 'partial.json');
  const schema = { type: 'object', properties: { title: { type: 'string', const: 'Agent CLI fixture' } }, required: ['title'], additionalProperties: false };
  await writeFile(schemaPath, JSON.stringify(schema));
  let sessionId, verificationId;
  const service = await fixture(t, (body, step) => {
    const publish = body.tools.find(item => item.function.name === 'agent_publish')?.function.parameters;
    assert.ok(publish);
    assert.deepEqual(publish.properties.data, schema);
    if (step === 1) return { name: 'tab_open', arguments: { url: `${service.url}/form` } };
    const previous = latest(body);
    if (step === 2) {
      sessionId = previous.structuredContent.session_id;
      return { name: 'tab_verify', arguments: { session_id: sessionId, checks: [{ kind: 'title', contains: 'Agent CLI fixture' }] } };
    }
    if (step === 3) {
      verificationId = previous.toolCallId;
      return { name: 'agent_publish', arguments: { key: 'title', data: { title: 'Agent CLI fixture' }, evidence: [verificationId] } };
    }
    assert.equal(step, 4);
    assert.ok(body.messages.some(message => typeof message.content === 'string' && message.content.includes('Executor checked partial:')));
    return { name: 'agent_request_input', arguments: { question: 'Which record should be processed next?' } };
  });
  const child = await launch(['run', '--task', 'Check one title and then ask.', '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--partial-schema', schemaPath, '--max-steps', '4']);
  assert.deepEqual(service.errors, [], service.errors.map(error => error.message).join('\n'));
  assert.equal(child.code, 2, child.stderr + child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'needs_input');
  assert.equal(report.data, undefined);
  assert.deepEqual(report.partials.map(item => item.key), ['title']);
  assert.deepEqual(report.partials[0].data, { title: 'Agent CLI fixture' });
  assert.equal(report.partials[0].evidence[0].toolCallId, verificationId);
  assert.equal(report.partials[0].evidence[0].sessionId, sessionId);
});

test('run CLI returns human input with exit 2 and an explicit failure with exit 1', { timeout: 30_000 }, async t => {
  for (const kind of ['human_input', 'failure']) {
    const service = await fixture(t, () => kind === 'human_input'
      ? { name: 'agent_request_input', arguments: { question: 'Which account should be used?' } }
      : { name: 'agent_fail', arguments: { reason: 'The requested record does not exist.' } });
    const child = await launch(['run', '--task', 'Scripted terminal state.', '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint], { TABLAZE_API_KEY: 'default-env-fixture-key' });
    assert.deepEqual(service.errors, []);
    const report = JSON.parse(child.stdout);
    assert.equal(child.code, kind === 'human_input' ? 2 : 1, child.stderr);
    assert.equal(report.status, kind === 'human_input' ? 'needs_input' : 'failed');
    assert.equal(report.tool_calls, 0);
    assert.equal(report.steps, 1);
    assert.deepEqual(report.verification, []);
    if (kind === 'human_input') assert.equal(report.question, 'Which account should be used?');
    else assert.equal(report.reason, 'The requested record does not exist.');
    assert.equal(service.requests[0].headers.authorization, 'Bearer default-env-fixture-key');
    assert.equal((child.stdout + child.stderr).includes('default-env-fixture-key'), false);
  }
});

test('run CLI does not accept an unverified model completion and enforces the step limit', { timeout: 30_000 }, async t => {
  const service = await fixture(t, () => ({ name: 'agent_finish', arguments: { summary: 'An unsupported claim.', evidence: ['invented-verification'] } }));
  const child = await launch(['run', '--task', 'Must actually verify.', '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint, '--max-steps', '2']);
  assert.deepEqual(service.errors, []);
  assert.equal(child.code, 1);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'limit_reached');
  assert.equal(report.steps, 2);
  assert.equal(report.tool_calls, 0);
  assert.deepEqual(report.verification, []);
  assert.equal(service.requests.length, 2);
  assert.ok(service.requests[1].body.messages.some(message => typeof message.content === 'string' && message.content.includes('VERIFICATION_REQUIRED')));
});

test('CLI rejects agent-only options outside run and validates required arguments and limits', { timeout: 30_000 }, async () => {
  const directOnly = await launch(['doctor', '--direct-open-task-url']);
  assert.equal(directOnly.code, 1);
  assert.match(directOnly.stderr, /Agent options require the run command/);
  for (const [flag, value] of [['--task', 'x'], ['--model', 'fixture'], ['--endpoint', 'http://localhost/fixture'], ['--api-key-env', 'TEST_KEY'], ['--max-steps', '1'], ['--max-calls', '1'], ['--output-schema', '/tmp/schema.json'], ['--run-timeout-ms', '1000']]) {
    const child = await launch(['doctor', flag, value]);
    assert.equal(child.code, 1, flag);
    assert.equal(child.stdout, '', flag);
    assert.match(child.stderr, /Agent options require the run command/, flag);
  }
  const missing = await launch(['run', '--task', 'x']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /requires --task \(or --resume\), --model and --endpoint/);
  for (const [flag, value] of [['--max-steps', '0'], ['--max-calls', '10001'], ['--run-timeout-ms', 'NaN'], ['--api-key-env', 'invalid-name']]) {
    const child = await launch(['run', '--task', 'x', '--model', 'fixture', '--endpoint', 'http://localhost/fixture', flag, value]);
    assert.equal(child.code, 1, flag);
    assert.equal(child.stdout, '', flag);
    assert.ok(child.stderr.includes(flag), flag);
  }
});

test('CLI rejects invalid or changed final schema before restoring a browser', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-schema-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemaPath = join(directory, 'schema.json');
  await writeFile(schemaPath, JSON.stringify({ $ref: 'https://untrusted.example/schema.json' }));
  const base = ['run', '--task', 'Resume typed output.', '--model', 'scripted-cli-fixture', '--endpoint', 'http://127.0.0.1:1/unused'];
  const invalid = await launch([...base, '--output-schema', schemaPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /--output-schema/);
  assert.equal(invalid.stdout, '');
  const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  await writeFile(schemaPath, JSON.stringify(schema));
  const saved = await runAgent({ task: 'Resume typed output.', finalOutputSchema: schema, tools: { listTools: async () => [], callTool: async () => { throw new Error('unused'); } }, planner: async () => ({ type: 'human_input', question: 'Which ID?' }) });
  const checkpoint = join(directory, 'run.json');
  await writeFile(checkpoint, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), agent: saved.checkpoint, browser: { version: 1, sessions: [] } }));
  const missing = await launch(['run', '--resume', checkpoint, '--model', 'scripted-cli-fixture', '--endpoint', 'http://127.0.0.1:1/unused']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /original --output-schema/);
  await writeFile(schemaPath, JSON.stringify({ type: 'string' }));
  const changed = await launch(['run', '--resume', checkpoint, '--model', 'scripted-cli-fixture', '--endpoint', 'http://127.0.0.1:1/unused', '--output-schema', schemaPath]);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /original --output-schema/);
  assert.equal(changed.stdout, '');
});

test('CLI rejects a missing or changed partial schema before browser restoration', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-partial-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemaPath = join(directory, 'partial.json');
  const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  await writeFile(schemaPath, JSON.stringify(schema));
  const saved = await runAgent({ task: 'Resume checked partials.', partialOutputSchema: schema, tools: { listTools: async () => [], callTool: async () => { throw new Error('unused'); } }, planner: async () => ({ type: 'human_input', question: 'Which ID?' }) });
  const checkpoint = join(directory, 'run.json');
  await writeFile(checkpoint, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), agent: saved.checkpoint, browser: { version: 1, sessions: [] } }));
  const base = ['run', '--resume', checkpoint, '--model', 'scripted-cli-fixture', '--endpoint', 'http://127.0.0.1:1/unused'];
  const missing = await launch(base);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /original --partial-schema/);
  await writeFile(schemaPath, JSON.stringify({ type: 'string' }));
  const changed = await launch([...base, '--partial-schema', schemaPath]);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /original --partial-schema/);
  assert.equal(changed.stdout, '');
});

async function preload(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-cli-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'preload.mjs');
  await writeFile(path, `import { BrowserEngine, BrowserError } from ${JSON.stringify(new URL('../dist/browser.js', import.meta.url).href)};\n${body}\n`);
  return { directory, env: { NODE_OPTIONS: `--import=${pathToFileURL(path).href}` } };
}

test('CLI reports cleanup failure separately from an already verified successful agent result', { timeout: 30_000 }, async t => {
  const hook = await preload(t, `
    const dispose = BrowserEngine.prototype.dispose;
    BrowserEngine.prototype.dispose = async function () {
      await dispose.call(this);
      throw new BrowserError('CLEANUP_INCOMPLETE', 'Fixture cleanup could not finish.');
    };
  `);
  const service = await fixture(t, (body, step) => {
    if (step === 1) return { name: 'tab_open', arguments: { url: `${service.url}/form` } };
    const previous = latest(body);
    if (step === 2) return { name: 'tab_verify', arguments: { session_id: previous.structuredContent.session_id, checks: [{ kind: 'title', contains: 'Agent CLI fixture' }] } };
    return { name: 'agent_finish', arguments: { summary: 'Title verified.', evidence: [previous.toolCallId] } };
  });
  const child = await launch(['run', '--task', 'Verify the page title.', '--model', 'scripted-cli-fixture', '--endpoint', service.endpoint, '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome'], hook.env);
  assert.deepEqual(service.errors, []);
  assert.equal(child.code, 1);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'failed');
  assert.equal(report.agent_status, 'succeeded');
  assert.equal(report.agent_reason, 'Explicit verification passed.');
  assert.equal(report.summary, 'Title verified.');
  assert.equal(report.cleanup.status, 'incomplete');
  assert.equal(report.cleanup.code, 'CLEANUP_INCOMPLETE');
  assert.equal(report.verification.length, 1);
  assert.match(child.stderr, /Tablaze cleanup failed \(CLEANUP_INCOMPLETE\)/);
});

test('restoration abort handles a rejected asynchronous dispose without an unhandled rejection', { timeout: 10_000 }, async t => {
  const hook = await preload(t, `
    BrowserEngine.prototype.restoreWorkspace = async function () {
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 20);
      await new Promise((_, reject) => setTimeout(() => reject(new Error('RESTORE_FIXTURE_ABORTED')), 120));
    };
    BrowserEngine.prototype.dispose = async function () {
      throw new BrowserError('CLEANUP_INCOMPLETE', 'Fixture pending page cleanup.');
    };
  `);
  const saved = await runAgent({ task: 'Restore later.', tools: { listTools: async () => [], callTool: async () => { throw new Error('Unused'); } }, planner: async () => ({ type: 'human_input', question: 'Continue later?' }) });
  const path = join(hook.directory, 'run.json');
  await writeFile(path, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), agent: saved.checkpoint, browser: { version: 1, sessions: [] } }));
  const child = await launch(['run', '--resume', path, '--model', 'scripted-cli-fixture', '--endpoint', 'http://127.0.0.1:1/unused'], hook.env);
  assert.equal(child.code, 1);
  assert.match(child.stderr, /RESTORE_FIXTURE_ABORTED/, 'Execution reached the handled restoration failure after the abort-triggered cleanup rejection.');
  assert.equal(child.stderr.match(/Tablaze cleanup failed/g)?.length, 1);
  assert.doesNotMatch(child.stderr, /UnhandledPromiseRejection|triggerUncaughtException/);
});

test('CLI publishes bounded planner diagnostics without exposing endpoint, key, or upstream error text', { timeout: 10_000 }, async t => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'CODEX_TURN_FAILED', message: 'PRIVATE_PROVIDER_ERROR', apiKey: 'PRIVATE_DIAGNOSTIC_KEY' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/PRIVATE_ENDPOINT`;
  const child = await launch(['run', '--task', 'Report a provider failure.', '--model', 'scripted-cli-fixture', '--endpoint', endpoint], { TABLAZE_API_KEY: 'PRIVATE_DIAGNOSTIC_KEY' });
  assert.equal(child.code, 1);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.failure, { phase: 'planner', code: 'PLANNER_HTTP_ERROR', retryable: true, httpStatus: 502 });
  assert.equal(report.planner_calls, 1); assert.equal(report.tool_calls, 0); assert.equal(requests, 1);
  for (const hidden of [endpoint, 'PRIVATE_ENDPOINT', 'PRIVATE_DIAGNOSTIC_KEY', 'PRIVATE_PROVIDER_ERROR', 'CODEX_TURN_FAILED']) assert.equal((child.stdout + child.stderr).includes(hidden), false);
});
