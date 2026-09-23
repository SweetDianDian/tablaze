import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectAgentTools, runAgent } from '../dist/agent.js';
import { AGENT_CHECKPOINT_VERSION, parseAgentCheckpoint } from '../dist/checkpoint.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const payload = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const rejection = () => ({ ...payload({ ok: false, error: { code: 'CONTEXT_CHANGED', message: 'The trusted execution context changed.' } }), isError: true });
const calls = (...names) => ({ type: 'tools', calls: names.map(name => ({ name, arguments: name === 'tab_verify' ? { session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] } : {} })) });
const last = messages => messages.filter(message => message.role === 'tool').at(-1);
const finish = id => ({ type: 'finish', summary: 'The current outcome was verified.', evidence: [id] });
const input = () => ({ type: 'human_input', question: 'Review the current outcome?' });

async function fixture(t, options = {}) {
  const state = { epoch: 0, tenant: 'tenant-a', registry: 'contracts-v1', prepared: 0, closed: 0, writes: 0, actualCalls: [], identityReads: 0 };
  const server = new McpServer({ name: 'bound-tools-fixture', version: '1' });
  for (const name of ['save_a', 'save_b']) server.registerTool(name, { inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, async () => { state.writes++; return payload({ ok: true, data: { saved: true } }); });
  server.registerTool('read', { inputSchema: z.object({}).strict(), annotations: { readOnlyHint: false } }, async () => payload({ ok: true, value: 'Observed' }));
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() })) }).strict(), annotations: { readOnlyHint: true } }, async args => payload({ ok: true, session_id: args.session_id, passed: true, checks: args.checks.map(check => ({ kind: check.kind, pass: true, actual: 'Saved' })) }));
  server.registerTool('tab_open', { inputSchema: z.object({ url: z.string() }).strict(), annotations: { readOnlyHint: false } }, async () => payload({ ok: true, session_id: 's1', snapshot_id: `snapshot-${state.epoch}`, text: 'Ready' }));
  server.registerTool('tab_close', { inputSchema: z.object({ session_id: z.string() }).strict(), annotations: { readOnlyHint: false } }, async args => payload({ ok: true, closed: true, session_id: args.session_id }));
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  const underlying = await connection.tools.listTools({ signal: new AbortController().signal });
  const tools = {
    listTools: async () => { throw new Error('The legacy catalog must not be used by bound execution.'); },
    callTool: async () => { throw new Error('The legacy dispatcher must not bypass the lease.'); },
    getExecutionIdentity: async ({ signal }) => { signal.throwIfAborted(); state.identityReads++; return { registryHash: hash(state.registry), contextHash: hash(state.tenant) }; },
    prepareTools: async ({ signal }) => {
      signal.throwIfAborted(); state.prepared++;
      const epoch = state.epoch; let closed = false;
      const visible = underlying.filter(tool => !tool.name.startsWith('save_') || tool.name === (epoch ? 'save_b' : 'save_a'));
      const metadata = new Map(underlying.map(tool => [tool.name, { effect: ['read', 'tab_verify'].includes(tool.name) ? 'read' : 'write', sessionId: 's1', privateTenant: 'PRIVATE_TENANT' }]));
      return {
        contextKey: hash(`private-context-${epoch}`),
        tools: visible.map(tool => ({ ...tool, outputSchema: { type: 'object' }, privateTenant: 'PRIVATE_TENANT' })),
        metadata,
        assertCurrent: async () => { if (epoch !== state.epoch) throw new Error('PRIVATE_TENANT context changed'); },
        dispatch: async (call, { signal }) => {
          assert.equal(closed, false); signal.throwIfAborted();
          assert.match(call.id, /_call_\d+$/);
          if (epoch !== state.epoch) return { result: rejection(), outcome: 'not_started', contextChanged: true };
          if (options.dispatch) return options.dispatch({ call, signal, state, execute: async () => { state.actualCalls.push(call); return connection.tools.callTool(call, { signal }); } });
          state.actualCalls.push(call);
          return { result: await connection.tools.callTool(call, { signal }), outcome: 'completed', sessionId: 's1' };
        },
        close: async () => { assert.equal(closed, false, 'Each lease closes exactly once.'); closed = true; state.closed++; await options.onClose?.(state); },
      };
    },
  };
  return { state, tools, connection };
}

