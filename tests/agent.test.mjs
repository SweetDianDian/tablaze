import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createServer } from '../dist/server.js';
import { connectAgentTools, createOpenAICompatiblePlanner, runAgent } from '../dist/agent.js';
import { parseAgentCheckpoint } from '../dist/checkpoint.js';

const tool = (name, args = {}) => ({ type: 'tools', calls: [{ name, arguments: args }] });
const done = (...evidence) => ({ type: 'finish', summary: 'Verified requested result.', evidence });
const payload = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const results = messages => messages.filter(message => message.role === 'tool');
const last = messages => results(messages).at(-1);

async function mockMcp(t) {
  const server = new McpServer({ name: 'agent-protocol-fixture', version: '1' });
  const observed = [];
  server.registerTool('change', { inputSchema: z.object({ session_id: z.string(), value: z.string() }).strict(), annotations: { readOnlyHint: false } }, async args => {
    observed.push(args); return payload({ ok: true, session_id: args.session_id });
  });
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() })).min(1), pass: z.boolean().optional(), force_error: z.boolean().optional() }).strict(), annotations: { readOnlyHint: true } }, async args => ({ ...payload({ ok: true, session_id: args.session_id, passed: args.pass !== false, checks: args.checks.map(check => ({ kind: check.kind, pass: args.pass !== false })) }), ...(args.force_error ? { isError: true } : {}) }));
  server.registerTool('tab_close', { inputSchema: z.object({ session_id: z.string() }).strict(), annotations: { readOnlyHint: false } }, async args => payload({ ok: true, session_id: args.session_id }));
  server.registerTool('stale', { inputSchema: z.object({}).strict(), annotations: { readOnlyHint: false } }, async () => {
    observed.push('stale'); return payload({ ok: false, error: { code: 'STALE_REFERENCE', message: 'Observe again.' } });
  });
  server.registerTool('tab_snapshot', { inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true } }, async () => payload({ ok: true, snapshot_id: 'fresh' }));
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  return { ...connection, observed };
}
const check = (session_id = 's1', extras = {}) => ({ session_id, checks: [{ kind: 'text', contains: 'Requested result' }], ...extras });

test('agent drives real MCP browser tools and requires verified form state before finishing', { timeout: 30_000 }, async t => {
  const fixture = createHttpServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Agent fixture</title><label>Name<input id="name" aria-label="Name"></label><button onclick="document.querySelector(\'#status\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><p id="status">Ready</p>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const runtime = createServer({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1_000 });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  let sessionId;
  let verificationId;
  const run = await runAgent({ task: 'Save Ada in the Name field.', tools: connection.tools, maxSteps: 5, planner: async ({ step, messages }) => {
    if (step === 1) return tool('tab_open', { url: `http://127.0.0.1:${fixture.address().port}/` });
    const previous = last(messages);
    if (step === 2) {
      const page = previous.result.structuredContent;
      sessionId = page.session_id;
      return tool('tab_act', { session_id: sessionId, snapshot_id: page.snapshot_id, actions: [{ type: 'fill', ref: page.elements.find(el => el.name === 'Name').ref, value: 'Ada' }, { type: 'click', ref: page.elements.find(el => el.name === 'Save').ref }] });
    }
    if (step === 3) return tool('tab_verify', { session_id: sessionId, checks: [{ kind: 'text', contains: 'Saved Ada' }, { kind: 'value', selector: '#name', value: 'Ada' }] });
    if (step === 4) { verificationId = previous.toolCallId; return tool('tab_close', { session_id: sessionId }); }
    return done(verificationId);
  }, validateCompletion: ({ evidence }) => evidence.some(item => item.arguments.checks.some(item => item.kind === 'value' && item.selector === '#name' && item.value === 'Ada')) });
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(run.toolCalls, 4);
  assert.equal(run.evidence[0].checks.every(item => item.pass), true);
  assert.deepEqual(runtime.engine.list(), []);
});

test('MCP schema rejects malformed arguments before side effects, then planner can recover', async t => {
  const connection = await mockMcp(t);
  const run = await runAgent({ task: 'Change a string.', tools: connection.tools, planner: async ({ step, messages }) => {
    if (step === 1) return tool('change', { session_id: 's1', value: 42 });
    if (step === 2) {
      assert.equal(last(messages).result.isError, true);
      assert.deepEqual(connection.observed, []);
      return tool('change', { session_id: 's1', value: 'correct' });
    }
    if (step === 3) return tool('tab_verify', check());
    return done(last(messages).toolCallId);
  } });
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(connection.observed, [{ session_id: 's1', value: 'correct' }]);
});

