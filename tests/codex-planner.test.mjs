import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runAgent } from '../dist/agent.js';
import { createCodexPlanner } from '../dist/codex.js';

const privateValue = 'fixture-private-provider-content';
const readTool = { name: 'read', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true } };
const input = (overrides = {}) => ({ task: 'Fixture task.', step: 1, signal: new AbortController().signal, messages: [{ role: 'system', content: 'Trusted executor.' }, { role: 'user', content: 'Fixture task.' }], tools: [readTool], ...overrides });
const payload = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });

async function fixture(t, mode = 'normal', config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-codex-test-'));
  const script = join(directory, 'fake.cjs'), report = join(directory, 'report.jsonl');
  await writeFile(script, `
const fs = require('node:fs'), path = require('node:path');
const folder = ${JSON.stringify(directory)}, mode = ${JSON.stringify(mode)}, config = ${JSON.stringify(config)};
let prompt = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const args = process.argv.slice(2), at = flag => args[args.indexOf(flag) + 1];
  const output = at('--output-last-message'), schema = JSON.parse(fs.readFileSync(at('--output-schema'), 'utf8'));
  const images = args.flatMap((arg, i) => arg === '--image' ? [args[i + 1]] : []);
  fs.appendFileSync(path.join(folder, 'report.jsonl'), JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, prompt, schema,
    mode: fs.statSync(process.cwd()).mode & 511,
    files: fs.readdirSync(process.cwd()).map(name => ({ name, mode: fs.statSync(name).mode & 511 })),
    images: images.map(image => fs.readFileSync(image).toString('base64')),
    secretInherited: 'TABLAZE_PRIVATE_TEST_KEY' in process.env,
  }) + '\\n');
  const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
  const usage = config.usage ?? { input_tokens: 11, output_tokens: 3, cached_input_tokens: 2 };
  const complete = () => emit({ type: 'turn.completed', usage });
  if (mode === 'wait') {
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { complete(); clearInterval(timer); process.exitCode = 0; }); return;
  }
  if (mode === 'bad-event') { process.stdout.write('PRIVATE INVALID JSON\\n'); return; }
  if (mode === 'external') { emit({ type: 'item.started', item: { type: 'command_execution', command: 'PRIVATE COMMAND' } }); return; }
  if (mode === 'stderr-limit') { process.stderr.write('x'.repeat(4 * 1024 * 1024 + 1)); return; }
  let call = { name: 'agent_request_input', arguments_json: JSON.stringify({ question: 'Fixture needs input.' }) };
  if (mode === 'loop') {
    const messages = JSON.parse(prompt.split('CONVERSATION_JSON\\n')[1].split('\\n\\nFUNCTION_SPECIFICATIONS_JSON\\n')[0]);
    const previous = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
    if (!previous.length) call = { name: 'save', arguments_json: JSON.stringify({ text: 'Saved' }) };
    else if (previous.length === 1) call = { name: 'tab_verify', arguments_json: JSON.stringify({ session_id: 's1', checks: [{ kind: 'text', contains: 'Saved' }] }) };
    else call = { name: 'agent_finish', arguments_json: JSON.stringify({ summary: 'Saved once and verified.', evidence: [previous.at(-1).toolCallId] }) };
  }
  const invocation = fs.readFileSync(path.join(folder, 'report.jsonl'), 'utf8').trim().split('\\n').length;
  const outputBody = mode === 'repair' || mode === 'repair-fail' ? { tool_calls: [invocation === 1 || mode === 'repair-fail'
    ? { name: 'agent_request_input', arguments_json: '{' }
    : { name: 'agent_request_input', arguments_json: JSON.stringify({ question: 'Recovered from malformed JSON.' }) }] }
    : config.response ?? { tool_calls: [call] };
  if (mode === 'symlink') { fs.writeFileSync(path.join(folder, 'external.json'), JSON.stringify(outputBody)); fs.symlinkSync(path.join(folder, 'external.json'), output); }
  else fs.writeFileSync(output, mode === 'large' ? 'x'.repeat(2048) : mode === 'bad-json' ? '{PRIVATE' : JSON.stringify(outputBody));
  if (mode === 'generic-error') {
    process.stderr.write(${JSON.stringify(privateValue)});
    emit({ type: 'error', message: ${JSON.stringify(privateValue)} });
    emit({ type: 'item.completed', item: { type: 'error', message: ${JSON.stringify(privateValue)} } });
  }
  if (mode === 'failed-terminal') emit({ type: 'turn.failed', error: { message: ${JSON.stringify(privateValue)} } });
  if (mode === 'cleanup-failure') fs.chmodSync(process.cwd(), 0o500);
  if (mode !== 'incomplete') complete();
  if (mode === 'nonzero') process.exitCode = 7;
});
`);
  t.after(async () => {
    try { for (const entry of await reports()) { await chmod(entry.cwd, 0o700).catch(() => {}); await rm(entry.cwd, { recursive: true, force: true }); } } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  async function reports() { return (await readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  async function ready(count = 1) {
    const end = Date.now() + 5000;
    while (Date.now() < end) { try { const rows = await reports(); if (rows.length >= count) return rows; } catch (error) { if (error.code !== 'ENOENT') throw error; } await delay(10); }
    throw new Error('Fixture process did not start.');
  }
  return { directory, reports, ready, planner(options = {}) {
    const planner = createCodexPlanner({ model: 'explicit-fixture-model', codexCommand: process.execPath, codexCommandArgs: [script], ...options });
    t.after(() => planner.close().catch(() => {}));
    return planner;
  } };
}
const rejectingTools = { listTools: async () => [readTool], callTool: async () => { throw new Error('No tools should execute.'); } };
async function gone(path) { await assert.rejects(stat(path), error => error.code === 'ENOENT'); }

test('Codex process decisions complete the Agent write/verify/evidence loop with isolated transient files', async t => {
  const fake = await fixture(t, 'loop'); const usages = [], diagnostics = [];
  const planner = fake.planner({ reasoningEffort: 'ultra', onUsage: value => usages.push(value), onDiagnostic: value => diagnostics.push(value) });
  let writes = 0;
  const result = await runAgent({ task: 'Save once and verify.', planner, tools: {
    listTools: async () => [
      { name: 'save', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'tab_verify', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, checks: { type: 'array', items: { type: 'object' } } }, required: ['session_id', 'checks'] } },
    ],
    callTool: async call => call.name === 'save' ? (writes++, payload({ ok: true, session_id: 's1' })) : payload({ ok: true, session_id: 's1', passed: writes === 1, checks: call.arguments.checks.map(check => ({ ...check, pass: writes === 1 })) }),
  } });
  await planner.close();
  assert.equal(result.status, 'succeeded'); assert.equal(writes, 1); assert.equal(result.toolCalls, 2); assert.equal(result.evidence.length, 1);
  assert.equal(usages.length, 3); assert.equal(diagnostics.length, 3);
  for (const report of await fake.reports()) {
    assert.equal(report.args[report.args.indexOf('--model') + 1], 'explicit-fixture-model');
    for (const flag of ['--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--output-schema', '--output-last-message', '--json']) assert.ok(report.args.includes(flag));
    assert.equal(report.args.at(-1), '-'); assert.equal(report.mode, 0o700); assert.ok(report.files.every(file => file.mode === 0o600));
    assert.ok(report.args.includes('model_reasoning_effort="ultra"')); assert.ok(report.args.includes('web_search="disabled"'));
    assert.ok(report.schema.properties.tool_calls.items.properties.name.enum.includes('tab_verify')); await gone(report.cwd);
  }
  assert.ok(diagnostics.every(value => value.status === 'completed' && value.exitCode === 0 && value.terminalEvent === 'turn.completed'));
});

test('Codex only inherits allowlisted environment and uses bounded deduplicated inline images', async t => {
  const fake = await fixture(t); const planner = fake.planner();
  const previous = process.env.TABLAZE_PRIVATE_TEST_KEY; process.env.TABLAZE_PRIVATE_TEST_KEY = privateValue;
  try {
    const messages = [...input().messages, { role: 'assistant', content: '', toolCalls: [{ id: 'image-call', name: 'read', arguments: { value: 1 } }] }, { role: 'tool', name: 'read', toolCallId: 'image-call', result: { content: [{ type: 'image', mimeType: 'image/png', data: 'AQIDBA==' }, { type: 'image', mimeType: 'image/png', data: 'AQIDBA==' }] } }];
    const original = structuredClone(messages);
    assert.equal((await planner(input({ messages }))).type, 'human_input'); assert.deepEqual(messages, original);
    const [report] = await fake.reports(); assert.equal(report.secretInherited, false); assert.deepEqual(report.images, ['AQIDBA==']);
    assert.equal(report.prompt.includes('AQIDBA=='), false); assert.equal(report.prompt.includes(privateValue), false); assert.ok(report.prompt.includes('Attached screenshot 1'));
    await gone(report.cwd);
  } finally { if (previous === undefined) delete process.env.TABLAZE_PRIVATE_TEST_KEY; else process.env.TABLAZE_PRIVATE_TEST_KEY = previous; }
});

test('Codex generic notifications do not abort successful terminal events or leak provider text', async t => {
  const fake = await fixture(t, 'generic-error'); const usages = [], diagnostics = [];
  const planner = fake.planner({ onUsage: value => usages.push(value), onDiagnostic: value => diagnostics.push(value) });
  const result = await runAgent({ task: 'Request input.', tools: rejectingTools, planner });
  assert.equal(result.status, 'needs_input'); assert.equal(diagnostics[0].errorNotifications, 2); assert.equal(diagnostics[0].status, 'completed');
  assert.equal(usages[0].promptTokens, 11); assert.equal(usages[0].totalTokens, undefined);
  assert.equal(JSON.stringify({ result, usages, diagnostics }).includes(privateValue), false); assert.equal((await fake.reports()).length, 1);
});

for (const [mode, failure, code] of [
  ['incomplete', 'PLANNER_INVALID_RESPONSE', 'CODEX_INCOMPLETE_TURN'],
  ['nonzero', 'PLANNER_PROCESS_FAILED', 'CODEX_PROCESS_FAILED'],
  ['failed-terminal', 'PLANNER_PROCESS_FAILED', 'CODEX_TURN_FAILED'],
  ['bad-event', 'PLANNER_INVALID_RESPONSE', 'CODEX_EVENT_INVALID'],
  ['external', 'PLANNER_PROCESS_FAILED', 'CODEX_EXTERNAL_TOOL'],
  ['stderr-limit', 'PLANNER_RESPONSE_TOO_LARGE', 'CODEX_OUTPUT_LIMIT'],
  ['large', 'PLANNER_RESPONSE_TOO_LARGE', 'CODEX_OUTPUT_LIMIT'],
  ['bad-json', 'PLANNER_INVALID_RESPONSE', 'CODEX_RESPONSE_INVALID'],
  ['symlink', 'PLANNER_INVALID_RESPONSE', 'CODEX_RESPONSE_INVALID'],
]) test(`Codex ${mode} cannot dispatch or imply Agent success`, async t => {
  const fake = await fixture(t, mode); const diagnostics = [];
  const planner = fake.planner({ maxResponseBytes: 1024, onDiagnostic: value => diagnostics.push(value) });
  const result = await runAgent({ task: 'Reject unusable responses.', tools: rejectingTools, planner });
  await planner.close(); assert.equal(result.status, 'failed'); assert.equal(result.failure.code, failure); assert.equal(result.toolCalls, 0);
  assert.equal(result.failure.retryable, mode === 'nonzero' || mode === 'failed-terminal');
  assert.equal(diagnostics[0].status, 'failed'); assert.equal(diagnostics[0].code, code);
  assert.equal(JSON.stringify({ result, diagnostics }).includes(privateValue), false); await gone((await fake.reports())[0].cwd);
});

test('Codex validates original tool arguments and the final schema before dispatch', async t => {
  for (const [response, stage] of [
    [{ tool_calls: [{ name: 'not-a-tool', arguments_json: '{}' }] }, 'envelope'],
    [{ tool_calls: [{ name: 'read', arguments_json: '{"value":"wrong"}' }] }, 'arguments_schema'],
    [{ tool_calls: [{ name: 'read', arguments_json: '{"value":1,"extra":true}' }] }, 'arguments_schema'],
    [{ tool_calls: [{ name: 'agent_finish', arguments_json: '{"summary":"unverified","evidence":[]}' }] }, 'arguments_schema'],
    [{ tool_calls: [{ name: 'agent_fail', arguments_json: '{"reason":"stop"}' }], extra: privateValue }, 'envelope'],
  ]) {
    const fake = await fixture(t, 'normal', { response });
    const diagnostics = [];
    const result = await runAgent({ task: 'Validate decisions.', tools: rejectingTools, planner: fake.planner({ onDiagnostic: value => diagnostics.push(value) }) });
    assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'PLANNER_INVALID_RESPONSE'); assert.equal(result.toolCalls, 0);
    assert.equal(diagnostics[0].responseStage, stage);
  }
});

test('Codex forwards a shape-correct but schema-invalid final value for Agent correction', async t => {
  const schema = { type: 'object', properties: { receiptId: { type: 'string' } }, required: ['receiptId'], additionalProperties: false };
  const fake = await fixture(t, 'normal', { response: { tool_calls: [{ name: 'agent_finish', arguments_json: JSON.stringify({ summary: 'Verified.', evidence: ['verification-1'], data: { receiptId: 7 } }) }] } });
  const planner = fake.planner();
  const decision = await planner(input({ finalOutputSchema: schema }));
  assert.deepEqual(decision, { type: 'finish', summary: 'Verified.', evidence: ['verification-1'], data: { receiptId: 7 } });
  const [report] = await fake.reports();
  assert.ok(report.prompt.includes('"receiptId"'));
  assert.ok(report.prompt.includes('"data"'));
});

test('Codex forwards a shape-correct but schema-invalid checked partial for Agent feedback', async t => {
  const schema = { type: 'object', properties: { receiptId: { type: 'string' } }, required: ['receiptId'], additionalProperties: false };
  const fake = await fixture(t, 'normal', { response: { tool_calls: [{ name: 'agent_publish', arguments_json: JSON.stringify({ key: 'first', evidence: ['verification-1'], data: { receiptId: 7 } }) }] } });
  const planner = fake.planner();
  const decision = await planner(input({ partialOutputSchema: schema }));
  assert.deepEqual(decision, { type: 'publish', key: 'first', evidence: ['verification-1'], data: { receiptId: 7 } });
  const [report] = await fake.reports();
  assert.ok(report.schema.properties.tool_calls.items.properties.name.enum.includes('agent_publish'));
});

test('Codex repairs one malformed arguments string without dispatching a browser tool', async t => {
  const fake = await fixture(t, 'repair'); const diagnostics = [], usage = [];
  const planner = fake.planner({ onDiagnostic: value => diagnostics.push(value), onUsage: value => usage.push(value) });
  const result = await runAgent({ task: 'Request input after a format correction.', tools: rejectingTools, planner });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.question, 'Recovered from malformed JSON.');
  assert.equal(result.toolCalls, 0);
  assert.equal(diagnostics[0].status, 'completed');
  assert.equal(diagnostics[0].formatRetries, 1);
  assert.equal(usage[0].promptTokens, 22);
  assert.equal(usage[0].completionTokens, 6);
  const reports = await fake.reports();
  assert.equal(reports.length, 2);
  assert.ok(reports[1].prompt.includes('FORMAT_CORRECTION'));
});

