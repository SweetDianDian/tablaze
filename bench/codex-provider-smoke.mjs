// Explicit opt-in live inference through the public CLI. Never part of npm test.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startTaskService } from './comparison/fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'codex-command': { type: 'string' }, output: { type: 'string' }, channel: { type: 'string' } }, strict: true });
if (!values.model || !values['codex-command'] || !values.output) throw new Error('Supply --model, --codex-command and a new --output path to opt into live Codex inference.');
const output = resolve(values.output), channel = values.channel ?? 'chrome';
await mkdir(dirname(output), { recursive: true });
// Reserve immutable attempt output before any model or browser is started.
await writeFile(output, '{}\n', { flag: 'wx', mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sources() {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'bench/codex-provider-smoke.mjs', 'bench/comparison/fixture.mjs'];
  for (const directory of ['src', 'dist']) for (const name of await readdir(join(root, directory))) if (/\.(?:ts|js)$/.test(name)) paths.push(`${directory}/${name}`);
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, hash(await readFile(join(root, path)))])));
}
const report = {
  schema_version: 1, kind: 'production-codex-provider-live-smoke', started_at: new Date().toISOString(),
  comparison: false, purpose: 'Verify the public production CLI with genuine Codex inference and independent server-side outcomes. Two visible development tasks, one attempt each; not a Browser Use ranking.',
  base_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  model: values.model, reasoning_effort: values['reasoning-effort'] ?? null,
  codex_version: execFileSync(values['codex-command'], ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
  doctor: JSON.parse(execFileSync(process.execPath, ['dist/cli.js', 'doctor', '--channel', channel], { cwd: root, encoding: 'utf8', timeout: 10000 })),
  source_sha256: await sources(), attempts: [],
  policies: { start_url: 'executor initialization', task_timeout_ms: 180000, max_steps: 12, max_tool_calls: 30, automatic_retries: false, popup_policy: 'follow-single', usage: 'Only actual CLI-reported counters; missing values stay unknown. CLI prompt overhead is included. No API pricing estimate.' },
};
delete report.doctor.browser.executable;
const service = await startTaskService();
try {
  for (const taskId of ['form', 'duplicate-write']) {
    const attempt = await service.createAttempt(taskId, 23), started = performance.now();
    const args = ['dist/cli.js', 'run', '--provider', 'codex', '--codex-command', values['codex-command'], '--model', values.model,
      ...(values['reasoning-effort'] ? ['--reasoning-effort', values['reasoning-effort']] : []),
      '--task', attempt.prompt, '--start-url', attempt.url, '--channel', channel, '--popup-policy', 'follow-single', '--timeout-ms', '5000', '--run-timeout-ms', '180000', '--max-steps', '12', '--max-calls', '30'];
    console.log(`Starting production CLI task: ${taskId}`);
    const execution = await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let stdout = '', bytes = 0, stderrBytes = 0, bounded = true, deadlineExceeded = false, killTimer;
      const terminate = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 7000); };
      const timer = setTimeout(() => { deadlineExceeded = true; terminate(); }, 190000);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { bounded = false; terminate(); } else stdout += chunk; });
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 4 * 1024 * 1024) { bounded = false; terminate(); } });
      child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer); clearTimeout(killTimer);
        let cli = null;
        if (bounded) try { cli = JSON.parse(stdout); } catch {}
        resolveRun({ exit_code: exitCode, signal, whole_run_ms: performance.now() - started, deadline_exceeded: deadlineExceeded, output_within_limit: bounded, stdout_bytes: bytes, stderr_bytes: stderrBytes, cli });
      });
    });
    const outcome = await attempt.judge();
    report.attempts.push({ task_id: taskId, seed: 23, canonical_prompt: attempt.canonicalPrompt, task_sha256: attempt.taskHash, ...execution, independent_judge: outcome,
      complete_success: execution.exit_code === 0 && execution.cli?.status === 'succeeded' && outcome.passed });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ task_id: taskId, status: execution.cli?.status ?? 'no_report', accepted: outcome.passed, whole_run_ms: execution.whole_run_ms }));
  }
} finally {
  await service.close(); report.finished_at = new Date().toISOString();
  report.source_unchanged = JSON.stringify(await sources()) === JSON.stringify(report.source_sha256);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (!report.source_unchanged || !report.attempts.every(attempt => attempt.complete_success)) process.exitCode = 1;
