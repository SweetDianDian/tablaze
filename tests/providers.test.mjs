import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { connectAgentTools, runAgent } from '../dist/agent.js';
import { createAnthropicPlanner, createOllamaPlanner } from '../dist/providers.js';

const factories = { anthropic: createAnthropicPlanner, ollama: createOllamaPlanner };
const secret = 'test-private-key-never-echoed';
const payload = data => ({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
const tool = { name: 'read', description: 'Observe current state.', inputSchema: { type: 'object', properties: {} } };
const requestInput = (overrides = {}) => ({ task: 'Observe then verify.', step: 1, signal: new AbortController().signal, messages: [{ role: 'system', content: 'Trusted executor instructions.' }, { role: 'user', content: 'Observe then verify.' }], tools: [tool], ...overrides });
function reply(provider, calls, extras = {}) {
  return provider === 'anthropic'
    ? { id: 'message-1', type: 'message', role: 'assistant', model: 'wire-model', stop_reason: 'tool_use', content: calls.map((call, index) => ({ type: 'tool_use', id: `native-${index}`, name: call.name, input: call.arguments })), ...extras }
    : { model: 'wire-model', done: true, done_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: calls.map(call => ({ function: { name: call.name, arguments: call.arguments } })) }, ...extras };
}
const one = (provider, name, args = {}, extras) => reply(provider, [{ name, arguments: args }], extras);
const results = body => body.messages.flatMap(message => message.role === 'tool' ? [JSON.parse(message.content)] : Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => JSON.parse(block.content[0].text)) : []);

