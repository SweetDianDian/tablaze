import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TASKS, startTaskService } from '../bench/comparison/fixture.mjs';
import { startModelGateway } from '../bench/comparison/model-gateway.mjs';
import { parseArgs, preflight, runComparison } from '../bench/comparison/runner.mjs';

test('Browser Use source pin accepts only exact git commits or hashed official archives', () => {
  const script = `import importlib.util,json
spec=importlib.util.spec_from_file_location('comparison_adapter','bench/comparison/browser-use-adapter.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
pin=module.PIN
good={'url':'https://codeload.github.com/browser-use/browser-use/zip/'+pin,'archive_info':{'hashes':{'sha256':'a'*64}}}
assert module.pinned_source(good)['sha256']=='a'*64
assert module.pinned_source({'vcs_info':{'commit_id':pin}})['commit']==pin
for url in ['file:///private/tmp/copied-source','https://example.com/browser-use/browser-use/zip/'+pin,'https://codeload.github.com/browser-use/browser-use/zip/main','https://codeload.github.com/browser-use/browser-use/zip/'+pin+'-suffix']:
 assert module.pinned_source({**good,'url':url}) is None
assert module.pinned_source({**good,'archive_info':{}}) is None
assert module.pinned_source({'dir_info':{},'url':'file:///private/tmp/source'}) is None
print('pinned-source-checks-passed')`;
  assert.equal(execFileSync('python3', ['-B', '-c', script], { encoding: 'utf8' }).trim(), 'pinned-source-checks-passed');
});

test('fixture judges actual records, rejects claimed success, and resets isolated attempts', async t => {
  const service = await startTaskService();
  t.after(() => service.close());
  const first = await service.createAttempt('form', 9);
  const second = await service.createAttempt('form', 9);
  assert.notEqual(first.id, second.id);
  assert.equal(first.taskHash, second.taskHash, 'Same task and seed have a stable hash despite randomized URLs');
  assert.equal((await first.judge({ summary: 'The task succeeded' })).passed, false);
  const save = body => fetch(first.url + 'save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await save({ name: 'Wrong name', city: 'Lisbon' });
  assert.equal((await first.judge()).passed, false);
  first.reset();
  await save({ name: 'Ada', city: 'Lisbon' });
  assert.equal((await first.judge()).passed, true);
  assert.equal((await second.judge()).passed, false, 'Attempts cannot share result state');
  await save({ name: 'Ada', city: 'Lisbon' });
  const duplicate = await first.judge();
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.evidence.duplicateWrites, 1);
});

test('download judge requires the actual matching file, not a download request or a claimed path', async t => {
  const service = await startTaskService();
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-judge-artifact-'));
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const attempt = await service.createAttempt('download', 11);
  const response = await fetch(attempt.url + 'report.csv');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal((await attempt.judge()).passed, false);
  const file = join(directory, 'actual.csv');
  await writeFile(file, bytes);
  assert.equal((await attempt.judge({ artifactPaths: [file] })).passed, true);
  await writeFile(file, 'Wrong file');
  assert.equal((await attempt.judge({ artifactPaths: [file] })).passed, false);
});

test('authorization-return judge requires one provider approval and one app submission', async t => {
  const service = await startTaskService();
  t.after(() => service.close());
  const attempt = await service.createAttempt('auth-return', 17);
  const fake = () => fetch(attempt.url + 'save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'claimed-without-popup' }) });
  await fake();
  assert.equal((await attempt.judge()).passed, false);
  attempt.reset();
  const authorized = await fetch(attempt.authUrl.replace(/\/auth$/, '/authorize'), { method: 'POST' });
  const { token } = await authorized.json();
  assert.equal((await attempt.judge()).passed, false, 'Provider approval alone is not app completion');
  await fetch(attempt.url + 'save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal((await attempt.judge()).passed, true);
  await fake();
  const duplicate = await attempt.judge();
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.evidence.authorizations, 1);
  assert.equal(duplicate.evidence.duplicateWrites, 1);
});

test('model gateway enforces equal wire settings and measures returned usage without a paid provider', async t => {
  const requests = [];
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const gateway = await startModelGateway({ endpoint: `http://127.0.0.1:${provider.address().port}/chat/completions`, model: 'fixture-model', temperature: 0, maxOutputTokens: 128 });
  t.after(async () => { await gateway.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  for (const model of ['different-a', 'different-b']) await fetch(gateway.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [], temperature: 1, frequency_penalty: 0.3, max_tokens: 999 }) });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].model, 'fixture-model');
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[0].max_completion_tokens, 128);
  assert.equal('frequency_penalty' in requests[0], false);
  assert.equal(gateway.metrics.calls, 2);
  assert.equal(gateway.metrics.inputTokens, 20);
  assert.equal(gateway.metrics.outputTokens, 4);
  assert.equal(gateway.metrics.cachedTokens, 6);
});

test('missing model/dependencies stay not_run and never become a competitor failure or a win', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-comparison-not-run-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { engine: 'matched', tasks: ['form'], repeat: 1, python: '/nonexistent/tablaze-test-python', output: directory };
  assert.equal((await preflight(config)).status, 'not_run');
  const { report } = await runComparison(config);
  assert.equal(report.attempts.length, 2);
  assert.ok(report.attempts.every(attempt => attempt.outcome === 'not_run'));
  assert.ok(report.attempts.every(attempt => attempt.inputTokens === null));
  assert.equal(report.superiorityProven, false);
  assert.equal(report.comparableForSuperiority, false);
  assert.equal(report.summary['browser-use'].failed, 0);
  assert.throws(() => parseArgs(['--engine', 'unknown']));
  assert.throws(() => parseArgs(['--tasks', 'form,form']));
});

test('scripted Tablaze smoke completes diverse real-browser tasks with independent judges', { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-comparison-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(TASKS.length >= 12);
  const { report, outputDirectory } = await runComparison({ engine: 'tablaze-scripted', repeat: 1, seed: 3, timeoutMs: 15000, output: directory });
  assert.equal(report.preflight.status, 'ready', JSON.stringify(report.preflight));
  assert.equal(report.attempts.length, TASKS.length);
  assert.deepEqual(report.attempts.filter(attempt => attempt.outcome !== 'passed').map(attempt => ({ task: attempt.taskId, failure: attempt.failureClass, judge: attempt.judge })), []);
  assert.ok(report.attempts.every(attempt => attempt.executionMode === 'scripted' && attempt.modelCalls === 0));
  assert.ok(report.attempts.every(attempt => attempt.judge.passed && attempt.toolCalls > 0));
  assert.equal(report.superiorityProven, false);
  assert.equal(report.comparableForSuperiority, false);
  const disk = JSON.parse(await readFile(join(outputDirectory, 'results.json'), 'utf8'));
  assert.equal(disk.summary['tablaze-scripted'].passed, TASKS.length);
});
