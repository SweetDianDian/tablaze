import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { test } from 'node:test';
import { z } from 'zod';
import { createServer, connectAgentTools, defineTool, createToolRegistry, runAgent, parseAgentCheckpoint } from '../dist/index.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const call = (name, args = {}) => ({ type: 'tools', calls: [{ name, arguments: args }] });
const payload = message => message.result.structuredContent;
const secret = 'local-fixture-credential-never-for-the-model';

async function fixture(t) {
  const records = { A: [], B: [] };
  let viewing = 'A';
  const server = httpServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/reserve') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (!['A', 'B'].includes(body.tenant) || request.headers.authorization !== `Bearer ${secret}-${body.tenant}`) { response.writeHead(403).end(); return; }
      const receipt = { id: `${body.tenant}-${records[body.tenant].length + 1}`, sku: body.sku, quantity: body.quantity, callId: body.callId };
      records[body.tenant].push(receipt);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(receipt));
      return;
    }
    const saved = records[viewing];
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Stock reservation</title><h1>Stock reservation</h1><p>Tenant ${viewing}</p><p>${saved.length ? `Reserved ${saved[0].sku} quantity ${saved[0].quantity}. Receipts: ${saved.length}` : 'No reservation yet'}</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: `${origin}/app`, records, view: tenant => { viewing = tenant; } };
}

async function runtime(t, url) {
  const runtime = createServer({ channel: process.env.TABLAZE_BROWSER_CHANNEL ?? 'chrome' });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  const initial = await runtime.engine.open(url);
  return { ...runtime, connection, sessionId: initial.session_id };
}

