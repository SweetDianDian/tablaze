import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { TASKS, hash, startTaskService } from './fixture.mjs';
import { startModelGateway } from './model-gateway.mjs';
import { runTablaze } from './tablaze-adapter.mjs';
import { CODEX_CLI_VERSION, CODEX_DISABLED_FEATURES, CODEX_TRANSPORT_LIMITS } from './codex-transport.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const baseline = JSON.parse(await readFile(join(here, 'baseline.json'), 'utf8'));
const publicEndpoint = value => {
  try { const endpoint = new URL(value); endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = ''; return endpoint.href; }
  catch { return null; }
};

async function command(program, args, { input, timeoutMs = 15000, cwd = root, env } = {}) {
  return new Promise(resolveResult => {
    let child, stdout = '', stderr = '', timeout = false, killTimer, failure, settled = false;
    const kill = signal => {
      if (!child?.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
    };
    const stop = reason => {
      failure ??= reason;
      if (reason === 'TIMEOUT') timeout = true;
      kill('SIGTERM');
      killTimer ??= setTimeout(() => kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const finish = value => {
      if (settled) return;
      settled = true;
      if (failure || value.error || value.code !== 0) kill('SIGKILL');
      clearTimeout(timer); clearTimeout(killTimer);
      resolveResult({ ...value, ...(failure ? { error: failure } : {}), stdout, stderr, timeout });
    };
    try { child = spawn(program, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); }
    catch (error) { finish({ code: null, error: error.code }); return; }
    child.on('error', error => finish({ code: null, error: error.code }));
    child.stdout.on('data', data => { if (stdout.length + data.length > 16 * 1024 * 1024) stop('OUTPUT_LIMIT'); else stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 2 * 1024 * 1024) stderr += data; });
    child.on('close', code => finish({ code }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
}

export function parseArgs(args) {
  const config = { engine: 'tablaze-scripted', transport: 'http', browserUseJudge: true, tablazeInitializeUrl: false, tablazeDirectOpenTaskUrl: false, tablazePopupPolicy: 'stay', repeat: 1, seed: 1, maxSteps: 40, maxToolCalls: 150, timeoutMs: 120000, maxOutputTokens: 4096, tokenBudget: 50000, temperature: 0 };
  const keys = { '--engine': 'engine', '--transport': 'transport', '--codex-command': 'codexCommand', '--tasks': 'tasks', '--repeat': 'repeat', '--seed': 'seed', '--model': 'model', '--endpoint': 'endpoint', '--python': 'python', '--executable-path': 'executablePath', '--output': 'output', '--max-steps': 'maxSteps', '--max-tool-calls': 'maxToolCalls', '--timeout-ms': 'timeoutMs', '--max-output-tokens': 'maxOutputTokens', '--token-budget': 'tokenBudget', '--temperature': 'temperature', '--reasoning-effort': 'reasoningEffort' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--preflight') { config.preflightOnly = true; continue; }
    if (flag === '--allow-anonymous') { config.allowAnonymous = true; continue; }
    if (flag === '--help') { config.help = true; continue; }
    if (flag === '--browser-use-judge' || flag === '--tablaze-initialize-url' || flag === '--tablaze-direct-open-task-url') {
      const value = args[++index];
      if (!['true', 'false'].includes(value)) throw new Error(`${flag} requires true or false`);
      config[flag === '--browser-use-judge' ? 'browserUseJudge' : flag === '--tablaze-initialize-url' ? 'tablazeInitializeUrl' : 'tablazeDirectOpenTaskUrl'] = value === 'true'; continue;
    }
    if (flag === '--tablaze-popup-policy') {
      const value = args[++index];
      if (!['stay', 'follow-single'].includes(value)) throw new Error('--tablaze-popup-policy requires stay or follow-single');
      config.tablazePopupPolicy = value; continue;
    }
    const key = keys[flag];
    if (!key || args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${flag}`);
    config[key] = args[++index];
  }
  if (!['tablaze-scripted', 'tablaze', 'browser-use', 'matched'].includes(config.engine)) throw new Error('Unknown engine');
  if (config.tablazeInitializeUrl && config.tablazeDirectOpenTaskUrl) throw new Error('Choose only one Tablaze URL initialization mode');
  if (!['http', 'codex'].includes(config.transport)) throw new Error('Unknown model transport');
  for (const key of ['repeat', 'seed', 'maxSteps', 'maxToolCalls', 'timeoutMs', 'maxOutputTokens', 'tokenBudget']) {
    config[key] = Number(config[key]);
    if (!Number.isInteger(config[key]) || config[key] < (key === 'seed' ? 0 : 1) || config[key] > 1000000) throw new Error(`Invalid ${key}`);
  }
  config.temperature = Number(config.temperature);
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) throw new Error('Invalid temperature');
  if (config.tasks) config.tasks = config.tasks.split(',');
  for (const id of config.tasks ?? []) if (!TASKS.some(task => task.id === id)) throw new Error(`Unknown task ${id}`);
  if (config.tasks && new Set(config.tasks).size !== config.tasks.length) throw new Error('Task IDs must be unique');
  return config;
}

export function completionAxes(result, wallTimeMs, deadlineMs) {
  const completion = result?.completion;
  const boolean = value => typeof value === 'boolean' ? value : null;
  return {
    agentDoneObserved: boolean(completion?.agentDoneObserved),
    agentSuccessObserved: boolean(completion?.agentSuccessObserved),
    agentRunReturned: boolean(completion?.agentRunReturned),
    runReturnedBeforeDeadline: !!(completion?.agentRunReturned === true && completion?.adapterProcessReturned !== false && completion?.cleanup?.status === 'completed' && wallTimeMs <= deadlineMs),
    completion: completion ?? null,
  };
}

const agentFailureCodes = new Set([
  'PLANNER_FAILED', 'PLANNER_PROCESS_FAILED', 'PLANNER_TRANSPORT_FAILED', 'PLANNER_HTTP_ERROR', 'PLANNER_INVALID_RESPONSE', 'PLANNER_RESPONSE_TOO_LARGE', 'PLANNER_RESPONSE_READ_FAILED', 'PLANNER_TOOL_NAME_CONFLICT',
  'TOOL_CATALOG_FAILED', 'TOOL_CATALOG_INVALID', 'TOOL_NAMES_DUPLICATED', 'INITIALIZATION_TOOL_MISSING',
  'EVENT_HOOK_FAILED', 'METRICS_HOOK_FAILED', 'COMPLETION_HOOK_FAILED', 'RETRY_POLICY_FAILED', 'USAGE_HOOK_FAILED',
  'CHECKPOINT_PERSISTENCE_FAILED', 'CHECKPOINT_PERSISTENCE_TIMEOUT', 'EXECUTOR_FAILED',
  'EXECUTION_IDENTITY_INVALID', 'EXECUTION_IDENTITY_MISMATCH', 'TOOL_CATALOG_CLOSE_FAILED',
]);
function safeAgentFailure(value) {
  if (!value || !['planner', 'catalog', 'application', 'persistence', 'executor'].includes(value.phase) || !agentFailureCodes.has(value.code) || typeof value.retryable !== 'boolean') return null;
  return { phase: value.phase, code: value.code, retryable: value.retryable,
    ...(Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}) };
}

export function classifyRunFailure(result, executionError) {
  if (executionError) return executionError;
  // Historical gateway errors may have been recovered by the framework. The
  // terminal result, not the presence of any prior error, determines failure.
  if (result?.agentStatus === 'succeeded') return null;
  const failure = safeAgentFailure(result?.failure);
  if (failure) return failure.code;
  if (result?.completion?.timedOut) return 'agent_deadline';
  const adapterFailure = result?.trace?.error_type ?? result?.trace?.comparison?.errorType;
  if (adapterFailure) return adapterFailure;
  return ({ failed: 'agent_failed', cancelled: 'agent_cancelled', limit_reached: 'agent_limit_reached', needs_input: 'agent_needs_input' })[result?.agentStatus] ?? 'agent_result_unavailable';
}

async function retainedAdapterProgress(directory) {
  try {
    const path = join(directory, 'adapter-progress.json');
    if ((await stat(path)).size > 16 * 1024 * 1024) return null;
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && value.completion && value.trace ? value : null;
  } catch { return null; }
}

export function summarizeAttempts(attempts) {
  return {
    passed: attempts.filter(a => a.outcome === 'passed').length,
    completedAndPassed: attempts.filter(a => a.outcome === 'passed' && a.agentStatus === 'succeeded').length,
    unfinishedWithPassedOutcome: attempts.filter(a => a.outcome === 'passed' && a.agentStatus !== 'succeeded').length,
    businessPassed: attempts.filter(a => a.businessPassed === true).length,
    agentDoneObserved: attempts.filter(a => a.agentDoneObserved === true).length,
    agentSuccessObserved: attempts.filter(a => a.agentSuccessObserved === true).length,
    runReturnedBeforeDeadline: attempts.filter(a => a.runReturnedBeforeDeadline === true).length,
    allAxesPassed: attempts.filter(a => a.businessPassed === true && a.agentDoneObserved === true && a.agentSuccessObserved === true && a.runReturnedBeforeDeadline === true).length,
    failed: attempts.filter(a => a.outcome === 'failed').length,
    notRun: attempts.filter(a => a.outcome === 'not_run').length,
    falseSuccess: attempts.filter(a => a.falseSuccess === true).length,
  };
}

async function browserPath(config) {
  const explicit = config.executablePath ?? process.env.TABLAZE_BENCH_BROWSER_PATH;
  if (explicit) return resolve(explicit);
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try { const { chromium } = await import('playwright'); return chromium.executablePath(); } catch { return null; }
}

export async function preflight(config) {
  const missing = [], executablePath = await browserPath(config);
  try { if (!executablePath) throw new Error(); await access(executablePath, constants.X_OK); } catch { missing.push('browser executable is missing; pass --executable-path'); }
  if (config.engine !== 'browser-use') {
    try { await access(join(root, 'dist/agent.js')); await access(join(root, 'dist/server.js')); } catch { missing.push('Tablaze build missing; run npm run build'); }
  }
  let codex = null;
  if (config.engine !== 'tablaze-scripted') {
    if (!config.model) missing.push('model missing; pass --model');
    if (config.transport === 'codex') {
      if (!config.reasoningEffort) missing.push('Codex reasoning effort missing; pass --reasoning-effort to make the shared setting explicit');
      const [version, auth] = await Promise.all([
        command(config.codexCommand ?? 'codex', ['--version']),
        command(config.codexCommand ?? 'codex', ['login', 'status']),
      ]);
      const observedVersion = version.stdout.trim().replace(/^codex-cli\s+/, '');
      const loggedIn = auth.code === 0 && /logged in/i.test(auth.stdout + auth.stderr);
      codex = { status: version.code === 0 && observedVersion === CODEX_CLI_VERSION && loggedIn ? 'ready' : 'not_run', version: version.code === 0 ? observedVersion : null,
        expectedVersion: CODEX_CLI_VERSION, authenticated: loggedIn, authentication: loggedIn ? /chatgpt/i.test(auth.stdout + auth.stderr) ? 'ChatGPT' : 'CLI-managed' : null };
      if (version.code !== 0) missing.push('Codex CLI is unavailable; pass --codex-command');
      else if (observedVersion !== CODEX_CLI_VERSION) missing.push(`Codex CLI version differs from the verified ${CODEX_CLI_VERSION} transport; revalidate and update its pin before comparing`);
      if (!loggedIn) missing.push('Codex CLI authentication unavailable; use codex login before running the comparison');
    } else {
      if (!config.endpoint) missing.push('endpoint missing; pass --endpoint with the full chat-completions URL');
      else {
        try { const endpoint = new URL(config.endpoint); if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(); }
        catch { missing.push('endpoint must be HTTP(S), without URL credentials/query/fragment'); }
      }
      if (!config.apiKey && !config.allowAnonymous) missing.push('credentials missing; set TABLAZE_BENCH_API_KEY or explicitly use --allow-anonymous for a local endpoint');
    }
  }
  let browserUse = null;
  if (config.engine === 'browser-use' || config.engine === 'matched') {
    const checked = await command(config.python ?? 'python3', [join(here, 'browser-use-adapter.py'), '--preflight']);
    try { browserUse = JSON.parse(checked.stdout.trim()); } catch { browserUse = { status: 'not_run', reason: checked.error ? 'Python interpreter unavailable' : 'Browser Use dependency preflight failed' }; }
    if (browserUse.status !== 'ready') missing.push(browserUse.reason);
  }
  return { status: missing.length ? 'not_run' : 'ready', missing, executablePath, browserUse, codex, credentialsPresent: !!config.apiKey, anonymousExplicit: !!config.allowAnonymous };
}

async function sourceEvidence() {
  const commit = await command('git', ['rev-parse', 'HEAD']);
  const diff = await command('git', ['diff', '--binary', 'HEAD']);
  const sources = [];
  for (const directory of ['src', 'dist', 'bench/comparison']) {
    const names = await readdir(join(root, directory)).catch(error => { if (directory === 'dist' && error.code === 'ENOENT') return []; throw error; });
    for (const name of names.sort()) {
      if (!/\.(?:ts|js|mjs|py|json)$/.test(name)) continue;
      const path = `${directory}/${name}`;
      sources.push([path, hash(await readFile(join(root, path)))]);
    }
  }
  return { commit: commit.code === 0 ? commit.stdout.trim() : null, patchSha256: diff.code === 0 ? hash(diff.stdout) : null, sourceTreeSha256: hash(JSON.stringify(sources)), sources, lockSha256: hash(await readFile(join(root, 'package-lock.json'))), judgeSha256: hash(await readFile(join(here, 'fixture.mjs'))) };
}

export async function runComparison(config) {
  const check = await preflight(config);
  const source = await sourceEvidence();
  const outputDirectory = resolve(config.output ?? join(root, 'artifacts/comparison', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(outputDirectory, { recursive: true });
  try {
    await access(join(outputDirectory, 'results.json'));
    throw new Error('Output directory already contains results.json; choose a new directory to preserve prior evidence.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const engineIds = config.engine === 'matched' ? ['tablaze', 'browser-use'] : [config.engine];
  const taskIds = config.tasks ?? TASKS.map(task => task.id);
  const codexTransport = config.transport === 'codex';
  const modelConfiguration = config.engine === 'tablaze-scripted' ? null : { model: config.model ?? null, transport: codexTransport ? 'codex-cli' : 'chat-completions', endpoint: codexTransport ? null : publicEndpoint(config.endpoint), temperature: codexTransport || config.reasoningEffort ? null : config.temperature ?? 0, reasoningEffort: config.reasoningEffort ?? null, maxOutputTokens: codexTransport ? null : config.maxOutputTokens ?? 4096, tokenBudget: config.tokenBudget ?? 50000, transportRetries: 0,
    ...(codexTransport ? { codexVersion: check.codex?.version, providerHTTPOverride: true, provider: 'tablaze-comparison', providerConfiguredRequestRetries: 0, providerConfiguredStreamRetries: 0, disabledFeatures: CODEX_DISABLED_FEATURES, limitations: CODEX_TRANSPORT_LIMITS } : {}) };
  const report = {
    schemaVersion: 2, suite: 'development-smoke-v1', purpose: 'Executable harness validation; not a superiority experiment',
    superiorityProven: false, baselineManifestUnchanged: true, preflight: check,
    environment: { platform: process.platform, arch: process.arch, os: os.release(), node: process.version, viewport: { width: 1280, height: 800 }, browserExecutable: check.executablePath, modelConfiguration, browserUseJudge: config.browserUseJudge ?? true,
      engineOptions: { tablaze: { initializeUrl: config.tablazeInitializeUrl ?? false, directOpenTaskUrl: config.tablazeDirectOpenTaskUrl ?? false, popupPolicy: config.tablazePopupPolicy ?? 'stay' }, browserUse: { useJudge: config.browserUseJudge ?? true } },
      deadlineScope: 'schema v2: common absolute deadline begins before gateway and adapter startup; adapter return and owned cleanup, final independent business judging and gateway teardown all count in runReturnedBeforeDeadline wall time; cancellation and cleanup may use bounded grace after deadline',
      historicalTimingComparable: false },
    source, attempts: [], summary: {},
  };
  const service = await startTaskService();
  try {
    for (const taskId of taskIds) for (let repeat = 0; repeat < (config.repeat ?? 1); repeat++) {
      // Alternate pair order deterministically; seed+repeat are recorded. This
      // smoke ordering is not the frozen randomized full-evaluation protocol.
      const ordered = repeat % 2 ? [...engineIds].reverse() : engineIds;
      for (const engine of ordered) {
        const attempt = await service.createAttempt(taskId, (config.seed ?? 1) + repeat);
        const workDirectory = join(outputDirectory, `${taskId}-${repeat}-${engine}`);
        await mkdir(workDirectory, { recursive: true });
        const record = {
          runId: attempt.id, taskId, taskHash: attempt.taskHash, canonicalPrompt: attempt.canonicalPrompt, taskSeed: attempt.seed, repeatIndex: repeat,
          capabilityTags: attempt.tags, engine, engineOrder: ordered.indexOf(engine), executionMode: engine === 'tablaze-scripted' ? 'scripted' : 'model',
          engineOptions: engine === 'browser-use' ? report.environment.engineOptions.browserUse : report.environment.engineOptions.tablaze,
          engineCommit: engine === 'browser-use' ? baseline.baselines.browser_use.commit : source.commit,
          stateResetId: attempt.id, startedAt: new Date().toISOString(), endedAt: null,
          deadlineMs: config.timeoutMs ?? 120000, stepBudget: config.maxSteps ?? 40, toolBudget: engine === 'browser-use' ? null : config.maxToolCalls ?? 150,
          outcome: 'not_run', failureClass: null, judge: null, wallTimeMs: null, llmTimeMs: null, toolTimeMs: null,
          toolCalls: null, steps: null, inputTokens: null, outputTokens: null, cachedTokens: null, modelCalls: null,
          cost: null, retries: null, browserVersion: null, falseSuccess: null, tracePath: null,
          businessPassed: null, agentDoneObserved: null, agentSuccessObserved: null, agentRunReturned: null, runReturnedBeforeDeadline: null, completion: null,
          limits: [...(engine === 'browser-use' ? ['Browser Use adapter currently bounds steps and deadline, not an identical tool-call ceiling.'] : []), ...(codexTransport ? CODEX_TRANSPORT_LIMITS : [])],
        };
        if (check.status !== 'ready') { record.failureClass = 'preflight_missing'; record.notRunReasons = check.missing; record.endedAt = new Date().toISOString(); report.attempts.push(record); continue; }
        const start = performance.now(); const deadlineAtMs = Date.now() + (config.timeoutMs ?? 120000); let gateway, result, executionError;
        try {
          if (engine !== 'tablaze-scripted') gateway = await startModelGateway({ ...config, tokenBudget: config.tokenBudget ?? 50000 });
          const adapterConfig = { ...config, apiKey: undefined, deadlineAtMs, browserUseJudge: config.browserUseJudge ?? true, mode: engine === 'tablaze-scripted' ? 'scripted' : 'model', executablePath: check.executablePath, gatewayEndpoint: gateway?.endpoint, workDirectory };
          if (engine === 'browser-use') {
            const child = await command(config.python ?? 'python3', [join(here, 'browser-use-adapter.py')], {
              input: { ...adapterConfig, prompt: attempt.prompt, uploadPath: attempt.uploadPath }, timeoutMs: (config.timeoutMs ?? 120000) + 30000,
            });
            await writeFile(join(workDirectory, 'adapter.stderr.log'), child.stderr);
            try { result = JSON.parse(child.stdout.trim()); } catch { result = await retainedAdapterProgress(workDirectory); }
            if (!result?.completion) result = await retainedAdapterProgress(workDirectory) ?? result;
            if (child.timeout || child.code !== 0 || child.error) {
              executionError = child.timeout ? 'adapter_timeout' : 'adapter_process_failed';
              if (!result) throw new Error(executionError);
              result = { ...result, agentStatus: 'failed', completion: { ...result.completion, adapterProcessReturned: false, ...(child.timeout ? { timedOut: true } : {}), adapterProcessError: executionError }, trace: { ...result.trace, adapterProcess: { exitCode: child.code, timeout: child.timeout, error: child.error ?? null } } };
            } else if (!result) throw new Error('adapter_result_invalid');
            if (result.status === 'not_run') throw new Error('adapter_dependency_changed');
          } else result = await runTablaze(attempt, adapterConfig);
          const judged = await attempt.judge({ artifactPaths: result.artifactPaths ?? [] });
          record.judge = judged;
          record.businessPassed = judged.passed === true;
          record.outcome = judged.passed ? 'passed' : 'failed';
          record.failureClass = judged.passed ? null : `outcome_mismatch:${result.agentStatus}`;
          record.falseSuccess = result.claimedSuccess === true && !judged.passed;
          record.agentStatus = result.agentStatus;
          record.toolCalls = result.toolCalls ?? null;
          record.steps = result.steps ?? null;
          record.toolTimeMs = result.toolTimeMs ?? null;
          record.browserVersion = result.browserVersion ?? null;
          record.tracePath = join(workDirectory, 'trace.json');
          await writeFile(record.tracePath, JSON.stringify(result.trace, null, 2), { mode: 0o600 });
          record.artifactPaths = result.artifactPaths ?? [];
        } catch (error) {
          executionError = error.message;
          record.judge = await attempt.judge();
          record.businessPassed = record.judge.passed === true;
          record.outcome = record.businessPassed ? 'passed' : 'failed';
          record.failureClass = record.businessPassed ? null : error.message;
          record.agentStatus = result?.agentStatus ?? 'failed';
        } finally {
          if (gateway) {
            // Closing first also waits for cancelled CLI subprocess teardown and
            // final usage events, so a timed-out inference is not undercounted.
            await gateway.close();
            const metrics = gateway.metrics;
            record.llmTimeMs = metrics.timeMs;
            record.modelCalls = metrics.calls;
            record.providerFailures = metrics.failedCalls;
            record.inputTokens = metrics.usageComplete ? metrics.inputTokens : null;
            record.outputTokens = metrics.usageComplete ? metrics.outputTokens : null;
            record.cachedTokens = metrics.usageComplete && metrics.cachedUsageComplete ? metrics.cachedTokens : null;
            record.transportRequests = metrics.transportRequests;
            record.transportErrors = metrics.errors;
          } else if (engine === 'tablaze-scripted') { record.llmTimeMs = 0; record.modelCalls = 0; record.inputTokens = 0; record.outputTokens = 0; record.cachedTokens = 0; }
          record.wallTimeMs = performance.now() - start;
          record.endedAt = new Date().toISOString();
          Object.assign(record, completionAxes(result, record.wallTimeMs, record.deadlineMs));
          record.agentFailure = safeAgentFailure(result?.failure);
          record.runFailureClass = classifyRunFailure(result, executionError);
          record.judgeModelCalls = result?.completion?.judgeModelCalls ?? (engine === 'browser-use' ? null : 0);
          record.judgeUsage = result?.completion?.judgeUsage ?? null;
          record.falseSuccess = record.agentSuccessObserved === true && !record.businessPassed;
          record.tracePath = join(workDirectory, 'trace.json');
          await writeFile(record.tracePath, JSON.stringify({ ...(result?.trace ?? {}), comparisonOutcome: { businessPassed: record.businessPassed, agentDoneObserved: record.agentDoneObserved, agentSuccessObserved: record.agentSuccessObserved, runReturnedBeforeDeadline: record.runReturnedBeforeDeadline, agentStatus: record.agentStatus, completion: record.completion, runFailureClass: record.runFailureClass } }, null, 2), { mode: 0o600 });
          report.attempts.push(record);
          await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
        }
      }
    }
  } finally { await service.close(); }
  for (const engine of engineIds) {
    const attempts = report.attempts.filter(attempt => attempt.engine === engine);
    report.summary[engine] = summarizeAttempts(attempts);
  }
  report.comparableForSuperiority = false;
  report.comparisonLimitations = ['Development smoke tasks are visible to the scripted adapter.', 'No frozen full task set or statistical superiority run has been completed.', 'Tool counts and cost timing differ by framework; missing metrics remain null.', 'The shared external-agent MCP comparison track is not implemented here.'];
  await writeFile(join(outputDirectory, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  return { report, outputDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = parseArgs(process.argv.slice(2));
    config.apiKey = process.env.TABLAZE_BENCH_API_KEY;
    if (config.help) console.log('Usage: node bench/comparison/runner.mjs --engine tablaze-scripted|tablaze|browser-use|matched [--browser-use-judge true|false] [--tablaze-initialize-url true|false] [--tablaze-direct-open-task-url true|false] [--tablaze-popup-policy stay|follow-single] [--transport http|codex] [--preflight] [--tasks form,popup] [--repeat 1] [--endpoint URL --model MODEL] [--reasoning-effort EFFORT] [--codex-command PATH] [--allow-anonymous] [--python PATH] [--executable-path PATH] [--output DIR]\nHTTP runs read TABLAZE_BENCH_API_KEY. Codex transport reuses CLI-managed login with no auth-file reads. Scripted smoke and preflight make no model calls.');
    else if (config.preflightOnly) console.log(JSON.stringify(await preflight(config), null, 2));
    else {
      const { report, outputDirectory } = await runComparison(config);
      console.log(JSON.stringify({ results: join(outputDirectory, 'results.json'), summary: report.summary, superiorityProven: false }, null, 2));
      if (report.attempts.some(attempt => attempt.outcome === 'failed')) process.exitCode = 1;
      else if (report.attempts.every(attempt => attempt.outcome === 'not_run')) process.exitCode = 2;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
