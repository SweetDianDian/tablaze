import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTaskService } from './fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const chromePath = process.env.TABLAZE_PREFLIGHT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const harnessSource = process.env.TABLAZE_HARNESS_PIN_SOURCE;
const harnessBinary = process.env.TABLAZE_HARNESS_MCP || '/private/tmp/tablaze-comparison-env/bin/browser-harness-mcp';
const harnessCli = process.env.TABLAZE_HARNESS_CLI || '/private/tmp/tablaze-comparison-env/bin/browser-harness';
const archivePath = process.env.TABLAZE_HARNESS_PIN_ARCHIVE || '/private/tmp/browser-harness-afbcc381.zip';

const sha256 = content => createHash('sha256').update(content).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const withoutProxy = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function startChrome(directory) {
  const port = await freePort();
  const child = spawn(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--disable-sync', '--disable-features=MediaRouter',
    '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(directory, 'chrome-profile')}`, '--window-size=1280,800', 'about:blank',
  ], { detached: true, stdio: 'ignore', env: { ...process.env, ...withoutProxy } });
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
  } catch (error) {
    await stopChrome(child);
    throw error;
  }
}

async function stopChrome(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already gone. */ }
  for (let i = 0; i < 20 && child.exitCode === null; i++) await delay(100);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already gone. */ }
  }
}

async function connect(command, args, env) {
  const transport = new StdioClientTransport({ command, args, cwd: root, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString().slice(0, 8_000); });
  const client = new Client({ name: 'tablaze-matched-mcp-preflight', version: '0.1.0' });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

function parseText(response) {
  const block = response.content.find(item => item.type === 'text');
  if (!block) throw new Error(`No text content: ${JSON.stringify(response).slice(0, 500)}`);
  return JSON.parse(block.text);
}

async function preflightArm(kind, directory, service, report) {
  const attempt = await service.createAttempt('form', 1);
  const chrome = await startChrome(directory);
  let connection;
  const harnessEnv = {
    PYTHONPATH: harnessSource,
    BU_CDP_URL: chrome.endpoint,
    BU_NAME: 'tblz_preflight',
    BH_HOME: join(directory, 'h', 'home'),
    BH_RUNTIME_DIR: join(directory, 'h', 'run'),
    BH_TMP_DIR: join(directory, 'h', 'tmp'),
    BH_AGENT_WORKSPACE: join(directory, 'h', 'work'),
    ...withoutProxy,
  };
  try {
    const start = performance.now();
    connection = kind === 'tablaze'
      ? await connect(process.execPath, [join(root, 'dist', 'cli.js'), '--cdp-url', chrome.endpoint], withoutProxy)
      : await connect(harnessBinary, [], harnessEnv);
    const listed = await connection.client.listTools();
    const call = (name, args) => connection.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const toolNames = listed.tools.map(tool => tool.name);
    const observation = kind === 'tablaze'
      ? await call('tab_open', { url: attempt.url })
      : await call('browser_new_tab', { url: attempt.url });
    if (observation.isError) throw new Error(`Open failed: ${JSON.stringify(observation).slice(0, 1000)}`);
    const opened = parseText(observation);
    const second = kind === 'tablaze'
      ? await call('tab_snapshot', { session_id: opened.session_id })
      : await call('browser_page_info', {});
    if (second.isError) throw new Error(`Observation failed: ${JSON.stringify(second).slice(0, 1000)}`);
    const observed = parseText(second);
    const capture = kind === 'tablaze'
      ? await call('tab_capture', { session_id: opened.session_id })
      : await call('browser_screenshot', {});
    if (capture.isError) throw new Error(`Screenshot failed: ${JSON.stringify(capture).slice(0, 1000)}`);
    const captureData = parseText(capture);
    let image;
    if (kind === 'tablaze') {
      const block = capture.content.find(item => item.type === 'image');
      if (!block?.data) throw new Error('Tablaze capture lacked a native MCP image block');
      image = { delivery: 'native_mcp_image', mimeType: block.mimeType, bytes: Buffer.from(block.data, 'base64').byteLength };
      await call('tab_close', { session_id: opened.session_id });
    } else {
      const path = captureData.path;
      await access(path);
      image = { delivery: 'file_path_for_agent_image_viewer', mimeType: 'image/png', bytes: (await stat(path)).size,
        width: captureData.width, height: captureData.height, readable: true };
      const list = await call('browser_list_tabs', {});
      if (list.isError) throw new Error(`Stateful tab list failed: ${JSON.stringify(list).slice(0, 1000)}`);
    }
    const invalid = kind === 'tablaze'
      ? await call('tab_snapshot', { session_id: 'missing-preflight-session' })
      : await call('browser_switch_tab', { target: 'missing-preflight-tab' });
    report[kind] = {
      status: 'passed', chrome: chrome.version, endpointOwnership: 'temporary Chrome profile and process',
      toolCount: toolNames.length, toolNames,
      toolSchemas: listed.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })),
      schemaHash: sha256(JSON.stringify(listed.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })))),
      serverInfo: connection.client.getServerVersion() || null,
      instructions: connection.client.getInstructions() || null,
      errorShape: { isError: invalid.isError === true,
        contentTypes: invalid.content.map(item => item.type),
        structured: invalid.structuredContent || null,
        text: invalid.content.find(item => item.type === 'text')?.text.slice(0, 500) || null },
      opened: kind === 'tablaze' ? { sessionIdPresent: Boolean(opened.session_id), url: opened.url } : opened,
      secondObservation: kind === 'tablaze' ? { snapshotIdPresent: Boolean(observed.snapshot_id), url: observed.url } : observed,
      image, elapsedMs: Math.round(performance.now() - start),
    };
  } finally {
    if (connection) await connection.client.close().catch(() => {});
    if (kind === 'harness') {
      const stopped = spawnSync(harnessCli, ['--reload'], { env: { ...process.env, ...harnessEnv }, timeout: 15_000, encoding: 'utf8' });
      report.harnessCleanup = { exitCode: stopped.status, output: (stopped.stdout + stopped.stderr).trim().slice(0, 1000) };
    }
    await stopChrome(chrome.child);
  }
}

async function main() {
  if (!harnessSource) throw new Error('Set TABLAZE_HARNESS_PIN_SOURCE to the verified pinned src directory');
  for (const path of [chromePath, harnessBinary, harnessCli, join(harnessSource, 'mcp_server.py')]) await access(path);
  const report = {
    kind: 'matched-external-mcp-preflight-v1',
    generatedAt: new Date().toISOString(),
    source: { tablazeHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
      harnessCommit: 'afbcc381b963040c19627d788e40c7e7663171ee',
      harnessArchiveSha256: sha256(await readFile(archivePath)),
      harnessExecutionSource: harnessSource },
    sdk: '@modelcontextprotocol/sdk 1.30.0',
  };
  const base = await mkdtemp(join(tmpdir(), 'tblzpf-'));
  const service = await startTaskService();
  try {
    for (const kind of ['tablaze', 'harness']) {
      const directory = await mkdtemp(join(base, `${kind}-`));
      await preflightArm(kind, directory, service, report);
    }
  } finally {
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
  const output = process.env.TABLAZE_PREFLIGHT_REPORT;
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
