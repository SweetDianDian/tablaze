import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createToolRegistry, runAgent } from '../dist/index.js';

test('CLI rejects a bound checkpoint before launching a browser or restoring its URLs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-bound-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'browser-launched');
  const executable = join(directory, 'fixture-browser');
  await writeFile(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.TABLAZE_TEST_MARKER,"launched");process.exit(7);\n', { mode: 0o700 });
  const tools = createToolRegistry({ base: { listTools: async () => [], callTool: async () => { throw new Error('No base tool should run'); } }, tools: [], getContext: () => ({ id: 'bound-fixture-account', value: {} }) });
  const result = await runAgent({ task: 'A bound SDK task.', tools, planner: async () => ({ type: 'fail', reason: 'Save a fixture checkpoint.' }) });
  const checkpoint = join(directory, 'checkpoint.json');
  await writeFile(checkpoint, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), agent: result.checkpoint, browser: { version: 1, sessions: [{ sessionId: 'fixture-session', activeTabId: 't1', storage: { cookies: [], origins: [] }, tabs: [{ tabId: 't1', url: 'http://127.0.0.1:1/should-not-open' }] }] } }), { mode: 0o600 });
  const observed = await new Promise((resolve, reject) => {
    const env = { ...process.env, TABLAZE_TEST_MARKER: marker };
    delete env.TABLAZE_BROWSER_CHANNEL;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'run', '--resume', checkpoint, '--executable-path', executable, '--model', 'fixture-model', '--endpoint', 'http://127.0.0.1:1/no-model'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI did not reject promptly')); }, 5000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(observed.code, 1);
  assert.match(observed.stderr, /bound tool registry/);
  assert.equal(observed.stdout, '');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
