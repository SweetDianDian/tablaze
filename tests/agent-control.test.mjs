import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgentControl } from '../dist/agent-control.js';
import { runAgent } from '../dist/agent.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const lastTool = messages => messages.filter(item => item.role === 'tool').at(-1);
function tools({ onWrite } = {}) {
  const writes = [];
  return {
    writes,
    client: {
      listTools: async () => [
        { name: 'write', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: false } },
        { name: 'tab_verify', inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, checks: { type: 'array' } }, required: ['session_id', 'checks'] }, annotations: { readOnlyHint: true } },
      ],
      callTool: async call => {
        if (call.name === 'write') { writes.push(call.arguments.value); await onWrite?.(); return result({ ok: true, session_id: 's1' }); }
        return result({ ok: true, session_id: 's1', passed: true, checks: [{ kind: 'text', pass: true }] });
      },
    },
  };
}

test('pause waits for a tool boundary, then steering skips the queued write without replay', { timeout: 10_000 }, async () => {
  const started = deferred(), release = deferred();
  const control = createAgentControl();
  const runtime = tools({ onWrite: async () => { started.resolve(); await release.promise; } });
  const run = runAgent({ task: 'Write only the accepted value and verify it.', tools: runtime.client, control, maxSteps: 4,
    planner: async ({ step, messages }) => {
      if (step === 1) return { type: 'tools', calls: [{ name: 'write', arguments: { value: 'accepted' } }, { name: 'write', arguments: { value: 'stale-queued' } }] };
      if (step === 2) {
        assert.ok(messages.some(item => item.role === 'user' && item.content.includes('Do not repeat the write')));
        return { type: 'tools', calls: [{ name: 'tab_verify', arguments: { session_id: 's1', checks: [{ kind: 'text', contains: 'accepted' }] } }] };
      }
      return { type: 'finish', summary: 'One accepted write.', evidence: [lastTool(messages).toolCallId] };
    },
  });
  await started.promise;
  const paused = control.pause();
  release.resolve();
  assert.equal(await paused, true);
  assert.deepEqual(runtime.writes, ['accepted']);
  control.steer('Do not repeat the write; verify the accepted value.');
  control.resume();
  const completed = await run;
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(runtime.writes, ['accepted']);
  assert.equal(completed.toolCalls, 2);
  assert.equal(completed.history.filter(item => item.role === 'tool' && item.result.structuredContent?.error?.code === 'CALL_SKIPPED').length, 1);
  assert.equal(completed.checkpoint.ambiguousCalls.length, 0);
  assert.equal(await control.pause(), false);
});

test('steering during planning discards the stale decision before any tool starts', { timeout: 10_000 }, async () => {
  const started = deferred(), release = deferred();
  const control = createAgentControl(), runtime = tools();
  const run = runAgent({ task: 'Wait for operator direction.', tools: runtime.client, control, maxSteps: 2,
    planner: async ({ step, messages }) => {
      if (step === 1) { started.resolve(); await release.promise; return { type: 'tools', calls: [{ name: 'write', arguments: { value: 'obsolete' } }] }; }
      assert.ok(messages.some(item => item.role === 'user' && item.content.includes('Only inspect')));
      return { type: 'human_input', question: 'Inspection complete.' };
    },
  });
  await started.promise;
  const paused = control.pause();
  release.resolve();
  assert.equal(await paused, true);
  control.steer('Only inspect; do not write.');
  control.resume();
  const completed = await run;
  assert.equal(completed.status, 'needs_input');
  assert.deepEqual(runtime.writes, []);
  assert.equal(completed.toolCalls, 0);
});

test('a pause during write-ahead persistence prevents dispatch and creates no ambiguous write', { timeout: 10_000 }, async () => {
  const saving = deferred(), release = deferred();
  const control = createAgentControl(), runtime = tools();
  let first = true;
  const run = runAgent({ task: 'Wait before writing.', tools: runtime.client, control, maxSteps: 2,
    onCheckpoint: async checkpoint => { if (checkpoint.phase === 'before_tool' && first) { first = false; saving.resolve(); await release.promise; } },
    planner: async ({ step }) => step === 1 ? { type: 'tools', calls: [{ name: 'write', arguments: { value: 'obsolete' } }] } : { type: 'human_input', question: 'Paused before write.' },
  });
  await saving.promise;
  const paused = control.pause();
  release.resolve();
  assert.equal(await paused, true);
  assert.deepEqual(runtime.writes, []);
  control.resume();
  const completed = await run;
  assert.equal(completed.status, 'needs_input');
  assert.deepEqual(runtime.writes, []);
  assert.equal(completed.checkpoint.ambiguousCalls.length, 0);
  assert.ok(completed.history.some(item => item.role === 'tool' && item.result.structuredContent?.error?.code === 'CONTROLLED_REPLAN'));
});