test('stale-reference result stops the batch and is returned for replanning without retry', async t => {
  const connection = await mockMcp(t);
  const run = await runAgent({ task: 'Recover from an outdated page.', tools: connection.tools, planner: async ({ step, messages }) => {
    if (step === 1) return { type: 'tools', calls: [{ name: 'stale', arguments: {} }, { name: 'change', arguments: { session_id: 's1', value: 'must not execute' } }] };
    if (step === 2) {
      assert.equal(results(messages)[0].result.structuredContent.error.code, 'STALE_REFERENCE');
      assert.equal(last(messages).result.structuredContent.error.code, 'CALL_SKIPPED');
      return tool('tab_snapshot');
    }
    return { type: 'human_input', question: 'The page changed. Which record should be updated?' };
  } });
  assert.equal(run.status, 'needs_input');
  assert.deepEqual(connection.observed, ['stale']);
  assert.equal(run.toolCalls, 2);
});

test('failed checks and isError=true cannot satisfy completion even when passed=true', async t => {
  for (const extras of [{ pass: false }, { force_error: true }]) {
    const connection = await mockMcp(t);
    const run = await runAgent({ task: 'Verify the result.', tools: connection.tools, maxSteps: 2, planner: async ({ step, messages }) => step === 1 ? tool('tab_verify', check('s1', extras)) : done(last(messages).toolCallId) });
    assert.equal(run.status, 'limit_reached');
    assert.ok(run.events.some(event => event.type === 'feedback' && event.code === 'VERIFICATION_REQUIRED'));
  }
});

test('completion rejects stale evidence, another session, invented IDs, and contradicted checks', async t => {
  const cases = ['stale', 'other-session', 'invented', 'contradicted'];
  for (const mode of cases) {
    const connection = await mockMcp(t);
    let verificationId;
    const run = await runAgent({ task: 'Change and verify s1.', tools: connection.tools, maxSteps: 4, planner: async ({ step, messages }) => {
      if (step === 1) return tool('change', { session_id: 's1', value: 'first' });
      if (step === 2) return tool('tab_verify', check(mode === 'other-session' ? 's2' : 's1'));
      if (step === 3) {
        verificationId = last(messages).toolCallId;
        if (mode === 'stale') return tool('change', { session_id: 's1', value: 'second' });
        if (mode === 'contradicted') return tool('tab_verify', check('s1', { pass: false }));
        return done(mode === 'invented' ? 'fake-id' : verificationId);
      }
      return done(mode === 'invented' ? 'fake-id' : verificationId);
    } });
    assert.equal(run.status, 'limit_reached', mode);
    assert.deepEqual(run.evidence, [], mode);
  }
});

test('application task-specific acceptance can reject a technically passing unrelated check', async t => {
  const connection = await mockMcp(t);
  const run = await runAgent({ task: 'Require actual invoice submission.', tools: connection.tools, maxSteps: 2, validateCompletion: () => 'The invoice confirmation ID must be checked.', planner: async ({ step, messages }) => step === 1 ? tool('tab_verify', check()) : done(last(messages).toolCallId) });
  assert.equal(run.status, 'limit_reached');
  assert.ok(run.events.some(event => event.type === 'feedback' && event.code === 'COMPLETION_REJECTED'));
});

