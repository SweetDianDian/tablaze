import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createCodexTransport } from '../bench/comparison/codex-transport.mjs';
import { startModelGateway } from '../bench/comparison/model-gateway.mjs';

// These processes stand in for the CLI. No real Codex, model, or browser runs.
async function fakeCLI(t, mode, result = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-codex-review-'));
  const script = join(directory, 'fake.mjs');
  const descendantFile = join(directory, 'descendant.json');
  const readyFile = join(directory, 'ready');
  t.after(async () => {
    try { const { pid } = JSON.parse(await readFile(descendantFile, 'utf8')); process.kill(pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(script, `
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2);
for await (const chunk of process.stdin) {}
const usage = { input_tokens: 101, output_tokens: 17, cached_input_tokens: 23 };
if (process.env.FAKE_MODE === 'late-usage') {
  process.on('SIGTERM', () => {
    console.log(JSON.stringify({ type: 'turn.completed', usage }));
    setTimeout(() => process.exit(0), 20);
  });
  await writeFile(process.env.FAKE_READY, 'ready');
  setInterval(() => {}, 1000);
} else if (process.env.FAKE_MODE === 'descendant') {
  spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.DESCENDANT_FILE, JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  for (let n = 0; n < 100; n++) {
    try { await readFile(process.env.DESCENDANT_FILE); break; } catch { await delay(5); }
  }
  setInterval(() => {}, 1000);
} else {
  await writeFile(args[args.indexOf('--output-last-message') + 1], process.env.FAKE_RESULT);
  console.log(JSON.stringify({ type: 'turn.completed', usage }));
}
`);
  return { descendantFile, readyFile, config: {
    model: 'fake-review-model', codexCommand: process.execPath, codexCommandArgs: [script], timeoutMs: 500,
    codexEnvironment: { FAKE_MODE: mode, FAKE_RESULT: JSON.stringify(result), DESCENDANT_FILE: descendantFile, FAKE_READY: readyFile },
  } };
}

const tools = ['allowed', 'other'].map(name => ({ type: 'function', function: {
  name, parameters: { type: 'object', properties: {}, additionalProperties: false },
} }));
const request = { messages: [{ role: 'user', content: 'Run the selected function.' }], tools, parallel_tool_calls: false };

test('cancelled Codex process retains usage emitted while handling SIGTERM', async t => {
  const fake = await fakeCLI(t, 'late-usage');
  await assert.rejects(createCodexTransport(fake.config).complete({ ...request, tool_choice: 'required' }), cause => {
    assert.equal(cause.code, 'CODEX_TIMEOUT');
    assert.deepEqual(cause.usage, { prompt_tokens: 101, completion_tokens: 17, total_tokens: 118, prompt_tokens_details: { cached_tokens: 23 } });
    return true;
  });
});

test('gateway close waits for cancellation usage before exposing final metrics', async t => {
  const fake = await fakeCLI(t, 'late-usage');
  const gateway = await startModelGateway({ ...fake.config, timeoutMs: 5000, transport: 'codex' });
  t.after(() => gateway.close());
  const requestDone = fetch(gateway.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, tool_choice: 'required' }) }).catch(() => undefined);
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { await readFile(fake.readyFile); ready = true; break; } catch { await delay(10); }
  }
  assert.equal(ready, true, 'The fake inference process must start before cancellation');
  await gateway.close();
  await requestDone;
  assert.equal(gateway.metrics.calls, 1);
  assert.equal(gateway.metrics.failedCalls, 1);
  assert.equal(gateway.metrics.usageComplete, true);
  assert.equal(gateway.metrics.inputTokens, 101);
  assert.equal(gateway.metrics.outputTokens, 17);
  assert.equal(gateway.metrics.cachedTokens, 23);
});

test('named tool_choice rejects a different schema-valid tool', async t => {
  const fake = await fakeCLI(t, 'normal', { tool_calls: [{ name: 'other', arguments_json: '{}' }] });
  await assert.rejects(createCodexTransport(fake.config).complete({ ...request, tool_choice: { type: 'function', function: { name: 'allowed' } } }));
});

test('tool_choice none permits a text response with tools present', async t => {
  const fake = await fakeCLI(t, 'normal', { text: 'The task is complete.' });
  const completion = await createCodexTransport(fake.config).complete({ ...request, tool_choice: 'none' });
  assert.equal(completion.choices[0].message.content, 'The task is complete.');
  assert.equal(completion.choices[0].message.tool_calls, undefined);
});

test('tool_choice auto with no selected tools is a stopped text completion', async t => {
  const fake = await fakeCLI(t, 'normal', { tool_calls: [], content: 'No action is needed.' });
  const completion = await createCodexTransport(fake.config).complete({ ...request, tool_choice: 'auto' });
  assert.equal(completion.choices[0].message.content, 'No action is needed.');
  assert.equal(completion.choices[0].message.tool_calls, undefined);
  assert.equal(completion.choices[0].finish_reason, 'stop');
});

test('timeout terminates a SIGTERM-resistant descendant after its parent exits', { skip: process.platform === 'win32' }, async t => {
  const fake = await fakeCLI(t, 'descendant');
  await assert.rejects(createCodexTransport(fake.config).complete({ ...request, tool_choice: 'required' }), { code: 'CODEX_TIMEOUT' });
  const { pid } = JSON.parse(await readFile(fake.descendantFile, 'utf8'));
  await delay(1200);
  let alive = true;
  try { process.kill(pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; else throw cause; }
  assert.equal(alive, false, 'A parent exit must not cancel escalation for its surviving process group');
});
