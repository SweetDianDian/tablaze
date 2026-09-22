import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createServer } from '../dist/server.js';
import { connectAgentTools } from '../dist/agent.js';

let fixture;
let runtime;
let connection;
let base;
before(async () => {
  fixture = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/frame') { response.end('<!doctype html><p id="frame-value">Frame source evidence</p>'); return; }
    response.end(`<!doctype html><h1>Structured fixture</h1><div id="host"></div><p id="price" data-price="25">EUR 25</p><label>Memo<input id="memo" value="old" aria-label="Memo"></label><input id="enabled" type="checkbox" checked><input id="password" type="password" value="password-source-secret"><input id="hidden" type="hidden" value="hidden-source-secret"><div id="hidden-text" style="display:none">hidden-text-source-secret</div><textarea id="textarea">initial-textarea-secret</textarea><ul><li class="item">Fast</li><li class="item">Local</li></ul><p id="long">${'x'.repeat(20001)}</p>${'<span class="too-many">Repeated</span>'.repeat(21)}<iframe src="/frame"></iframe><script>document.querySelector('#memo').value='Current memo';document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<p id="city">Lisbon <span>Portugal</span></p>';</script>`);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${fixture.address().port}`;
  runtime = createServer({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined, timeoutMs: 1000 });
  connection = await connectAgentTools(runtime.server);
});
after(async () => { await connection?.close(); await runtime?.dispose(); await new Promise(resolve => fixture.close(resolve)); });

const call = (name, args) => connection.client.callTool({ name, arguments: args });
const content = result => { assert.ok(result.structuredContent); assert.deepEqual(JSON.parse(result.content.find(item => item.type === 'text').text), result.structuredContent); return result.structuredContent; };
async function open(t) {
  const snapshot = content(await call('tab_open', { url: `${base}/` }));
  t.after(async () => { if (runtime.engine.list().some(session => session.session_id === snapshot.session_id)) await call('tab_close', { session_id: snapshot.session_id }); });
  return snapshot;
}
const stringField = (name, selector, more = {}) => ({ name, selector, mode: 'text', ...more });

test('MCP schema extraction returns typed shadow/form data and keeps observed references usable', { timeout: 30000 }, async t => {
  const initial = await open(t);
  const schema = { type: 'object', properties: { city: { type: 'string' }, price: { type: 'number' }, memo: { type: 'string' }, enabled: { type: 'boolean' }, features: { type: 'array', items: { type: 'string' } } }, required: ['city', 'price', 'memo', 'enabled', 'features'], additionalProperties: false };
  const fields = [stringField('city', '#city', { required: true }), { name: 'price', selector: '#price', mode: 'attribute', attribute: 'data-price', type: 'number', required: true }, { name: 'memo', selector: '#memo', mode: 'value' }, { name: 'enabled', selector: '#enabled', mode: 'value', type: 'boolean' }, stringField('features', '.item', { multiple: true }), stringField('optional', '.absent')];
  const response = await call('tab_extract_structured', { session_id: initial.session_id, schema, fields });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const output = content(response);
  assert.deepEqual(output.data, { city: 'Lisbon Portugal', price: 25, memo: 'Current memo', enabled: true, features: ['Fast', 'Local'] });
  assert.equal(output.schema_validated, true);
  assert.equal(output.provenance, 'dom-observation');
  assert.deepEqual(output.citations.map(item => item.pointer), ['/city', '/price', '/memo', '/enabled', '/features/0', '/features/1']);
  assert.ok(output.citations.every(item => item.url === `${base}/`));
  assert.equal(output.citations.find(item => item.pointer === '/price').quote, '25');
  const memo = initial.elements.find(item => item.name === 'Memo');
  const action = content(await call('tab_act', { session_id: initial.session_id, snapshot_id: initial.snapshot_id, actions: [{ type: 'fill', ref: memo.ref, value: 'Edited after extraction' }] }));
  assert.equal(action.ok, true, JSON.stringify(action));
});

test('MCP preserves structured validation error codes and pointer issues without raw page values', async t => {
  const initial = await open(t);
  const response = await call('tab_extract_structured', { session_id: initial.session_id, schema: { type: 'object', properties: { memo: { type: 'string', maxLength: 2 } }, required: ['memo'] }, fields: [{ name: 'memo', selector: '#memo', mode: 'value' }] });
  assert.equal(response.isError, true);
  const output = content(response);
  assert.equal(output.error.code, 'SCHEMA_MISMATCH');
  assert.equal(output.error.issues[0].pointer, '/memo');
  assert.doesNotMatch(JSON.stringify(response), /Current memo|password-source-secret|hidden-source-secret/);
  for (const [schema, fields, expected] of [
    [{ $ref: 'https://outside.test/schema' }, [stringField('title', 'h1')], 'INVALID_SCHEMA'],
    [true, [stringField('missing', '.absent', { required: true })], 'MISSING_FIELD'],
    [true, [stringField('duplicate', 'h1'), stringField('duplicate', 'h1')], 'INVALID_FIELD_PLAN'],
    [true, [stringField('number', '#price', { type: 'number' })], 'TYPE_CONVERSION'],
  ]) {
    const failed = await call('tab_extract_structured', { session_id: initial.session_id, schema, fields });
    assert.equal(failed.isError, true);
    assert.equal(content(failed).error.code, expected);
  }
});

test('MCP rejects sensitive, hidden, raw-form and truncated fields without partial extracted data', async t => {
  const initial = await open(t);
  for (const [field, expected] of [
    [{ name: 'secret', selector: '#password', mode: 'value' }, 'SENSITIVE_VALUE'],
    [{ name: 'secret', selector: '#hidden', mode: 'value' }, 'SENSITIVE_VALUE'],
    [stringField('secret', '#hidden-text'), 'HIDDEN_FIELD'],
    [stringField('secret', '#textarea'), 'FORM_TEXT'],
    [{ name: 'raw', selector: '#memo', mode: 'attribute', attribute: 'value' }, 'RAW_FORM_VALUE'],
    [stringField('long', '#long'), 'TRUNCATED_FIELD'],
  ]) {
    const response = await call('tab_extract_structured', { session_id: initial.session_id, schema: true, fields: [stringField('title', 'h1'), field] });
    assert.equal(response.isError, true);
    const output = content(response);
    assert.equal(output.error.code, expected);
    assert.equal(output.data, undefined);
    assert.doesNotMatch(JSON.stringify(response), /password-source-secret|hidden-source-secret|hidden-text-source-secret|initial-textarea-secret/);
  }
});

test('MCP extraction follows the explicitly observed frame and cites its own URL', async t => {
  const initial = await open(t);
  let current = initial;
  const deadline = Date.now() + 2000;
  while (!current.frames.some(frame => frame.url === `${base}/frame`) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    current = content(await call('tab_snapshot', { session_id: initial.session_id }));
  }
  const frame = current.frames.find(frame => frame.url === `${base}/frame`);
  assert.ok(frame, JSON.stringify(current.frames));
  const observed = content(await call('tab_snapshot', { session_id: initial.session_id, frame_id: frame.frame_id }));
  assert.match(observed.text, /Frame source evidence/);
  const response = await call('tab_extract_structured', { session_id: initial.session_id, schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, fields: [stringField('value', '#frame-value', { required: true })] });
  assert.notEqual(response.isError, true, JSON.stringify(response));
  const output = content(response);
  assert.deepEqual(output.data, { value: 'Frame source evidence' });
  assert.equal(output.url, `${base}/frame`);
  assert.equal(output.citations[0].url, `${base}/frame`);
});

test('MCP bounds field counts and rejects unsupported field options before extraction', async t => {
  const initial = await open(t);
  const tooMany = await call('tab_extract_structured', { session_id: initial.session_id, schema: true, fields: [stringField('items', '.too-many', { multiple: true })] });
  assert.equal(content(tooMany).error.code, 'EXTRACTION_LIMIT');
  const ambiguous = await call('tab_extract_structured', { session_id: initial.session_id, schema: true, fields: [stringField('items', '.item')] });
  assert.equal(content(ambiguous).error.code, 'SELECTOR_COUNT');
  for (const fields of [[], Array.from({ length: 31 }, (_, index) => stringField(`f${index}`, 'h1')), [{ name: 'bad', selector: 'h1', mode: 'evaluate', code: 'document.body.textContent' }]]) {
    const response = await call('tab_extract_structured', { session_id: initial.session_id, schema: true, fields });
    assert.equal(response.isError, true);
  }
});
