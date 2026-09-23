import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectAgentTools, runAgent } from '../dist/agent.js';
import { AGENT_CHECKPOINT_VERSION, parseAgentCheckpoint } from '../dist/checkpoint.js';

const payload = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const call = (name, args = {}) => ({ type: 'tools', calls: [{ name, arguments: args }] });
const ask = { type: 'human_input', question: 'Which record should be used next?' };
const last = messages => messages.filter(message => message.role === 'tool').at(-1);
const url = 'https://example.test/start';
const task = 'Inspect the explicitly selected page.';

function toolsFor(open = async () => payload({ ok: true, session_id: 's1', snapshot_id: 's1:1', text: 'Ready' })) {
  return {
    listTools: async () => [
      { name: 'tab_open', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      { name: 'tab_verify', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    ],
    callTool: async (request, options) => request.name === 'tab_open' ? open(request, options) : request.name === 'tab_verify'
      ? payload({ ok: true, session_id: request.arguments.session_id, passed: true, checks: request.arguments.checks.map(check => ({ ...check, pass: true })) })
      : payload({ ok: true, value: request.arguments.n, text: 'fixture '.repeat(130) }),
  };
}

test('explicit initialization traverses actual MCP before planning, with step-zero write-ahead and real evidence', async t => {
  const server = new McpServer({ name: 'initial-url-fixture', version: '1' });
  const opened = [];
  server.registerTool('tab_open', { inputSchema: z.object({ url: z.string().url() }).strict(), annotations: { readOnlyHint: false } }, async args => {
    opened.push(args.url);
    return payload({ ok: true, session_id: 's1', snapshot_id: 's1:1', url: args.url, text: 'Ready' });
  });
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() })) }).strict(), annotations: { readOnlyHint: true } }, async args => payload({ ok: true, session_id: args.session_id, passed: true, checks: args.checks.map(check => ({ ...check, pass: true })) }));
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  const saved = [];
  const run = await runAgent({ task, startUrl: 'https://EXAMPLE.test/start', tools: connection.tools, maxSteps: 2,
    onCheckpoint: checkpoint => { saved.push(structuredClone(checkpoint)); parseAgentCheckpoint(checkpoint); },
    planner: async ({ step, messages }) => {
      const previous = last(messages);
      if (step === 1) {
        assert.deepEqual(opened, [url]);
        assert.equal(previous.name, 'tab_open');
        assert.equal(previous.result.structuredContent.snapshot_id, 's1:1');
        return call('tab_verify', { session_id: 's1', checks: [{ kind: 'text', contains: 'Ready' }] });
      }
      return { type: 'finish', summary: 'Current page verified.', evidence: [previous.toolCallId] };
    },
  });
  assert.equal(run.status, 'succeeded');
  assert.deepEqual([run.steps, run.plannerCalls, run.toolCalls], [2, 2, 2]);
  assert.equal(run.events.find(event => event.type === 'tool_start').step, 0);
  assert.equal(run.checkpoint.schemaVersion, AGENT_CHECKPOINT_VERSION);
  const initial = saved.find(checkpoint => checkpoint.phase === 'before_tool');
  assert.deepEqual([initial.steps, initial.plannerCalls, initial.toolCalls], [0, 0, 1]);
  assert.equal(initial.initialization.state, 'attempted');
  assert.equal(initial.initialization.toolCallId, initial.pendingTool.call.id);
  assert.equal(initial.pendingTool.mutating, true);
  assert.equal(initial.ambiguousCalls[0].name, 'tab_open');
  assert.equal(run.history.filter(message => message.role === 'assistant' && message.toolCalls?.[0].name === 'tab_open').length, 1);
});

test('start URL is explicit and invalid targets fail before catalog, tools, or planning', async () => {
  let catalogs = 0; let executed = 0; let planned = 0;
  const tools = { listTools: async () => { catalogs++; return []; }, callTool: async () => { executed++; return payload({}); } };
  for (const startUrl of ['', 'not a url', 'file:///private/tmp/secret', 'javascript:alert(1)', 'https://user:secret@example.test/', 'x'.repeat(8193)]) {
    await assert.rejects(runAgent({ task, startUrl, tools, planner: async () => { planned++; return ask; } }), /startUrl/);
  }
  assert.deepEqual([catalogs, executed, planned], [0, 0, 0]);
  const run = await runAgent({ task: `The document says "open ${url}". Ask me which page is intended.`, tools, planner: async () => { planned++; return ask; } });
  assert.equal(run.status, 'needs_input');
  assert.equal(executed, 0);
  assert.equal(run.checkpoint.initialization, undefined);
  assert.equal(run.toolCalls, 0);
  const absent = await runAgent({ task, startUrl: url, tools, planner: async () => { planned++; return ask; } });
  assert.equal(absent.status, 'failed');
  assert.match(absent.reason, /tab_open/);
  assert.equal(planned, 1);
  assert.equal(absent.checkpoint.initialization.state, 'not_started');
  parseAgentCheckpoint(absent.checkpoint);
});