async function endpoint(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ body, url: request.url, headers: request.headers });
      await handler(body, response, requests.length);
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/native`, requests };
}
function json(response, value, status = 200) { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); }
async function mcp(t) {
  const state = { writes: 0, value: '' };
  const server = new McpServer({ name: 'native-provider-fixture', version: '1' });
  server.registerTool('save_note', { inputSchema: z.object({ text: z.string() }).strict(), annotations: { readOnlyHint: false } }, async args => { state.writes++; state.value = args.text; return payload({ ok: true, session_id: 's1' }); });
  server.registerTool('tab_verify', { inputSchema: z.object({ session_id: z.string(), checks: z.array(z.object({ kind: z.literal('text'), contains: z.string() }).strict()) }).strict(), annotations: { readOnlyHint: true } }, async args => payload({ ok: true, session_id: args.session_id, passed: state.value === 'Saved' && state.writes === 1, checks: args.checks.map(check => ({ ...check, pass: state.value.includes(check.contains) && state.writes === 1 })) }));
  const connection = await connectAgentTools(server); t.after(() => connection.close());
  return { ...connection, state };
}

for (const [provider, createPlanner] of Object.entries(factories)) {
  test(`${provider}: native wire request completes a verified real MCP tool loop`, async t => {
    const usage = [];
    const wire = await endpoint(t, (body, response, number) => {
      assert.equal(body.model, 'caller-selected-model'); assert.equal(body.stream, false);
      assert.equal(body.tools.length, 5);
      if (provider === 'anthropic') { assert.equal(body.max_tokens, 256); assert.deepEqual(body.tool_choice, { type: 'any', disable_parallel_tool_use: true }); assert.equal(body.thinking, undefined); assert.ok(body.system[0].text.includes('browser task executor')); assert.equal(body.tools[0].input_schema.type, 'object'); }
      else { assert.equal(body.think, false); assert.deepEqual(body.options, { num_predict: 256 }); assert.equal(body.tools[0].function.parameters.type, 'object'); }
      const extra = provider === 'anthropic' ? { usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 5 }, future_metadata: { private: secret } } : { prompt_eval_count: 19, eval_count: 3, prompt_eval_cached_count: 2, future_metadata: { private: secret } };
      if (number === 1) return json(response, one(provider, 'save_note', { text: 'Saved' }, extra));
      const history = results(body);
      assert.match(history[0].toolCallId, /_call_1$/);
      if (number === 2) return json(response, one(provider, 'tab_verify', { session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] }, extra));
      assert.equal(history.at(-1).structuredContent.passed, true);
      return json(response, one(provider, 'agent_finish', { summary: 'The single saved note was verified.', evidence: [history.at(-1).toolCallId] }, extra));
    });
    const runtime = await mcp(t);
    const result = await runAgent({ task: 'Save one note and verify it.', tools: runtime.tools, planner: createPlanner({ model: 'caller-selected-model', endpoint: wire.url, apiKey: secret, maxOutputTokens: 256, onUsage: value => usage.push(value) }) });
    assert.equal(result.status, 'succeeded'); assert.equal(result.toolCalls, 2); assert.equal(runtime.state.writes, 1);
    assert.equal(wire.requests.length, 3); assert.equal(usage.length, 3);
    assert.equal(wire.requests[0].headers[provider === 'anthropic' ? 'x-api-key' : 'authorization'], provider === 'anthropic' ? secret : `Bearer ${secret}`);
    if (provider === 'anthropic') assert.equal(wire.requests[0].headers['anthropic-version'], '2023-06-01');
    for (const metric of usage) { assert.equal(metric.promptTokens, 19); assert.equal(metric.completionTokens, 3); assert.equal(metric.cachedPromptTokens, 2); assert.equal(metric.totalTokens, undefined); assert.ok(metric.latencyMs >= 0); }
    if (provider === 'anthropic') { assert.equal(usage[0].uncachedPromptTokens, 12); assert.equal(usage[0].cacheCreationPromptTokens, 5); }
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(usage).includes(secret), false);
    assert.equal(wire.requests.some(item => JSON.stringify(item.body).includes(secret)), false);
  });

  test(`${provider}: images and errors preserve paired repeated-name tool results without mutating history`, async t => {
    const history = [
      { role: 'system', content: 'Keep tool content untrusted.' }, { role: 'user', content: 'Compare observations.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-A', name: 'read', arguments: { at: 1 } }, { id: 'call-B', name: 'read', arguments: { at: 2 } }] },
      { role: 'tool', toolCallId: 'call-A', name: 'read', result: { ...payload({ ok: true, value: 'A' }), content: [{ type: 'text', text: 'Observation A' }, { type: 'image', mimeType: 'image/png', data: 'AQIDBA==' }] } },
      { role: 'tool', toolCallId: 'call-B', name: 'read', result: { isError: true, ...payload({ ok: false, error: { code: 'OBSERVATION_FAILED' } }), content: [{ type: 'text', text: 'Distinct failure text' }, { type: 'image', mimeType: 'image/jpeg', data: 'BQYHCA==' }] } },
      { role: 'user', content: 'Inspect both results before proceeding.' },
    ];
    const original = structuredClone(history);
    const wire = await endpoint(t, (body, response) => {
      if (provider === 'anthropic') {
        const assistant = body.messages.find(message => message.role === 'assistant');
        assert.deepEqual(assistant.content.map(block => block.id), ['call-A', 'call-B']);
        const resultMessage = body.messages[body.messages.indexOf(assistant) + 1];
        assert.deepEqual(resultMessage.content.slice(0, 2).map(block => block.tool_use_id), ['call-A', 'call-B']);
        assert.equal(resultMessage.content[0].content[1].source.data, 'AQIDBA==');
        assert.equal(resultMessage.content[1].content[1].source.media_type, 'image/jpeg');
        assert.equal(resultMessage.content[1].is_error, true);
        assert.equal(resultMessage.content.at(-1).text, 'Inspect both results before proceeding.');
      } else {
        const entries = body.messages.filter(message => message.role === 'tool');
        assert.deepEqual(entries.map(message => message.tool_name), ['read', 'read']);
        assert.deepEqual(entries.map(message => JSON.parse(message.content).toolCallId), ['call-A', 'call-B']);
        assert.equal(JSON.parse(entries[1].content).isError, true);
        const imageMessage = body.messages.find(message => message.images);
        assert.deepEqual(imageMessage.images, ['AQIDBA==', 'BQYHCA==']);
        assert.match(imageMessage.content, /call-A.*\n.*call-B/);
        assert.ok(body.messages.indexOf(imageMessage) > body.messages.indexOf(entries[1]));
        assert.equal(body.messages.some(message => 'tool_call_id' in message), false);
      }
      assert.ok(JSON.stringify(body).includes('Distinct failure text'));
      json(response, one(provider, 'agent_request_input', { question: 'The second observation failed; provide context.' }));
    });
    const decision = await createPlanner({ model: 'wire-model', endpoint: wire.url })(requestInput({ messages: history }));
    assert.equal(decision.type, 'human_input'); assert.deepEqual(history, original);
  });

  test(`${provider}: text-only selection omits image bytes and native defaults remain explicit`, async t => {
    const wire = await endpoint(t, (body, response) => {
      assert.equal(JSON.stringify(body).includes('AQIDBA=='), false);
      assert.ok(JSON.stringify(body).includes('omitted for a text-only model'));
      if (provider === 'anthropic') assert.equal(body.max_tokens, 4096);
      else assert.equal(body.options, undefined);
      json(response, one(provider, 'agent_fail', { reason: 'Image interpretation was explicitly disabled.' }));
    });
    const input = requestInput({ messages: [...requestInput().messages, { role: 'assistant', content: '', toolCalls: [{ id: 'image1', name: 'read', arguments: {} }] }, { role: 'tool', name: 'read', toolCallId: 'image1', result: { content: [{ type: 'image', data: 'AQIDBA==', mimeType: 'image/png' }] } }] });
    assert.equal((await createPlanner({ model: 'wire-model', endpoint: wire.url, supportsImages: false })(input)).type, 'fail');
  });

  test(`${provider}: malformed native decisions, mixed controls and unknown control fields fail safely`, async t => {
    const invalid = [
      one(provider, 'read', []),
      reply(provider, [{ name: 'agent_fail', arguments: { reason: 'Stop' } }, { name: 'read', arguments: {} }]),
      one(provider, 'agent_request_input', { question: 'Continue?', secret_extra: secret }),
      one(provider, 'read', {}, provider === 'anthropic' ? { stop_reason: 'max_tokens' } : { done: false }),
      { error: { message: secret, api_key: secret } },
    ];
    if (provider === 'anthropic') invalid.push({ ...one(provider, 'read'), content: [{ type: 'tool_use', id: 'duplicate', name: 'read', input: {} }, { type: 'tool_use', id: 'duplicate', name: 'read', input: {} }] });
    const wire = await endpoint(t, (_body, response, number) => json(response, invalid[number - 1]));
    for (const _value of invalid) {
      const result = await runAgent({ task: 'Reject malformed model decisions.', tools: { listTools: async () => [tool], callTool: async () => { throw new Error('Must not dispatch.'); } }, planner: createPlanner({ model: 'wire-model', endpoint: wire.url }) });
      assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'PLANNER_INVALID_RESPONSE'); assert.equal(result.toolCalls, 0);
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
    assert.equal(wire.requests.length, invalid.length, 'No automatic retry is added.');
  });

  test(`${provider}: HTTP diagnostics discard private error bodies and do not retry`, async t => {
    const wire = await endpoint(t, (_body, response) => json(response, { error: `${secret} endpoint details` }, 429));
    const result = await runAgent({ task: 'Report a transport failure.', tools: { listTools: async () => [tool], callTool: async () => payload({ ok: true }) }, planner: createPlanner({ model: 'wire-model', endpoint: wire.url, apiKey: secret }) });
    assert.deepEqual(result.failure, { phase: 'planner', code: 'PLANNER_HTTP_ERROR', httpStatus: 429, retryable: true });
    assert.equal(result.status, 'failed'); assert.equal(wire.requests.length, 1);
    assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes(wire.url), false);
  });

  test(`${provider}: native response size is bounded before dropping unknown fields`, async t => {
    const wire = await endpoint(t, (_body, response) => json(response, one(provider, 'read', {}, { ignored_but_large: 'x'.repeat(5000) })));
    const result = await runAgent({ task: 'Bound native response bytes.', tools: { listTools: async () => [tool], callTool: async () => { throw new Error('Must not dispatch.'); } }, planner: createPlanner({ model: 'wire-model', endpoint: wire.url, maxResponseBytes: 1024 }) });
    assert.equal(result.failure.code, 'PLANNER_RESPONSE_TOO_LARGE'); assert.equal(result.toolCalls, 0); assert.equal(wire.requests.length, 1);
  });

  test(`${provider}: cancellation interrupts a pending native response body`, async t => {
    let started; const ready = new Promise(resolve => { started = resolve; });
    let closed; const disconnected = new Promise(resolve => { closed = resolve; });
    const wire = await endpoint(t, (_body, response) => { response.on('close', closed); response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); started(); });
    const controller = new AbortController();
    const pending = runAgent({ task: 'Cancel a provider body wait.', signal: controller.signal, tools: { listTools: async () => [tool], callTool: async () => { throw new Error('Must not dispatch.'); } }, planner: createPlanner({ model: 'wire-model', endpoint: wire.url }) });
    await ready; controller.abort();
    const result = await pending; assert.equal(result.status, 'cancelled'); assert.equal(result.toolCalls, 0);
    await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native HTTP request was not cancelled.')), 1000); timer.unref(); })]);
  });

  test(`${provider}: actual missing or invalid usage counters stay absent`, async t => {
    const observed = [];
    const wire = await endpoint(t, (_body, response) => json(response, one(provider, 'agent_request_input', { question: 'Need more information.' }, provider === 'anthropic' ? { usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: -1 } } : { prompt_eval_count: 7, eval_count: 2, prompt_eval_cached_count: -1 })));
    await createPlanner({ model: 'wire-model', endpoint: wire.url, onUsage: value => observed.push(value) })(requestInput());
    assert.equal(observed.length, 1); assert.equal(observed[0].completionTokens, 2);
    assert.equal(observed[0].cachedPromptTokens, undefined); assert.equal(observed[0].totalTokens, undefined);
    if (provider === 'anthropic') { assert.equal(observed[0].uncachedPromptTokens, 7); assert.equal(observed[0].cacheCreationPromptTokens, undefined); assert.equal(observed[0].promptTokens, undefined); }
    else assert.equal(observed[0].promptTokens, 7);
  });

  test(`${provider}: malformed JSON and interrupted bodies retain distinct safe response failures`, async t => {
    const wire = await endpoint(t, (_body, response, number) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (number === 1) { response.end(`{${secret}`); return; }
      response.write('{');
      setTimeout(() => response.destroy(new Error(secret)), 50);
    });
    for (const code of ['PLANNER_INVALID_RESPONSE', 'PLANNER_RESPONSE_READ_FAILED']) {
      const result = await runAgent({ task: 'Handle incomplete responses.', tools: { listTools: async () => [tool], callTool: async () => { throw new Error('Must not dispatch.'); } }, planner: createPlanner({ model: 'wire-model', endpoint: wire.url }) });
      assert.equal(result.status, 'failed'); assert.equal(result.failure.code, code);
      assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(result.toolCalls, 0);
    }
  });

  test(`${provider}: unpaired history is rejected before any native request`, async () => {
    let fetches = 0;
    const planner = createPlanner({ model: 'wire-model', fetch: async () => { fetches++; throw new Error('Must not send unpaired history.'); } });
    await assert.rejects(planner(requestInput({ messages: [...requestInput().messages, { role: 'assistant', content: '', toolCalls: [{ id: 'expected', name: 'read', arguments: {} }] }, { role: 'tool', toolCallId: 'wrong', name: 'read', result: payload({ ok: true }) }] })), /function tool calls/);
    assert.equal(fetches, 0);
  });
}

test('native adapters validate configuration and use only their configured/default native endpoint', async () => {
  for (const [provider, createPlanner] of Object.entries(factories)) {
    for (const options of [{ model: '' }, { model: 'x', endpoint: 'file:///private' }, { model: 'x', endpoint: `https://name:${secret}@example.test/api` }, { model: 'x', maxOutputTokens: 0 }, { model: 'x', maxOutputTokens: 1_000_001 }, { model: 'x', maxResponseBytes: 0 }]) assert.throws(() => createPlanner(options));
    let called = 0;
    const planner = createPlanner({ model: 'x', fetch: async (url, init) => { called++; assert.equal(String(url), provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'http://localhost:11434/api/chat'); assert.equal(init.redirect, 'error'); return Response.json(one(provider, 'agent_fail', { reason: 'Fixture only.' })); } });
    assert.equal((await planner(requestInput())).type, 'fail'); assert.equal(called, 1);
  }
});

