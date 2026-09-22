import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../dist/agent.js';
import { parseAgentCheckpoint } from '../dist/checkpoint.js';

const data = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const readOnlyTools = {
  listTools: async () => [{ name: 'tab_verify', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
  callTool: async () => data({ ok: true, session_id: 's1', passed: true, checks: [{ pass: true }] }),
};
const finishPlanner = async ({ step, messages }) => step === 1
  ? { type: 'tools', calls: [{ name: 'tab_verify', arguments: { session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] } }] }
  : { type: 'finish', summary: 'The result was verified.', evidence: [messages.findLast(message => message.role === 'tool').toolCallId] };

test('cancellation during terminal persistence cannot return succeeded with accepted evidence', async () => {
  const controller = new AbortController();
  const result = await runAgent({ task: 'Respect cancellation while saving the final checkpoint.', tools: readOnlyTools, planner: finishPlanner, signal: controller.signal, onCheckpoint: async checkpoint => {
    if (checkpoint.phase === 'terminal') { controller.abort(); await Promise.resolve(); }
  } });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.evidence, []);
  parseAgentCheckpoint(result.checkpoint);
});

test('deadline expiry during terminal persistence is reported and returned elapsed time includes the wait', async () => {
  const result = await runAgent({ task: 'Respect the deadline while saving completion.', tools: readOnlyTools, planner: finishPlanner, timeoutMs: 100, onCheckpoint: async checkpoint => {
    if (checkpoint.phase === 'terminal') await new Promise(resolve => setTimeout(resolve, 150));
  } });
  assert.equal(result.status, 'limit_reached');
  assert.deepEqual(result.evidence, []);
  assert.ok(result.checkpoint.elapsedMs >= 140, `Returned elapsed was ${result.checkpoint.elapsedMs} ms`);
  parseAgentCheckpoint(result.checkpoint);
});

test('returned checkpoint accounts for final persistence time before a later resume', async () => {
  const first = await runAgent({ task: 'Preserve the active time budget.', tools: readOnlyTools, timeoutMs: 1000, planner: async () => ({ type: 'human_input', question: 'Which record?' }), onCheckpoint: async checkpoint => {
    if (checkpoint.phase === 'terminal') await new Promise(resolve => setTimeout(resolve, 40));
  } });
  assert.ok(first.checkpoint.elapsedMs >= 35, `Returned elapsed was ${first.checkpoint.elapsedMs} ms`);
  const resumed = await runAgent({ task: first.checkpoint.task, tools: readOnlyTools, resume: first.checkpoint, planner: async () => ({ type: 'human_input', question: 'Which record?' }) });
  assert.ok(resumed.checkpoint.elapsedMs >= first.checkpoint.elapsedMs);
  assert.equal(resumed.steps, 2);
});

test('resume retains application restrictions unless the caller explicitly replaces them', async () => {
  const restriction = 'Application restriction: do not submit payments.';
  const first = await runAgent({ task: 'Continue the same user task.', tools: readOnlyTools, systemPrompt: restriction, planner: async () => ({ type: 'human_input', question: 'Which account?' }) });
  const savedVariants = [first.checkpoint, (() => { const legacy = structuredClone(first.checkpoint); delete legacy.systemPrompt; return legacy; })()];
  for (const resume of savedVariants) {
    let observed;
    const resumed = await runAgent({ task: first.checkpoint.task, tools: readOnlyTools, resume, planner: async ({ messages }) => { observed = messages[0].content; return { type: 'human_input', question: 'Which account?' }; } });
    assert.ok(observed.includes(restriction), 'The retained checkpoint must not silently drop application restrictions');
    assert.ok(resumed.history[0].content.includes(restriction));
    parseAgentCheckpoint(resumed.checkpoint);
  }
  const updated = await runAgent({ task: first.checkpoint.task, tools: readOnlyTools, resume: first.checkpoint, systemPrompt: 'Updated application policy.', planner: async () => ({ type: 'human_input', question: 'Which account?' }) });
  assert.match(updated.history[0].content, /Updated application policy/);
  assert.ok(!updated.history[0].content.includes(restriction));
});

test('resume cannot silently remove a previously required application completion policy', async () => {
  const first = await runAgent({ task: 'Require the application acceptance policy.', tools: readOnlyTools, validateCompletion: () => false, maxSteps: 3, planner: async () => ({ type: 'human_input', question: 'Review the invoice first.' }) });
  assert.equal(first.checkpoint.requiresCompletionPolicy, true);
  let listed = false, planned = false;
  await assert.rejects(runAgent({ task: first.checkpoint.task, resume: first.checkpoint, tools: { ...readOnlyTools, listTools: async () => { listed = true; return readOnlyTools.listTools(); } }, planner: async () => { planned = true; return { type: 'human_input', question: 'Should never run.' }; } }), /validateCompletion/);
  assert.equal(listed, false);
  assert.equal(planned, false);
  const resumed = await runAgent({ task: first.checkpoint.task, resume: first.checkpoint, tools: readOnlyTools, validateCompletion: () => 'A passing generic check does not satisfy this application.', planner: async ({ step, messages }) => step === 2
    ? { type: 'tools', calls: [{ name: 'tab_verify', arguments: { session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] } }] }
    : { type: 'finish', summary: 'Attempt to bypass application acceptance.', evidence: [messages.findLast(message => message.role === 'tool').toolCallId] } });
  assert.equal(resumed.status, 'limit_reached');
  assert.ok(resumed.events.some(event => event.type === 'feedback' && event.code === 'COMPLETION_REJECTED'));
  assert.equal(resumed.checkpoint.requiresCompletionPolicy, true);
  parseAgentCheckpoint(resumed.checkpoint);
});
