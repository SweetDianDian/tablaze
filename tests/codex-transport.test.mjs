import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEX_DISABLED_FEATURES, createCodexTransport, prepareCodexRequest } from '../bench/comparison/codex-transport.mjs';
import { startModelGateway } from '../bench/comparison/model-gateway.mjs';

async function fakeCLI(t, result, mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-fake-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'fake-codex.mjs'), report = join(directory, 'invocation.json');
  await writeFile(script, `import {readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2), index=flag=>args[args.indexOf(flag)+1];
let prompt=''; for await(const chunk of process.stdin) prompt+=chunk;
const imageIndex=args.indexOf('--image');
await writeFile(process.env.FAKE_REPORT,JSON.stringify({args,prompt,cwd:process.cwd(),schema:JSON.parse(await readFile(index('--output-schema'),'utf8')),imageBytes:imageIndex<0?null:(await readFile(args[imageIndex+1])).toString('base64'),hasApiKey:!!process.env.OPENAI_API_KEY}));
if(process.env.FAKE_MODE==='hang') {setInterval(()=>{},1000);}
else if(process.env.FAKE_MODE==='external') {console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'this is only a fake event, never executed'}}));setInterval(()=>{},1000);}
else {
const response=process.env.FAKE_MODE==='dynamic'?(prompt.includes('FUNCTION_SPECIFICATIONS_JSON')?JSON.stringify({tool_calls:[{name:'tab_open',arguments_json:'{"url":"http://127.0.0.1:1234"}'}]}):JSON.stringify({action:'click'})):process.env.FAKE_RESPONSE;
await writeFile(index('--output-last-message'),response);
console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:response}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:20,output_tokens:15}}));
}`);
  return { directory, report, config: { model: 'fake-model', reasoningEffort: 'ultra', codexCommand: process.execPath, codexCommandArgs: [script], timeoutMs: 5000,
    codexEnvironment: { FAKE_REPORT: report, FAKE_RESPONSE: JSON.stringify(result), FAKE_MODE: mode } } };
}

const tools = [{ type: 'function', function: { name: 'tab_open', parameters: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string' } } } } }];
const request = { model: 'must-be-overridden', messages: [{ role: 'system', content: 'Use the actual framework to open the task page.' }, { role: 'user', content: 'Open http://127.0.0.1:1234' }], tools, tool_choice: 'required', parallel_tool_calls: false };

test('Codex transport adapts function decisions, disables external tools, and preserves actual CLI usage', async t => {
  const fake = await fakeCLI(t, { tool_calls: [{ name: 'tab_open', arguments_json: '{"url":"http://127.0.0.1:1234"}' }] });
  const result = await createCodexTransport(fake.config).complete(request);
  assert.equal(result.model, 'fake-model');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'tab_open');
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { url: 'http://127.0.0.1:1234' });
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115, prompt_tokens_details: { cached_tokens: 20 } });
  const invocation = JSON.parse(await readFile(fake.report, 'utf8'));
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('read-only'));
  for (const feature of CODEX_DISABLED_FEATURES) assert.equal(invocation.args[invocation.args.indexOf(feature) - 1], '--disable');
  assert.ok(invocation.args.includes('web_search="disabled"'));
  assert.equal(invocation.hasApiKey, false);
  assert.ok(invocation.prompt.includes('FUNCTION_SPECIFICATIONS_JSON'));
  assert.ok(!invocation.cwd.startsWith(process.cwd()), 'CLI runs in an independent empty temporary directory');
  await assert.rejects(readFile(join(invocation.cwd, 'response.json')), { code: 'ENOENT' });
});

test('Browser Use structured schema and inline images share the same Codex inference transport', async t => {
  const schema = { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string' } } };
  const bytes = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const fake = await fakeCLI(t, { action: 'click' });
  const result = await createCodexTransport(fake.config).complete({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Browser Use screenshot' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes}` } }] }], response_format: { type: 'json_schema', json_schema: { name: 'agent_output', strict: true, schema } } });
  assert.deepEqual(JSON.parse(result.choices[0].message.content), { action: 'click' });
  const invocation = JSON.parse(await readFile(fake.report, 'utf8'));
  assert.deepEqual(invocation.schema, schema, 'The full public Agent schema is preserved');
  assert.equal(invocation.imageBytes, bytes);
  assert.ok(invocation.prompt.includes('Attached screenshot 1'));
  assert.equal(invocation.prompt.includes(bytes), false, 'Pixels are image attachments, not base64 prompt text');
  assert.equal(result.comparison_transport.images.length, 1);
  await assert.rejects(prepareCodexRequest({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/private.png' } }] }] }, fake.directory), { code: 'CODEX_IMAGE_UNSUPPORTED' });
});

test('Codex transport rejects schema-invalid function arguments before the browser runtime sees them', async t => {
  const fake = await fakeCLI(t, { tool_calls: [{ name: 'tab_open', arguments_json: '{"url":17}' }] });
  await assert.rejects(createCodexTransport(fake.config).complete(request), { code: 'CODEX_ARGUMENTS_SCHEMA' });
});

test('automatic tool choice can return ordinary text without inventing an executed call', async t => {
  const fake = await fakeCLI(t, { tool_calls: [], content: 'No browser operation is needed.' });
  const result = await createCodexTransport(fake.config).complete({ ...request, tool_choice: 'auto' });
  assert.equal(result.choices[0].message.content, 'No browser operation is needed.');
  assert.equal(result.choices[0].message.tool_calls, undefined);
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('unexpected Codex tool activity invalidates the attempt and stops its own process', async t => {
  const fake = await fakeCLI(t, {}, 'external');
  await assert.rejects(createCodexTransport(fake.config).complete(request), { code: 'CODEX_EXTERNAL_TOOL' });
  const invocation = JSON.parse(await readFile(fake.report, 'utf8'));
  await assert.rejects(readFile(join(invocation.cwd, 'response-schema.json')), { code: 'ENOENT' });
});

test('Codex inference deadline and cancellation stop owned child processes without treating them as model answers', async t => {
  const fake = await fakeCLI(t, {}, 'hang');
  await assert.rejects(createCodexTransport({ ...fake.config, timeoutMs: 200 }).complete(request), { code: 'CODEX_TIMEOUT' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createCodexTransport(fake.config).complete(request, { signal: controller.signal }), { code: 'CODEX_CANCELLED' });
});

test('shared model gateway bridges both framework formats through the same fake Codex process settings', async t => {
  const fake = await fakeCLI(t, {}, 'dynamic');
  const gateway = await startModelGateway({ ...fake.config, transport: 'codex', tokenBudget: 1000 });
  t.after(() => gateway.close());
  const send = async body => {
    const response = await fetch(gateway.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await send(request)).choices[0].message.tool_calls[0].function.name, 'tab_open');
  assert.deepEqual(JSON.parse((await send({ messages: request.messages, response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string' } } } } } })).choices[0].message.content), { action: 'click' });
  assert.equal(gateway.metrics.calls, 2);
  assert.equal(gateway.metrics.failedCalls, 0);
  assert.equal(gateway.metrics.inputTokens, 200);
  assert.equal(gateway.metrics.outputTokens, 30);
  assert.equal(gateway.metrics.transportRequests.length, 2);
  for (const call of gateway.metrics.transportRequests) { assert.equal(call.model, 'fake-model'); assert.equal(call.reasoningEffort, 'ultra'); assert.equal(call.providerHTTPOverride, true); }
});