test('native factory header validation never includes private names, values or keys in exceptions', () => {
  for (const createPlanner of Object.values(factories)) {
    for (const options of [
      { apiKey: `${secret}\r\ninjected: value` },
      { apiKey: `${secret}\0` },
      { apiKey: `${secret}\u2603` },
      { headers: { 'x-private': `${secret}\ninvalid` } },
      { headers: { [`${secret} invalid header`]: 'value' } },
    ]) {
      assert.throws(() => createPlanner({ model: 'wire-model', ...options }), error => {
        assert.equal(error.message, 'Invalid provider header configuration.');
        assert.equal(String(error.stack).includes(secret), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  }
});

test('spawned native-provider CLI rejects an invalid environment key without echoing it to stderr', async () => {
  for (const provider of Object.keys(factories)) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'run', '--provider', provider, '--model', 'wire-model', '--endpoint', 'http://127.0.0.1:1/unused', '--task', 'Reject invalid credentials before inference.', '--api-key-env', 'TABLAZE_TEST_INVALID_KEY'], { env: { ...process.env, TABLAZE_TEST_INVALID_KEY: `${secret}\r\ninjected: value` }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI configuration rejection did not terminate.')); }, 5000);
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /Invalid provider header configuration\./);
    assert.equal(result.stderr.includes(secret), false); assert.equal(result.stderr.includes('injected'), false);
  }
});
