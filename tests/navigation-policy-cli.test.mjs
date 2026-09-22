import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compileNavigationPolicy } from '../dist/navigation-policy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
function environment() {
  const env = { ...process.env, TABLAZE_API_KEY: '' };
  delete env.TABLAZE_BROWSER_CHANNEL; delete env.TABLAZE_EXECUTABLE_PATH;
  return env;
}
function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Navigation policy CLI did not settle')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function files(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-policy-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policy = join(directory, 'navigation.json');
  const marker = join(directory, 'browser-started');
  const executable = join(directory, 'fake-browser');
  await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(7);\n`, { mode: 0o700 });
  return { directory, policy, marker, executable, write: value => writeFile(policy, JSON.stringify(value)) };
}
async function noBrowser(fixture) { await assert.rejects(readFile(fixture.marker), { code: 'ENOENT' }); }
const doctorArgs = fixture => ['doctor', '--executable-path', fixture.executable, '--navigation-policy', fixture.policy];

test('doctor validates and summarizes canonical policy without launching or printing origins', async t => {
  const fixture = await files(t);
  await fixture.write({ allowedOrigins: ['HTTPS://PRIVATE-POLICY.EXAMPLE:443/', 'https://private-policy.example'], blockedOrigins: ['https://blocked-private.example'] });
  const result = await launch(doctorArgs(fixture)); assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.navigation_policy, { enabled: true, allowed_origin_count: 1, blocked_origin_count: 1 });
  for (const privateValue of ['PRIVATE-POLICY', 'private-policy.example', 'blocked-private.example', fixture.policy]) assert.equal((result.stdout + result.stderr).includes(privateValue), false);
  await fixture.write({ allowedOrigins: [] });
  assert.deepEqual(JSON.parse((await launch(doctorArgs(fixture))).stdout).navigation_policy, { enabled: true, allowed_origin_count: 0, blocked_origin_count: 0 });
  await fixture.write({});
  assert.deepEqual(JSON.parse((await launch(doctorArgs(fixture))).stdout).navigation_policy, { enabled: true, allowed_origin_count: null, blocked_origin_count: 0 });
  const disabled = await launch(['doctor', '--executable-path', fixture.executable]);
  assert.deepEqual(JSON.parse(disabled.stdout).navigation_policy, { enabled: false, allowed_origin_count: null, blocked_origin_count: 0 });
  await noBrowser(fixture);
});

test('policy file parsing rejects unsafe shapes, origin syntax, unknown fields and raw error disclosure', { timeout: 30_000 }, async t => {
  const fixture = await files(t);
  const invalid = [null, [], 'PRIVATE_POLICY_CONTENT', { unknown: 'PRIVATE_POLICY_CONTENT' }, { allowedOrigins: null }, { allowedOrigins: 'PRIVATE_POLICY_CONTENT' }, { blockedOrigins: ['https://*.private.example'] }, { allowedOrigins: ['https://private.example/path'] }, { allowedOrigins: ['https://private.example?'] }, { allowedOrigins: ['https://private.example#'] }, { blockedOrigins: ['https://PRIVATE_POLICY_CONTENT@private.example'] }, { allowedOrigins: ['file:///PRIVATE_POLICY_CONTENT'] }, { allowedOrigins: Array(201).fill('https://private.example') }];
  for (const value of invalid) {
    await fixture.write(value); const result = await launch(doctorArgs(fixture));
    assert.equal(result.code, 1); assert.match(result.stderr, /--navigation-policy must reference/); assert.equal(result.stdout, '');
    for (const secret of ['PRIVATE_POLICY_CONTENT', 'private.example', fixture.policy]) assert.equal(result.stderr.includes(secret), false);
  }
  for (const bytes of [Buffer.from('{"PRIVATE_POLICY_CONTENT":'), Buffer.from([0x7b, 0xff, 0x7d])]) {
    await writeFile(fixture.policy, bytes); const result = await launch(doctorArgs(fixture)); assert.equal(result.code, 1); assert.equal(result.stderr.includes('PRIVATE_POLICY_CONTENT'), false);
  }
  await noBrowser(fixture);
});

test('policy reader enforces a 64 KiB file bound and refuses directories and missing files', async t => {
  const fixture = await files(t);
  await writeFile(fixture.policy, '{}' + ' '.repeat(65534));
  assert.equal((await launch(doctorArgs(fixture))).code, 0, 'Exactly 64 KiB remains valid');
  await writeFile(fixture.policy, '{}' + ' '.repeat(65535));
  const tooLarge = await launch(doctorArgs(fixture)); assert.equal(tooLarge.code, 1); assert.match(tooLarge.stderr, /64 KiB/);
  for (const file of [fixture.directory, join(fixture.directory, 'missing')]) {
    const result = await launch(['doctor', '--navigation-policy', file]); assert.equal(result.code, 1); assert.match(result.stderr, /regular UTF-8 JSON file/); assert.equal(result.stderr.includes(file), false);
  }
  await noBrowser(fixture);
});

test('policy reader refuses a FIFO without waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const fixture = await files(t); execFileSync('mkfifo', [fixture.policy]);
  const result = await launch(doctorArgs(fixture)); assert.equal(result.code, 1); assert.match(result.stderr, /regular UTF-8 JSON file/); await noBrowser(fixture);
});

test('policy and external CDP or setup are rejected before reading the policy path', async t => {
  const fixture = await files(t);
  for (const args of [['doctor', '--cdp-url', 'http://127.0.0.1:1'], ['--cdp-url', 'http://127.0.0.1:1'], ['run', '--task', 'Do not open anything.', '--provider', 'codex', '--model', 'fixture', '--cdp-url', 'http://127.0.0.1:1']]) {
    const result = await launch([...args, '--navigation-policy', fixture.policy]); assert.equal(result.code, 1); assert.match(result.stderr, /cannot be combined with --cdp-url/); assert.equal(result.stderr.includes('must reference'), false);
  }
  const setup = await launch(['setup', '--navigation-policy', fixture.policy]); assert.equal(setup.code, 1); assert.match(setup.stderr, /not setup/);
  await noBrowser(fixture);
});

test('malformed private checkpoints do not disclose JSON excerpts before policy restoration', async t => {
  const fixture = await files(t); await fixture.write({ allowedOrigins: ['https://example.test'] });
  const checkpoint = join(fixture.directory, 'private-checkpoint.json');
  for (const encoded of ['S3CRET42', '{"cookies":S3CRET42}', '{"authorization":"Bearer S3CRET42",']) {
    await writeFile(checkpoint, encoded);
    const result = await launch(['run', '--resume', checkpoint, '--provider', 'codex', '--model', 'fixture', '--codex-command', fixture.executable, '--executable-path', fixture.executable, '--navigation-policy', fixture.policy]);
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Tablaze: Run checkpoint must contain valid JSON.\n');
    for (const sensitive of ['S3CRET42', 'cookies', 'authorization', 'Bearer']) assert.equal(result.stderr.includes(sensitive), false);
  }
  await noBrowser(fixture);
});

test('MCP startup accepts a valid policy and exposes tools without launching a browser', { timeout: 15_000 }, async t => {
  const fixture = await files(t); await fixture.write({ allowedOrigins: ['https://example.test'] });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--navigation-policy', fixture.policy, '--executable-path', fixture.executable], cwd: root, env: environment(), stderr: 'pipe' });
  const client = new Client({ name: 'navigation-policy-cli-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'tab_open'));
  const listed = await client.callTool({ name: 'tab_list', arguments: {} });
  assert.equal(listed.isError, undefined);
  await client.close(); await noBrowser(fixture);
});

test('empty CLI checkpoints retain policy identity and reject changed, removed or legacy policy on resume', { timeout: 20_000 }, async t => {
  const fixture = await files(t), requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Pause this fixture.' }) } }] } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const endpoint = `http://127.0.0.1:${server.address().port}/model`, checkpoint = join(fixture.directory, 'checkpoint.json');
  const policy = { allowedOrigins: ['https://example.test', 'https://other.test'], blockedOrigins: [] };
  await fixture.write(policy);
  const shared = ['--model', 'scripted-policy-fixture', '--endpoint', endpoint, '--executable-path', fixture.executable];
  const first = await launch(['run', '--task', 'Pause without opening a browser.', ...shared, '--navigation-policy', fixture.policy, '--checkpoint', checkpoint]);
  assert.equal(first.code, 2, first.stderr);
  const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
  assert.equal(saved.browser.navigationPolicyHash, compileNavigationPolicy(policy).hash); assert.deepEqual(saved.browser.sessions, []);
  if (process.platform !== 'win32') assert.equal((await stat(checkpoint)).mode & 0o777, 0o600);
  await fixture.write({ allowedOrigins: ['https://other.test/', 'https://example.test:443', 'https://example.test'] });
  const same = await launch(['run', '--resume', checkpoint, ...shared, '--navigation-policy', fixture.policy]);
  assert.equal(same.code, 2, same.stderr); assert.equal(JSON.parse(same.stdout).steps, 2); assert.equal(requests.length, 2);
  await fixture.write({ allowedOrigins: ['https://different.test'] });
  for (const args of [['--navigation-policy', fixture.policy], []]) {
    const result = await launch(['run', '--resume', checkpoint, ...shared, ...args]);
    assert.equal(result.code, 1); assert.match(result.stderr, /same navigation policy/); assert.equal(requests.length, 2);
  }
  const legacy = join(fixture.directory, 'legacy.json'); delete saved.browser.navigationPolicyHash;
  await writeFile(legacy, JSON.stringify(saved));
  const changedLegacy = await launch(['run', '--resume', legacy, ...shared, '--navigation-policy', fixture.policy]);
  assert.equal(changedLegacy.code, 1); assert.match(changedLegacy.stderr, /same navigation policy/); assert.equal(requests.length, 2);
  const unchangedLegacy = await launch(['run', '--resume', legacy, ...shared]);
  assert.equal(unchangedLegacy.code, 2, unchangedLegacy.stderr); assert.equal(requests.length, 3);
  await noBrowser(fixture);
});
