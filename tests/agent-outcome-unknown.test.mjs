import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectAgentTools, runAgent } from '../dist/agent.js';
import { AGENT_CHECKPOINT_VERSION, parseAgentCheckpoint } from '../dist/checkpoint.js';

const payload = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(data.ok === false ? { isError: true } : {}) });
const stale = extra => payload({ ok: false, error: { code: 'STALE_REFERENCE', message: 'Observe the current target.' }, ...extra });
const act = snapshotId => ({ name: 'tab_act', arguments: { session_id: 's1', snapshot_id: snapshotId, actions: [{ type: 'fill_secret', ref: 'e1', alias: 'login' }] } });
const snapshot = { name: 'tab_snapshot', arguments: { session_id: 's1' } };
const verify = { name: 'tab_verify', arguments: { session_id: 's1', checks: [{ kind: 'text', contains: 'Written once' }] } };
const calls = (...items) => ({ type: 'tools', calls: items });
const finish = id => ({ type: 'finish', summary: 'The current result was verified.', evidence: [id] });
const input = () => ({ type: 'human_input', question: 'Review the observed state?' });
const last = messages => messages.findLast(message => message.role === 'tool');

// Real in-memory MCP transport; the page-independent handler records actual
// simulated writes. No browser, secret resolver, or inference service is used.
async function fixture(t, options = {}) {
  const state = { writes: 0, attempts: 0, reads: 0, verifications: 0, snapshots: 0, prepared: 0, closed: 0, dispatched: 0 };
  const server = new McpServer({ name: 'explicit-outcome-fixture', version: '1' });
  server.registerTool('tab_act', { inputSchema: z.object({ session_id: z.string(), snapshot_id: z.string(), actions: z.array(z.object({ type: z.literal('fill_secret'), ref: z.string(), alias: z.string() }).strict()) }).strict(), annotations: { readOnlyHint: options.bound === true } }, async () => {
    state.attempts++;
    if (options.rejectFirst && state.attempts === 1) return options.rejectFirst;
    state.writes++;
    return options.uncertainResult ?? payload({ ok: true, session_id: 's1' });
  });
  server.registerTool('tab_snapshot', { inputSchema: z.object({ session_id: z.string() }).strict(), annotations: { readOnlyHint: true } }, async () => payload({ ok: true, session_id: 's1', snapshot_id: `fresh_${++state.snapshots}`, text: state.writes ? 'Written once' : 'Ready' }));
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() }).strict()) }).strict(), annotations: { readOnlyHint: true } }, async args => {
    state.verifications++;
    const passed = state.writes === 1;
    return payload({ ok: true, session_id: 's1', passed, checks: args.checks.map(check => ({ ...check, pass: passed, actual: `${state.writes} writes` })) });
  });
  server.registerTool('read', { inputSchema: z.object({}).strict(), annotations: { readOnlyHint: options.bound !== true } }, async () => { state.reads++; return payload({ ok: true, outcome_unknown: true, text: 'Observed an unknown state without writing.' }); });
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  if (!options.bound) return { state, tools: connection.tools };
  const catalog = await connection.tools.listTools({ signal: new AbortController().signal });
  const tools = {
    listTools: async () => { throw new Error('Bound execution must not use the legacy catalog.'); },
    callTool: async () => { throw new Error('Bound execution must not bypass dispatch.'); },
    getExecutionIdentity: async () => ({ registryHash: 'a'.repeat(64), contextHash: 'b'.repeat(64) }),
    prepareTools: async () => {
      state.prepared++;
      return {
        tools: catalog,
        contextKey: 'c'.repeat(64),
        metadata: new Map(catalog.map(tool => [tool.name, { effect: tool.name === 'tab_act' ? 'write' : 'read', sessionId: 's1' }])),
        assertCurrent: async () => {},
        dispatch: async (call, options_) => {
          state.dispatched++;
          if (options.notStarted && call.name === 'tab_act') return { result: stale({ outcome_unknown: true }), outcome: 'not_started' };
          return { result: await connection.tools.callTool(call, options_), outcome: 'completed', sessionId: 's1' };
        },
        close: async () => { state.closed++; },
      };
    },
  };
  return { state, tools };
}