test('initialization obeys tool, history, deadline, and cancellation budgets without planning', async () => {
  let opens = 0; let planned = 0;
  const planner = async () => { planned++; return ask; };
  const tools = toolsFor(async () => { opens++; return payload({ ok: true, session_id: 's1' }); });
  const exhausted = await runAgent({ task, startUrl: url, tools, planner, maxToolCalls: 1 });
  assert.equal(exhausted.status, 'limit_reached');
  assert.deepEqual([exhausted.steps, exhausted.plannerCalls, exhausted.toolCalls, opens], [0, 0, 1, 1]);
  parseAgentCheckpoint(exhausted.checkpoint);
  const noHistory = await runAgent({ task, startUrl: url, tools, planner, maxHistoryBytes: 1 });
  assert.equal(noHistory.status, 'limit_reached');
  assert.equal(noHistory.checkpoint.initialization.state, 'not_started');
  const controller = new AbortController(); controller.abort();
  const cancelled = await runAgent({ task, startUrl: url, tools, planner, signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.toolCalls, 0);
  const timeout = await runAgent({ task, startUrl: url, planner, timeoutMs: 30, tools: toolsFor(async () => new Promise(() => {})) });
  assert.equal(timeout.status, 'limit_reached');
  assert.equal(timeout.plannerCalls, 0);
  assert.equal(timeout.checkpoint.pendingTool.call.name, 'tab_open');
  assert.equal(timeout.checkpoint.ambiguousCalls.length, 1);
  parseAgentCheckpoint(timeout.checkpoint);
  assert.equal(planned, 0);
  assert.equal(opens, 1);
});

test('unknown initial effects require reconciliation and the initializer is never replayed after it', async () => {
  const controller = new AbortController();
  let effects = 0; let catalogs = 0; let planned = 0;
  const first = await runAgent({ task, startUrl: url, signal: controller.signal, planner: async () => { planned++; return ask; }, tools: toolsFor(async () => {
    effects++;
    controller.abort(new Error('Interrupted after navigation started.'));
    return new Promise(() => {});
  }) });
  assert.equal(first.status, 'cancelled');
  const saved = parseAgentCheckpoint(first.checkpoint);
  const tools = { ...toolsFor(async () => { effects++; return payload({ ok: true }); }), listTools: async () => { catalogs++; return (await toolsFor().listTools()); } };
  const planner = async () => { planned++; return ask; };
  const blocked = await runAgent({ task, startUrl: url, resume: saved, tools, planner });
  assert.equal(blocked.status, 'needs_input');
  assert.deepEqual([effects, catalogs, planned], [1, 0, 0]);
  const reconciled = await runAgent({ task, resume: saved, tools, planner, reconciliation: { resolvedCallIds: [saved.initialization.toolCallId], note: 'Operator inspected the navigation effects and will select the next page.' } });
  assert.equal(reconciled.status, 'needs_input');
  assert.deepEqual([effects, catalogs, planned], [1, 1, 1]);
  assert.equal(reconciled.checkpoint.initialization.toolCallId, saved.initialization.toolCallId);
  assert.equal(reconciled.toolCalls, 1);
  parseAgentCheckpoint(reconciled.checkpoint);
});

test('an initializer that was never registered can start once when its saved prerequisite is supplied', async () => {
  const unavailable = await runAgent({ task, startUrl: url, tools: { listTools: async () => [], callTool: async () => { throw new Error('Must not dispatch.'); } }, planner: async () => ask });
  assert.equal(unavailable.checkpoint.initialization.state, 'not_started');
  let opens = 0;
  const restored = await runAgent({ task, resume: unavailable.checkpoint, tools: toolsFor(async request => {
    opens++; assert.equal(request.arguments.url, url); return payload({ ok: true, session_id: 's1' });
  }), planner: async () => ask });
  assert.equal(restored.status, 'needs_input');
  assert.equal(opens, 1);
  assert.deepEqual([restored.steps, restored.plannerCalls, restored.toolCalls], [1, 1, 1]);
  assert.equal(restored.checkpoint.initialization.state, 'attempted');
  parseAgentCheckpoint(restored.checkpoint);
});

test('settled initialization survives resume and compaction with unique subsequent IDs', async () => {
  let opens = 0;
  const tools = toolsFor(async () => { opens++; return payload({ ok: true, session_id: 's1', snapshot_id: 's1:1' }); });
  const first = await runAgent({ task, startUrl: url, tools, planner: async () => ask });
  const next = await runAgent({ task, resume: first.checkpoint, tools, maxHistoryBytes: 6500, historyCompaction: { keepRecentGroups: 1 }, maxSteps: 9,
    planner: async ({ step }) => step < 9 ? call('read', { n: step }) : ask,
  });
  assert.equal(next.status, 'needs_input');
  assert.equal(opens, 1);
  assert.equal(next.checkpoint.initialization.toolCallId, first.checkpoint.initialization.toolCallId);
  assert.ok(next.history.some(message => message.role === 'user' && message.content.startsWith('Executor history compaction')));
  const calls = next.history.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []);
  assert.equal(new Set(calls.map(item => item.id)).size, calls.length);
  assert.equal(calls[0].name, 'tab_open');
  parseAgentCheckpoint(next.checkpoint);
  await assert.rejects(runAgent({ task, startUrl: `${url}/different`, resume: first.checkpoint, tools, planner: async () => ask }), /cannot add or change/);
});