test('Codex stops after one failed format repair and never dispatches the malformed call', async t => {
  const fake = await fixture(t, 'repair-fail'); const diagnostics = [];
  const result = await runAgent({ task: 'Reject repeatedly malformed decisions.', tools: rejectingTools, planner: fake.planner({ onDiagnostic: value => diagnostics.push(value) }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'PLANNER_INVALID_RESPONSE');
  assert.equal(result.toolCalls, 0);
  assert.equal((await fake.reports()).length, 2);
  assert.equal(diagnostics[0].formatRetries, 1);
  assert.equal(diagnostics[0].responseStage, 'arguments_json');
});

test('Codex timeout drains final reported usage, deletes files and keeps fixed failure diagnostics', async t => {
  const fake = await fixture(t, 'wait'); const usages = [], diagnostics = [];
  const planner = fake.planner({ timeoutMs: 500, onUsage: value => usages.push(value), onDiagnostic: value => diagnostics.push(value) });
  const result = await runAgent({ task: 'Timeout pending inference.', tools: rejectingTools, planner });
  await planner.close(); assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'PLANNER_PROCESS_FAILED');
  assert.equal(diagnostics[0].code, 'CODEX_TIMEOUT'); assert.equal(usages[0].promptTokens, 11);
  await gone((await fake.reports())[0].cwd);
});

test('Codex one-request cancellation is isolated and close drains every outstanding process', async t => {
  const fake = await fixture(t, 'wait'); const usages = [], diagnostics = [];
  const planner = fake.planner({ onUsage: value => usages.push(value), onDiagnostic: value => diagnostics.push(value) });
  const a = new AbortController(), b = new AbortController();
  const first = planner(input({ step: 1, signal: a.signal })).then(() => null, error => error);
  const second = planner(input({ step: 2, signal: b.signal })).then(() => null, error => error);
  const reports = await fake.ready(2); a.abort(); assert.match((await first).message, /CODEX_CANCELLED/);
  assert.equal(diagnostics.length, 1); assert.equal(usages.length, 1); assert.equal(b.signal.aborted, false);
  const close = planner.close(); assert.equal(close, planner.close()); await close;
  assert.match((await second).message, /CODEX_CANCELLED/); assert.equal(usages.length, 2); assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every(value => value.code === 'CODEX_CANCELLED'));
  for (const report of reports) await gone(report.cwd);
  await assert.rejects(planner(input()), /closed/); assert.equal((await fake.reports()).length, 2);
});

