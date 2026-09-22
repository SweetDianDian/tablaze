import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { assembleDOMExtraction, extractWithProvenance, inspectDOMField, validateDOMFieldPlan, validateProvenance } from '../dist/extraction.js';
import { inspectDOM } from '../dist/snapshot.js';

const schema = { type: 'object', properties: { city: { type: 'string' }, price: { type: 'number' } }, required: ['city', 'price'], additionalProperties: false };
const sources = [{ id: 'one', url: 'https://example.test/a', text: 'Lisbon costs 25. Published 2026-09-22.' }, { id: 'two', url: 'https://example.test/b', text: 'Porto costs 15. Contact sales@example.test.' }];
const candidate = () => ({ data: { city: 'Lisbon', price: 25 }, citations: [{ pointer: '/city', sourceId: 'one', quote: 'Lisbon' }, { pointer: '/price', sourceId: 'one', quote: '25' }] });
const validate = overrides => validateProvenance({ schema, sources, candidate: candidate(), ...overrides });
const plain = value => JSON.parse(JSON.stringify(value));
const throwsCode = (operation, code) => assert.throws(operation, error => error.code === code, code);

test('schema extraction binds every populated leaf to exact source text and authoritative URLs', () => {
  const output = validate();
  assert.deepEqual(plain(output.data), { city: 'Lisbon', price: 25 });
  assert.equal(output.provenance, 'source-quote-presence');
  for (const citation of output.citations) {
    const source = sources.find(source => source.id === citation.sourceId);
    assert.equal(citation.url, source.url);
    assert.equal(source.text.slice(citation.start, citation.end), citation.quote);
  }
});

test('multiple sources can produce nested data and a checked aggregate without a provider dependency', async () => {
  const aggregateSchema = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { city: { type: 'string' }, price: { type: 'number' } }, required: ['city', 'price'], additionalProperties: false } }, total: { type: 'number' } }, required: ['rows', 'total'], additionalProperties: false };
  let calls = 0;
  const output = await extractWithProvenance({ schema: aggregateSchema, sources, task: 'Compare the two listed cities and total their prices.', extractor: async request => {
    calls++;
    assert.equal(request.sources.length, 2);
    assert.equal(Object.isFrozen(request.sources[0]), true);
    assert.equal(Object.isFrozen(request.schema), true);
    return { data: { rows: [{ city: 'Lisbon', price: 25 }, { city: 'Porto', price: 15 }], total: 40 }, citations: [
      { pointer: '/rows/0/city', sourceId: 'one', quote: 'Lisbon' }, { pointer: '/rows/0/price', sourceId: 'one', quote: '25' },
      { pointer: '/rows/1/city', sourceId: 'two', quote: 'Porto' }, { pointer: '/rows/1/price', sourceId: 'two', quote: '15' },
      { pointer: '/total', sourceId: 'one', quote: '25' }, { pointer: '/total', sourceId: 'two', quote: '15' },
    ] };
  }, validateSupport: ({ data }) => data.total === data.rows.reduce((sum, row) => sum + row.price, 0) });
  assert.equal(calls, 1);
  assert.equal(output.data.total, 40);
  assert.equal(output.citations.filter(item => item.pointer === '/total').length, 2);
});

test('invented sources, URLs, approximate quotes and missing or non-leaf citations are rejected', () => {
  for (const patch of [{ sourceId: 'invented' }, { url: 'https://other.test/' }, { url: 'file:///secret' }, { quote: 'lisbon' }, { quote: 'Lisbon  costs' }, { pointer: '/missing' }, { pointer: '' }, { pointer: '/c~2ity' }]) {
    const changed = candidate(); Object.assign(changed.citations[0], patch);
    throwsCode(() => validate({ candidate: changed }), 'INVALID_CITATION');
  }
  const missing = candidate(); missing.citations.pop();
  throwsCode(() => validate({ candidate: missing }), 'INCOMPLETE_EVIDENCE');
  const wrongSource = candidate(); wrongSource.citations[0].sourceId = 'two';
  throwsCode(() => validate({ candidate: wrongSource }), 'INVALID_CITATION');
});

test('JSON pointers escape literal keys and require evidence for null and empty containers', () => {
  const data = { 'a/b~c': [null, [], {}] };
  const citations = ['/a~1b~0c/0', '/a~1b~0c/1', '/a~1b~0c/2'].map(pointer => ({ pointer, sourceId: 'one', quote: 'Lisbon' }));
  const result = validate({ schema: true, candidate: { data, citations } });
  assert.deepEqual(plain(result.data), data);
  throwsCode(() => validate({ schema: true, candidate: { data, citations: citations.slice(0, 2) } }), 'INCOMPLETE_EVIDENCE');
  const primitive = validate({ schema: { type: 'number' }, candidate: { data: 25, citations: [{ pointer: '', sourceId: 'one', quote: '25' }] } });
  assert.equal(primitive.data, 25);
});

