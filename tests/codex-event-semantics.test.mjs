import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexTransport } from '../bench/comparison/codex-transport.mjs';
import { startModelGateway } from '../bench/comparison/model-gateway.mjs';
import { classifyRunFailure } from '../bench/comparison/runner.mjs';

const secret = 'sensitive-provider-message-and-request-id';
const request = { messages: [{ role: 'user', content: 'A synthetic inference test. No tools or network are needed.' }] };

async function fakeCLI(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-codex-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'fake-cli.mjs');
  // Scheduling is entirely inside this self-owned process. In particular a
  // delayed completion must survive earlier error notifications, whereas a
  // failed turn cannot be rescued by a SIGTERM handler flushing late usage.
  await writeFile(script, `import {writeFile} from 'node:fs/promises';
const mode=process.env.FAKE_EVENT_MODE, secret=${JSON.stringify(secret)};
const emit=value=>console.log(JSON.stringify(value));
const complete=()=>emit({type:'turn.completed',usage:{input_tokens:40,output_tokens:7,cached_input_tokens:3,private_details:secret}});
for await(const chunk of process.stdin){}
await writeFile(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(mode==='bad_schema'?{unexpected:true}:{text:'finished'}));
emit({type:'thread.started',thread_id:secret});emit({type:'turn.started'});
if(mode==='typed') {
 emit({type:'error',error:{code:'rate_limit_exceeded',message:secret,retryable:true,extra:secret},will_retry:false});
 emit({type:'item.completed',item:{type:'error',code:secret,category:secret,retryable:'yes',message:secret}});
 complete();
} else if(mode==='failed') {
 process.on('SIGTERM',()=>{complete();process.exit(0)});
 emit({type:'turn.failed',error:{message:secret}});setInterval(()=>{},1000);
} else {
 emit({type:'error',message:secret});
 if(mode==='recover') {emit({type:'item.completed',item:{type:'error',message:secret}});await new Promise(resolve=>setTimeout(resolve,30));complete()}
 else if(mode==='hang')setInterval(()=>{},1000);
 else if(mode==='nonzero')process.exitCode=7;
 else if(mode==='bad_schema')complete();
}
`);
  return { model: 'fake-model', codexCommand: process.execPath, codexCommandArgs: [script], timeoutMs: mode === 'hang' ? 250 : 3000, codexEnvironment: { FAKE_EVENT_MODE: mode } };
}

function safeMetadata(metadata) {
  assert.equal(JSON.stringify(metadata).includes(secret), false, 'Raw messages, request identifiers, and unrecognized diagnostics are omitted');
  assert.match(metadata.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.schemaSha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.providerConfiguredRequestRetries, 0);
  assert.equal(metadata.providerConfiguredStreamRetries, 0);
}

test('stream and item error diagnostics may precede a successful completed turn', async t => {
  const result = await createCodexTransport(await fakeCLI(t, 'recover')).complete(request);
  assert.equal(result.choices[0].message.content, 'finished');
  assert.deepEqual(result.usage, { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47, prompt_tokens_details: { cached_tokens: 3 } });
  const metadata = result.comparison_transport;
  safeMetadata(metadata);
  assert.equal(metadata.exitCode, 0);
  assert.equal(metadata.exitSignal, null);
  assert.equal(metadata.terminalEvent, 'turn.completed');
  assert.equal(metadata.bridgeFailureCode, null);
  assert.deepEqual(metadata.diagnostics, ['stream_error', 'item_error'].map(source => ({ source, code: 'unknown', category: 'unknown', retryable: null, willRetry: null })));
  assert.deepEqual(metadata.usages, [{ input_tokens: 40, output_tokens: 7, cached_input_tokens: 3 }]);
});

test('only allowlisted structured diagnostic fields survive without deriving a retry policy', async t => {
  const { comparison_transport: metadata } = await createCodexTransport(await fakeCLI(t, 'typed')).complete(request);
  safeMetadata(metadata);
  assert.deepEqual(metadata.diagnostics, [
    { source: 'stream_error', code: 'rate_limit_exceeded', category: 'rate_limit', retryable: true, willRetry: false },
    { source: 'item_error', code: 'unknown', category: 'unknown', retryable: null, willRetry: null },
  ]);
  assert.equal(metadata.events.filter(event => event.type === 'thread.started').length, 1, 'Diagnostic flags do not cause a new CLI invocation');
});

