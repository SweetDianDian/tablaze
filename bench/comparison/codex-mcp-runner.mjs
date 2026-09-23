import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTaskService } from './fixture.mjs';
import { startModelGateway } from './model-gateway.mjs';
import { CODEX_CLI_VERSION, CODEX_DISABLED_FEATURES, CODEX_PROVIDER_CONFIG } from './codex-transport.mjs';

const root = resolve(import.meta.dirname, '../..');
const codex = process.env.TABLAZE_CODEX_COMMAND || '/Applications/ChatGPT.app/Contents/Resources/codex';
const chromePath = process.env.TABLAZE_PREFLIGHT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const harnessSource = process.env.TABLAZE_HARNESS_PIN_SOURCE;
const harnessBinary = process.env.TABLAZE_HARNESS_MCP || '/private/tmp/tablaze-comparison-env/bin/browser-harness-mcp';
const harnessCli = process.env.TABLAZE_HARNESS_CLI || '/private/tmp/tablaze-comparison-env/bin/browser-harness';
const browserUseCli = process.env.TABLAZE_BROWSER_USE_CLI || '/private/tmp/tablaze-comparison-env/bin/browser-use';
const archivePath = process.env.TABLAZE_HARNESS_PIN_ARCHIVE || '/private/tmp/browser-harness-afbcc381.zip';
const output = process.env.TABLAZE_MCP_REPORT || join(root, 'bench', 'comparison', 'codex-mcp-smoke.json');
const taskId = process.argv[2] || 'form';
const arms = (process.env.TABLAZE_MCP_ARMS || 'tablaze,harness').split(',');
const pageScript = process.env.TABLAZE_MCP_PAGE_SCRIPT === '1';
const timeoutMs = Number(process.env.TABLAZE_MCP_TIMEOUT_MS || 180_000);
const fullToolTimeoutSec = Number(process.env.TABLAZE_MCP_FULL_TOOL_TIMEOUT_SEC || 300);
const sha256 = content => createHash('sha256').update(content).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const localEnv = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const tomlString = value => JSON.stringify(String(value));
const tomlTable = object => `{ ${Object.entries(object).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`;

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function stopGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
}

