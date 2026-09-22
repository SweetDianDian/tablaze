import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAICompatiblePlanner, runAgent } from '../dist/agent.js';

const response = (name = 'agent_request_input', args = { question: 'Which record?' }) => new Response(JSON.stringify({
  choices: [{ message: { tool_calls: [{ type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
}));
const call = (id, name = 'inspect') => ({ id, name, arguments: {} });
const assistant = (...toolCalls) => ({ role: 'assistant', content: '', toolCalls });
const tool = (id, result, name = 'inspect') => ({ role: 'tool', toolCallId: id, name, result });
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

async function project(messages, options = {}) {
  let request;
  const planner = createOpenAICompatiblePlanner({
    endpoint: 'http://localhost/scripted', model: 'fixture', ...options,
    fetch: async (_url, init) => { request = JSON.parse(init.body); return response(); },
  });
  await planner({ task: 'Inspect the result.', step: 1, tools: [], messages, signal: new AbortController().signal });
  return request.messages;
}

test('planner removes only exact plain duplicates while preserving errors and distinct or annotated text', async () => {
  const structuredContent = { ok: false, error: { code: 'NOT_SAVED', message: 'Saving failed.' } };
  const text = JSON.stringify(structuredContent);
  const retained = [
    { type: 'text', text: 'The form still requires a billing address.' },
    { type: 'text', text, annotations: { audience: ['assistant'], priority: 1 } },
    { type: 'text', text, _meta: { provenance: 'external-service' } },
    { type: 'text', text, custom: true },
    { type: 'text', text: JSON.stringify(structuredContent, null, 2) },
    { type: 'text', text: JSON.stringify({ error: structuredContent.error, ok: false }) },
  ];
  const result = { content: [{ type: 'text', text }, ...retained], structuredContent, isError: true, _meta: { source: 'fixture' } };
  const messages = freeze([assistant(call('c1')), tool('c1', result)]);
  const before = structuredClone(messages);
  const projected = await project(messages);
  const serialized = JSON.parse(projected[1].content);
  assert.equal(projected[1].tool_call_id, 'c1');
  assert.deepEqual(serialized, { toolCallId: 'c1', ...result, content: retained });
  assert.deepEqual(messages, before);
});

test('planner retains text-only fallback and near-duplicate serialization', async () => {
  const fallback = { content: [{ type: 'text', text: '{"ok":false,"error":"Rejected"}' }, { type: 'text', text: 'Ask the operator.' }], isError: true };
  const nearDuplicate = { content: [{ type: 'text', text: '{}\n' }], structuredContent: {} };
  const projected = await project([assistant(call('c1'), call('c2')), tool('c1', fallback), tool('c2', nearDuplicate)]);
  assert.deepEqual(JSON.parse(projected[1].content), { toolCallId: 'c1', ...fallback });
  assert.deepEqual(JSON.parse(projected[2].content), { toolCallId: 'c2', ...nearDuplicate });
});

test('projection preserves image order and complete assistant/tool groups with and without image support', async () => {
  const first = { page: 'first' };
  const second = { page: 'second' };
  const messages = freeze([
    assistant(call('c1'), call('c2')),
    tool('c1', { content: [
      { type: 'text', text: JSON.stringify(first) },
      { type: 'text', text: 'Before image.' },
      { type: 'image', data: 'YQ==', mimeType: 'image/png' },
      { type: 'text', text: 'After image.' },
    ], structuredContent: first }),
    tool('c2', { content: [
      { type: 'image', data: 'Yg==', mimeType: 'image/jpeg' },
      { type: 'text', text: JSON.stringify(second) },
      { type: 'image', data: 'Yw==', mimeType: 'image/png' },
    ], structuredContent: second, isError: false }),
    assistant(call('c3')),
    tool('c3', { content: [{ type: 'image', data: 'ZA==', mimeType: 'image/png' }] }),
  ]);
  const before = structuredClone(messages);
  const projected = await project(messages);
  assert.deepEqual(projected.map(message => message.role), ['assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'user']);
  assert.deepEqual(projected.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['c1', 'c2', 'c3']);
  assert.deepEqual(projected[3].content.filter(item => item.type === 'image_url').map(item => item.image_url.url), [
    'data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg==', 'data:image/png;base64,Yw==',
  ]);
  assert.equal(projected[6].content[1].image_url.url, 'data:image/png;base64,ZA==');
  const firstContent = JSON.parse(projected[1].content).content;
  assert.equal(firstContent[0].text, 'Before image.');
  assert.match(firstContent[1].text, /Image from inspect/);
  assert.equal(firstContent[2].text, 'After image.');
  assert.equal(JSON.parse(projected[2].content).isError, false);
  const textOnly = await project(messages, { supportsImages: false });
  assert.deepEqual(textOnly.map(message => message.role), ['assistant', 'tool', 'tool', 'assistant', 'tool']);
  assert.match(JSON.parse(textOnly[1].content).content[1].text, /omitted for a text-only model/);
  assert.deepEqual(messages, before);
});

test('projection leaves successful evidence, full history, events, and saved checkpoints intact', async () => {
  const value = { ok: true, session_id: 's1', passed: true, checks: [{ kind: 'text', pass: true }] };
  const result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  const saved = [];
  let modelCalls = 0;
  const planner = createOpenAICompatiblePlanner({ endpoint: 'http://localhost/scripted', model: 'fixture', fetch: async (_url, init) => {
    const request = JSON.parse(init.body);
    modelCalls++;
    if (modelCalls === 1) return response('tab_verify', { session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] });
    const verification = request.messages.find(message => message.role === 'tool');
    assert.deepEqual(JSON.parse(verification.content), { toolCallId: verification.tool_call_id, ...result, content: [] });
    return response('agent_finish', { summary: 'Saved status verified.', evidence: [verification.tool_call_id] });
  } });
  const run = await runAgent({ task: 'Verify the saved status.', planner,
    tools: {
      listTools: async () => [{ name: 'tab_verify', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      callTool: async () => result,
    },
    onCheckpoint: async checkpoint => { saved.push(structuredClone(checkpoint)); },
  });
  assert.equal(run.status, 'succeeded');
  assert.equal(modelCalls, 2);
  assert.deepEqual(run.evidence[0].result, result);
  assert.deepEqual(run.history.find(message => message.role === 'tool').result, result);
  assert.deepEqual(run.events.find(event => event.type === 'tool_result').result, result);
  assert.deepEqual(run.checkpoint.history.find(message => message.role === 'tool').result, result);
  assert.ok(saved.some(checkpoint => checkpoint.history.some(message => message.role === 'tool')));
  // Write-ahead checkpoints contain an unknown-outcome placeholder until the
  // result arrives; their text/structured pairing must remain intact as well.
  for (const checkpoint of saved) for (const message of checkpoint.history) if (message.role === 'tool') {
    assert.equal(message.result.content[0].text, JSON.stringify(message.result.structuredContent));
    if (checkpoint.phase === 'terminal') assert.deepEqual(message.result, result);
  }
});