test('final data needs valid JSON, a matching schema, verification, and application acceptance', async t => {
  const connection = await mockMcp(t);
  const schema = { type: 'object', properties: { receiptId: { type: 'string', pattern: '^WF-[0-9]{3}$' }, amount: { type: 'integer', minimum: 1 } }, required: ['receiptId', 'amount'], additionalProperties: false };
  let verifiedId;
  const run = await runAgent({ task: 'Report the verified invoice receipt.', tools: connection.tools, maxSteps: 5, finalOutputSchema: schema,
    validateCompletion: ({ data, evidence }) => data?.receiptId === 'WF-001' && evidence.length === 1 || 'The returned receipt does not match the accepted invoice.',
    planner: async ({ step, messages, finalOutputSchema }) => {
      assert.deepEqual(finalOutputSchema, schema);
      if (step === 1) return tool('tab_verify', check());
      verifiedId = last(messages).toolCallId;
      if (step === 2) return { ...done(verifiedId), data: { receiptId: 'WF-001', amount: '2' } };
      if (step === 3) return { ...done(verifiedId), data: { receiptId: 'WF-999', amount: 2 } };
      return { ...done(verifiedId), data: { receiptId: 'WF-001', amount: 2 } };
    },
  });
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.data, { receiptId: 'WF-001', amount: 2 });
  assert.equal(run.toolCalls, 1);
  assert.deepEqual(run.events.filter(item => item.type === 'feedback').map(item => item.code), ['FINAL_OUTPUT_INVALID', 'COMPLETION_REJECTED']);
  assert.match(run.checkpoint.outputSchemaHash, /^[a-f0-9]{64}$/);
});

test('checked partials survive limits and resume without duplicating a write', async t => {
  const connection = await mockMcp(t);
  const schema = { type: 'object', properties: { receiptId: { type: 'string', pattern: '^WF-[0-9]{3}$' } }, required: ['receiptId'], additionalProperties: false };
  const validatePartial = ({ data }) => data.receiptId !== 'WF-999' || 'This receipt was not accepted by the application.';
  let verificationId;
  const first = await runAgent({ task: 'Process verified receipts.', tools: connection.tools, maxSteps: 6, partialOutputSchema: schema, validatePartial,
    planner: async ({ step, messages, partialOutputSchema }) => {
      assert.deepEqual(partialOutputSchema, schema);
      if (step === 1) return tool('change', { session_id: 's1', value: 'WF-001' });
      if (step === 2) return tool('tab_verify', check());
      verificationId = last(messages).toolCallId;
      if (step === 3) return { type: 'publish', key: 'receipt-1', data: { receiptId: 42 }, evidence: [verificationId] };
      if (step === 4) return { type: 'publish', key: 'receipt-1', data: { receiptId: 'WF-999' }, evidence: [verificationId] };
      return { type: 'publish', key: 'receipt-1', data: { receiptId: 'WF-001' }, evidence: [verificationId] };
    },
  });
  assert.equal(first.status, 'limit_reached');
  assert.equal(first.data, undefined);
  assert.deepEqual(first.partials.map(item => item.key), ['receipt-1']);
  assert.deepEqual(first.partials[0].data, { receiptId: 'WF-001' });
  assert.equal(first.partials[0].evidence[0].toolCallId, verificationId);
  assert.deepEqual(first.events.filter(item => item.type === 'feedback').map(item => item.code), ['PARTIAL_INVALID', 'PARTIAL_REJECTED', 'PARTIAL_KEY_EXISTS']);
  assert.deepEqual(first.checkpoint.partials, first.partials);
  assert.equal(connection.observed.length, 1);
  const tampered = structuredClone(first.checkpoint);
  tampered.partials[0].data.receiptId = 'WF-002';
  assert.throws(() => parseAgentCheckpoint(tampered), /retained publication history/);
  await assert.rejects(runAgent({ task: first.checkpoint.task, tools: connection.tools, resume: first.checkpoint, planner: async () => { throw new Error('Must not plan.'); } }), /partial output schema/);
  await assert.rejects(runAgent({ task: first.checkpoint.task, tools: connection.tools, resume: first.checkpoint, partialOutputSchema: schema, planner: async () => { throw new Error('Must not plan.'); } }), /validatePartial policy/);
  const resumed = await runAgent({ task: first.checkpoint.task, tools: connection.tools, resume: first.checkpoint, maxSteps: 9, partialOutputSchema: schema, validatePartial,
    planner: async ({ step, messages }) => {
      if (step === 7) return { type: 'publish', key: 'receipt-2', data: { receiptId: 'WF-002' }, evidence: [verificationId] };
      if (step === 8) {
        assert.ok(messages.some(message => message.role === 'user' && message.content.includes('PARTIAL_VERIFICATION_REQUIRED')));
        return tool('tab_verify', check());
      }
      return { type: 'publish', key: 'receipt-2', data: { receiptId: 'WF-002' }, evidence: [last(messages).toolCallId] };
    },
  });
  assert.equal(resumed.status, 'limit_reached');
  assert.deepEqual(resumed.partials.map(item => item.key), ['receipt-1', 'receipt-2']);
  assert.deepEqual(connection.observed, [{ session_id: 's1', value: 'WF-001' }]);
});

