import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connectAgentTools, runAgent } from '../dist/agent.js';
import { createServer } from '../dist/server.js';
import { AGENT_CHECKPOINT_VERSION, parseAgentCheckpoint } from '../dist/checkpoint.js';

const payload = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const ask = { type: 'human_input', question: 'Continue?' };
const task = 'Inspect the prepared pages.';

test('trusted initial actions reject invalid URLs and incompatible start modes before touching tools', async () => {
  let touches = 0;
  const tools = { listTools: async () => { touches++; return []; }, callTool: async () => { touches++; return payload({ ok: true }); } };
  for (const initialActions of [
    [],
    [{ url: 'file:///private/data' }],
    [{ url: 'https://user:password@example.test/' }],
    [{ url: 'https://example.test/', newTab: 'yes' }],
    [{ url: 'https://example.test/', extra: true }],
    [{ click: { name: 'Start' } }],
    [{ url: 'https://example.test/' }, { click: { name: ' ' } }],
    [{ url: 'https://example.test/' }, { click: { name: 'Start', role: 'textbox' } }],
    [{ url: 'https://example.test/' }, { click: { name: 'Start', extra: true } }],
    Array.from({ length: 21 }, () => ({ url: 'https://example.test/' })),
  ]) await assert.rejects(runAgent({ task, initialActions, tools, planner: async () => ask }), /initialActions|startUrl/);
  await assert.rejects(runAgent({ task, startUrl: 'https://example.test/', initialActions: [{ url: 'https://example.test/' }], tools, planner: async () => ask }), /cannot be combined/);
  assert.equal(touches, 0);
});

