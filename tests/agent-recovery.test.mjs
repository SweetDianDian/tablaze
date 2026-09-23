import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentPlannerError, connectAgentTools, createOpenAICompatiblePlanner, runAgent } from '../dist/agent.js';
import { parseAgentCheckpoint } from '../dist/checkpoint.js';

const tool = (name, arguments_ = {}) => ({ type: 'tools', calls: [{ name, arguments: arguments_ }] });
const done = (...evidence) => ({ type: 'finish', summary: 'The requested state was verified.', evidence });
const input = () => ({ type: 'human_input', question: 'Continue after reviewing the current state?' });
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(data.ok === false ? { isError: true } : {}) });
const last = messages => messages.filter(message => message.role === 'tool').at(-1);
const checks = [{ kind: 'text', contains: 'Saved' }];

async function fixture(t) {
  const server = new McpServer({ name: 'agent-recovery-fixture', version: '1' });
  const changes = []; let snapshots = 0;
  server.registerTool('change', { inputSchema: z.object({ session_id: z.string(), value: z.string() }).strict(), annotations: { readOnlyHint: false } }, async args => { changes.push(args); return result({ ok: true, session_id: args.session_id }); });
  server.registerTool('tab_snapshot', { inputSchema: z.object({ session_id: z.string(), large: z.boolean().optional(), varying: z.boolean().optional() }).strict(), annotations: { readOnlyHint: true } }, async args => {
    snapshots++;
    return result({ ok: true, session_id: args.session_id, snapshot_id: `fresh_${snapshots}`, text: args.large ? `OBSERVED_${snapshots}_` + 'x'.repeat(2_000) : 'Stable page', ...(args.varying ? { observedCounter: snapshots } : {}) });
  });
  server.registerTool('tab_act', { inputSchema: z.object({ session_id: z.string(), snapshot_id: z.string(), value: z.string() }).strict(), annotations: { readOnlyHint: false } }, async args => { changes.push(args); return result({ ok: true, session_id: args.session_id }); });
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() })).min(1) }).strict(), annotations: { readOnlyHint: true } }, async args => result({ ok: true, session_id: args.session_id, passed: true, checks: args.checks.map(check => ({ kind: check.kind, pass: true, actual: 'Saved' })) }));
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  return { ...connection, changes, snapshots: () => snapshots };
}

test('decision checkpoint resume preserves counters and IDs but requires fresh verification', async t => {
  const runtime = await fixture(t);
  const saved = [];
  let oldEvidence;
  const first = await runAgent({ task: 'Save a record.', tools: runtime.tools, maxSteps: 10, onCheckpoint: async value => { saved.push(parseAgentCheckpoint(value)); }, planner: async ({ step, messages }) => {
    if (step === 1) return tool('change', { session_id: 's1', value: 'record' });
    if (step === 2) return tool('tab_verify', { session_id: 's1', checks });
    oldEvidence = last(messages).toolCallId;
    return input();
  } });
  assert.equal(first.status, 'needs_input');
  assert.equal(first.steps, 3);
  assert.equal(first.toolCalls, 2);
  assert.ok(saved.some(checkpoint => checkpoint.phase === 'before_tool' && checkpoint.pendingTool?.mutating));
  assert.ok(saved.some(checkpoint => checkpoint.phase === 'decision' && !checkpoint.pendingTool));
  let newEvidence;
  const resumed = await runAgent({ task: first.checkpoint.task, tools: runtime.tools, resume: JSON.parse(JSON.stringify(first.checkpoint)), resumeFeedback: 'The operator reviewed the record; continue.', planner: async ({ step, messages }) => {
    if (step === 4) return done(oldEvidence);
    if (step === 5) {
      assert.ok(messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED')));
      return tool('tab_verify', { session_id: 's1', checks });
    }
    newEvidence = last(messages).toolCallId;
    return done(newEvidence);
  } });
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.steps, 6);
  assert.equal(resumed.toolCalls, 3);
  assert.equal(resumed.plannerCalls, 6);
  assert.notEqual(newEvidence, oldEvidence);
  assert.equal(resumed.checkpoint.runId, first.checkpoint.runId);
  assert.ok(resumed.checkpoint.elapsedMs >= first.checkpoint.elapsedMs);
  assert.deepEqual(runtime.changes, [{ session_id: 's1', value: 'record' }], 'Resume never replays the earlier mutation.');
  parseAgentCheckpoint(resumed.checkpoint);
});