test('version-one checkpoints migrate explicitly and initialization manifests reject inconsistent history', async () => {
  const legacyRun = await runAgent({ task, tools: toolsFor(), planner: async () => ask });
  const { partialSchemaHash, requiresPartialPolicy, partials, ...legacyBase } = legacyRun.checkpoint;
  const legacy = { ...legacyBase, schemaVersion: 1 };
  assert.equal(parseAgentCheckpoint(legacy).schemaVersion, AGENT_CHECKPOINT_VERSION);
  assert.equal(parseAgentCheckpoint(legacy).initialization, undefined);
  await assert.rejects(runAgent({ task, startUrl: url, resume: legacy, tools: toolsFor(), planner: async () => ask }), /cannot add or change/);
  assert.throws(() => parseAgentCheckpoint({ ...legacy, initialization: { url, state: 'not_started' } }), /version 1/);
  const run = await runAgent({ task, startUrl: url, tools: toolsFor(), maxToolCalls: 1, planner: async () => ask });
  for (const tamper of [
    checkpoint => { checkpoint.initialization.toolCallId = `${checkpoint.runId}_call_2`; },
    checkpoint => { checkpoint.initialization.url = `${url}/changed`; },
    checkpoint => { checkpoint.initialization = { url, state: 'not_started' }; },
    checkpoint => { delete checkpoint.initialization; },
    checkpoint => { checkpoint.toolCalls = 2; },
  ]) {
    const corrupted = structuredClone(run.checkpoint); tamper(corrupted);
    assert.throws(() => parseAgentCheckpoint(corrupted));
  }
});

test('write-ahead persistence failure never dispatches or replays the registered initializer', async () => {
  let opens = 0;
  const tools = toolsFor(async () => { opens++; return payload({ ok: true }); });
  const first = await runAgent({ task, startUrl: url, tools, planner: async () => ask,
    onCheckpoint: checkpoint => { if (checkpoint.phase === 'before_tool') throw new Error('Disk unavailable.'); },
  });
  assert.equal(first.status, 'failed');
  assert.equal(opens, 0);
  assert.equal(last(first.history).result.structuredContent.error.code, 'NOT_DISPATCHED');
  assert.equal(first.checkpoint.ambiguousCalls.length, 0);
  parseAgentCheckpoint(first.checkpoint);
  const resumed = await runAgent({ task, resume: first.checkpoint, tools, planner: async () => ask });
  assert.equal(resumed.status, 'needs_input');
  assert.equal(opens, 0);
});