async function startChrome(directory) {
  const port = await freePort();
  const child = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--disable-sync', '--disable-features=MediaRouter',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(directory, 'chrome-profile')}`, '--window-size=1280,800', 'about:blank',
  ], { detached: true, stdio: 'ignore', env: { ...process.env, ...localEnv } });
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Owned Chrome exited early: ${child.exitCode}`);
      try {
        const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { child, endpoint, version: (await response.json()).Browser };
      } catch { /* Chrome is still starting. */ }
      await delay(100);
    }
    throw new Error('Owned Chrome CDP endpoint did not become ready');
  } catch (error) { await stopGroup(child); throw error; }
}

function runCodex(args, prompt, directory) {
  return new Promise(resolveRun => {
    const child = spawn(codex, args, { cwd: directory, detached: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...localEnv } });
    const events = [];
    let stdout = '', stderr = '', timedOut = false, closed = false;
    const started = performance.now();
    const limit = setTimeout(() => { timedOut = true; void stopGroup(child); }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        try { events.push(JSON.parse(line)); } catch { events.push({ type: 'unparsed', text: line.slice(0, 2_000) }); }
      }
      if (events.length > 10_000 || stdout.length > 8_000_000) void stopGroup(child);
    });
    child.stderr.on('data', chunk => { if (stderr.length < 100_000) stderr += chunk.toString(); });
    child.on('error', error => { stderr += `\nSPAWN_ERROR ${error.message}`; });
    child.on('close', (code, signal) => {
      if (closed) return; closed = true; clearTimeout(limit);
      if (stdout.trim()) { try { events.push(JSON.parse(stdout.trim())); } catch { /* Non-JSON tail. */ } }
      resolveRun({ code, signal, timedOut, elapsedMs: Math.round(performance.now() - started), events, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function summarize(run) {
  const types = Object.fromEntries([...new Set(run.events.map(event => event.type))].map(type => [type, run.events.filter(event => event.type === type).length]));
  const toolItems = run.events.filter(event => /mcp|tool/.test(event.item?.type || '')).map(event => ({
    event: event.type, kind: event.item?.type, server: event.item?.server, tool: event.item?.tool,
    name: event.item?.name, status: event.item?.status,
  }));
  const final = run.events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item?.text;
  const usage = run.events.filter(event => event.type === 'turn.completed').at(-1)?.usage;
  const errors = run.events.filter(event => event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error')
    .map(event => ({ type: event.type, message: String(event.message || event.error?.message || event.item?.message || '').slice(0, 500) }));
  return { exitCode: run.code, signal: run.signal, timedOut: run.timedOut, elapsedMs: run.elapsedMs,
    eventTypes: types, toolItems, final: final?.slice(0, 2_000) || null, usage: usage || null, errors,
    stderrTail: run.stderr.slice(-2_000) };
}

async function runArm(kind, directory, service) {
  const attempt = await service.createAttempt(taskId, 1);
  const chrome = await startChrome(directory);
  let nestedGateway;
  const harnessEnv = {
    PYTHONPATH: harnessSource, BU_CDP_URL: chrome.endpoint, BU_NAME: 'tblz_codex_mcp',
    BH_HOME: join(directory, 'h', 'home'), BH_RUNTIME_DIR: join(directory, 'h', 'run'),
    BH_TMP_DIR: join(directory, 'h', 'tmp'), BH_AGENT_WORKSPACE: join(directory, 'h', 'work'),
    BROWSER_USE_CONFIG_DIR: join(directory, 'browser-use-config'),
    BH_TELEMETRY: 'false', ANONYMIZED_TELEMETRY: 'false', BROWSER_USE_CLOUD_SYNC: 'false',
    ...localEnv,
  };
  try {
  if (kind === 'browser-use-mcp' || kind === 'browser-use-mcp-full') {
    if (kind === 'browser-use-mcp-full') {
      nestedGateway = await startModelGateway({ transport: 'codex', codexCommand: codex,
        model: 'gpt-6-astra', reasoningEffort: 'ultra', maxOutputTokens: 4096,
        tokenBudget: 500_000, timeoutMs: 180_000 });
      harnessEnv.OPENAI_BASE_URL = nestedGateway.endpoint.slice(0, -'/chat/completions'.length);
      harnessEnv.OPENAI_API_KEY = 'local-codex-gateway-no-secret';
    }
    const configDirectory = join(directory, 'browser-use-config');
    await mkdir(configDirectory, { recursive: true });
    const id = randomUUID();
    const configPath = join(configDirectory, 'config.json');
    await writeFile(configPath, JSON.stringify({
      browser_profile: { [id]: { id, default: true, headless: true, cdp_url: chrome.endpoint,
        user_data_dir: join(directory, 'browser-use-profile'), downloads_path: join(directory, 'downloads'),
        file_system_path: join(directory, 'files'), keep_alive: true, wait_between_actions: 0.5,
        viewport: { width: 1280, height: 713 }, screen: { width: 1280, height: 800 },
        window_size: { width: 1280, height: 800 }, device_scale_factor: 1,
        allowed_domains: ['127.0.0.1'] } },
      llm: nestedGateway ? { [id]: { id, default: true, model: 'gpt-6-astra',
        api_key: 'local-codex-gateway-no-secret', temperature: 0 } } : {}, agent: {},
    }, null, 2));
    harnessEnv.BROWSER_USE_CONFIG_PATH = configPath;
  }
  const command = kind === 'tablaze' ? process.execPath : kind === 'harness' ? harnessBinary : browserUseCli;
  const commandArgs = kind === 'tablaze' ? [join(root, 'dist', 'cli.js'), ...(pageScript ? ['--channel', 'chrome', '--page-script'] : ['--cdp-url', chrome.endpoint]), ...(taskId === 'network-receipt' && !pageScript ? ['--capture-network'] : [])]
    : kind === 'browser-use-cli-mcp' ? ['--cli-mcp'] : kind.startsWith('browser-use-mcp') ? ['--mcp'] : [];
  const flags = [
    'exec', '--ignore-user-config', '--skip-git-repo-check', '--approve-for-me', '--json',
    '--color', 'never', '--ephemeral', '--model', 'gpt-6-astra', '-C', directory,
    '-c', 'model_reasoning_effort="ultra"', '-c', 'web_search="disabled"',
    '-c', 'model_provider="tablaze-comparison"', '-c', CODEX_PROVIDER_CONFIG,
    '-c', `mcp_servers.browser.command=${tomlString(command)}`,
    '-c', `mcp_servers.browser.args=[${commandArgs.map(tomlString).join(', ')}]`,
    '-c', 'mcp_servers.browser.required=true', '-c', 'mcp_servers.browser.startup_timeout_sec=30',
    '-c', `mcp_servers.browser.tool_timeout_sec=${kind === 'browser-use-mcp-full' ? fullToolTimeoutSec : 60}`,
    '-c', `mcp_servers.browser.env=${tomlTable(kind === 'tablaze' ? localEnv : harnessEnv)}`,
    ...CODEX_DISABLED_FEATURES.filter(feature => feature !== 'view_image').flatMap(feature => ['--disable', feature]),
    '-',
  ];
  const prompt = `${attempt.prompt}\n\nUse the configured browser MCP to perform the task. Open the task URL with that MCP. After opening, request a screenshot and inspect the visual result before acting. If the screenshot tool gives a local file path, use the image-viewing tool to inspect that file. Verify the saved result in the page before reporting completion. Do not use shell, web search, or a second browser. This is a resettable local test application. Give a concise final report.\n`;
    const run = await runCodex(flags, prompt, directory);
    const judge = await attempt.judge();
    const rawPath = `${output}.${kind}.jsonl`;
    await writeFile(rawPath, run.events.map(event => JSON.stringify(event)).join('\n') + '\n');
    return { kind, taskId, chrome: chrome.version, promptHash: sha256(prompt),
      flagsHash: sha256(JSON.stringify(flags)), command: { executable: command, args: commandArgs },
      run: summarize(run), judge, rawEventsPath: rawPath,
      ...(nestedGateway ? { nestedModel: { provider: 'Codex CLI via local comparison gateway',
        model: 'gpt-6-astra', reasoningEffort: 'ultra',
        calls: nestedGateway.metrics.calls, failedCalls: nestedGateway.metrics.failedCalls,
        inputTokens: nestedGateway.metrics.inputTokens, outputTokens: nestedGateway.metrics.outputTokens,
        usageComplete: nestedGateway.metrics.usageComplete, timeMs: nestedGateway.metrics.timeMs,
        errors: nestedGateway.metrics.errors.map(error => ({ code: error.code })) } } : {}) };
  } finally {
    if (kind !== 'tablaze') {
      const stopped = spawnSync(harnessCli, ['--reload'], { env: { ...process.env, ...harnessEnv }, timeout: 15_000, encoding: 'utf8' });
      if (stopped.status !== 0) console.error(`Harness daemon cleanup failed: ${(stopped.stderr || '').slice(0, 500)}`);
    }
    if (nestedGateway) await nestedGateway.close();
    await stopGroup(chrome.child);
  }
}

async function main() {
  if (!harnessSource) throw new Error('Set TABLAZE_HARNESS_PIN_SOURCE to the verified pinned src directory');
  if (!Number.isInteger(fullToolTimeoutSec) || fullToolTimeoutSec < 60 || fullToolTimeoutSec > 900) throw new Error('TABLAZE_MCP_FULL_TOOL_TIMEOUT_SEC must be an integer from 60 to 900');
  for (const path of [codex, chromePath, harnessBinary, harnessCli, browserUseCli, join(harnessSource, 'mcp_server.py')]) await access(path);
  const version = spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim();
  if (version !== `codex-cli ${CODEX_CLI_VERSION}`) throw new Error(`Codex version mismatch: ${version}`);
  const base = await mkdtemp(join(tmpdir(), 'tblzcm-'));
  const service = await startTaskService();
  const report = { kind: 'native-codex-external-mcp-smoke-v1', generatedAt: new Date().toISOString(),
    codexVersion: version, model: 'gpt-6-astra', reasoningEffort: 'ultra', provider: CODEX_PROVIDER_CONFIG,
    featureOverrides: CODEX_DISABLED_FEATURES.filter(feature => feature !== 'view_image'),
    viewImageEnabled: true, taskId, timeoutMs, fullToolTimeoutSec, tablazePageScript: pageScript,
    source: { tablazeHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      harnessCommit: 'afbcc381b963040c19627d788e40c7e7663171ee',
      browserUseCommit: 'd8110c5ff87ccba887aaa726cdb780f2f84bef8d',
      harnessArchiveSha256: sha256(await readFile(archivePath)) }, arms: [] };
  try {
    for (const kind of arms) {
      if (!['tablaze', 'harness', 'browser-use-cli-mcp', 'browser-use-mcp', 'browser-use-mcp-full'].includes(kind)) throw new Error(`Unknown arm: ${kind}`);
      // Keep Harness AF_UNIX socket paths below macOS sun_path limit.
      const directory = await mkdtemp(join(base, 'a-'));
      const result = await runArm(kind, directory, service);
      report.arms.push(result);
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ kind, judge: result.judge, run: result.run }, null, 2));
    }
  } finally {
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