test('per-decision catalogs hide execution metadata and context changes skip queued writes', async t => {
  const runtime = await fixture(t, { dispatch: async ({ call, state, execute }) => {
    const result = await execute();
    if (call.name === 'save_a') { state.epoch++; return { result, outcome: 'completed', contextChanged: true, sessionId: 's1' }; }
    return { result, outcome: 'completed', sessionId: 's1' };
  } });
  let writeId;
  const result = await runAgent({ task: 'Save once and verify the current context.', tools: runtime.tools, planner: async ({ step, tools, messages }) => {
    assert.equal(JSON.stringify(tools).includes('PRIVATE_TENANT'), false);
    assert.ok(tools.every(tool => Object.keys(tool).every(key => ['name', 'description', 'inputSchema', 'outputSchema', 'annotations'].includes(key))));
    if (step === 1) { assert.ok(tools.some(tool => tool.name === 'save_a')); return calls('save_a', 'save_a'); }
    assert.ok(tools.some(tool => tool.name === 'save_b')); assert.equal(tools.some(tool => tool.name === 'save_a'), false);
    if (step === 2) { writeId = messages.find(message => message.role === 'tool' && message.name === 'save_a').toolCallId; return finish(writeId); }
    if (step === 3) { assert.ok(messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED'))); return calls('tab_verify'); }
    return finish(last(messages).toolCallId);
  } });
  assert.equal(result.status, 'succeeded'); assert.equal(runtime.state.writes, 1);
  assert.equal(result.toolCalls, 2); assert.equal(result.plannerCalls, 4);
  assert.equal(runtime.state.prepared, 4); assert.equal(runtime.state.closed, 4);
  assert.equal(result.events.filter(event => event.type === 'tool_result' && event.skipped).length, 1);
  assert.notEqual(result.evidence[0].toolCallId, writeId);
  assert.deepEqual(result.checkpoint.executionIdentity, { registryHash: hash('contracts-v1'), contextHash: hash('tenant-a') });
  assert.equal(JSON.stringify(result).includes('PRIVATE_TENANT'), false);
});

test('a context change during planning or write-ahead persistence never executes the stale handler', async t => {
  for (const boundary of ['planning', 'write-ahead']) {
    const runtime = await fixture(t);
    const result = await runAgent({ task: 'Respect the execution lease.', tools: runtime.tools,
      onCheckpoint: checkpoint => { if (boundary === 'write-ahead' && checkpoint.phase === 'before_tool') runtime.state.epoch++; },
      planner: async ({ step, tools }) => {
        if (step === 1) { if (boundary === 'planning') runtime.state.epoch++; return calls('save_a'); }
        assert.ok(tools.some(tool => tool.name === 'save_b')); return input();
      },
    });
    assert.equal(result.status, 'needs_input'); assert.equal(runtime.state.writes, 0);
    assert.deepEqual(result.checkpoint.ambiguousCalls, []);
    assert.equal(runtime.state.closed, runtime.state.prepared);
    assert.equal(result.toolCalls, boundary === 'planning' ? 0 : 1);
    assert.ok(result.events.some(event => event.type === 'feedback' && event.code === 'CONTEXT_CHANGED'));
  }
});

test('trusted write effects retain ambiguity for thrown, malformed, error, and unknown outcomes', async t => {
  for (const kind of ['throw', 'malformed', 'error', 'unknown']) {
    const runtime = await fixture(t, { dispatch: async ({ execute }) => {
      const result = await execute();
      if (kind === 'throw') throw new Error('Unreliable completion after the write.');
      if (kind === 'malformed') return { result: { content: 'invalid' }, outcome: 'completed' };
      if (kind === 'error') return { result: rejection(), outcome: 'completed' };
      return { result, outcome: 'unknown' };
    } });
    const result = await runAgent({ task: `Handle uncertain ${kind}.`, tools: runtime.tools, planner: async () => calls('save_a', 'save_a') });
    assert.equal(result.status, 'needs_input'); assert.equal(runtime.state.writes, 1);
    assert.equal(result.checkpoint.ambiguousCalls.length, 1, 'Trusted metadata overrides misleading readOnlyHint.');
    const prepared = runtime.state.prepared;
    const resumed = await runAgent({ task: result.checkpoint.task, tools: runtime.tools, resume: result.checkpoint, planner: async () => { throw new Error('Must not replan an unresolved write.'); } });
    assert.equal(resumed.status, 'needs_input'); assert.equal(runtime.state.writes, 1); assert.equal(runtime.state.prepared, prepared);
    parseAgentCheckpoint(result.checkpoint);
  }
  const readonly = await fixture(t, { dispatch: async ({ execute }) => ({ result: await execute(), outcome: 'unknown' }) });
  const result = await runAgent({ task: 'Read without mutation ambiguity.', tools: readonly.tools, planner: async ({ step }) => step === 1 ? calls('read') : input() });
  assert.deepEqual(result.checkpoint.ambiguousCalls, [], 'Trusted read metadata overrides misleading write annotation.');
  assert.equal(result.status, 'needs_input');
});

test('finish rechecks its lease and cannot reuse verification from the old context', async t => {
  const runtime = await fixture(t); let oldEvidence;
  const result = await runAgent({ task: 'Verify the active context.', tools: runtime.tools, planner: async ({ step, messages }) => {
    if (step === 1) return calls('tab_verify');
    if (step === 2) { oldEvidence = last(messages).toolCallId; runtime.state.epoch++; return finish(oldEvidence); }
    if (step === 3) return finish(oldEvidence);
    if (step === 4) { assert.ok(messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED'))); return calls('tab_verify'); }
    return finish(last(messages).toolCallId);
  } });
  assert.equal(result.status, 'succeeded'); assert.equal(result.steps, 5);
  assert.notEqual(result.evidence[0].toolCallId, oldEvidence);
  assert.equal(runtime.state.closed, 5);
});

test('a context change between closed and newly prepared leases invalidates old verification', async t => {
  const runtime = await fixture(t, { onClose: state => { if (state.closed === 1) state.epoch++; } });
  let oldEvidence;
  const result = await runAgent({ task: 'Finish only for the same observed execution context.', tools: runtime.tools, planner: async ({ step, messages, tools }) => {
    for (const key of [hash('private-context-0'), hash('private-context-1')]) assert.equal(JSON.stringify({ messages, tools }).includes(key), false);
    if (step === 1) return calls('tab_verify');
    if (step === 2) {
      oldEvidence = last(messages).toolCallId;
      assert.ok(tools.some(tool => tool.name === 'save_b'));
      assert.ok(messages.some(message => message.role === 'user' && message.content.includes('between decisions')));
      return finish(oldEvidence);
    }
    if (step === 3) {
      assert.ok(messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED')));
      return calls('tab_verify');
    }
    return finish(last(messages).toolCallId);
  } });
  assert.equal(result.status, 'succeeded'); assert.equal(result.steps, 4);
  assert.notEqual(result.evidence[0].toolCallId, oldEvidence);
  assert.equal(result.toolCalls, 2); assert.equal(runtime.state.closed, 4);
  assert.equal(JSON.stringify(result).includes(hash('private-context-1')), false, 'Runtime context keys must not enter audit output or checkpoints.');
});

test('only a confirmed session close preserves current evidence across context changes and later writes still invalidate it', async t => {
  for (const mode of ['confirmed', 'unconfirmed', 'wrong-session', 'later-write']) {
    const runtime = await fixture(t, { dispatch: async ({ call, state, execute }) => {
      const result = await execute();
      if (call.name === 'tab_close') {
        state.epoch++;
        return { result: mode === 'unconfirmed' ? payload({ ok: true, closed: false, session_id: 's1' }) : mode === 'wrong-session' ? payload({ ok: true, closed: true, session_id: 'another-session' }) : result, outcome: 'completed', contextChanged: true, sessionId: 's1' };
      }
      if (mode === 'later-write' && call.name === 'save_b') { state.epoch++; return { result, outcome: 'completed', contextChanged: true, sessionId: 's1' }; }
      return { result, outcome: 'completed', sessionId: 's1' };
    } });
    let verified;
    const result = await runAgent({ task: `Verify and close with ${mode} outcome.`, tools: runtime.tools, planner: async ({ step, messages }) => {
      if (step === 1) return calls('tab_verify');
      if (step === 2) { verified = last(messages).toolCallId; return { type: 'tools', calls: [{ name: 'tab_close', arguments: { session_id: 's1' } }] }; }
      if (mode === 'later-write' && step === 3) return calls('save_b');
      if (step === (mode === 'later-write' ? 4 : 3)) return finish(verified);
      assert.ok(messages.some(message => message.role === 'user' && message.content.includes('VERIFICATION_REQUIRED')));
      return input();
    } });
    assert.equal(result.status, mode === 'confirmed' ? 'succeeded' : 'needs_input');
    if (mode === 'confirmed') assert.equal(result.evidence[0].toolCallId, verified);
    else assert.deepEqual(result.evidence, []);
    assert.equal(runtime.state.writes, mode === 'later-write' ? 1 : 0);
  }
});

test('bound checkpoints reject missing runtimes and changed registry or same-origin tenant identities', async t => {
  const runtime = await fixture(t);
  const first = await runAgent({ task: 'Resume in the same tenant.', tools: runtime.tools, planner: async () => input() });
  await assert.rejects(runAgent({ task: first.checkpoint.task, tools: runtime.connection.tools, resume: first.checkpoint, planner: async () => input() }), /bound tool execution/);
  for (const changed of ['registry', 'tenant']) {
    const previous = runtime.state[changed]; runtime.state[changed] = 'changed';
    const prepared = runtime.state.prepared;
    const rejected = await runAgent({ task: first.checkpoint.task, tools: runtime.tools, resume: first.checkpoint, planner: async () => { throw new Error('Must not plan under another identity.'); } });
    assert.equal(rejected.status, 'failed'); assert.equal(rejected.failure.code, 'EXECUTION_IDENTITY_MISMATCH');
    assert.equal(runtime.state.prepared, prepared); assert.equal(rejected.plannerCalls, first.plannerCalls);
    assert.deepEqual(rejected.checkpoint.executionIdentity, first.checkpoint.executionIdentity);
    runtime.state[changed] = previous;
  }
  const matched = await runAgent({ task: first.checkpoint.task, tools: runtime.tools, resume: first.checkpoint, planner: async () => input() });
  assert.equal(matched.status, 'needs_input'); assert.equal(matched.plannerCalls, 2);
  assert.throws(() => parseAgentCheckpoint({ ...first.checkpoint, executionIdentity: { ...first.checkpoint.executionIdentity, contextHash: 'not-a-hash' } }), /checkpoint/);
});

test('version-one and version-two checkpoints explicitly migrate unbound and cannot gain a registry', async t => {
  const runtime = await fixture(t);
  const original = await runAgent({ task: 'Keep the legacy execution boundary.', tools: runtime.connection.tools, planner: async () => input() });
  const { partialSchemaHash, requiresPartialPolicy, partials, ...legacyBase } = original.checkpoint;
  for (const version of [1, 2]) {
    const old = { ...legacyBase, schemaVersion: version };
    const migrated = parseAgentCheckpoint(old);
    assert.equal(migrated.schemaVersion, AGENT_CHECKPOINT_VERSION); assert.equal(migrated.executionIdentity, undefined);
    await assert.rejects(runAgent({ task: old.task, resume: old, tools: runtime.tools, planner: async () => input() }), /unbound checkpoint/);
    assert.throws(() => parseAgentCheckpoint({ ...old, executionIdentity: { registryHash: hash('a'), contextHash: hash('b') } }), /version/);
    const resumed = await runAgent({ task: old.task, resume: old, tools: runtime.connection.tools, planner: async () => input() });
    assert.equal(resumed.status, 'needs_input'); assert.equal(resumed.steps, 2);
  }
  await assert.rejects(runAgent({ task: 'Reject an incomplete interface.', tools: { ...runtime.connection.tools, prepareTools: runtime.tools.prepareTools }, planner: async () => input() }), /supplied together/);
});

test('version-three bound checkpoints migrate without gaining a final output contract', async t => {
  const runtime = await fixture(t);
  const original = await runAgent({ task: 'Preserve the old registry identity.', tools: runtime.tools, planner: async () => input() });
  const { partialSchemaHash, requiresPartialPolicy, partials, ...legacyBase } = original.checkpoint;
  const old = { ...legacyBase, schemaVersion: 3 };
  const migrated = parseAgentCheckpoint(old);
  assert.equal(migrated.schemaVersion, AGENT_CHECKPOINT_VERSION);
  assert.deepEqual(migrated.executionIdentity, original.checkpoint.executionIdentity);
  assert.equal(migrated.outputSchemaHash, undefined);
  assert.throws(() => parseAgentCheckpoint({ ...old, outputSchemaHash: hash('added-later') }), /version 3/);
  const resumed = await runAgent({ task: old.task, resume: old, tools: runtime.tools, planner: async () => input() });
  assert.equal(resumed.status, 'needs_input');
  assert.equal(resumed.steps, 2);
  const oldV4 = { ...legacyBase, schemaVersion: 4 };
  assert.deepEqual(parseAgentCheckpoint(oldV4).partials, []);
  assert.throws(() => parseAgentCheckpoint({ ...oldV4, partials: [] }), /version 4/);
});

test('resume rechecks a pending call effect rather than trusting a tampered mutating flag', async t => {
  const runtime = await fixture(t); let pending;
  const first = await runAgent({ task: 'Preserve uncertain writes.', tools: runtime.tools, planner: async () => calls('save_a'), onCheckpoint: checkpoint => { if (checkpoint.phase === 'before_tool') { pending = structuredClone(checkpoint); throw new Error('Stop before dispatch.'); } } });
  assert.equal(first.status, 'failed'); assert.equal(runtime.state.writes, 0);
  pending.pendingTool.mutating = false; pending.ambiguousCalls = [];
  runtime.state.tenant = 'another-tenant';
  const wrongIdentity = await runAgent({ task: pending.task, tools: runtime.tools, resume: pending, planner: async () => { throw new Error('Must not execute.'); } });
  assert.equal(wrongIdentity.failure.code, 'EXECUTION_IDENTITY_MISMATCH');
  assert.deepEqual(wrongIdentity.checkpoint.pendingTool, pending.pendingTool, 'An early identity failure cannot erase a pending claimed-read before effect validation.');
  runtime.state.tenant = 'tenant-a';
  const resumed = await runAgent({ task: pending.task, tools: runtime.tools, resume: wrongIdentity.checkpoint, planner: async () => { throw new Error('Must not execute.'); } });
  assert.equal(resumed.status, 'failed'); assert.equal(resumed.failure.code, 'EXECUTION_IDENTITY_MISMATCH');
  assert.equal(resumed.checkpoint.ambiguousCalls.length, 1); assert.equal(runtime.state.writes, 0);
  parseAgentCheckpoint(resumed.checkpoint);
});

test('initialization uses the bound dispatcher and each lease closes before terminal persistence', async t => {
  const runtime = await fixture(t);
  const result = await runAgent({ task: 'Open the explicit initial page.', startUrl: 'https://example.test/', tools: runtime.tools, planner: async ({ step, messages }) => {
    assert.equal(step, 1); assert.equal(last(messages).name, 'tab_open'); return input();
  }, onCheckpoint: checkpoint => { if (checkpoint.phase === 'terminal') assert.equal(runtime.state.closed, runtime.state.prepared); } });
  assert.equal(result.status, 'needs_input'); assert.equal(result.steps, 1); assert.equal(result.toolCalls, 1);
  assert.equal(runtime.state.prepared, 2); assert.equal(runtime.state.actualCalls[0].name, 'tab_open');
  assert.equal(result.checkpoint.initialization.toolCallId, runtime.state.actualCalls[0].id);
  const controller = new AbortController();
  const cancellation = await fixture(t, { onClose: () => controller.abort() });
  const cancelled = await runAgent({ task: 'Account for cancellation during lease release.', tools: cancellation.tools, signal: controller.signal, planner: async () => input() });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancellation.state.closed, 1);
});

test('a prepared lease that arrives after cancellation is still closed without planning', async t => {
  const runtime = await fixture(t); const controller = new AbortController(); let release;
  const prepare = runtime.tools.prepareTools;
  runtime.tools.prepareTools = async options => { const lease = await prepare(options); await new Promise(resolve => { release = resolve; controller.abort(); }); return lease; };
  const result = await runAgent({ task: 'Cancel during catalog preparation.', tools: runtime.tools, signal: controller.signal, planner: async () => { throw new Error('Must not plan.'); } });
  assert.equal(result.status, 'cancelled'); assert.equal(result.plannerCalls, 0);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.state.closed, 1);
});

test('catalog release failure or cancellation cannot turn accepted verification into success', async t => {
  for (const mode of ['error', 'cancel']) {
    const controller = new AbortController();
    const runtime = await fixture(t, { onClose: state => {
      if (state.prepared === 2) {
        if (mode === 'error') throw new Error('Private lease-release detail.');
        controller.abort();
      }
    } });
    const result = await runAgent({ task: 'Finish only after closing the active lease.', tools: runtime.tools, signal: controller.signal, planner: async ({ step, messages }) => step === 1 ? calls('tab_verify') : finish(last(messages).toolCallId) });
    assert.equal(result.status, mode === 'error' ? 'failed' : 'cancelled');
    assert.deepEqual(result.evidence, []); assert.equal(runtime.state.closed, 2);
    if (mode === 'error') assert.equal(result.failure.code, 'TOOL_CATALOG_CLOSE_FAILED');
    assert.equal(JSON.stringify(result).includes('Private lease-release detail.'), false);
  }
});