test('cancellation wakes a paused run without dispatching its planned write', { timeout: 10_000 }, async () => {
  const control = createAgentControl(), abort = new AbortController(), runtime = tools();
  const planning = deferred();
  let pause;
  const run = runAgent({ task: 'Stop safely.', tools: runtime.client, control, signal: abort.signal,
    onEvent: event => { if (event.type === 'planning') { pause = control.pause(); planning.resolve(); } },
    planner: async () => ({ type: 'tools', calls: [{ name: 'write', arguments: { value: 'must-not-run' } }] }),
  });
  await planning.promise;
  assert.equal(await pause, true);
  abort.abort();
  const completed = await run;
  assert.equal(completed.status, 'cancelled');
  assert.deepEqual(runtime.writes, []);
  assert.equal(await control.pause(), false);
});

test('cancellation at the persisted pre-dispatch pause keeps the write known not started', { timeout: 10_000 }, async () => {
  const control = createAgentControl(), abort = new AbortController(), runtime = tools();
  const saving = deferred(), release = deferred();
  const run = runAgent({ task: 'Cancel before the write.', tools: runtime.client, control, signal: abort.signal,
    onCheckpoint: async checkpoint => { if (checkpoint.phase === 'before_tool') { saving.resolve(); await release.promise; } },
    planner: async () => ({ type: 'tools', calls: [{ name: 'write', arguments: { value: 'must-not-run' } }] }),
  });
  await saving.promise;
  const paused = control.pause();
  release.resolve();
  assert.equal(await paused, true);
  abort.abort();
  const completed = await run;
  assert.equal(completed.status, 'cancelled');
  assert.deepEqual(runtime.writes, []);
  assert.deepEqual(completed.checkpoint.ambiguousCalls, []);
});

test('one control cannot bind a second live run or leak steering across runs', { timeout: 10_000 }, async () => {
  const control = createAgentControl(), runtime = tools(), started = deferred(), release = deferred();
  const first = runAgent({ task: 'First run.', tools: runtime.client, control,
    planner: async () => { started.resolve(); await release.promise; return { type: 'human_input', question: 'Done.' }; },
  });
  await started.promise;
  control.steer('Only the first run may see this.');
  const second = await runAgent({ task: 'Second run.', tools: runtime.client, control, planner: async () => ({ type: 'human_input', question: 'Should never plan.' }) });
  assert.equal(second.status, 'failed');
  assert.equal(second.failure.code, 'EXECUTOR_FAILED');
  release.resolve();
  const original = await first;
  assert.equal(original.status, 'needs_input');
  assert.ok(original.history.some(item => item.role === 'user' && item.content.includes('Only the first run')));
  const reused = await runAgent({ task: 'Third run.', tools: runtime.client, control, planner: async ({ messages }) => {
    assert.equal(messages.some(item => item.role === 'user' && item.content.includes('Only the first run')), false);
    return { type: 'human_input', question: 'Fresh control.' };
  } });
  assert.equal(reused.status, 'needs_input');
});

test('pausing the explicit start URL still opens it exactly once after resume', { timeout: 10_000 }, async () => {
  const control = createAgentControl(), saving = deferred(), release = deferred(), opened = [];
  const client = {
    listTools: async () => [{ name: 'tab_open', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, annotations: { readOnlyHint: false } }],
    callTool: async call => { opened.push(call.arguments.url); return result({ ok: true, session_id: 's1', snapshot_id: 'snap-1' }); },
  };
  const run = runAgent({ task: 'Open the approved start URL.', startUrl: 'https://example.test/', tools: client, control,
    onCheckpoint: async checkpoint => { if (checkpoint.phase === 'before_tool') { saving.resolve(); await release.promise; } },
    planner: async ({ step }) => { assert.equal(step, 1); return { type: 'human_input', question: 'Opened.' }; },
  });
  await saving.promise;
  const paused = control.pause();
  release.resolve();
  assert.equal(await paused, true);
  assert.deepEqual(opened, []);
  control.resume();
  const completed = await run;
  assert.equal(completed.status, 'needs_input');
  assert.deepEqual(opened, ['https://example.test/']);
  assert.equal(completed.toolCalls, 1);
});

test('operator pause invalidates pre-pause verification and requires a fresh check', { timeout: 10_000 }, async () => {
  const control = createAgentControl(), runtime = tools(), firstCheck = deferred();
  let pause, oldId, newId;
  const run = runAgent({ task: 'Verify the current state after intervention.', tools: runtime.client, control, maxSteps: 4,
    onEvent: event => { if (event.type === 'tool_result' && event.call.name === 'tab_verify' && !pause) { pause = control.pause(); firstCheck.resolve(); } },
    planner: async ({ step, messages }) => {
      if (step === 1 || step === 3) return { type: 'tools', calls: [{ name: 'tab_verify', arguments: { session_id: 's1', checks: [{ kind: 'text', contains: 'current' }] } }] };
      if (step === 2) { oldId = lastTool(messages).toolCallId; return { type: 'finish', summary: 'Old check.', evidence: [oldId] }; }
      newId = lastTool(messages).toolCallId;
      return { type: 'finish', summary: 'Fresh check.', evidence: [newId] };
    },
  });
  await firstCheck.promise;
  assert.equal(await pause, true);
  control.resume();
  const completed = await run;
  assert.equal(completed.status, 'succeeded');
  assert.notEqual(oldId, newId);
  assert.equal(completed.evidence[0].toolCallId, newId);
  assert.ok(completed.events.some(event => event.type === 'feedback' && event.code === 'VERIFICATION_REQUIRED'));
});