test('an interrupted maybe-applied mutation blocks every resumed planner until trusted reconciliation', async t => {
  const runtime = await fixture(t);
  const controller = new AbortController();
  let effects = 0; let writeAhead;
  const first = await runAgent({ task: 'Create exactly one record.', tools: {
    listTools: runtime.tools.listTools,
    callTool: async () => { effects++; controller.abort(); return new Promise(() => {}); },
  }, signal: controller.signal, onCheckpoint: value => { if (value.phase === 'before_tool') writeAhead = parseAgentCheckpoint(value); }, planner: async () => ({ type: 'tools', calls: [{ name: 'change', arguments: { session_id: 's1', value: 'first' } }, { name: 'change', arguments: { session_id: 's1', value: 'must-not-run' } }] }) });
  assert.equal(first.status, 'cancelled');
  assert.equal(effects, 1);
  const checkpoint = parseAgentCheckpoint(first.checkpoint);
  assert.equal(checkpoint.ambiguousCalls.length, 1);
  assert.equal(checkpoint.pendingTool.mutating, true);
  const outputs = checkpoint.history.filter(message => message.role === 'tool');
  assert.equal(outputs[0].result.structuredContent.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(outputs[1].result.structuredContent.error.code, 'NOT_DISPATCHED');
  assert.equal(writeAhead.ambiguousCalls.length, 1, 'Uncertainty is persisted before the side effect can start.');
  for (const resume of [writeAhead, checkpoint]) {
    let plannerCalled = false; let catalogCalled = false;
    const blocked = await runAgent({ task: checkpoint.task, resume, tools: { listTools: async () => { catalogCalled = true; return []; }, callTool: async () => { throw new Error('Must not execute'); } }, planner: async () => { plannerCalled = true; return done('model-claims-reconciled'); } });
    assert.equal(blocked.status, 'needs_input');
    assert.equal(plannerCalled, false);
    assert.equal(catalogCalled, false);
    assert.equal(effects, 1);
  }
  await assert.rejects(runAgent({ task: checkpoint.task, resume: checkpoint, tools: runtime.tools, reconciliation: { resolvedCallIds: ['invented'], note: 'claimed resolved' }, planner: async () => input() }), /not ambiguous/);
  const acknowledged = await runAgent({ task: checkpoint.task, resume: checkpoint, tools: runtime.tools, reconciliation: { resolvedCallIds: checkpoint.ambiguousCalls.map(call => call.id), note: 'Operator inspected the database and confirmed the record exists exactly once.' }, planner: async ({ messages }) => { assert.ok(messages.some(message => message.role === 'user' && message.content.includes('Operator inspected'))); return input(); } });
  assert.equal(acknowledged.status, 'needs_input');
  assert.deepEqual(acknowledged.checkpoint.ambiguousCalls, []);
  assert.equal(effects, 1);
  assert.deepEqual(runtime.changes, []);
});

test('failed checkpoint persistence prevents dispatch and never retries a tool', async t => {
  const runtime = await fixture(t);
  let writeCalls = 0;
  const run = await runAgent({ task: 'Save with a durable write-ahead record.', tools: runtime.tools, onCheckpoint: async checkpoint => { writeCalls++; if (checkpoint.phase === 'before_tool') throw new Error('Disk unavailable.'); }, planner: async () => tool('change', { session_id: 's1', value: 'must-not-run' }) });
  assert.equal(run.status, 'failed');
  assert.match(run.reason, /Checkpoint persistence failed/);
  assert.deepEqual(runtime.changes, []);
  assert.equal(writeCalls, 2, 'No later checkpoint callback races a failed/uncertain write.');
  assert.deepEqual(run.checkpoint.ambiguousCalls, []);
  parseAgentCheckpoint(run.checkpoint);
});

test('restored sessions reject old session IDs and refs until a fresh snapshot is obtained', async t => {
  const runtime = await fixture(t);
  const first = await runAgent({ task: 'Update a restored session.', tools: runtime.tools, maxSteps: 10, planner: async ({ step }) => step === 1 ? tool('tab_snapshot', { session_id: 'old' }) : input() });
  const oldSnapshot = last(first.history).result.structuredContent.snapshot_id;
  const run = await runAgent({ task: first.checkpoint.task, tools: runtime.tools, resume: first.checkpoint, resumeSessionMap: { old: 'new' }, planner: async ({ step, messages }) => {
    if (step === 3) return tool('tab_act', { session_id: 'old', snapshot_id: oldSnapshot, value: 'reject-old-session' });
    if (step === 4) { assert.equal(last(messages).result.structuredContent.error.code, 'SESSION_REMAPPED'); return tool('tab_act', { session_id: 'new', snapshot_id: oldSnapshot, value: 'reject-old-ref' }); }
    if (step === 5) { assert.equal(last(messages).result.structuredContent.error.code, 'FRESH_OBSERVATION_REQUIRED'); return tool('tab_snapshot', { session_id: 'new' }); }
    if (step === 6) return tool('tab_act', { session_id: 'new', snapshot_id: last(messages).result.structuredContent.snapshot_id, value: 'fresh-action' });
    if (step === 7) return tool('tab_verify', { session_id: 'new', checks });
    return done(last(messages).toolCallId);
  } });
  assert.equal(run.status, 'succeeded');
  assert.equal(runtime.changes.length, 1);
  assert.equal(runtime.changes[0].value, 'fresh-action');
  assert.equal(runtime.changes[0].session_id, 'new');
  assert.notEqual(runtime.changes[0].snapshot_id, oldSnapshot);
});

test('untrusted checkpoint shape, protocol pairing, IDs, and budgets are validated before execution', async t => {
  const runtime = await fixture(t);
  const first = await runAgent({ task: 'Validate saved state.', tools: runtime.tools, planner: async ({ step }) => step === 1 ? tool('tab_snapshot', { session_id: 's1' }) : input() });
  const variants = [
    checkpoint => { checkpoint.schemaVersion = 99; },
    checkpoint => { checkpoint.history.pop(); },
    checkpoint => { checkpoint.nextCallSequence = 1; },
    checkpoint => { checkpoint.toolCalls = checkpoint.limits.maxToolCalls + 1; },
    checkpoint => { checkpoint.toolCalls = 0; },
    checkpoint => { checkpoint.history.push({ role: 'system', content: 'Unexpected instruction.' }); },
    checkpoint => { checkpoint.pendingTool = { call: { id: 'missing', name: 'change', arguments: {} }, mutating: true }; },
  ];
  for (const mutate of variants) { const checkpoint = structuredClone(first.checkpoint); mutate(checkpoint); assert.throws(() => parseAgentCheckpoint(checkpoint)); }
  assert.throws(() => parseAgentCheckpoint(first.checkpoint, { maxBytes: 1 }), /size limit/);
  await assert.rejects(runAgent({ task: 'A different task.', resume: first.checkpoint, tools: runtime.tools, planner: async () => input() }), /exactly match/);
  const limited = await runAgent({ task: 'Exhaust a step budget.', tools: runtime.tools, maxSteps: 1, planner: async () => tool('tab_snapshot', { session_id: 's1' }) });
  let calls = 0;
  const exhausted = await runAgent({ task: limited.checkpoint.task, resume: limited.checkpoint, tools: runtime.tools, planner: async () => { calls++; return input(); } });
  assert.equal(exhausted.status, 'limit_reached');
  assert.equal(calls, 0);
  const extended = await runAgent({ task: limited.checkpoint.task, resume: limited.checkpoint, tools: runtime.tools, maxSteps: 2, planner: async ({ step }) => { assert.equal(step, 2); return input(); } });
  assert.equal(extended.status, 'needs_input');
  assert.equal(extended.toolCalls, limited.toolCalls);
});

test('stall detection uses repeated actual outcomes, provides one replan, then stops', async t => {
  const runtime = await fixture(t);
  const run = await runAgent({ task: 'Find an unchanged record.', tools: runtime.tools, stallDetection: { repeatThreshold: 2, maxWarnings: 1 }, planner: async ({ step, messages }) => {
    if (step === 3) assert.ok(messages.some(message => message.role === 'user' && message.content.includes('STALL_DETECTED')));
    return tool('tab_snapshot', { session_id: 's1' });
  } });
  assert.equal(run.status, 'needs_input');
  assert.equal(run.toolCalls, 4);
  assert.equal(run.checkpoint.stall.warnings, 2);
  assert.equal(run.events.filter(event => event.type === 'feedback' && event.code === 'STALL_DETECTED').length, 2);
  const progress = await runAgent({ task: 'Observe actual changing state.', tools: runtime.tools, maxSteps: 5, stallDetection: { repeatThreshold: 2, maxWarnings: 0 }, planner: async ({ step }) => step < 5 ? tool('tab_snapshot', { session_id: 's1', varying: true }) : input() });
  assert.equal(progress.reason, 'Human input is required.');
  assert.equal(progress.checkpoint.stall.warnings, 0);
});

test('queued actions skipped after replanning do not count as repeated execution', async t => {
  const runtime = await fixture(t);
  let observed = 0; let dispatchedWrites = 0;
  const run = await runAgent({ task: 'Observe a changing page before writing.', maxSteps: 6, stallDetection: { repeatThreshold: 2, maxWarnings: 0 }, tools: {
    listTools: runtime.tools.listTools,
    callTool: async call => {
      if (call.name === 'change') { dispatchedWrites++; throw new Error('A queued write must be skipped.'); }
      assert.equal(call.name, 'tab_snapshot');
      observed++;
      return result({ ok: true, session_id: 's1', snapshot_id: `s1:${observed}`, observedCounter: observed, replan_required: true });
    },
  }, planner: async ({ step }) => step <= 5 ? { type: 'tools', calls: [
    { name: 'tab_snapshot', arguments: { session_id: 's1' } },
    { name: 'change', arguments: { session_id: 's1', value: 'same-queued-write' } },
  ] } : input() });
  assert.equal(run.reason, 'Human input is required.');
  assert.equal(run.toolCalls, 5);
  assert.equal(observed, 5);
  assert.equal(dispatchedWrites, 0);
  assert.equal(run.checkpoint.stall.warnings, 0);
  assert.equal(run.events.filter(event => event.type === 'feedback' && event.code === 'STALL_DETECTED').length, 0);
  const skipped = run.events.filter(event => event.type === 'tool_result' && event.skipped);
  assert.equal(skipped.length, 5);
  assert.ok(skipped.every(event => event.result.structuredContent.error.code === 'CALL_SKIPPED'));
});

test('bounded retry and fallback only repeat planning; tools with uncertain effects are not retried', async t => {
  const runtime = await fixture(t);
  let primary = 0; let fallback = 0;
  const metrics = [];
  const run = await runAgent({ task: 'Recover model transport.', tools: runtime.tools, plannerRecovery: { maxRetries: 2, retryDelayMs: 0, fallback: async () => { fallback++; return input(); } }, onMetrics: metric => metrics.push(metric), planner: async () => { primary++; throw new AgentPlannerError('Transient fixture transport.', true); } });
  assert.equal(run.status, 'needs_input');
  assert.equal(primary, 3);
  assert.equal(fallback, 1);
  assert.equal(run.plannerCalls, 4);
  assert.deepEqual(metrics.map(metric => [metric.planner, metric.outcome]), [['primary', 'error'], ['primary', 'error'], ['primary', 'error'], ['fallback', 'success']]);
  assert.ok(metrics.every(metric => Number.isFinite(metric.latencyMs) && metric.latencyMs >= 0));
  let permanentCalls = 0;
  const permanent = await runAgent({ task: 'Permanent error.', tools: runtime.tools, plannerRecovery: { maxRetries: 2, fallback: async () => { throw new Error('Must not run'); } }, planner: async () => { permanentCalls++; throw new AgentPlannerError('Malformed model response.'); } });
  assert.equal(permanent.status, 'failed');
  assert.equal(permanentCalls, 1);
  let effects = 0;
  const uncertain = await runAgent({ task: 'Never retry a mutation.', tools: { listTools: runtime.tools.listTools, callTool: async () => { effects++; throw new Error('Connection lost after applying effect.'); } }, plannerRecovery: { maxRetries: 5 }, planner: async () => tool('change', { session_id: 's1', value: 'one' }) });
  assert.equal(uncertain.status, 'needs_input');
  assert.equal(effects, 1);
  assert.equal(uncertain.checkpoint.ambiguousCalls.length, 1);
});

test('opt-in compaction preserves complete tool groups and real verification evidence', async t => {
  const runtime = await fixture(t);
  let evidenceId;
  const run = await runAgent({ task: 'Observe changing data then report verified state.', tools: runtime.tools, maxSteps: 8, maxHistoryBytes: 10_000, historyCompaction: { keepRecentGroups: 1 }, onCheckpoint: checkpoint => { parseAgentCheckpoint(checkpoint); }, planner: async ({ step, messages }) => {
    if (step === 1) return tool('tab_verify', { session_id: 's1', checks });
    if (step === 2) evidenceId = last(messages).toolCallId;
    if (step < 8) return tool('tab_snapshot', { session_id: 's1', large: true, varying: true });
    assert.ok(messages.some(message => message.role === 'user' && message.content.includes('metadata only')));
    assert.ok(messages.some(message => message.role === 'tool' && message.toolCallId === evidenceId));
    return done(evidenceId);
  } });
  assert.equal(run.status, 'succeeded', JSON.stringify({ status: run.status, reason: run.reason }));
  assert.equal(run.evidence[0].toolCallId, evidenceId);
  assert.ok(Buffer.byteLength(JSON.stringify(run.history)) <= 10_000);
  parseAgentCheckpoint(run.checkpoint);
  const summary = run.history.find(message => message.role === 'user' && message.content.includes('metadata only'));
  assert.ok(summary);
  assert.equal(summary.content.includes('OBSERVED_'), false, 'Compaction does not fabricate a summary of page facts.');
});

test('HTTP adapter reports only actual provider usage and exposes transient status classification', async () => {
  const usage = [];
  const response = { id: 'provider-response-1', model: 'actual-fixture-model', usage: { prompt_tokens: 120, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } }, choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Which record?' }) } }] } }] };
  const planner = createOpenAICompatiblePlanner({ endpoint: 'http://localhost/fixture', model: 'requested-fixture-model', fetch: async () => new Response(JSON.stringify(response)), onUsage: value => usage.push(value) });
  const request = { task: 'Read usage.', messages: [], tools: [], step: 7, signal: new AbortController().signal };
  await planner(request);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].step, 7);
  assert.equal(usage[0].model, 'actual-fixture-model');
  assert.equal(usage[0].responseId, 'provider-response-1');
  assert.equal(usage[0].promptTokens, 120);
  assert.equal(usage[0].completionTokens, 9);
  assert.equal(usage[0].cachedPromptTokens, 40);
  assert.equal(usage[0].reasoningTokens, 3);
  assert.equal('totalTokens' in usage[0], false, 'Missing total is not invented from a sum.');
  assert.ok(usage[0].latencyMs >= 0);
  const missingUsage = createOpenAICompatiblePlanner({ endpoint: 'http://localhost/fixture', model: 'fixture', fetch: async () => new Response(JSON.stringify({ choices: response.choices })), onUsage: value => usage.push(value) });
  await missingUsage(request);
  assert.equal(usage.length, 1, 'An absent provider usage object produces no fabricated counters.');
  for (const status of [401, 429, 503]) {
    const unavailable = createOpenAICompatiblePlanner({ endpoint: 'http://localhost/fixture', model: 'fixture', fetch: async () => new Response('{}', { status }) });
    await assert.rejects(unavailable(request), error => error instanceof AgentPlannerError && error.retryable === (status !== 401));
  }
});