test('ordinary MCP explicit unknown write persists uncertainty, skips the batch and cannot replay on resume', async t => {
  const runtime = await fixture(t, { uncertainResult: payload({ ok: false, session_id: 's1', outcome_unknown: true, error: { code: 'SECRET_INPUT_FAILED', message: 'The write may have happened.' } }) });
  const saved = [];
  const run = await runAgent({ task: 'Write once and verify the actual result.', tools: runtime.tools, onCheckpoint: checkpoint => saved.push(parseAgentCheckpoint(JSON.parse(JSON.stringify(checkpoint)))), planner: async () => calls(act('observed_1'), act('observed_1'), verify) });
  assert.equal(run.status, 'needs_input');
  assert.equal(run.plannerCalls, 1);
  assert.equal(run.toolCalls, 1);
  assert.equal(runtime.state.writes, 1);
  assert.equal(runtime.state.verifications, 0);
  assert.deepEqual(run.evidence, []);
  const ambiguous = run.checkpoint.ambiguousCalls;
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].name, 'tab_act');
  const outcomes = run.history.filter(message => message.role === 'tool');
  assert.equal(outcomes[0].result.structuredContent.outcome_unknown, true);
  assert.ok(outcomes.slice(1).every(message => message.result.structuredContent.error.code === 'CALL_SKIPPED'));
  assert.equal(run.events.filter(event => event.type === 'tool_result' && event.skipped).length, 2);
  const checkpoints = ['before_tool', 'after_tool', 'decision', 'terminal'].map(phase => saved.find(item => item.phase === phase));
  for (const checkpoint of checkpoints) {
    assert.ok(checkpoint);
    assert.equal(checkpoint.schemaVersion, AGENT_CHECKPOINT_VERSION);
    assert.deepEqual(checkpoint.ambiguousCalls, ambiguous);
    let planned = false; let catalogued = false;
    const blocked = await runAgent({ task: run.checkpoint.task, resume: checkpoint, resumeFeedback: 'The planner may claim the earlier action is complete.', tools: { listTools: async () => { catalogued = true; return []; }, callTool: async () => { throw new Error('Do not replay'); } }, planner: async () => { planned = true; return finish(ambiguous[0].id); } });
    assert.equal(blocked.status, 'needs_input');
    assert.equal(planned, false); assert.equal(catalogued, false);
    assert.deepEqual(blocked.checkpoint.ambiguousCalls, ambiguous);
  }
  const resumed = await runAgent({ task: run.checkpoint.task, resume: run.checkpoint, tools: runtime.tools,
    reconciliation: { resolvedCallIds: [ambiguous[0].id], note: 'The operator checked the target and confirmed the write occurred exactly once.' },
    planner: async ({ step, messages }) => {
      if (step === 2) return finish(ambiguous[0].id);
      if (step === 3) { assert.ok(messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED'))); return calls(snapshot); }
      if (step === 4) return calls(verify);
      return finish(last(messages).toolCallId);
    },
  });
  assert.equal(resumed.status, 'succeeded');
  assert.deepEqual(resumed.checkpoint.ambiguousCalls, []);
  assert.equal(runtime.state.writes, 1, 'Neither the uncertain write nor the skipped mutation is replayed.');
  assert.equal(runtime.state.verifications, 1, 'Reconciliation still needs new explicit verification.');
  assert.notEqual(resumed.evidence[0].toolCallId, ambiguous[0].id);
  parseAgentCheckpoint(resumed.checkpoint);
});

test('explicit uncertainty overrides a superficially successful write in legacy and bound MCP execution', async t => {
  for (const bound of [false, true]) await t.test(bound ? 'bound trusted write metadata' : 'ordinary MCP write annotation', async sub => {
    const runtime = await fixture(sub, { bound, uncertainResult: payload({ ok: true, session_id: 's1', outcome_unknown: true }) });
    const run = await runAgent({ task: 'Do not accept a write with uncertain effects.', tools: runtime.tools, planner: async () => calls(act('observed_1'), verify) });
    assert.equal(run.status, 'needs_input');
    assert.equal(run.checkpoint.ambiguousCalls.length, 1);
    assert.equal(last(run.history).result.structuredContent.error.code, 'CALL_SKIPPED');
    assert.equal(run.history.find(message => message.role === 'tool').result.isError, true);
    assert.equal(runtime.state.writes, 1); assert.equal(runtime.state.verifications, 0);
    assert.equal(runtime.state.prepared, runtime.state.closed);
    const prepared = runtime.state.prepared;
    const resumed = await runAgent({ task: run.checkpoint.task, tools: runtime.tools, resume: JSON.parse(JSON.stringify(run.checkpoint)), planner: async () => { throw new Error('A model cannot reconcile this write.'); } });
    assert.equal(resumed.status, 'needs_input'); assert.equal(runtime.state.writes, 1);
    assert.equal(runtime.state.prepared, prepared);
  });
});