test('schema types, required fields, formats and local references are enforced without coercion', () => {
  const wrong = candidate(); wrong.data.price = '25';
  throwsCode(() => validate({ candidate: wrong }), 'SCHEMA_MISMATCH');
  const extra = candidate(); extra.data.unrequested = true;
  throwsCode(() => validate({ candidate: extra }), 'SCHEMA_MISMATCH');
  const contactSchema = { type: 'object', definitions: { email: { type: 'string', format: 'email' } }, properties: { email: { $ref: '#/definitions/email' } }, required: ['email'], additionalProperties: false };
  const contact = { data: { email: 'sales@example.test' }, citations: [{ pointer: '/email', sourceId: 'two', quote: 'sales@example.test' }] };
  assert.equal(validate({ schema: contactSchema, candidate: contact }).data.email, 'sales@example.test');
  contact.data.email = 'not-an-email';
  throwsCode(() => validate({ schema: contactSchema, candidate: contact }), 'SCHEMA_MISMATCH');
  for (const invalidSchema of [{ $ref: 'https://remote.test/schema' }, { $async: true, type: 'object' }, { type: 'string', unknownKeyword: true }, { $schema: 'https://json-schema.org/draft/2020-12/schema' }]) throwsCode(() => validate({ schema: invalidSchema }), 'INVALID_SCHEMA');
});

test('literal schema const data is not interpreted as schema references', () => {
  const data = { $ref: 'https://data.test/value', $schema: 'https://data.test/schema' };
  const citations = Object.keys(data).map(key => ({ pointer: `/${key}`, sourceId: 'one', quote: 'Lisbon' }));
  assert.deepEqual(plain(validate({ schema: { const: data }, candidate: { data, citations } }).data), data);
});

test('source and candidate limits fail before accepting output', () => {
  for (const badSources of [[], [sources[0], sources[0]], [{ ...sources[0], url: 'data:text/plain,x' }], [{ ...sources[0], url: 'https://user:secret@example.test/' }], [{ ...sources[0], text: 'x'.repeat(100001) }]]) throwsCode(() => validate({ sources: badSources }), 'INVALID_SOURCE');
  const cyclic = candidate(); cyclic.data.city = cyclic;
  throwsCode(() => validate({ candidate: cyclic }), 'INVALID_CANDIDATE');
  const nonfinite = candidate(); nonfinite.data.price = Infinity;
  throwsCode(() => validate({ candidate: nonfinite }), 'INVALID_CANDIDATE');
  const missingData = { citations: candidate().citations };
  throwsCode(() => validate({ candidate: missingData }), 'INVALID_CANDIDATE');
});

test('quote presence is distinct from truth and the application can reject unsupported claims', async () => {
  const unsupported = candidate(); unsupported.data.price = 999;
  assert.equal(validate({ candidate: unsupported }).data.price, 999, 'Mechanical provenance must not be described as semantic proof');
  for (const verdict of [false, undefined, null, 'The quote does not support this price.']) await assert.rejects(extractWithProvenance({ schema, sources, extractor: async () => unsupported, validateSupport: () => verdict }), error => error.code === 'SUPPORT_REJECTED');
});

test('cancellation and deadline stop waiting on non-cooperating extractors without retries', async () => {
  let calls = 0;
  await assert.rejects(extractWithProvenance({ schema, sources, timeoutMs: 10, extractor: async () => { calls++; return new Promise(() => {}); } }), error => error.code === 'EXTRACTION_TIMEOUT');
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractWithProvenance({ schema, sources, signal: controller.signal, extractor: async () => { calls++; return candidate(); } }), error => error.code === 'CANCELLED');
  assert.equal(calls, 1);
  const beforeDispatch = new AbortController();
  queueMicrotask(() => beforeDispatch.abort());
  await assert.rejects(extractWithProvenance({ schema, sources, signal: beforeDispatch.signal, extractor: async () => { calls++; return candidate(); } }), error => error.code === 'CANCELLED');
  assert.equal(calls, 1);
});