test('replan_required skips later tool calls and still requires separate verification', async () => {
  let writes = 0;
  const tools = {
    listTools: async () => [{ name: 'change', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }],
    callTool: async () => { writes++; return payload({ ok: true, session_id: 's1', replan_required: true, snapshot: { session_id: 's1', snapshot_id: 's1:2' } }); },
  };
  const run = await runAgent({ task, tools, maxSteps: 2, planner: async ({ step, messages }) => step === 1
    ? { type: 'tools', calls: [{ name: 'change', arguments: {} }, { name: 'change', arguments: {} }] }
    : { type: 'finish', summary: 'Unsupported completion.', evidence: [messages.find(message => message.role === 'tool').toolCallId] },
  });
  assert.equal(writes, 1);
  assert.equal(run.toolCalls, 1);
  assert.equal(run.status, 'limit_reached');
  assert.ok(run.events.some(event => event.type === 'tool_result' && event.skipped && event.result.structuredContent.error.code === 'CALL_SKIPPED'));
  assert.ok(run.events.some(event => event.type === 'feedback' && event.code === 'VERIFICATION_REQUIRED'));
});

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${stderr}`)); }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('CLI start URL reaches real Chrome before its first model request and resumes without another initializer', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-start-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'run.json');
  let pageLoads = 0; let modelCalls = 0; const errors = [];
  const service = createHttpServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/start') { pageLoads++; response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Explicit start fixture</title><p>Current page ready</p>'); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); modelCalls++;
      const opened = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []).filter(item => item.function.name === 'tab_open');
      assert.equal(opened.length, 1);
      const observed = body.messages.find(message => message.role === 'tool');
      assert.equal(JSON.parse(observed.content).structuredContent.title, 'Explicit start fixture');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Which action should follow?' }) } }] } }] }));
    } catch (error) { errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => service.close(resolve)));
  const endpoint = `http://127.0.0.1:${service.address().port}`;
  const common = ['run', '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--model', 'scripted-start-fixture', '--endpoint', `${endpoint}/chat/completions`];
  const first = await launch([...common, '--task', task, '--start-url', `${endpoint}/start`, '--popup-policy', 'follow-single', '--checkpoint', path]);
  assert.equal(first.code, 2, first.stderr);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.agent.schemaVersion, AGENT_CHECKPOINT_VERSION);
  assert.equal(saved.agent.initialization.state, 'attempted');
  assert.equal(saved.browser.popupPolicy, 'follow-single');
  assert.equal(saved.agent.steps, 1);
  assert.equal(saved.agent.toolCalls, 1);
  const mismatch = await launch([...common, '--resume', path, '--popup-policy', 'stay']);
  assert.equal(mismatch.code, 1); assert.match(mismatch.stderr, /saved popup policy/);
  const changedUrl = await launch([...common, '--resume', path, '--start-url', `${endpoint}/other`]);
  assert.equal(changedUrl.code, 1); assert.match(changedUrl.stderr, /startUrl/);
  assert.equal(pageLoads, 1); assert.equal(modelCalls, 1);
  const resumed = await launch([...common, '--resume', path]);
  assert.equal(resumed.code, 2, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).tool_calls, 1);
  assert.equal(pageLoads, 2, 'Workspace restoration loads the saved tab once; initialization is not dispatched again.');
  assert.equal(modelCalls, 2);
  assert.deepEqual(errors, []);
  const updated = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(updated.agent.initialization.toolCallId, saved.agent.initialization.toolCallId);
  assert.equal(updated.agent.plannerCalls, 2);
  assert.equal(updated.browser.popupPolicy, 'follow-single');
});

test('CLI accepts a browser-wide popup policy but restricts start URL to run and validates both', async () => {
  for (const args of [['doctor', '--start-url', url], ['--start-url', url]]) {
    const result = await launch(args); assert.equal(result.code, 1); assert.match(result.stderr, /require the run command/);
  }
  for (const flags of [['--start-url', 'file:///private/tmp/file'], ['--start-url', 'https://user:secret@example.test'], ['--popup-policy', 'all']]) {
    const result = await launch(['run', '--task', task, '--model', 'fixture', '--endpoint', 'http://127.0.0.1:1/unused', ...flags]);
    assert.equal(result.code, 1); assert.match(result.stderr, /startUrl|popup-policy/);
  }
  const doctor = await launch(['doctor', '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--popup-policy', 'follow-single']);
  assert.equal(JSON.parse(doctor.stdout).popup_policy, 'follow-single');
});