test('three pre-model navigations use one session, save standalone attempts, and never replay on resume', async () => {
  const calls = [];
  const snapshots = [];
  const tools = {
    listTools: async () => ['tab_open', 'tab_tabs', 'tab_navigate'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async request => {
      calls.push(structuredClone(request));
      return payload({ ok: true, session_id: 'session-1', snapshot_id: `snap-${calls.length}`, url: request.arguments.url, title: `Page ${calls.length}` });
    },
  };
  const actions = [
    { url: 'https://EXAMPLE.test/first', newTab: true },
    { url: 'https://example.test/second', newTab: true },
    { url: 'https://example.test/third' },
  ];
  const first = await runAgent({ task, initialActions: actions, tools, planner: async ({ step, messages }) => {
    assert.equal(step, 1);
    assert.equal(messages.filter(message => message.role === 'tool').length, 3);
    return ask;
  }, onCheckpoint: checkpoint => { snapshots.push(structuredClone(checkpoint)); parseAgentCheckpoint(checkpoint); } });
  assert.equal(first.status, 'needs_input');
  assert.deepEqual([first.steps, first.toolCalls, first.plannerCalls], [1, 3, 1]);
  assert.deepEqual(calls.map(({ name, arguments: args }) => [name, args]), [
    ['tab_open', { url: 'https://example.test/first' }],
    ['tab_tabs', { session_id: 'session-1', action: 'new', url: 'https://example.test/second' }],
    ['tab_navigate', { session_id: 'session-1', action: 'goto', url: 'https://example.test/third' }],
  ]);
  assert.equal(first.checkpoint.schemaVersion, AGENT_CHECKPOINT_VERSION);
  assert.deepEqual(first.checkpoint.initialActions.attempts.map(item => item.state), ['succeeded', 'succeeded', 'succeeded']);
  assert.deepEqual(snapshots.filter(item => item.phase === 'before_tool').map(item => item.initialActions.attempts.length), [1, 2, 3]);
  const resumed = await runAgent({ task, resume: first.checkpoint, initialActions: actions, tools, planner: async () => ask });
  assert.equal(resumed.status, 'needs_input');
  assert.equal(calls.length, 3);
  await assert.rejects(runAgent({ task, resume: first.checkpoint, initialActions: [{ url: 'https://example.test/changed' }], tools, planner: async () => ask }), /cannot add or change/);
  const tampered = structuredClone(first.checkpoint);
  tampered.initialActions.actions[1].url = 'https://example.test/other';
  assert.throws(() => parseAgentCheckpoint(tampered), /manifest/);
  const forged = structuredClone(first.checkpoint);
  forged.initialActions.attempts[1].state = 'attempted';
  delete forged.initialActions.attempts[1].sessionId;
  assert.throws(() => parseAgentCheckpoint(forged), /unsettled|impossible/);
});

test('resume after a completed first action continues only the remaining action in a restored session', async () => {
  const actions = [{ url: 'https://example.test/first' }, { url: 'https://example.test/second', newTab: true }];
  let intermediate;
  const firstTools = {
    listTools: async () => ['tab_open', 'tab_tabs'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async request => payload({ ok: true, session_id: 'old-session', snapshot_id: 'old-snapshot', url: request.arguments.url }),
  };
  await runAgent({ task, initialActions: actions, tools: firstTools, planner: async () => ask,
    onCheckpoint: checkpoint => {
      if (checkpoint.phase === 'after_tool' && checkpoint.initialActions?.attempts.length === 1) intermediate = structuredClone(checkpoint);
    },
  });
  assert.ok(intermediate);
  parseAgentCheckpoint(intermediate);
  const calls = [];
  const restoredTools = {
    listTools: firstTools.listTools,
    callTool: async request => { calls.push(request); return payload({ ok: true, session_id: 'restored-session', snapshot_id: 'new-snapshot', url: request.arguments.url }); },
  };
  const resumed = await runAgent({ task, resume: intermediate, resumeSessionMap: { 'old-session': 'restored-session' }, tools: restoredTools, planner: async () => ask });
  assert.equal(resumed.status, 'needs_input');
  assert.deepEqual(calls, [{ name: 'tab_tabs', arguments: { session_id: 'restored-session', action: 'new', url: 'https://example.test/second' } }]);
  assert.deepEqual(resumed.checkpoint.initialActions.attempts.map(item => item.state), ['succeeded', 'succeeded']);
  parseAgentCheckpoint(resumed.checkpoint);
});

test('failed preparation stops the trusted sequence and lets the planner inspect the failure', async () => {
  const actions = [{ url: 'https://example.test/first' }, { url: 'https://example.test/second', newTab: true }];
  let calls = 0;
  const tools = {
    listTools: async () => ['tab_open', 'tab_tabs'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async () => { calls++; return payload({ ok: false, error: { code: 'NAVIGATION_FAILED' } }); },
  };
  const run = await runAgent({ task, initialActions: actions, tools, planner: async ({ messages }) => {
    assert.equal(messages.filter(message => message.role === 'tool').length, 1);
    return ask;
  } });
  assert.equal(run.status, 'needs_input');
  assert.equal(calls, 1);
  assert.equal(run.checkpoint.initialActions.attempts[0].state, 'failed');
  parseAgentCheckpoint(run.checkpoint);
});

test('version-five checkpoints migrate without inventing a pre-model sequence', async () => {
  const tools = { listTools: async () => [], callTool: async () => payload({ ok: true }) };
  const run = await runAgent({ task, tools, planner: async () => ask });
  const old = { ...run.checkpoint, schemaVersion: 5 };
  const migrated = parseAgentCheckpoint(old);
  assert.equal(migrated.schemaVersion, AGENT_CHECKPOINT_VERSION);
  assert.equal(migrated.initialActions, undefined);
  assert.throws(() => parseAgentCheckpoint({ ...old, initialActions: { actions: [{ url: 'https://example.test/' }], attempts: [] } }), /version 5/);
});

test('an uncertain second initial action is never replayed after reconciliation', async () => {
  let calls = 0; let plans = 0;
  const controller = new AbortController();
  const actions = [{ url: 'https://example.test/first' }, { url: 'https://example.test/second', newTab: true }];
  const tools = {
    listTools: async () => ['tab_open', 'tab_tabs'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async request => {
      calls++;
      if (request.name === 'tab_open') return payload({ ok: true, session_id: 's1', snapshot_id: 'first' });
      controller.abort();
      return new Promise(() => {});
    },
  };
  const first = await runAgent({ task, initialActions: actions, tools, signal: controller.signal, planner: async () => { plans++; return ask; } });
  assert.equal(first.status, 'cancelled');
  assert.equal(first.checkpoint.initialActions.attempts[1].state, 'attempted');
  assert.equal(calls, 2);
  parseAgentCheckpoint(first.checkpoint);
  const blocked = await runAgent({ task, resume: first.checkpoint, tools, planner: async () => { plans++; return ask; } });
  assert.equal(blocked.status, 'needs_input');
  assert.equal(plans, 0);
  const resumed = await runAgent({ task, resume: first.checkpoint, tools, reconciliation: { resolvedCallIds: [first.checkpoint.initialActions.attempts[1].toolCallId], note: 'Checked the open tabs.' }, planner: async () => { plans++; return ask; } });
  assert.equal(resumed.status, 'needs_input');
  assert.deepEqual([calls, plans], [2, 1]);
});

test('exact-name click is checkpointed, validated and never replayed after resume', async () => {
  const calls = [];
  const actions = [{ url: 'https://example.test/prepare' }, { click: { name: 'Prepare task', role: 'button' } }];
  const tools = {
    listTools: async () => ['tab_open', 'tab_click_named'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async request => {
      calls.push(structuredClone(request));
      return payload(request.name === 'tab_open'
        ? { ok: true, session_id: 'session-1', snapshot_id: 'first' }
        : { ok: true, session_id: 'session-1', batch_complete: true, completed: 1, snapshot: { text: 'Prepared' } });
    },
  };
  const first = await runAgent({ task, initialActions: actions, tools, planner: async ({ messages }) => {
    assert.deepEqual(messages.filter(message => message.role === 'tool').map(message => message.name), ['tab_open', 'tab_click_named']);
    return ask;
  } });
  assert.equal(first.status, 'needs_input');
  assert.deepEqual(calls.map(call => [call.name, call.arguments]), [
    ['tab_open', { url: 'https://example.test/prepare' }],
    ['tab_click_named', { session_id: 'session-1', name: 'Prepare task', role: 'button' }],
  ]);
  assert.deepEqual(first.checkpoint.initialActions.attempts.map(item => item.state), ['succeeded', 'succeeded']);
  parseAgentCheckpoint(first.checkpoint);
  const tampered = structuredClone(first.checkpoint);
  tampered.initialActions.actions[1].click.name = 'Another button';
  assert.throws(() => parseAgentCheckpoint(tampered), /manifest/);
  const invalidFirst = structuredClone(first.checkpoint);
  invalidFirst.initialActions.actions[0] = { click: { name: 'Prepare task' } };
  assert.throws(() => parseAgentCheckpoint(invalidFirst), /begin with a navigation/);
  const resumed = await runAgent({ task, resume: first.checkpoint, tools, planner: async () => ask });
  assert.equal(resumed.status, 'needs_input');
  assert.equal(calls.length, 2);
  const old = { ...first.checkpoint, schemaVersion: 6 };
  assert.throws(() => parseAgentCheckpoint(old), /version 6/, 'Version 6 cannot gain a click action retrospectively');
});

test('version-six navigation checkpoints migrate without changing their trusted calls', async () => {
  const tools = {
    listTools: async () => ['tab_open'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async () => payload({ ok: true, session_id: 's1', snapshot_id: 'snapshot' }),
  };
  const run = await runAgent({ task, initialActions: [{ url: 'https://example.test/' }], tools, planner: async () => ask });
  const migrated = parseAgentCheckpoint({ ...run.checkpoint, schemaVersion: 6 });
  assert.equal(migrated.schemaVersion, AGENT_CHECKPOINT_VERSION);
  assert.deepEqual(migrated.initialActions, run.checkpoint.initialActions);
});

test('uncertain trusted click is not repeated after cancellation or reconciliation', async () => {
  const controller = new AbortController();
  const actions = [{ url: 'https://example.test/prepare' }, { click: { name: 'Prepare task' } }];
  let clicks = 0, plans = 0;
  const tools = {
    listTools: async () => ['tab_open', 'tab_click_named'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } })),
    callTool: async request => {
      if (request.name === 'tab_open') return payload({ ok: true, session_id: 's1', snapshot_id: 'first' });
      clicks++; controller.abort(); return new Promise(() => {});
    },
  };
  const first = await runAgent({ task, initialActions: actions, tools, signal: controller.signal, planner: async () => { plans++; return ask; } });
  assert.equal(first.status, 'cancelled');
  assert.equal(first.checkpoint.initialActions.attempts[1].state, 'attempted');
  parseAgentCheckpoint(first.checkpoint);
  const blocked = await runAgent({ task, resume: first.checkpoint, tools, planner: async () => { plans++; return ask; } });
  assert.equal(blocked.status, 'needs_input');
  assert.deepEqual([clicks, plans], [1, 0]);
  const reconciled = await runAgent({ task, resume: first.checkpoint, tools, reconciliation: { resolvedCallIds: [first.checkpoint.initialActions.attempts[1].toolCallId], note: 'Checked the actual click effect.' }, planner: async () => { plans++; return ask; } });
  assert.equal(reconciled.status, 'needs_input');
  assert.deepEqual([clicks, plans], [1, 1]);
});

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out: ${stderr}`)); }, 30_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('CLI prepares two owned Chrome tabs before the model and restores without dispatching either action again', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-initial-actions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkpointPath = join(directory, 'checkpoint.json');
  const actionsPath = join(directory, 'actions.json');
  let firstLoads = 0; let secondLoads = 0; let modelCalls = 0;
  const errors = [];
  const server = createHttpServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/first') { firstLoads++; response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>First prepared tab</title><p>First</p>'); return; }
    if (request.url === '/second') { secondLoads++; response.writeHead(200, { 'content-type': 'text/html' }); response.end('<title>Second prepared tab</title><p>Second</p>'); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      modelCalls++;
      const toolCalls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
      assert.deepEqual(toolCalls.map(item => item.function.name), ['tab_open', 'tab_tabs']);
      const observations = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).structuredContent);
      assert.deepEqual(observations.map(item => item.title), ['First prepared tab', 'Second prepared tab']);
      assert.equal(observations[0].session_id, observations[1].session_id);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'What should I inspect next?' }) } }] } }] }));
    } catch (error) { errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await writeFile(actionsPath, JSON.stringify([{ url: `${base}/first`, newTab: true }, { url: `${base}/second`, newTab: true }]));
  const common = ['run', '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--model', 'scripted-initial-actions', '--endpoint', `${base}/chat/completions`];
  const first = await launch([...common, '--task', task, '--initial-actions', actionsPath, '--checkpoint', checkpointPath]);
  assert.equal(first.code, 2, first.stderr);
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.deepEqual(saved.agent.initialActions.attempts.map(item => item.state), ['succeeded', 'succeeded']);
  assert.equal(saved.browser.sessions.length, 1);
  assert.equal(saved.browser.sessions[0].tabs.length, 2);
  assert.deepEqual([firstLoads, secondLoads, modelCalls], [1, 1, 1]);
  const resumed = await launch([...common, '--resume', checkpointPath]);
  assert.equal(resumed.code, 2, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).tool_calls, 2);
  assert.deepEqual([firstLoads, secondLoads, modelCalls], [2, 2, 2], 'Only workspace restoration reloads each URL.');
  assert.deepEqual(errors, []);
  const updated = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.deepEqual(updated.agent.initialActions.attempts, saved.agent.initialActions.attempts);
});

test('exact-name browser click refuses ambiguous controls without dispatching input', { timeout: 30_000 }, async t => {
  let writes = 0;
  const fixture = createHttpServer((request, response) => {
    if (request.url === '/write') { writes++; response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<button onclick="fetch(\'/write\')">Prepare task</button><button onclick="fetch(\'/write\')">Prepare task</button>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL || 'chrome' });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const opened = await connection.tools.callTool({ name: 'tab_open', arguments: { url: `http://127.0.0.1:${fixture.address().port}/` } }, { signal: AbortSignal.timeout(15_000) });
  assert.equal(opened.structuredContent.ok, true);
  const clicked = await connection.tools.callTool({ name: 'tab_click_named', arguments: { session_id: opened.structuredContent.session_id, name: 'Prepare task', role: 'button' } }, { signal: AbortSignal.timeout(15_000) });
  assert.equal(clicked.structuredContent.error.code, 'AMBIGUOUS_TARGET');
  assert.equal(writes, 0);
});

test('CLI clicks one trusted named control before planning and never replays it on resume', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-initial-click-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkpointPath = join(directory, 'checkpoint.json'), actionsPath = join(directory, 'actions.json');
  let writes = 0, modelCalls = 0;
  const errors = [];
  const fixture = createHttpServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/prepare') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<title>Preparation</title><button onclick="document.querySelector(\'#status\').textContent=\'Prepared\';fetch(\'/commit\',{method:\'POST\',keepalive:true})">Prepare task</button><p id="status">Ready</p>'); return;
    }
    if (request.url === '/commit') { writes++; response.writeHead(204); response.end(); return; }
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); modelCalls++;
      const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
      assert.deepEqual(calls.map(call => call.function.name), ['tab_open', 'tab_click_named']);
      const observations = body.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).structuredContent);
      assert.equal(observations[1].batch_complete, true);
      assert.equal(observations[1].completed, 1);
      assert.match(observations[1].snapshot.text, /Prepared/);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Continue?' }) } }] } }] }));
    } catch (error) { errors.push(error); response.writeHead(500); response.end('{}'); }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const base = `http://127.0.0.1:${fixture.address().port}`;
  await writeFile(actionsPath, JSON.stringify([{ url: `${base}/prepare` }, { click: { name: 'Prepare task', role: 'button' } }]));
  const common = ['run', '--channel', process.env.TABLAZE_BROWSER_CHANNEL || 'chrome', '--model', 'scripted-initial-click', '--endpoint', `${base}/chat/completions`];
  const first = await launch([...common, '--task', task, '--initial-actions', actionsPath, '--checkpoint', checkpointPath]);
  assert.equal(first.code, 2, first.stderr);
  const saved = JSON.parse(await readFile(checkpointPath, 'utf8'));
  assert.deepEqual(saved.agent.initialActions.attempts.map(item => item.state), ['succeeded', 'succeeded']);
  assert.deepEqual([writes, modelCalls], [1, 1]);
  const resumed = await launch([...common, '--resume', checkpointPath]);
  assert.equal(resumed.code, 2, resumed.stderr);
  assert.deepEqual([writes, modelCalls], [1, 2], 'Workspace restore may reload the page but must not click again.');
  assert.deepEqual(errors, []);
});