const observation = (field, raw, matchIndex = 0) => ({ ok: true, url: 'https://example.test/form', selector: field.selector, mode: field.mode, ...(field.attribute ? { attribute: field.attribute } : {}), matchIndex, raw, truncated: false });
test('deterministic fields create typed values and preserve their exact DOM provenance', () => {
  const fields = [{ name: 'city', selector: '.city', mode: 'text', required: true }, { name: 'price', selector: '.price', mode: 'text', type: 'number', required: true }];
  const result = assembleDOMExtraction({ schema, fields, observations: { city: [observation(fields[0], 'Lisbon')], price: [observation(fields[1], '25')] } });
  assert.deepEqual(plain(result.data), { city: 'Lisbon', price: 25 });
  assert.deepEqual(result.citations.map(item => [item.pointer, item.selector, item.quote]), [['/city', '.city', 'Lisbon'], ['/price', '.price', '25']]);
  assert.equal(result.provenance, 'dom-observation');
});

test('field-map cardinality, optional omissions, strict conversions and observation binding are enforced', () => {
  const field = { name: 'count', selector: '.count', mode: 'attribute', attribute: 'data-count', type: 'integer', required: true };
  const create = observations => assembleDOMExtraction({ schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, fields: [field], observations: { count: observations } });
  throwsCode(() => create([]), 'MISSING_FIELD');
  throwsCode(() => create([observation(field, '1'), observation(field, '2', 1)]), 'SELECTOR_COUNT');
  for (const value of ['1,000', '$25', '', '01', '1.5', '9007199254740993']) throwsCode(() => create([observation(field, value)]), 'TYPE_CONVERSION');
  for (const patch of [{ selector: '.other' }, { mode: 'text' }, { truncated: true }, { matchIndex: 5 }]) throwsCode(() => create([{ ...observation(field, '1'), ...patch }]), 'INVALID_OBSERVATION');
  assert.deepEqual(plain(assembleDOMExtraction({ schema: { type: 'object' }, fields: [{ ...field, required: false }], observations: { count: [] } }).data), {});
  throwsCode(() => validateDOMFieldPlan([field, field]), 'INVALID_FIELD_PLAN');
  throwsCode(() => validateDOMFieldPlan([{ ...field, mode: 'text' }]), 'INVALID_FIELD_PLAN');
  const many = { name: 'values', selector: '.value', mode: 'text', multiple: true, type: 'boolean' };
  const result = assembleDOMExtraction({ schema: true, fields: [many], observations: { values: [observation(many, 'true'), observation(many, 'false', 1)] } });
  assert.deepEqual(plain(result.data), { values: [true, false] });
  assert.deepEqual(result.citations.map(citation => citation.pointer), ['/values/0', '/values/1']);
});

test('browser inspector uses composed text, current form state and real page provenance', { timeout: 30000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><div id="host"></div><input id="count" value="1"><input id="checked" type="checkbox" checked><input id="password" type="password" value="password-secret"><input id="hidden" type="hidden" value="hidden-secret"><textarea id="memo">initial-secret</textarea><div hidden id="hidden-text">hidden-text-secret</div><script>const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<p id="city" data-city="Lisbon">Lisbon <span>Portugal</span></p>';document.querySelector('#count').value='42';document.querySelector('#memo').value='Current memo';</script>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, channel: process.env.TABLAZE_BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const actualUrl = `http://127.0.0.1:${server.address().port}/source`;
  await page.goto(actualUrl);
  const read = async (selector, mode, attribute) => {
    const node = await page.locator(selector).elementHandle();
    try {
      const text = mode === 'text' ? await page.evaluate(inspectDOM, { op: 'text', root: node, textLimit: 20000 }) : undefined;
      return await page.evaluate(inspectDOMField, { node, selector, mode, attribute, text });
    } finally { await node.dispose(); }
  };
  const city = await read('#city', 'text');
  assert.equal(city.raw, 'Lisbon Portugal');
  assert.equal(city.url, actualUrl);
  assert.equal((await read('#city', 'attribute', 'data-city')).raw, 'Lisbon');
  assert.equal((await read('#count', 'value')).raw, '42');
  assert.equal((await read('#checked', 'value')).raw, 'true');
  assert.equal((await read('#memo', 'value')).raw, 'Current memo');
  const rejected = await Promise.all([read('#password', 'value'), read('#hidden', 'value'), read('#hidden-text', 'text'), read('#memo', 'text'), read('#count', 'attribute', 'value')]);
  assert.ok(rejected.every(result => !result.ok && result.raw === undefined));
  assert.doesNotMatch(JSON.stringify(rejected), /password-secret|hidden-secret|initial-secret|hidden-text-secret/);
  await page.locator('#city').evaluate(node => node.textContent = 'x'.repeat(20001));
  assert.equal((await read('#city', 'text')).error.code, 'TRUNCATED_FIELD');
});