test('a resumed run cannot omit or change its final result schema before using tools', async () => {
  let catalogs = 0;
  const tools = { listTools: async () => { catalogs++; return []; }, callTool: async () => { throw new Error('No tool should run.'); } };
  const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
  const saved = await runAgent({ task: 'Keep the original result contract.', tools, finalOutputSchema: schema, planner: async () => ({ type: 'human_input', question: 'Which item?' }) });
  assert.equal(saved.status, 'needs_input');
  const before = catalogs;
  const base = { task: 'Keep the original result contract.', tools, resume: saved.checkpoint, planner: async () => ({ type: 'human_input', question: 'Still waiting?' }) };
  await assert.rejects(runAgent(base), /original final output schema/);
  await assert.rejects(runAgent({ ...base, finalOutputSchema: { type: 'string' } }), /original final output schema/);
  assert.equal(catalogs, before);
  const resumed = await runAgent({ ...base, finalOutputSchema: schema });
  assert.equal(resumed.status, 'needs_input');
  assert.equal(resumed.checkpoint.outputSchemaHash, saved.checkpoint.outputSchemaHash);
});

test('tool and planning budgets are bounded; invalid decisions never dispatch a tool', async t => {
  const connection = await mockMcp(t);
  const run = await runAgent({ task: 'Read repeatedly.', tools: connection.tools, maxToolCalls: 1, maxSteps: 10, planner: async () => tool('tab_snapshot') });
  assert.equal(run.status, 'limit_reached');
  assert.equal(run.reason, 'Tool-call budget reached.');
  assert.equal(run.toolCalls, 1);
  assert.equal(run.steps, 2);
  const malformed = await runAgent({ task: 'Reject invalid shape.', tools: connection.tools, maxSteps: 2, planner: async () => ({ type: 'tools', calls: [{ name: 'change', arguments: 'not an object' }] }) });
  assert.equal(malformed.status, 'limit_reached');
  assert.equal(malformed.toolCalls, 0);
  const empty = await runAgent({ task: 'No invented success.', tools: connection.tools, maxSteps: 1, planner: async () => done('made-up') });
  assert.equal(empty.status, 'limit_reached');
  const memory = await runAgent({ task: 'Bound history.', tools: connection.tools, maxHistoryBytes: 1, planner: async () => { throw new Error('should not run'); } });
  assert.equal(memory.reason, 'Conversation history budget reached.');
});

test('deadline bounds a non-cooperating planner and abort propagates into an in-flight tool', { timeout: 5_000 }, async t => {
  const connection = await mockMcp(t);
  const deadline = await runAgent({ task: 'Wait.', tools: connection.tools, timeoutMs: 20, planner: async () => new Promise(() => {}) });
  assert.equal(deadline.status, 'limit_reached');
  assert.equal(deadline.reason, 'Agent deadline reached.');
  const controller = new AbortController();
  let observedSignal;
  const result = await runAgent({ task: 'Cancel work.', signal: controller.signal, tools: {
    listTools: connection.tools.listTools,
    callTool: async (_call, { signal }) => { observedSignal = signal; controller.abort(); return new Promise(() => {}); },
  }, planner: async () => tool('change', { session_id: 's1', value: 'a' }) });
  assert.equal(result.status, 'cancelled');
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.inFlightToolCall.name, 'change');
});

test('MCP cancellation reaches the actual server request signal', { timeout: 5_000 }, async t => {
  const server = new McpServer({ name: 'agent-cancellation', version: '1' });
  const controller = new AbortController();
  let sawCancellation;
  const cancelled = new Promise(resolve => { sawCancellation = resolve; });
  server.registerTool('wait', { inputSchema: z.object({}).strict() }, async (_args, extra) => {
    const signal = extra.signal;
    const response = new Promise(resolve => signal.addEventListener('abort', () => { sawCancellation(); resolve(payload({ ok: false })); }, { once: true }));
    controller.abort();
    return response;
  });
  const connection = await connectAgentTools(server);
  t.after(() => connection.close());
  const run = await runAgent({ task: 'Cancel the MCP operation.', tools: connection.tools, signal: controller.signal, planner: async () => tool('wait') });
  assert.equal(run.status, 'cancelled');
  await cancelled;
});

