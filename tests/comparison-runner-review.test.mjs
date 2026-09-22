import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { runComparison } from '../bench/comparison/runner.mjs';

test('comparison runner stops the owned adapter process group after output overflow', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tablaze-runner-review-'));
  const script = join(directory, 'fake-python');
  const pidFile = join(directory, 'descendant.json');
  t.after(async () => {
    try { const { pid } = JSON.parse(await readFile(pidFile, 'utf8')); process.kill(pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(script, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
if (process.argv.includes('--preflight')) {
  console.log(JSON.stringify({ status: 'ready', version: 'fake-for-process-lifecycle-test' }));
} else {
  for await (const chunk of process.stdin) {}
  spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000)', ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { await readFile(${JSON.stringify(pidFile)}); ready = true; break; } catch { await delay(5); }
  }
  if (!ready) throw new Error('Fake child did not start');
  process.stdout.write('x'.repeat(17 * 1024 * 1024));
  setInterval(() => {}, 1000);
}
`, { mode: 0o700 });
  const { report } = await runComparison({
    engine: 'browser-use', transport: 'http', tasks: ['form'], repeat: 1,
    python: script, executablePath: process.execPath, model: 'fake-no-model-calls',
    endpoint: 'http://127.0.0.1:1/never-called', allowAnonymous: true,
    timeoutMs: 10000, output: join(directory, 'report'),
  });
  assert.equal(report.preflight.status, 'ready');
  assert.equal(report.attempts[0].outcome, 'failed');
  assert.equal(report.attempts[0].modelCalls, 0, 'The fake adapter never requests model inference');
  const { pid } = JSON.parse(await readFile(pidFile, 'utf8'));
  await delay(100);
  let alive = true;
  try { process.kill(pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; else throw cause; }
  assert.equal(alive, false, 'Adapter failure must not leave its browser-like child alive');
});
