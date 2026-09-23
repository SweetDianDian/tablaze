import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadSecretConfig } from '../dist/secret-config.js';
import { compileSecretStore } from '../dist/secret-store.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const PRIVATE = { context: 'private-context-canary', alias: 'private_alias_canary', version: 'private-version-canary', origin: 'https://private-origin-canary.example', env: 'PRIVATE_ENV_CANARY', value: 'private-credential-value-canary' };
function environment() {
  const env = { ...process.env, TABLAZE_API_KEY: '', [PRIVATE.env]: PRIVATE.value };
  delete env.TABLAZE_BROWSER_CHANNEL; delete env.TABLAZE_EXECUTABLE_PATH;
  return env;
}
function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Secret configuration CLI did not settle')); }, 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-secret-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'private-secret-config.json'), marker = join(directory, 'browser-started'), executable = join(directory, 'fake-browser');
  await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(7);\n`, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ contextId: PRIVATE.context, secrets: [{ name: PRIVATE.alias, version: PRIVATE.version, allowedOrigins: [PRIVATE.origin], env: PRIVATE.env }] }));
  return { directory, config, marker, executable };
}
function noPrivate(output, f) {
  for (const value of [...Object.values(PRIVATE), f.config]) assert.equal(output.includes(value), false, `Must not publish private configuration: ${value}`);
}
async function noBrowser(f) { await assert.rejects(readFile(f.marker), { code: 'ENOENT' }); }

test('doctor reports only secret metadata and never launches the configured browser', async t => {
  const f = await fixture(t);
  const result = await launch(['doctor', '--executable-path', f.executable, '--secret-config', f.config]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).secrets, { enabled: true, alias_count: 1, allow_sensitive_artifacts: false });
  noPrivate(result.stdout + result.stderr, f);
  const disabled = await launch(['doctor', '--executable-path', f.executable]);
  assert.deepEqual(JSON.parse(disabled.stdout).secrets, { enabled: false, alias_count: 0, allow_sensitive_artifacts: false });
  await noBrowser(f);
});

test('malformed secret configuration fails before doctor or run with one fixed message', async t => {
  const f = await fixture(t);
  for (const contents of [`{"${PRIVATE.value}":`, JSON.stringify({ contextId: PRIVATE.value, unknown: PRIVATE.env }), Buffer.from([0x7b, 0xff, 0x7d])]) {
    await writeFile(f.config, contents);
    for (const command of ['doctor', 'run']) {
      const result = await launch([command, '--executable-path', f.executable, '--secret-config', f.config]);
      assert.equal(result.code, 1); assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Tablaze: Invalid secret configuration.\n');
      noPrivate(result.stderr, f);
    }
  }
  await noBrowser(f);
});

test('CDP and setup reject secrets before reading the configuration path', async t => {
  const f = await fixture(t); await rm(f.config);
  for (const command of [[], ['doctor'], ['run', '--task', 'Do not launch.', '--provider', 'codex', '--model', 'fixture']]) {
    const result = await launch([...command, '--cdp-url', 'http://127.0.0.1:1', '--secret-config', f.config]);
    assert.equal(result.code, 1); assert.match(result.stderr, /--secret-config cannot be combined with --cdp-url/);
    noPrivate(result.stderr, f);
  }
  const result = await launch(['setup', '--secret-config', f.config]);
  assert.equal(result.code, 1); assert.match(result.stderr, /not setup/);
  noPrivate(result.stderr, f); await noBrowser(f);
});

test('stdio accepts configured aliases and exposes the public action without resolving or launching', { timeout: 15_000 }, async t => {
  const f = await fixture(t), env = environment(); delete env[PRIVATE.env];
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--secret-config', f.config, '--executable-path', f.executable], cwd: root, env, stderr: 'pipe' });
  const client = new Client({ name: 'secret-config-cli-test', version: '1' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(() => client.close()); await client.connect(transport);
  const catalog = await client.listTools();
  assert.ok(JSON.stringify(catalog.tools.find(tool => tool.name === 'tab_act').inputSchema).includes('fill_secret'));
  const listed = await client.callTool({ name: 'tab_list', arguments: {} });
  assert.equal(listed.isError, undefined); assert.deepEqual(listed.structuredContent.sessions, []);
  noPrivate(JSON.stringify(catalog) + JSON.stringify(listed), f);
  await client.close(); assert.equal(stderr, ''); await noBrowser(f);
});

test('CLI run saves secret policy identity and requires the same configuration on resume', { timeout: 20_000 }, async t => {
  const f = await fixture(t), requests = [];
  const provider = createHttpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'agent_request_input', arguments: JSON.stringify({ question: 'Pause this test before opening any browser.' }) } }] } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const checkpoint = join(f.directory, 'checkpoint.json');
  const common = ['--model', 'scripted-secret-fixture', '--endpoint', `http://127.0.0.1:${provider.address().port}/model`, '--executable-path', f.executable];
  const initial = await launch(['run', '--task', 'Pause before opening a browser.', ...common, '--secret-config', f.config, '--checkpoint', checkpoint]);
  assert.equal(initial.code, 2, initial.stderr);
  const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
  const store = compileSecretStore(loadSecretConfig(f.config, {})); t.after(() => store.close());
  assert.equal(saved.browser.secretPolicyHash, store.hash);
  assert.deepEqual(saved.browser.sessions, []);
  noPrivate(JSON.stringify(saved) + JSON.stringify(requests), f);
  const resumed = await launch(['run', '--resume', checkpoint, ...common, '--secret-config', f.config]);
  assert.equal(resumed.code, 2, resumed.stderr); assert.equal(requests.length, 2);
  const changed = JSON.parse(await readFile(f.config, 'utf8')); changed.secrets[0].version = 'v2';
  await writeFile(f.config, JSON.stringify(changed));
  for (const extra of [['--secret-config', f.config], []]) {
    const rejected = await launch(['run', '--resume', checkpoint, ...common, ...extra]);
    assert.equal(rejected.code, 1); assert.match(rejected.stderr, /same secret context, versions and policy/);
    noPrivate(rejected.stderr, f);
  }
  assert.equal(requests.length, 2, 'An incompatible restore must fail before calling the planner');
  await noBrowser(f);
});
