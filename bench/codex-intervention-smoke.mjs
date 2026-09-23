// Opt-in real Codex inference for SDK pause/steer; independent local judge, no competitor arm.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer, connectAgentTools, createCodexPlanner, createAgentControl, runAgent } from '../dist/index.js';
import { startTaskService } from './comparison/fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'codex-command': { type: 'string' }, output: { type: 'string' }, channel: { type: 'string' } }, strict: true });
if (!values.model || !values['codex-command'] || !values.output) throw new Error('Supply --model, --codex-command and a new --output path to opt into live inference.');
const output = resolve(values.output), channel = values.channel ?? 'chrome';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, '{}\n', { flag: 'wx', mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceHash() {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'bench/codex-intervention-smoke.mjs', 'bench/comparison/fixture.mjs'];
  for (const directory of ['src', 'dist']) for (const name of await readdir(join(root, directory))) if (/\.(?:ts|js)$/.test(name)) paths.push(`${directory}/${name}`);
  return hash(JSON.stringify(await Promise.all(paths.sort().map(async path => [path, hash(await readFile(join(root, path)))]))));
}
const report = { kind: 'codex-sdk-intervention-live-smoke', schema_version: 1, started_at: new Date().toISOString(), comparison: false,
  base_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  model: values.model, reasoning_effort: values['reasoning-effort'] ?? null,
  codex_version: execFileSync(values['codex-command'], ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
  source_sha256: await sourceHash(), policy: { seed: 23, task_timeout_ms: 180000, max_steps: 20, max_tool_calls: 30, automatic_retries: false, browser_channel: channel } };
const service = await startTaskService();
const attempt = await service.createAttempt('form', 23);
const runtime = createServer({ headless: true, channel, timeoutMs: 5000 });
let connection, planner;
try {
  connection = await connectAgentTools(runtime.server);
  const usage = [];
  planner = createCodexPlanner({ model: values.model, codexCommand: values['codex-command'], reasoningEffort: values['reasoning-effort'], onUsage: value => usage.push(value) });
  const control = createAgentControl();
  let pausePromise, signalIntervention;
  const intervention = new Promise(resolve => { signalIntervention = resolve; });
  const started = performance.now();
  const running = runAgent({ task: attempt.prompt, startUrl: attempt.url, planner, tools: connection.tools, control, maxSteps: 20, maxToolCalls: 30, timeoutMs: 180000,
    onEvent: event => {
      if (event.type === 'tool_result' && event.call.name === 'tab_verify' && event.result.structuredContent?.passed === true && !pausePromise) {
        pausePromise = control.pause(); signalIntervention('requested');
      }
    },
  });
  const trigger = await Promise.race([intervention, running.then(() => 'ended')]);
  let reachedBoundary = false;
  if (trigger === 'requested') {
    reachedBoundary = await pausePromise;
    if (reachedBoundary) {
      control.steer('A human checked the page after the first verification. Re-observe and verify the saved contact once more; do not submit the form again.');
      control.resume();
    }
  }
  const agent = await running;
  const judge = await attempt.judge();
  report.attempt = { task_id: 'form', task_sha256: attempt.taskHash, whole_run_ms: performance.now() - started,
    intervention_trigger: trigger, pause_reached_boundary: reachedBoundary,
    status: agent.status, reason: agent.reason, steps: agent.steps, tool_calls: agent.toolCalls, planner_calls: agent.plannerCalls,
    feedback_codes: agent.events.filter(item => item.type === 'feedback').map(item => item.code),
    verification: agent.evidence.map(item => ({ tool_call_id: item.toolCallId, session_id: item.sessionId, checks: item.checks })),
    reported_usage: usage, independent_judge: judge,
    complete_success: reachedBoundary && agent.status === 'succeeded' && judge.passed && judge.evidence.duplicateWrites === 0 };
  console.log(JSON.stringify({ status: agent.status, paused: reachedBoundary, accepted: judge.passed, writes: judge.evidence.writeCount, whole_run_ms: report.attempt.whole_run_ms }));
} finally {
  await Promise.allSettled([planner?.close(), connection?.close(), runtime.dispose(), service.close()]);
  report.finished_at = new Date().toISOString();
  report.source_unchanged = await sourceHash() === report.source_sha256;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (!report.source_unchanged || !report.attempt?.complete_success) process.exitCode = 1;
