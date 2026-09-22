import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentPlannerError, connectAgentTools, createOpenAICompatiblePlanner, runAgent } from '../dist/agent.js';
import { AGENT_CHECKPOINT_VERSION, parseAgentCheckpoint } from '../dist/checkpoint.js';

const secret = 'SECRET_TOKEN https://private.invalid/api?key=PRIVATE_KEY';
const broken = () => Object.assign(new Error(secret, { cause: { apiKey: secret } }), { code: secret, httpStatus: secret });
const input = () => ({ type: 'human_input', question: 'Review the current state?' });
const call = (name, arguments_) => ({ type: 'tools', calls: [{ name, arguments: arguments_ }] });
const data = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

async function fixture(t) {
  const server = new McpServer({ name: 'diagnostic-fixture', version: '1' });
  let writes = 0;
  server.registerTool('change', { inputSchema: z.object({}).strict(), annotations: { readOnlyHint: false } }, async () => { writes++; return data({ ok: true, session_id: 's1' }); });
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() })) }).strict(), annotations: { readOnlyHint: true } }, async args => data({ ok: true, session_id: args.session_id, passed: true, checks: args.checks.map(check => ({ kind: check.kind, pass: true, actual: 'Saved' })) }));
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  return { ...connection, writes: () => writes };
}
function diagnostic(result, expected) {
  assert.deepEqual(result.failure, expected);
  assert.deepEqual(result.events.filter(event => event.type === 'failure').at(-1), { type: 'failure', step: result.steps, failure: expected });
  const serialized = JSON.stringify(result);
  for (const text of ['SECRET_TOKEN', 'private.invalid', 'PRIVATE_KEY']) assert.equal(serialized.includes(text), false);
  assert.equal(Object.hasOwn(result.checkpoint, 'failure'), false, 'Diagnostics do not alter the versioned checkpoint schema.');
  assert.equal(parseAgentCheckpoint(result.checkpoint).schemaVersion, AGENT_CHECKPOINT_VERSION);
}
const verifiedPlanner = async ({ step, messages }) => step === 1
  ? call('tab_verify', { session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] })
  : { type: 'finish', summary: 'The state was verified.', evidence: [messages.filter(message => message.role === 'tool').at(-1).toolCallId] };

test('HTTP planner failures expose only status and fixed classification without enabling default retries', async t => {
  const runtime = await fixture(t);
  for (const status of [401, 408, 429, 502]) {
    let requests = 0;
    const planner = createOpenAICompatiblePlanner({ endpoint: 'https://private.invalid/api?key=PRIVATE_KEY', apiKey: secret, model: 'fixture', fetch: async () => { requests++; return new Response(JSON.stringify({ code: 'CODEX_TURN_FAILED', message: secret }), { status }); } });
    const result = await runAgent({ task: 'Classify a failed request.', tools: runtime.tools, planner });
    assert.equal(result.status, 'failed');
    assert.equal(requests, 1); assert.equal(result.plannerCalls, 1); assert.equal(result.toolCalls, 0);
    assert.equal(result.metrics[0].outcome, 'error');
    diagnostic(result, { phase: 'planner', code: 'PLANNER_HTTP_ERROR', retryable: status !== 401, httpStatus: status });
    assert.equal(JSON.stringify(result).includes('CODEX_TURN_FAILED'), false, 'Do not infer upstream causes from an error body.');
  }
});

test('unknown exceptions cannot inject diagnostic codes and custom retry policy remains authoritative', async t => {
  const runtime = await fixture(t);
  const error = broken(); let calls = 0; let policies = 0;
  const result = await runAgent({ task: 'Classify a custom planner.', tools: runtime.tools, planner: async () => { calls++; throw error; }, plannerRecovery: { maxRetries: 1, retryDelayMs: 0, shouldRetry: caught => { policies++; assert.equal(caught, error); return true; } } });
  assert.equal(result.status, 'failed'); assert.equal(calls, 2); assert.equal(policies, 2);
  diagnostic(result, { phase: 'planner', code: 'PLANNER_FAILED', retryable: true });
  const unknown = await runAgent({ task: 'Classify an unknown error.', tools: runtime.tools, planner: async () => { throw broken(); } });
  diagnostic(unknown, { phase: 'planner', code: 'PLANNER_FAILED', retryable: false });
  const recovered = await runAgent({ task: 'Use an explicit fallback.', tools: runtime.tools, planner: async () => { throw new AgentPlannerError(secret, true); }, plannerRecovery: { fallback: async () => input() } });
  assert.equal(recovered.status, 'needs_input'); assert.equal(recovered.plannerCalls, 2);
  assert.equal(recovered.failure, undefined, 'A recovered attempt is not a terminal failure.');
});

test('transport and malformed response diagnostics remain distinct and omit raw response data', async t => {
  const runtime = await fixture(t);
  for (const [fetch, maxResponseBytes, code, retryable] of [
    [async () => { throw new TypeError(secret); }, undefined, 'PLANNER_TRANSPORT_FAILED', true],
    [async () => new Response(secret), undefined, 'PLANNER_INVALID_RESPONSE', false],
    [async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'change', arguments: secret } }] } }] })), undefined, 'PLANNER_INVALID_RESPONSE', false],
    [async () => new Response(secret), 4, 'PLANNER_RESPONSE_TOO_LARGE', false],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(broken()); } })), undefined, 'PLANNER_RESPONSE_READ_FAILED', false],
  ]) {
    const planner = createOpenAICompatiblePlanner({ endpoint: 'https://private.invalid/unused', model: 'fixture', fetch, maxResponseBytes });
    const result = await runAgent({ task: 'Classify the response.', tools: runtime.tools, planner });
    assert.equal(result.status, 'failed'); assert.equal(result.plannerCalls, 1); assert.equal(runtime.writes(), 0);
    diagnostic(result, { phase: 'planner', code, retryable });
  }
});