test('a failed turn stays failed even if termination flushes completion usage and exits zero', async t => {
  await assert.rejects(createCodexTransport(await fakeCLI(t, 'failed')).complete(request), error => {
    assert.equal(error.code, 'CODEX_TURN_FAILED');
    safeMetadata(error.metadata);
    assert.equal(error.metadata.exitCode, 0);
    assert.equal(error.metadata.terminalEvent, 'turn.failed');
    assert.equal(error.metadata.bridgeFailureCode, 'CODEX_TURN_FAILED');
    assert.deepEqual(error.usage, { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47, prompt_tokens_details: { cached_tokens: 3 } });
    return true;
  });
});

test('valid output and exit zero cannot substitute for an actual completed event', async t => {
  await assert.rejects(createCodexTransport(await fakeCLI(t, 'incomplete')).complete(request), error => {
    assert.equal(error.code, 'CODEX_INCOMPLETE_TURN');
    safeMetadata(error.metadata);
    assert.equal(error.metadata.exitCode, 0);
    assert.equal(error.metadata.terminalEvent, null);
    assert.equal(error.usage, undefined);
    return true;
  });
});

test('a message-only error followed by a hanging process ends at the original deadline', async t => {
  await assert.rejects(createCodexTransport(await fakeCLI(t, 'hang')).complete(request), error => {
    assert.equal(error.code, 'CODEX_TIMEOUT');
    safeMetadata(error.metadata);
    assert.equal(error.metadata.exitSignal, 'SIGTERM');
    assert.equal(error.metadata.terminalEvent, null);
    assert.equal(error.metadata.diagnostics.length, 1);
    return true;
  });
});

test('a nonzero exit and a completed response with invalid schema both remain failures', async t => {
  await assert.rejects(createCodexTransport(await fakeCLI(t, 'nonzero')).complete(request), error => {
    assert.equal(error.code, 'CODEX_PROCESS_FAILED');
    assert.equal(error.metadata.exitCode, 7);
    assert.equal(error.metadata.terminalEvent, null);
    safeMetadata(error.metadata);
    return true;
  });
  await assert.rejects(createCodexTransport(await fakeCLI(t, 'bad_schema')).complete(request), error => {
    assert.equal(error.code, 'CODEX_RESPONSE_SCHEMA');
    assert.equal(error.metadata.terminalEvent, 'turn.completed');
    safeMetadata(error.metadata);
    return true;
  });
});

test('gateway counts one successful dispatch after diagnostics and retains unknown usage on incomplete failure', async t => {
  for (const mode of ['recover', 'incomplete']) {
    const gateway = await startModelGateway({ ...await fakeCLI(t, mode), transport: 'codex' });
    try {
      const response = await fetch(gateway.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      await response.json();
      assert.equal(response.status, mode === 'recover' ? 200 : 502);
      assert.equal(gateway.metrics.calls, 1);
      assert.equal(gateway.metrics.failedCalls, mode === 'recover' ? 0 : 1);
      assert.equal(gateway.metrics.transportRequests.length, mode === 'recover' ? 1 : 0);
      assert.equal(gateway.metrics.errors.length, mode === 'recover' ? 0 : 1);
      assert.equal(gateway.metrics.usageComplete, mode === 'recover');
      if (mode === 'recover') assert.equal(gateway.metrics.inputTokens, 40);
      else {
        assert.equal(gateway.metrics.errors[0].code, 'CODEX_INCOMPLETE_TURN');
        safeMetadata(gateway.metrics.errors[0].metadata);
      }
    } finally { await gateway.close(); }
  }
});

test('run failure classification uses terminal AgentFailure and never erases a returned failure', () => {
  const failure = { phase: 'planner', code: 'PLANNER_HTTP_ERROR', retryable: true, httpStatus: 502 };
  assert.equal(classifyRunFailure({ agentStatus: 'failed', businessPassed: true, trace: { comparison: { errorType: null } } }), 'agent_failed');
  assert.equal(classifyRunFailure({ agentStatus: 'failed', failure, trace: { comparison: { errorType: 'Error' } } }), 'PLANNER_HTTP_ERROR');
  assert.equal(classifyRunFailure({ agentStatus: 'succeeded', failure, transportErrors: [{ code: 'CODEX_TURN_FAILED' }] }), null);
  assert.equal(classifyRunFailure({ agentStatus: 'failed', failure: { ...failure, code: secret } }), 'agent_failed');
  assert.equal(classifyRunFailure({ agentStatus: 'failed', completion: { timedOut: true } }), 'agent_deadline');
  for (const status of ['cancelled', 'limit_reached', 'needs_input']) assert.equal(classifyRunFailure({ agentStatus: status }), `agent_${status}`);
  assert.equal(classifyRunFailure({ agentStatus: 'succeeded' }, 'process_deadline'), 'process_deadline');
  assert.equal(classifyRunFailure(null), 'agent_result_unavailable');
});