test('Codex missing usage counters remain absent and usage hook errors still produce process diagnostics', async t => {
  const fake = await fixture(t, 'normal', { usage: { input_tokens: 7, output_tokens: -1, cached_input_tokens: null, private: privateValue } });
  const usages = [], diagnostics = [];
  const planner = fake.planner({ onUsage: value => { usages.push(value); throw new Error(privateValue); }, onDiagnostic: value => diagnostics.push(value) });
  const result = await runAgent({ task: 'Handle application usage failure.', tools: rejectingTools, planner });
  assert.equal(result.failure.code, 'USAGE_HOOK_FAILED'); assert.equal(diagnostics.length, 1); assert.equal(usages[0].promptTokens, 7);
  for (const key of ['completionTokens', 'cachedPromptTokens', 'totalTokens']) assert.equal(usages[0][key], undefined);
  assert.equal(JSON.stringify({ result, usages, diagnostics }).includes(privateValue), false); await planner.close();
});

test('Codex file cleanup failure remains visible to Agent and close without dropping measured usage', { skip: process.platform === 'win32' || process.geteuid?.() === 0 }, async t => {
  const fake = await fixture(t, 'cleanup-failure'); const usages = [], diagnostics = [];
  const planner = fake.planner({ onUsage: value => usages.push(value), onDiagnostic: value => diagnostics.push(value) });
  const result = await runAgent({ task: 'Report cleanup failure.', tools: rejectingTools, planner });
  assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'PLANNER_PROCESS_FAILED');
  assert.equal(usages[0].promptTokens, 11); assert.equal(diagnostics[0].code, 'CODEX_CLEANUP_FAILED'); assert.equal(diagnostics[0].status, 'failed');
  await assert.rejects(planner.close(), /CODEX_CLEANUP_FAILED/);
});

test('Codex invalid configuration fails before child launch', () => {
  for (const options of [{ model: '' }, { model: 'x', codexCommand: '' }, { model: 'x', codexCommandArgs: [null] }, { model: 'x', timeoutMs: 0 }, { model: 'x', maxResponseBytes: 0 }, { model: 'x', reasoningEffort: 'invented' }]) assert.throws(() => createCodexPlanner(options));
});