function reservationTool(site, behavior = {}) {
  return defineTool({
    name: 'reserve_stock', version: '1', description: 'Reserve stock once and return a receipt; inspect the page before reporting completion.',
    effect: 'write', allowedOrigins: [site.origin],
    input: z.object({ sku: z.literal('CEDAR'), quantity: z.literal(1) }),
    output: z.object({ receiptId: z.string(), quantity: z.number() }),
    async handler(input, execution) {
      behavior.entered?.resolve();
      if (behavior.release) await behavior.release.promise;
      await execution.assertCurrent();
      const response = await fetch(`${site.origin}/reserve`, { method: 'POST', signal: execution.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${execution.context.credential}` }, body: JSON.stringify({ ...input, tenant: execution.context.tenant, callId: execution.callId }) });
      const receipt = await response.json();
      if (behavior.loseResponse) throw new Error(`${secret}: simulated response loss after commit`);
      return { receiptId: receipt.id, quantity: receipt.quantity };
    },
  });
}
function registry(site, browser, tool, getTenant) {
  return createToolRegistry({ base: browser.connection.tools, tools: [tool], getContext: () => { const tenant = getTenant(); return { id: `principal:fixture/tenant:${tenant}/policy:1`, value: { tenant, credential: `${secret}-${tenant}` } }; }, browser: { engine: browser.engine, getSessionId: () => browser.sessionId } });
}

test('typed backend write, actual browser receipt, and Agent verification complete one reservation', async t => {
  const site = await fixture(t), browser = await runtime(t, site.url);
  const tools = registry(site, browser, reservationTool(site), () => 'A');
  const plannerInputs = [];
  const result = await runAgent({ task: 'Reserve CEDAR once and verify the receipt.', tools, maxSteps: 6, timeoutMs: 15000,
    planner: async input => {
      plannerInputs.push(JSON.stringify(input));
      const previous = input.messages.filter(message => message.role === 'tool').at(-1);
      if (!previous) return call('reserve_stock', { sku: 'CEDAR', quantity: 1 });
      if (previous.name === 'reserve_stock') return call('tab_navigate', { session_id: browser.sessionId, action: 'reload' });
      if (previous.name === 'tab_navigate') return call('tab_verify', { session_id: browser.sessionId, checks: [{ kind: 'text', contains: 'Reserved CEDAR quantity 1. Receipts: 1' }] });
      assert.equal(previous.name, 'tab_verify'); assert.equal(payload(previous).passed, true);
      return { type: 'finish', summary: 'One reservation and its page receipt were verified.', evidence: [previous.toolCallId] };
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(site.records.A.length, 1); assert.equal(site.records.B.length, 0);
  assert.equal(site.records.A[0].callId, result.history.find(message => message.role === 'tool' && message.name === 'reserve_stock').toolCallId);
  assert.equal(result.evidence.length, 1);
  assert.ok(result.checkpoint.executionIdentity);
  assert.equal(parseAgentCheckpoint(result.checkpoint).schemaVersion, 6);
  for (const text of [...plannerInputs, JSON.stringify(result)]) {
    assert.equal(text.includes(secret), false); assert.equal(text.includes('principal:fixture/tenant:'), false);
  }
});

test('real navigation while planning removes the restricted tool before its stale decision dispatches', async t => {
  const site = await fixture(t), other = await fixture(t), browser = await runtime(t, site.url);
  let entered = 0, calls = 0;
  const tool = defineTool({ name: 'reserve_guarded', version: '1', description: 'Reserve only on the inventory origin.', input: z.object({}), output: z.object({ reserved: z.boolean() }), effect: 'write', allowedOrigins: [site.origin], handler: async () => { entered++; return { reserved: true }; } });
  const tools = registry(site, browser, tool, () => 'A');
  const result = await runAgent({ task: 'Reserve on the original inventory site.', tools, maxSteps: 4, timeoutMs: 15000,
    planner: async input => {
      calls++;
      if (calls === 1) {
        assert.ok(input.tools.some(tool => tool.name === 'reserve_guarded'));
        await browser.engine.navigate(browser.sessionId, { action: 'goto', url: other.url });
        return call('reserve_guarded');
      }
      assert.equal(input.tools.some(tool => tool.name === 'reserve_guarded'), false);
      return { type: 'fail', reason: 'The intended site is no longer active.' };
    },
  });
  assert.equal(result.status, 'failed'); assert.equal(entered, 0); assert.equal(calls, 2);
  assert.equal(site.records.A.length, 0); assert.equal(other.records.A.length, 0);
});

test('handler rechecks a real browser binding after waiting and rejects a stale external write', async t => {
  const site = await fixture(t), other = await fixture(t), browser = await runtime(t, site.url);
  const entered = deferred(), release = deferred();
  const tools = registry(site, browser, reservationTool(site, { entered, release }), () => 'A');
  const signal = new AbortController().signal;
  const catalog = await tools.prepareTools({ signal });
  try {
    const pending = catalog.dispatch({ id: 'fixture-call', name: 'reserve_stock', arguments: { sku: 'CEDAR', quantity: 1 } }, { signal });
    await entered.promise;
    await browser.engine.navigate(browser.sessionId, { action: 'goto', url: other.url });
    release.resolve();
    const result = await pending;
    assert.equal(result.outcome, 'unknown', 'An entered write handler is conservatively uncertain even when this fixture observes no write');
    assert.equal(result.contextChanged, true);
    assert.equal(site.records.A.length, 0); assert.equal(other.records.A.length, 0);
  } finally { release.resolve(); await catalog.close(); }
});

test('same-origin tenant change cannot resume an uncertain write; matching identity reconciles without replay', async t => {
  const site = await fixture(t), original = await runtime(t, site.url);
  const definition = reservationTool(site, { loseResponse: true });
  const task = 'Reserve CEDAR exactly once, inspect its receipt, and do not replay an uncertain write.';
  const first = await runAgent({ task, tools: registry(site, original, definition, () => 'A'), maxSteps: 8, timeoutMs: 20000, planner: async () => call('reserve_stock', { sku: 'CEDAR', quantity: 1 }) });
  assert.equal(first.status, 'needs_input'); assert.equal(first.checkpoint.ambiguousCalls.length, 1);
  assert.equal(site.records.A.length, 1);
  assert.equal(JSON.stringify(first).includes(secret), false);

  site.view('B');
  const wrong = await runtime(t, site.url);
  let wrongPlans = 0;
  const rejected = await runAgent({ task, tools: registry(site, wrong, definition, () => 'B'), resume: first.checkpoint, resumeSessionMap: { [original.sessionId]: wrong.sessionId }, reconciliation: { resolvedCallIds: first.checkpoint.ambiguousCalls.map(call => call.id), note: 'The trusted caller inspected the A receipt.' }, planner: async () => { wrongPlans++; return call('reserve_stock', { sku: 'CEDAR', quantity: 1 }); } });
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.failure.code, 'EXECUTION_IDENTITY_MISMATCH');
  assert.equal(wrongPlans, 0); assert.equal(site.records.B.length, 0); assert.equal(site.records.A.length, 1);

  site.view('A');
  const restored = await runtime(t, site.url);
  let restoredPlans = 0;
  const resumed = await runAgent({ task, tools: registry(site, restored, definition, () => 'A'), resume: first.checkpoint, resumeSessionMap: { [original.sessionId]: restored.sessionId }, reconciliation: { resolvedCallIds: first.checkpoint.ambiguousCalls.map(call => call.id), note: 'Server receipt A-1 exists and exactly one reservation was confirmed.' },
    planner: async input => {
      restoredPlans++;
      if (restoredPlans === 1) return call('tab_snapshot', { session_id: restored.sessionId });
      if (restoredPlans === 2) return call('tab_verify', { session_id: restored.sessionId, checks: [{ kind: 'text', contains: 'Reserved CEDAR quantity 1. Receipts: 1' }] });
      const verification = input.messages.filter(message => message.role === 'tool' && message.name === 'tab_verify').at(-1);
      return { type: 'finish', summary: 'The previously committed reservation has a current verified receipt.', evidence: [verification.toolCallId] };
    },
  });
  assert.equal(resumed.status, 'succeeded'); assert.equal(resumed.checkpoint.ambiguousCalls.length, 0);
  assert.equal(site.records.A.length, 1); assert.equal(site.records.B.length, 0);
  assert.equal(resumed.history.filter(message => message.role === 'tool' && message.name === 'reserve_stock').length, 1);
});
