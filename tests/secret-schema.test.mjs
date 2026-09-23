import assert from 'node:assert/strict';
import { test } from 'node:test';
import Ajv from 'ajv';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';
import { SecretError } from '../dist/secret-store.js';

async function fixture(t) {
  let resolved = 0;
  const runtime = createServer({ secrets: { contextId: 'private-context', secrets: [{ name: 'password', version: 'v1', allowedOrigins: ['https://private.example'], resolve: () => { resolved++; return 'private-never-resolved'; } }] } });
  const connection = await connectAgentTools(runtime.server);
  t.after(async () => { await connection.close(); await runtime.dispose(); });
  return { ...runtime, ...connection, resolved: () => resolved };
}
const request = action => ({ session_id: 'observed-session', snapshot_id: 'observed-snapshot', actions: [action] });
const action = overrides => ({ type: 'fill_secret', ref: 'observed-ref', secret: 'password', ...overrides });

test('published and runtime MCP schemas accept only a bounded alias plus observed ref for fill_secret', async t => {
  const f = await fixture(t);
  const catalog = (await f.client.listTools()).tools.find(tool => tool.name === 'tab_act');
  const validate = new Ajv({ strict: false }).compile(catalog.inputSchema);
  let dispatched = 0;
  f.engine.act = async (session, snapshot, actions) => { dispatched++; return { ok: true, session_id: session, snapshot_id: snapshot, actions }; };
  for (const valid of [action(), action({ secret: 'A'.repeat(64) }), action({ secret: 'Login_2' })]) {
    assert.equal(validate(request(valid)), true, JSON.stringify(validate.errors));
    const response = await f.client.callTool({ name: 'tab_act', arguments: request(valid) });
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent.actions, [valid], 'Only the alias is forwarded to the engine');
  }
  assert.equal(dispatched, 3);
  for (const invalid of [action({ secret: '' }), action({ secret: 'A'.repeat(65) }), action({ secret: '_password' }), action({ secret: 'my-password' }), action({ secret: 'password\n' }), action({ secret: 42 }), action({ ref: '' }), action({ ref: 'r'.repeat(161) }), action({ value: 'never-forward-plaintext' }), { type: 'fill_secret', ref: 'r', alias: 'password' }, { type: 'fill_secret', secret: 'password' }]) {
    assert.equal(validate(request(invalid)), false);
    const response = await f.client.callTool({ name: 'tab_act', arguments: request(invalid) });
    assert.equal(response.isError, true);
  }
  assert.equal(dispatched, 3, 'Rejected calls must not reach the engine');
  assert.equal(f.resolved(), 0, 'MCP setup/schema validation must not resolve any value');
});

test('secret failures retain their fixed public code in structured and text MCP results', async t => {
  const f = await fixture(t);
  f.engine.act = async () => { throw new SecretError('SECRET_RESOLUTION_FAILED'); };
  const response = await f.client.callTool({ name: 'tab_act', arguments: request(action()) });
  assert.equal(response.isError, true);
  assert.deepEqual(response.structuredContent, { ok: false, error: { code: 'SECRET_RESOLUTION_FAILED', message: 'The secret resolver or trusted context check failed.' } });
  assert.deepEqual(JSON.parse(response.content.find(item => item.type === 'text').text), response.structuredContent);
  assert.equal(f.resolved(), 0);
});

test('SDK server rejects secret configuration with external CDP before any resolver is called', () => {
  let resolved = false;
  assert.throws(() => createServer({ cdpUrl: 'http://127.0.0.1:1', secrets: { contextId: 'private-context', secrets: [{ name: 'password', version: 'v1', allowedOrigins: ['https://example.test'], resolve: () => { resolved = true; return 'private'; } }] } }), { code: 'SECRET_CDP_UNSUPPORTED' });
  assert.equal(resolved, false);
});