test('catalog failure is distinguishable before any planner or mutation runs', async t => {
  const runtime = await fixture(t); let planned = false;
  await runtime.close();
  const result = await runAgent({ task: 'Discover tools.', tools: runtime.tools, planner: async () => { planned = true; return input(); } });
  assert.equal(result.status, 'failed'); assert.equal(planned, false); assert.equal(runtime.writes(), 0);
  diagnostic(result, { phase: 'catalog', code: 'TOOL_CATALOG_FAILED', retryable: false });
  const malformed = await runAgent({ task: 'Reject invalid tools.', tools: { listTools: async () => [null], callTool: async () => { throw broken(); } }, planner: async () => { throw broken(); } });
  diagnostic(malformed, { phase: 'catalog', code: 'TOOL_CATALOG_INVALID', retryable: false });
});

test('application callbacks are classified without recursively notifying a broken event hook', async t => {
  const runtime = await fixture(t); let notifications = 0;
  const event = await runAgent({ task: 'Observe the executor.', tools: runtime.tools, planner: async () => { throw new Error('Planner must not run.'); }, onEvent: () => { notifications++; throw broken(); } });
  assert.equal(event.status, 'failed'); assert.equal(notifications, 1); assert.equal(event.plannerCalls, 0);
  diagnostic(event, { phase: 'application', code: 'EVENT_HOOK_FAILED', retryable: false });
  const metric = await runAgent({ task: 'Do not dispatch after a hook failure.', tools: runtime.tools, planner: async () => call('change', {}), onMetrics: () => { throw broken(); } });
  diagnostic(metric, { phase: 'application', code: 'METRICS_HOOK_FAILED', retryable: false });
  assert.equal(runtime.writes(), 0);
  const completion = await runAgent({ task: 'Require application acceptance.', tools: runtime.tools, planner: verifiedPlanner, validateCompletion: () => { throw broken(); } });
  assert.equal(completion.status, 'failed'); assert.deepEqual(completion.evidence, []); assert.equal(completion.toolCalls, 1);
  diagnostic(completion, { phase: 'application', code: 'COMPLETION_HOOK_FAILED', retryable: false });
  const policy = await runAgent({ task: 'Check a retry policy.', tools: runtime.tools, planner: async () => { throw new AgentPlannerError(secret, true); }, plannerRecovery: { maxRetries: 2, shouldRetry: () => { throw broken(); } } });
  assert.equal(policy.plannerCalls, 1);
  diagnostic(policy, { phase: 'application', code: 'RETRY_POLICY_FAILED', retryable: false });
});

test('adapter usage callback failures retain their application phase and original retry policy input', async t => {
  const runtime = await fixture(t); const error = new AgentPlannerError(secret, true); let policies = 0;
  const planner = createOpenAICompatiblePlanner({ endpoint: 'https://private.invalid/unused', model: 'fixture', fetch: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 1 }, choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Review?' }) } }] } }] })), onUsage: () => { throw error; } });
  const result = await runAgent({ task: 'Report actual usage.', tools: runtime.tools, planner, plannerRecovery: { maxRetries: 2, shouldRetry: caught => { policies++; assert.equal(caught, error); return false; } } });
  assert.equal(result.status, 'failed'); assert.equal(policies, 1); assert.equal(result.plannerCalls, 1);
  diagnostic(result, { phase: 'application', code: 'USAGE_HOOK_FAILED', retryable: false });
});

test('persistence failures prevent mutation or successful completion without changing resume schema', async t => {
  const runtime = await fixture(t); let saved = 0;
  const beforeTool = await runAgent({ task: 'Save before changing.', tools: runtime.tools, planner: async () => call('change', {}), onCheckpoint: checkpoint => { saved++; if (checkpoint.phase === 'before_tool') throw broken(); } });
  assert.equal(beforeTool.status, 'failed'); assert.equal(runtime.writes(), 0); assert.equal(saved, 2);
  diagnostic(beforeTool, { phase: 'persistence', code: 'CHECKPOINT_PERSISTENCE_FAILED', retryable: false });
  const terminal = await runAgent({ task: 'Durably finish.', tools: runtime.tools, planner: verifiedPlanner, onCheckpoint: checkpoint => { if (checkpoint.phase === 'terminal') throw broken(); } });
  assert.equal(terminal.status, 'failed'); assert.deepEqual(terminal.evidence, []);
  diagnostic(terminal, { phase: 'persistence', code: 'CHECKPOINT_PERSISTENCE_FAILED', retryable: false });
  const resumed = await runAgent({ task: terminal.checkpoint.task, tools: runtime.tools, resume: JSON.parse(JSON.stringify(terminal.checkpoint)), planner: async () => input() });
  assert.equal(resumed.status, 'needs_input'); assert.equal(resumed.failure, undefined);
  assert.equal(resumed.plannerCalls, terminal.plannerCalls + 1);
});

test('a noncooperating checkpoint callback receives a bounded persistence-timeout diagnosis', { timeout: 8_000 }, async t => {
  const runtime = await fixture(t); let saves = 0;
  const result = await runAgent({ task: 'Require durable state before execution.', tools: runtime.tools, planner: async () => call('change', {}), onCheckpoint: () => { saves++; return new Promise(() => {}); } });
  assert.equal(result.status, 'failed'); assert.equal(saves, 1); assert.equal(runtime.writes(), 0);
  diagnostic(result, { phase: 'persistence', code: 'CHECKPOINT_PERSISTENCE_TIMEOUT', retryable: false });
});
