import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Ajv from 'ajv';
import { z } from 'zod';
import { defineTool, createToolRegistry, ToolRegistryError, runAgent } from '../dist/index.js';

const secret = 'private-context-credential-never-serialize';
const tenant = 'private-principal-A-tenant-A-policy-1';
const origin = 'http://127.0.0.1:8123';
const signal = () => new AbortController().signal;
const plain = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const baseTool = { name: 'lookup_base', description: 'Read a synthetic record', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } };
function base(tools = []) {
  return { async listTools() { return structuredClone(tools); }, async callTool() { return plain({ ok: true }); } };
}
function definition(extra = {}) {
  return { name: 'custom_lookup', description: 'Look up a synthetic record', version: '1', input: z.object({ number: z.number().int() }), output: z.object({ found: z.boolean() }), effect: 'read', handler: () => ({ found: true }), ...extra };
}
function browserFixture() {
  const state = { sessionId: 'session-1', tabId: 'tab-1', documentEpoch: 1, origin, acquired: 0, closed: 0 };
  return { state, browser: { getSessionId: () => state.sessionId, engine: {
    async acquireBinding(sessionId) {
      state.acquired++;
      const binding = Object.freeze({ sessionId, tabId: state.tabId, documentEpoch: state.documentEpoch, origin: state.origin });
      const contextKey = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
      let closed = false;
      return { binding, contextKey, async assertCurrent() {
        if (closed || binding.sessionId !== state.sessionId || binding.tabId !== state.tabId || binding.documentEpoch !== state.documentEpoch || binding.origin !== state.origin) throw Error(secret);
      }, async close() { if (!closed) { closed = true; state.closed++; } } };
    },
  } } };
}
function registry(definitions, extra = {}) {
  return createToolRegistry({ base: base(), tools: definitions.map(defineTool), getContext: () => ({ id: tenant, value: { credential: secret } }), ...extra });
}
async function catalog(t, client) {
  const value = await client.prepareTools({ signal: signal() });
  t.after(() => value.close());
  return value;
}
const dispatch = (catalog, name = 'custom_lookup', args = { number: 1 }, id = 'stable-test-call-id') => catalog.dispatch({ name, arguments: args, id }, { signal: signal() });
const code = result => result.result.structuredContent.error.code;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), 1000); })]); }
  finally { clearTimeout(timer); }
}

