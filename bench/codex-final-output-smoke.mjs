// Explicit opt-in real-model smoke for schema-bound final output; not a competitor comparison.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startTaskService } from './comparison/fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'codex-command': { type: 'string' }, output: { type: 'string' }, channel: { type: 'string' } }, strict: true });
if (!values.model || !values['codex-command'] || !values.output) throw new Error('Supply --model, --codex-command and a new --output path to opt into live Codex inference.');
const output = resolve(values.output), channel = values.channel ?? 'chrome';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '{}\n', { flag: 'wx', mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const schema = { type: 'object', properties: { total: { type: 'number', minimum: 0 } }, required: ['total'], additionalProperties: false };
const schemaDirectory = await mkdtemp(join(tmpdir(), 'tablaze-final-output-smoke-'));
const schemaPath = join(schemaDirectory, 'schema.json');
await writeFile(schemaPath, JSON.stringify(schema) + '\n', { mode: 0o600 });
async function sourceHash() {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'bench/codex-final-output-smoke.mjs', 'bench/comparison/fixture.mjs'];
  for (const directory of ['src', 'dist']) for (const name of await readdir(join(root, directory))) if (/\.(?:ts|js)$/.test(name)) paths.push(`${directory}/${name}`);
  return hash(JSON.stringify(await Promise.all(paths.sort().map(async path => [path, hash(await readFile(join(root, path)))]))));
}
const report = {
  kind: 'production-codex-final-output-live-smoke', schema_version: 1,
  started_at: new Date().toISOString(), comparison: false,
  purpose: 'One real Codex task with schema-bound final data and independent server-side acceptance.',
  base_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  model: values.model, reasoning_effort: values['reasoning-effort'] ?? null,
  codex_version: execFileSync(values['codex-command'], ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
  final_schema: schema, source_sha256: await sourceHash(),
  policy: { seed: 23, task_timeout_ms: 180000, max_steps: 12, max_tool_calls: 30, automatic_retries: false, browser_channel: channel },
};
const service = await startTaskService();
try {
  const attempt = await service.createAttempt('extraction', 23);
  const started = performance.now();
  const args = ['dist/cli.js', 'run', '--provider', 'codex', '--codex-command', values['codex-command'], '--model', values.model,
    ...(values['reasoning-effort'] ? ['--reasoning-effort', values['reasoning-effort']] : []),
    '--task', `${attempt.prompt}\nReturn the submitted total as JSON final data with the field total.`,
    '--start-url', attempt.url, '--output-schema', schemaPath, '--channel', channel,
    '--timeout-ms', '5000', '--run-timeout-ms', '180000', '--max-steps', '12', '--max-calls', '30'];
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
  const judge = await attempt.judge();
  const finalMatchesServer = judge.passed && execution.cli?.data?.total === judge.evidence.records[0]?.total;
  report.attempt = { task_id: 'extraction', task_sha256: attempt.taskHash, prompt_sha256: hash(args[args.indexOf('--task') + 1]), ...execution, independent_judge: judge, final_matches_server: finalMatchesServer,
    complete_success: execution.exit_code === 0 && execution.cli?.status === 'succeeded' && finalMatchesServer };
  console.log(JSON.stringify({ status: execution.cli?.status ?? 'no_report', accepted: judge.passed, final_matches_server: finalMatchesServer, whole_run_ms: execution.whole_run_ms }));
} finally {
  await service.close();
  await rm(schemaDirectory, { recursive: true, force: true });
  report.finished_at = new Date().toISOString();
  report.source_unchanged = await sourceHash() === report.source_sha256;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (!report.source_unchanged || !report.attempt?.complete_success) process.exitCode = 1;