test('ordinary pre-write failures and non-protocol markers remain recoverable by fresh observation', async t => {
  const variants = [
    ['absent', stale({})],
    ['false', stale({ outcome_unknown: false })],
    ['string true', stale({ outcome_unknown: 'true' })],
    ['nested payload', stale({ data: { outcome_unknown: true } })],
    ['text-only JSON', { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, outcome_unknown: true, error: { code: 'STALE_REFERENCE' } }) }] }],
  ];
  for (const [name, rejectFirst] of variants) await t.test(name, async sub => {
    const runtime = await fixture(sub, { rejectFirst });
    const run = await runAgent({ task: 'Re-observe a rejected target and perform one write.', tools: runtime.tools, planner: async ({ step, messages }) => {
      if (step === 1) return calls(act('stale_1'), act('stale_1'));
      if (step === 2) { assert.equal(runtime.state.writes, 0); return calls(snapshot); }
      if (step === 3) return calls(act(last(messages).result.structuredContent.snapshot_id));
      if (step === 4) return calls(verify);
      return finish(last(messages).toolCallId);
    } });
    assert.equal(run.status, 'succeeded');
    assert.deepEqual(run.checkpoint.ambiguousCalls, []);
    assert.equal(runtime.state.attempts, 2); assert.equal(runtime.state.writes, 1);
    assert.equal(runtime.state.snapshots, 1);
    assert.equal(run.events.filter(event => event.type === 'tool_result' && event.skipped).length, 1);
  });
});

test('read-only metadata and trusted not-started outcomes do not invent mutation ambiguity', async t => {
  for (const bound of [false, true]) await t.test(bound ? 'bound read despite misleading write annotation' : 'ordinary read', async sub => {
    const runtime = await fixture(sub, { bound });
    const run = await runAgent({ task: 'Read an uncertain observation.', tools: runtime.tools, planner: async ({ step }) => step === 1 ? calls({ name: 'read', arguments: {} }, { name: 'read', arguments: {} }) : input() });
    assert.equal(run.status, 'needs_input'); assert.equal(run.reason, 'Human input is required.');
    assert.deepEqual(run.checkpoint.ambiguousCalls, []);
    assert.equal(runtime.state.reads, 2); assert.equal(runtime.state.writes, 0);
  });
  await t.test('not_started overrides a contradictory result marker', async sub => {
    const runtime = await fixture(sub, { bound: true, notStarted: true });
    const run = await runAgent({ task: 'Respect a trusted pre-dispatch rejection.', tools: runtime.tools, planner: async ({ step }) => step === 1 ? calls(act('observed_1'), act('observed_1')) : input() });
    assert.equal(run.status, 'needs_input'); assert.equal(run.reason, 'Human input is required.');
    assert.deepEqual(run.checkpoint.ambiguousCalls, []);
    assert.equal(runtime.state.dispatched, 1); assert.equal(runtime.state.attempts, 0);
    assert.equal(runtime.state.prepared, runtime.state.closed);
  });
});

test('failure after an explicit unknown result cannot erase the persisted reconciliation requirement', async t => {
  for (const boundary of ['after_tool persistence', 'tool_result callback']) await t.test(boundary, async sub => {
    const runtime = await fixture(sub, { uncertainResult: stale({ outcome_unknown: true }) });
    let writeAhead;
    const run = await runAgent({ task: 'Retain unknown effects after a callback fails.', tools: runtime.tools,
      onCheckpoint: checkpoint => {
        if (checkpoint.phase === 'before_tool') writeAhead = parseAgentCheckpoint(checkpoint);
        if (boundary === 'after_tool persistence' && checkpoint.phase === 'after_tool') throw new Error('Checkpoint storage unavailable.');
      },
      onEvent: event => { if (boundary === 'tool_result callback' && event.type === 'tool_result') throw new Error('Consumer unavailable.'); },
      planner: async () => calls(act('observed_1'), act('observed_1')),
    });
    assert.equal(run.status, 'failed');
    assert.equal(runtime.state.writes, 1);
    for (const checkpoint of [writeAhead, parseAgentCheckpoint(run.checkpoint)]) {
      assert.equal(checkpoint.ambiguousCalls.length, 1);
      const blocked = await runAgent({ task: checkpoint.task, resume: checkpoint, tools: runtime.tools, planner: async () => { throw new Error('Must remain blocked.'); } });
      assert.equal(blocked.status, 'needs_input');
      assert.equal(runtime.state.writes, 1);
    }
  });
});