test('input validation rejects extra fields and attempted context injection before entering a handler', async t => {
  let calls = 0;
  const client = registry([definition({ handler: () => { calls++; return { found: true }; } })]);
  const c = await catalog(t, client);
  for (const args of [{ number: '1' }, { number: 1.5 }, { number: 1, extra: true }, { number: 1, context: { credential: secret } }, { number: 1, callId: 'forged' }]) {
    const result = await dispatch(c, 'custom_lookup', args);
    assert.equal(result.outcome, 'not_started');
    assert.equal(code(result), 'CUSTOM_TOOL_INPUT_INVALID');
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  assert.equal(calls, 0);
  assert.equal((await dispatch(c)).result.structuredContent.data.found, true);
  assert.equal(calls, 1);
});

test('global tools work without a browser and receive trusted context, stable callId and a signal', async t => {
  const context = { credential: secret, connection: new Map([['record', 7]]) };
  let received;
  const client = registry([definition({ handler: async (input, execution) => {
    received = execution;
    await execution.assertCurrent();
    return { found: input.number === execution.context.connection.get('record') };
  } })], { getContext: () => ({ id: tenant, value: context }) });
  const identity = await client.getExecutionIdentity({ signal: signal() });
  const c = await catalog(t, client);
  const result = await dispatch(c, 'custom_lookup', { number: 7 }, 'caller-generated-001');
  assert.equal(received.context, context);
  assert.equal(received.callId, 'caller-generated-001');
  assert.ok(received.signal instanceof AbortSignal);
  assert.equal(received.binding, undefined);
  assert.equal(Object.isFrozen(received), true);
  assert.deepEqual(result.result.structuredContent, { ok: true, data: { found: true } });
  assert.equal(result.sessionId, undefined);
  for (const value of [identity, c.tools, result]) {
    assert.equal(JSON.stringify(value).includes(secret), false);
    assert.equal(JSON.stringify(value).includes(tenant), false);
  }
  assert.match(identity.contextHash, /^[a-f0-9]{64}$/);
});

test('caller-selected output may deliberately include a context value', async t => {
  const c = await catalog(t, registry([definition({ output: z.object({ explicitValue: z.string() }), handler: (_, execution) => ({ explicitValue: execution.context.credential }) })]));
  assert.equal((await dispatch(c)).result.structuredContent.data.explicitValue, secret);
});

test('published output schema validates the actual MCP envelope and relocated reusable refs', async t => {
  const item = z.object({ label: z.string(), values: z.array(z.number()) }).strict();
  const output = z.object({ first: item, second: item });
  const data = { first: { label: 'one', values: [1] }, second: { label: 'two', values: [2] } };
  for (const bound of [false, true]) {
    const browser = browserFixture();
    const c = await catalog(t, registry([definition({ output, handler: () => data })], bound ? { browser: browser.browser } : {}));
    const schema = c.tools[0].outputSchema;
    assert.ok(JSON.stringify(schema).includes('$ref'), 'The fixture must actually exercise a reused schema reference');
    const validate = new Ajv({ strict: false }).compile(schema);
    const result = await dispatch(c);
    assert.equal(validate(result.result.structuredContent), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...result.result.structuredContent, data: { ...data, second: { label: 3, values: [] } } }), false);
    assert.equal(validate({ ok: true, data, unrelated: true }), false);
    assert.equal(result.result.structuredContent.session_id, bound ? 'session-1' : undefined);
    assert.deepEqual(JSON.parse(result.result.content[0].text), result.result.structuredContent);
  }
});