test('HTTP planner preserves MCP image evidence and structured errors without real model calls', async t => {
  const requests = [];
  const http = createHttpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Which account?' }) } }] } }] }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const planner = createOpenAICompatiblePlanner({ endpoint: `http://127.0.0.1:${http.address().port}/chat/completions`, model: 'deterministic-fixture', apiKey: 'fixture-key' });
  const decision = await planner({ task: 'Inspect.', step: 1, tools: [], signal: new AbortController().signal, messages: [
    { role: 'user', content: 'Inspect the screenshot.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'tab_capture', arguments: {} }, { id: 'c2', name: 'tab_list', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'tab_capture', result: { content: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }], isError: false } },
    { role: 'tool', toolCallId: 'c2', name: 'tab_list', result: payload({ ok: false, error: { code: 'FIXTURE' } }) },
  ] });
  assert.deepEqual(decision, { type: 'human_input', question: 'Which account?' });
  assert.equal(requests[0].headers.authorization, 'Bearer fixture-key');
  const body = requests[0].body;
  assert.equal(body.model, 'deterministic-fixture');
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(body.messages.at(-1).content[1].image_url.url, 'data:image/png;base64,eA==');
  assert.equal(JSON.parse(body.messages[3].content).isError, true);
});

test('HTTP planner rejects malformed model arguments, mixed finish calls, and oversized output', async () => {
  const invoke = async (toolCalls, overrides = {}) => {
    const planner = createOpenAICompatiblePlanner({ endpoint: 'http://localhost/test', model: 'fixture', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: toolCalls } }] })), ...overrides });
    return planner({ task: 'Fixture.', messages: [], tools: [], step: 1, signal: new AbortController().signal });
  };
  await assert.rejects(invoke([{ type: 'function', function: { name: 'tab_list', arguments: '{' } }]));
  await assert.rejects(invoke([{ type: 'function', function: { name: 'tab_list', arguments: '[]' } }]), /object/);
  await assert.rejects(invoke([{ type: 'function', function: { name: 'agent_finish', arguments: JSON.stringify({ summary: 'x', evidence: ['x'] }) } }, { type: 'function', function: { name: 'tab_list', arguments: '{}' } }]), /only tool call/);
  await assert.rejects(invoke([], { maxResponseBytes: 1 }), /size limit/);
});

test('an installed completion policy must explicitly return true', async t => {
  for (const verdict of [undefined, null, false]) {
    const connection = await mockMcp(t);
    const run = await runAgent({ task: 'Require approval by the application policy.', tools: connection.tools, maxSteps: 2, validateCompletion: () => verdict,
      planner: async ({ step, messages }) => step === 1 ? tool('tab_verify', check()) : done(last(messages).toolCallId),
    });
    assert.equal(run.status, 'limit_reached');
    assert.ok(run.events.some(event => event.type === 'feedback' && event.code === 'COMPLETION_REJECTED'));
  }
});

test('history budget stops later mutations within the same planning decision', async () => {
  let dispatched = 0;
  const run = await runAgent({ task: 'Respect history budget.', maxHistoryBytes: 6000,
    tools: {
      listTools: async () => [{ name: 'change', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }],
      callTool: async () => { dispatched++; return payload({ ok: true, text: 'large result '.repeat(2000) }); },
    },
    planner: async () => ({ type: 'tools', calls: Array.from({ length: 20 }, () => ({ name: 'change', arguments: {} })) }),
  });
  assert.equal(run.status, 'limit_reached');
  assert.equal(dispatched, 1);
  assert.equal(run.events.filter(event => event.type === 'tool_result' && event.skipped).length, 19);
});

test('cancellation before the dispatch microtask never starts a custom tool', async () => {
  const controller = new AbortController();
  let dispatched = false;
  const run = await runAgent({ task: 'Cancel before dispatch.', signal: controller.signal,
    tools: {
      listTools: async () => [{ name: 'change', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }],
      callTool: async () => { dispatched = true; return payload({ ok: true }); },
    },
    planner: async () => tool('change'),
    onEvent: event => { if (event.type === 'tool_start') queueMicrotask(() => controller.abort()); },
  });
  assert.equal(run.status, 'cancelled');
  assert.equal(dispatched, false);
});