test('write handler exceptions and invalid outputs remain unknown without exposing raw errors', async t => {
  for (const handler of [() => { throw Error(secret); }, () => ({ found: 'wrong' }), () => ({ found: true, extra: secret }), () => new Date()]) {
    const client = registry([definition({ effect: 'write', handler })]);
    const c = await catalog(t, client);
    const result = await dispatch(c);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.result.isError, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(['CUSTOM_TOOL_FAILED', 'CUSTOM_TOOL_OUTPUT_INVALID'].includes(code(result)));
    await assert.rejects(client.callTool({ name: 'custom_lookup', arguments: { number: 1 } }, { signal: signal() }), error => {
      assert.ok(error instanceof ToolRegistryError);
      assert.equal(error.code, 'CUSTOM_TOOL_OUTCOME_UNKNOWN');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('trusted read effects remain reads when handlers report failures', async t => {
  const c = await catalog(t, registry([definition({ handler: () => { throw Error(secret); } })]));
  assert.deepEqual(c.metadata.get('custom_lookup'), { effect: 'read' });
  assert.equal(c.tools[0].annotations.readOnlyHint, true);
  const result = await dispatch(c);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.result.isError, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('duplicate registrations, forged handles and reserved names are rejected', async () => {
  for (const name of ['tab_verify', 'tab_close', 'agent_finish', 'agent_custom', 'bad name', '']) {
    assert.throws(() => defineTool(definition({ name })), { code: 'INVALID_TOOL_DEFINITION' });
  }
  const tool = defineTool(definition());
  assert.throws(() => createToolRegistry({ base: base(), tools: [tool, tool], getContext: () => ({ id: tenant, value: null }) }), { code: 'TOOL_NAME_CONFLICT' });
  assert.throws(() => createToolRegistry({ base: base(), tools: [{ name: tool.name, version: tool.version }], getContext: () => ({ id: tenant, value: null }) }), { code: 'INVALID_TOOL_DEFINITION' });
  for (const baseTools of [[{ ...baseTool, name: tool.name }], [baseTool, baseTool], [{ ...baseTool, name: 'agent_finish' }]]) {
    await assert.rejects(registry([definition()], { base: base(baseTools) }).getExecutionIdentity({ signal: signal() }), { code: 'TOOL_NAME_CONFLICT' });
  }
});

test('origins reject wildcard and non-origin restrictions and require a browser binding', () => {
  for (const allowedOrigins of [[], ['*'], ['https://*.example.com'], ['http://example.com/path'], ['http://example.com/?q=1'], ['http://user:password@example.com'], ['file:///tmp/file'], ['https://example.com/#fragment']]) {
    assert.throws(() => defineTool(definition({ allowedOrigins })), { code: 'INVALID_TOOL_DEFINITION' });
  }
  assert.throws(() => registry([definition({ allowedOrigins: [origin] })]), { code: 'INVALID_TOOL_DEFINITION' });
});

test('site filtering includes the exact port and metadata still covers invisible tools', async t => {
  const fixture = browserFixture();
  let calls = 0;
  const client = registry([definition({ effect: 'write', allowedOrigins: [origin], handler: () => { calls++; return { found: true }; } }), definition({ name: 'always_available' })], { browser: fixture.browser, base: base([baseTool]) });
  fixture.state.origin = 'http://127.0.0.1:8124';
  const hidden = await catalog(t, client);
  assert.deepEqual(hidden.tools.map(x => x.name), ['lookup_base', 'always_available']);
  assert.equal(hidden.metadata.get('custom_lookup').effect, 'write');
  assert.equal(hidden.metadata.get('lookup_base').effect, 'read');
  assert.equal((await dispatch(hidden)).outcome, 'not_started');
  assert.equal(calls, 0);
  await hidden.close();
  fixture.state.origin = origin;
  const visible = await catalog(t, client);
  assert.ok(visible.tools.some(x => x.name === 'custom_lookup'));
  assert.equal((await dispatch(visible)).result.structuredContent.session_id, 'session-1');
  assert.equal(calls, 1);
});

test('closed catalogs release a captured guard once and cannot dispatch handlers', async t => {
  const fixture = browserFixture();
  let calls = 0;
  const c = await catalog(t, registry([definition({ handler: () => { calls++; return { found: true }; } })], { browser: fixture.browser }));
  await c.close(); await c.close();
  assert.equal(fixture.state.closed, 1);
  await assert.rejects(c.assertCurrent(), { code: 'TOOL_CATALOG_CLOSED' });
  assert.equal((await dispatch(c)).outcome, 'not_started');
  assert.equal(calls, 0);
});

test('catalog context keys stay stable across leases and change when the captured document changes', async t => {
  const fixture = browserFixture();
  const client = registry([definition()], { browser: fixture.browser });
  const first = await catalog(t, client);
  const initialKey = first.contextKey;
  assert.match(initialKey, /^[a-f0-9]{64}$/);
  await first.close();
  const same = await catalog(t, client);
  assert.equal(same.contextKey, initialKey);
  await same.close();
  fixture.state.documentEpoch++;
  const navigated = await catalog(t, client);
  assert.notEqual(navigated.contextKey, initialKey);
  await navigated.close();
  const repeated = await catalog(t, client);
  assert.equal(repeated.contextKey, navigated.contextKey);
});

test('binding changes after catalog preparation refuse dispatch before entering a handler', async t => {
  for (const field of ['sessionId', 'tabId', 'documentEpoch', 'origin']) {
    const fixture = browserFixture();
    let calls = 0;
    const c = await catalog(t, registry([definition({ handler: () => { calls++; return { found: true }; } })], { browser: fixture.browser }));
    fixture.state[field] = field === 'documentEpoch' ? 2 : 'changed';
    const result = await dispatch(c);
    assert.equal(result.outcome, 'not_started');
    assert.equal(result.contextChanged, true);
    assert.equal(calls, 0);
  }
});

test('context identity is rechecked after asynchronous validation before the handler starts', async t => {
  let id = tenant, calls = 0;
  const input = z.object({ number: z.number().superRefine(async () => { await Promise.resolve(); id = 'tenant-B'; }) });
  const c = await catalog(t, registry([definition({ input, handler: () => { calls++; return { found: true }; } })], { getContext: () => ({ id, value: { credential: secret } }) }));
  const result = await dispatch(c);
  assert.equal(result.outcome, 'not_started');
  assert.equal(result.contextChanged, true);
  assert.equal(calls, 0);
});

test('handler assertCurrent rejects a binding change across await and a started write remains unknown', async t => {
  const fixture = browserFixture();
  let entered, release, effects = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const c = await catalog(t, registry([definition({ effect: 'write', handler: async (_, execution) => {
    entered(); await barrier; await execution.assertCurrent(); effects++; return { found: true };
  } })], { browser: fixture.browser }));
  const pending = dispatch(c);
  await started;
  fixture.state.documentEpoch++;
  release();
  const result = await pending;
  assert.equal(effects, 0);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.contextChanged, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('handler assertCurrent also rejects its cancelled dispatch after a noncooperating await', async t => {
  let entered, release, finished, effects = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const handlerFinished = new Promise(resolve => { finished = resolve; });
  const c = await catalog(t, registry([definition({ effect: 'write', handler: async (_, execution) => {
    try { entered(); await barrier; await execution.assertCurrent(); effects++; return { found: true }; }
    finally { finished(); }
  } })]));
  const controller = new AbortController();
  const pending = c.dispatch({ name: 'custom_lookup', arguments: { number: 1 }, id: 'cancelled-write' }, { signal: controller.signal });
  await started;
  controller.abort(new Error(secret));
  const result = await pending;
  assert.equal(result.outcome, 'unknown');
  release();
  await handlerFinished;
  assert.equal(effects, 0, 'A helper rechecking identity before an effect must also reject the aborted invocation');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('a retained execution context is revoked when a successful dispatch has returned', async t => {
  let execution;
  const c = await catalog(t, registry([definition({ handler: (_, value) => { execution = value; return { found: true }; } })]));
  const result = await dispatch(c);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.result.structuredContent.ok, true);
  await c.assertCurrent();
  await assert.rejects(execution.assertCurrent());
  assert.equal(execution.signal.aborted, true, 'Completion revokes the invocation, not the still-open catalog');
});

for (const phase of ['before_handler', 'after_handler']) for (const dependency of ['getContext', 'guard']) {
  test(`independent dispatch cancellation bounds a hanging ${dependency} check ${phase}`, async t => {
    const fixture = browserFixture();
    const entered = deferred(), release = deferred();
    let blocking = false, calls = 0;
    const waitIfBlocked = async () => {
      if (blocking) { entered.resolve(); await release.promise; }
    };
    const getContext = async () => {
      if (dependency === 'getContext') await waitIfBlocked();
      return { id: tenant, value: { credential: secret } };
    };
    const acquire = fixture.browser.engine.acquireBinding;
    fixture.browser.engine.acquireBinding = async (...args) => {
      const guard = await acquire(...args);
      return { ...guard, async assertCurrent() {
        if (dependency === 'guard') await waitIfBlocked();
        await guard.assertCurrent();
      } };
    };
    const c = await catalog(t, registry([definition({ effect: 'write', handler: () => {
      calls++;
      // Throw after entering the handler so the next hanging check is the
      // contextChanged error path, not the successful output validation path.
      blocking = true;
      throw Error(secret);
    } })], { browser: fixture.browser, getContext }));
    const controller = new AbortController();
    t.after(() => { blocking = false; release.resolve(); controller.abort(); });
    blocking = phase === 'before_handler';
    const pending = c.dispatch({ name: 'custom_lookup', arguments: { number: 1 }, id: `bounded-${dependency}-${phase}` }, { signal: controller.signal });
    try {
      await bounded(entered.promise, 'The intended asynchronous boundary was not reached');
      controller.abort(new Error(secret));
      const result = await bounded(pending, 'Cancelling only the invocation must not wait for its hanging identity check');
      assert.equal(result.outcome, phase === 'before_handler' ? 'not_started' : 'unknown');
      assert.equal(calls, phase === 'before_handler' ? 0 : 1);
      assert.equal(result.contextChanged, true);
      assert.equal(JSON.stringify(result).includes(secret), false);
    } finally {
      blocking = false;
      release.resolve();
      // Permit abandoned resolver/guard promises to settle, without closing
      // the catalog to manufacture cancellation of the independent call.
      await bounded(pending, 'The test-owned invocation did not settle after releasing its boundary');
    }
    await c.assertCurrent();
    assert.equal(fixture.state.closed, 0, 'The enclosing catalog remains open after one invocation is cancelled');
  });
}

test('stable contract hashes exclude opaque context values while including schemas and all registry tools', async () => {
  const first = definition({ name: 'first', allowedOrigins: [origin, 'https://example.com'] });
  const second = definition({ name: 'second' });
  const fixture = browserFixture();
  const one = registry([first, second], { browser: fixture.browser, base: base([baseTool]) });
  const two = registry([second, { ...first, allowedOrigins: ['https://example.com', origin, origin] }], { browser: fixture.browser, base: base([{ annotations: baseTool.annotations, inputSchema: baseTool.inputSchema, description: baseTool.description, name: baseTool.name }]), getContext: () => ({ id: tenant, value: { differentRuntimeObject: new Map() } }) });
  const a = await one.getExecutionIdentity({ signal: signal() });
  const b = await two.getExecutionIdentity({ signal: signal() });
  assert.deepEqual(a, b);
  fixture.state.origin = 'https://unrelated.invalid';
  assert.deepEqual(await one.getExecutionIdentity({ signal: signal() }), a, 'Visibility is not the full registry contract');
});

test('an already established registry rejects base-contract and tenant identity changes', async () => {
  let tools = [baseTool], id = tenant;
  const client = registry([definition()], { base: { ...base(), listTools: async () => tools }, getContext: () => ({ id, value: null }) });
  await client.getExecutionIdentity({ signal: signal() });
  tools = [{ ...baseTool, description: 'Changed contract' }];
  await assert.rejects(client.getExecutionIdentity({ signal: signal() }), { code: 'TOOL_REGISTRY_CHANGED' });
  tools = [baseTool]; id = 'tenant-B';
  await assert.rejects(client.prepareTools({ signal: signal() }), { code: 'TOOL_CONTEXT_CHANGED' });
});

test('context resolver failures expose only a fixed registry error', async () => {
  for (const getContext of [() => { throw Error(secret); }, () => ({ id: '', value: secret }), () => null]) {
    await assert.rejects(registry([definition()], { getContext }).getExecutionIdentity({ signal: signal() }), error => {
      assert.equal(error.code, 'TOOL_CONTEXT_UNAVAILABLE');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('runAgent uses catalog dispatch, preserves callId, and records unknown custom writes for reconciliation', async () => {
  let called = 0, receivedId;
  const client = registry([definition({ effect: 'write', handler: (_, execution) => { called++; receivedId = execution.callId; throw Error(secret); } })]);
  const result = await runAgent({ task: 'Synthetic custom write', tools: client, planner: async () => ({ type: 'tools', calls: [{ name: 'custom_lookup', arguments: { number: 1 } }, { name: 'custom_lookup', arguments: { number: 2 } }] }), maxSteps: 3 });
  assert.equal(result.status, 'needs_input');
  assert.equal(called, 1);
  assert.equal(result.checkpoint.ambiguousCalls.length, 1);
  assert.equal(result.checkpoint.ambiguousCalls[0].id, receivedId);
  assert.equal(result.events.filter(e => e.type === 'tool_result' && e.skipped).length, 1);
  assert.match(result.checkpoint.executionIdentity.contextHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(tenant), false);
});

test('resume rejects schema, version, effect, origin, base-contract and same-origin tenant changes before planning', async () => {
  const fixture = browserFixture();
  const initial = definition({ allowedOrigins: [origin] });
  const options = { browser: fixture.browser, base: base([baseTool]) };
  const first = await runAgent({ task: 'Resume an identity-bound workflow', tools: registry([initial], options), planner: async () => ({ type: 'tools', calls: [{ name: 'custom_lookup', arguments: { number: 1 } }] }), maxSteps: 1 });
  assert.equal(first.status, 'limit_reached');
  const variants = [
    [{ ...initial, input: z.object({ number: z.number().int().min(0) }) }, options],
    [{ ...initial, output: z.object({ found: z.boolean(), other: z.string().optional() }) }, options],
    [{ ...initial, version: '2' }, options],
    [{ ...initial, effect: 'write' }, options],
    [{ ...initial, allowedOrigins: ['http://127.0.0.1:8124'] }, options],
    [initial, { ...options, base: base([{ ...baseTool, description: 'new' }]) }],
    [initial, { ...options, getContext: () => ({ id: 'private-principal-A-tenant-B-policy-1', value: null }) }],
  ];
  for (const [tool, extra] of variants) {
    let plans = 0, handlers = 0;
    const result = await runAgent({ task: first.checkpoint.task, resume: first.checkpoint, tools: registry([{ ...tool, handler: () => { handlers++; return { found: true }; } }], extra), planner: async () => { plans++; return { type: 'human_input', question: 'Should not run' }; }, maxSteps: 2 });
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, 'EXECUTION_IDENTITY_MISMATCH');
    assert.equal(plans, 0);
    assert.equal(handlers, 0);
  }
  let plans = 0;
  const unchanged = await runAgent({ task: first.checkpoint.task, resume: first.checkpoint, tools: registry([initial], options), planner: async () => { plans++; return { type: 'human_input', question: 'Continue under the same tenant' }; }, maxSteps: 2 });
  assert.equal(unchanged.status, 'needs_input');
  assert.equal(plans, 1);
});

test('reconciliation of an unknown write cannot rebind its checkpoint to another tenant on the same origin', async () => {
  const fixture = browserFixture();
  let writesA = 0, writesB = 0, plansB = 0;
  const spec = definition({ effect: 'write', allowedOrigins: [origin], handler: () => { writesA++; throw Error(secret); } });
  const first = await runAgent({ task: 'Exactly one write for tenant A', tools: registry([spec], { browser: fixture.browser }), planner: async () => ({ type: 'tools', calls: [{ name: 'custom_lookup', arguments: { number: 1 } }] }) });
  assert.equal(first.status, 'needs_input');
  assert.equal(writesA, 1);
  const resumed = await runAgent({ task: first.checkpoint.task, resume: first.checkpoint,
    reconciliation: { resolvedCallIds: first.checkpoint.ambiguousCalls.map(call => call.id), note: 'Trusted caller confirmed the original tenant A write.' },
    tools: registry([{ ...spec, handler: () => { writesB++; return { found: true }; } }], { browser: fixture.browser, getContext: () => ({ id: 'principal-A-tenant-B-policy-1', value: {} }) }),
    planner: async () => { plansB++; return { type: 'tools', calls: [{ name: 'custom_lookup', arguments: { number: 1 } }] }; },
  });
  assert.equal(resumed.failure.code, 'EXECUTION_IDENTITY_MISMATCH');
  assert.equal(writesA, 1);
  assert.equal(writesB, 0);
  assert.equal(plansB, 0);
});

test('runAgent discards a decision when the captured browser binding changes during planning', async () => {
  const fixture = browserFixture();
  let plans = 0, handlers = 0;
  const tools = registry([definition({ effect: 'write', handler: () => { handlers++; return { found: true }; } })], { browser: fixture.browser });
  const result = await runAgent({ task: 'A planning-boundary fixture', tools, maxSteps: 3, planner: async () => {
    plans++;
    if (plans === 1) { fixture.state.documentEpoch++; return { type: 'tools', calls: [{ name: 'custom_lookup', arguments: { number: 1 } }] }; }
    return { type: 'human_input', question: 'Fresh catalog reached' };
  } });
  assert.equal(result.status, 'needs_input');
  assert.equal(plans, 2);
  assert.equal(handlers, 0);
  assert.equal(result.toolCalls, 0);
  assert.ok(result.events.some(e => e.type === 'feedback' && e.code === 'CONTEXT_CHANGED'));
  assert.equal(fixture.state.acquired, fixture.state.closed);
});
