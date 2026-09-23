#!/usr/bin/env node
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserError, type BrowserOptions, type BrowserWorkspace } from "./browser.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { connectAgentTools, createOpenAICompatiblePlanner, runAgent, type AgentModelUsage } from "./agent.js";
import { createCodexPlanner, type CodexReasoningEffort } from "./codex.js";
import { createAnthropicPlanner, createOllamaPlanner } from "./providers.js";
import { normalizeStartUrl, parseAgentCheckpoint, type AgentCheckpoint } from "./checkpoint.js";
import { compileNavigationPolicy, type NavigationPolicy } from "./navigation-policy.js";
import { loadSecretConfig } from "./secret-config.js";
import { compileFinalOutput } from "./final-output.js";
import type { ExtractionSchema } from "./extraction.js";

const require = createRequire(import.meta.url);
const HELP = `Tablaze / 闪页 — compact browser MCP

Usage / 用法:
  tablaze [options]          Start the stdio MCP server / 启动 MCP
  tablaze doctor [options]   Print JSON diagnostics / 输出诊断
  tablaze setup              Install managed Chromium / 安装 Chromium
  tablaze run [options]      Execute a model-driven task / 执行模型驱动任务

Options / 选项:
  --headless                Run headless (default) / 无头模式
  --headed                  Show the isolated browser / 显示独立浏览器
  --capture-network         Expose bounded owned-tab response inspection / 观察自有标签页响应
  --record-video            Record real owned browser tabs to private WebM artifacts / 录制真实浏览器画面
  --page-script             Expose page-origin JavaScript (full page authority) / 开启页面脚本
  --profile-dir <path>       Use a dedicated persistent Chrome profile / 使用专有持久资料目录
  --profile-id <id>          Required identity when reopening that profile / 重开资料时核对身份
  --channel <name>          Use installed Chrome/Edge / 浏览器渠道
  --executable-path <path>  Use a browser executable / 浏览器程序路径
  --cdp-url <url>           Explicitly attach over CDP / 主动连接 CDP
  --timeout-ms <100-60000>  Action timeout (default 10000) / 操作超时
  --popup-policy <policy>   stay (default) or follow-single / 弹窗跟随策略
  --navigation-policy <file>  Trusted exact-origin JSON policy; isolated browsers only
  --secret-config <file>    Trusted secret aliases and env variable names in JSON; isolated browsers only
  --help                    Print this help / 帮助
  --version                 Print the version / 版本

Agent run options / 任务执行选项:
  --task <text>             Requested task / 任务描述
  --start-url <url>         Open this explicit URL once before planning / 首次规划前打开指定网址
  --model <id>              Model supporting tools / 支持工具的模型
  --provider <name>         openai-compatible (default), codex, anthropic, ollama
  --endpoint <url>          Full HTTP model endpoint; required for openai-compatible
  --api-key-env <name>      Read key from this env var (default TABLAZE_API_KEY)
  --codex-command <path>    Codex executable (default codex); codex only
  --reasoning-effort <id>   Explicit Codex reasoning effort; model support varies
  --max-output-tokens <n>   Anthropic max_tokens / Ollama num_predict (1-1000000)
  --max-steps <1-1000>      Planning limit (default 30) / 规划步数上限
  --max-calls <1-10000>     Tool limit (default 100) / 工具调用上限
  --output-schema <file>   Draft-07 JSON Schema for validated final data / 最终数据格式
  --partial-schema <file>  Draft-07 JSON Schema for checked partial data / 中途数据格式
  --run-timeout-ms <ms>    Task deadline (default 300000) / 任务总时限
  --checkpoint <path>     Persist private run/browser checkpoints / 保存恢复点
  --resume <path>         Resume a saved run; old refs must be re-observed / 恢复任务
  --reconciled <note>     Explicitly confirm ambiguous writes were checked / 核对未决操作

MCP writes protocol messages to stdout; diagnostics use stderr.
The browser is launched lazily. Startup never downloads a browser.
浏览器按需启动；MCP 启动时不会自动下载浏览器。
`;

const CHANNELS = new Set(["chromium", "chrome", "chrome-beta", "chrome-dev", "chrome-canary", "msedge", "msedge-beta", "msedge-dev", "msedge-canary"]);

type RunProvider = "openai-compatible" | "codex" | "anthropic" | "ollama";
interface RunOptions {
  task?: string; startUrl?: string; provider: RunProvider; model: string; endpoint?: string; apiKey?: string;
  codexCommand?: string; reasoningEffort?: CodexReasoningEffort; maxOutputTokens?: number;
  maxSteps?: number; maxToolCalls?: number; timeoutMs?: number; checkpointPath?: string; resumePath?: string; reconciled?: string;
  finalOutputSchema?: ExtractionSchema;
  partialOutputSchema?: ExtractionSchema;
}
const PROVIDERS = new Set<RunProvider>(["openai-compatible", "codex", "anthropic", "ollama"]);
const REASONING_EFFORTS = new Set<CodexReasoningEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function loadNavigationPolicy(path: string): NavigationPolicy {
  let descriptor: number | undefined;
  try {
    // Nonblocking open lets us reject FIFOs/devices instead of hanging before
    // fstat. The bounded read also detects growth after the initial size check.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 64 * 1024) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    return compileNavigationPolicy(value as NavigationPolicy).policy;
  } catch {
    throw new Error("--navigation-policy must reference a readable regular UTF-8 JSON file of at most 64 KiB, containing only valid allowedOrigins and/or blockedOrigins arrays.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function loadOutputSchema(path: string, flag = "--output-schema"): ExtractionSchema {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 64 * 1024) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    return compileFinalOutput(value as ExtractionSchema).schema;
  } catch {
    throw new Error(`${flag} must reference a readable regular UTF-8 draft-07 JSON Schema file of at most 64 KiB.`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseOptions(): { command: string; options: BrowserOptions; run?: RunOptions } {
  const { values, positionals } = parseArgs({
    options: { headless: { type: "boolean" }, headed: { type: "boolean" }, "capture-network": { type: "boolean" }, "record-video": { type: "boolean" }, "page-script": { type: "boolean" }, "profile-dir": { type: "string" }, "profile-id": { type: "string" }, channel: { type: "string" }, "executable-path": { type: "string" }, "cdp-url": { type: "string" }, "timeout-ms": { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, task: { type: "string" }, "start-url": { type: "string" }, "popup-policy": { type: "string" }, "navigation-policy": { type: "string" }, "secret-config": { type: "string" }, model: { type: "string" }, provider: { type: "string" }, endpoint: { type: "string" }, "api-key-env": { type: "string" }, "codex-command": { type: "string" }, "reasoning-effort": { type: "string" }, "max-output-tokens": { type: "string" }, "max-steps": { type: "string" }, "max-calls": { type: "string" }, "output-schema": { type: "string" }, "partial-schema": { type: "string" }, "run-timeout-ms": { type: "string" }, checkpoint: { type: "string" }, resume: { type: "string" }, reconciled: { type: "string" } },
    allowPositionals: true, strict: true,
  });
  if (values.help) return { command: "help", options: {} };
  if (values.version) return { command: "version", options: {} };
  if (positionals.length > 1 || (positionals[0] && !["doctor", "setup", "run"].includes(positionals[0]))) throw new Error("Expected no command, doctor, setup, or run. Run tablaze --help.");
  if (values.headless && values.headed) throw new Error("Choose either --headless or --headed.");
  if (values["page-script"] && (values["secret-config"] || values["cdp-url"] || values["navigation-policy"])) throw new Error("--page-script cannot be combined with --secret-config, --cdp-url, or --navigation-policy.");
  const cdpUrl = values["cdp-url"];
  if (values["profile-id"] && !values["profile-dir"]) throw new Error("--profile-id requires --profile-dir.");
  if (values["profile-dir"] !== undefined && !values["profile-dir"].trim()) throw new Error("--profile-dir must name a dedicated directory.");
  if (values["profile-dir"] && cdpUrl) throw new Error("--profile-dir cannot be combined with --cdp-url.");
  if (values["profile-dir"] && values["navigation-policy"]) throw new Error("--profile-dir cannot be combined with --navigation-policy because restored pages can load before the guard starts.");
  if (values["record-video"] && (values["profile-dir"] || cdpUrl)) throw new Error("--record-video requires isolated owned browser contexts; do not combine it with --profile-dir or --cdp-url.");
  if (values["profile-dir"] && positionals[0] === "setup") throw new Error("--profile-dir applies to MCP, run, or doctor, not setup.");
  if (values["profile-dir"] && (values.checkpoint || values.resume)) throw new Error("Persistent profiles cannot be combined with CLI checkpoints until profile identity is bound into the checkpoint contract.");
  if (values["navigation-policy"] !== undefined && cdpUrl) throw new Error("--navigation-policy cannot be combined with --cdp-url; it requires isolated browser contexts.");
  if (values["navigation-policy"] !== undefined && positionals[0] === "setup") throw new Error("--navigation-policy applies to MCP, run, or doctor, not setup.");
  if (values["secret-config"] !== undefined && cdpUrl) throw new Error("--secret-config cannot be combined with --cdp-url; it requires isolated browser contexts.");
  if (values["secret-config"] !== undefined && positionals[0] === "setup") throw new Error("--secret-config applies to MCP, run, or doctor, not setup.");
  const secrets = values["secret-config"] === undefined ? undefined : loadSecretConfig(values["secret-config"]);
  if (values["record-video"] && secrets && !secrets.allowSensitiveArtifacts) throw new Error("--record-video with --secret-config requires allowSensitiveArtifacts in the trusted secret configuration.");
  const navigationPolicy = values["navigation-policy"] === undefined ? undefined : loadNavigationPolicy(values["navigation-policy"]);
  const channel = values.channel ?? (cdpUrl ? undefined : process.env.TABLAZE_BROWSER_CHANNEL);
  if (channel && !CHANNELS.has(channel)) throw new Error("Unsupported browser channel. Use chromium, chrome, or a documented Chrome/Edge channel.");
  const executablePath = values["executable-path"] ?? (cdpUrl ? undefined : process.env.TABLAZE_EXECUTABLE_PATH);
  if (channel && executablePath) throw new Error("Choose --channel or --executable-path, not both.");
  if (cdpUrl && (channel || executablePath || values.headed || values.headless)) throw new Error("CDP attachment cannot be combined with browser launch options.");
  if (cdpUrl) {
    let parsed: URL;
    try { parsed = new URL(cdpUrl); } catch { throw new Error("Invalid CDP URL."); }
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) throw new Error("CDP URL must use HTTP(S) or WS(S).");
  }
  const timeoutMs = values["timeout-ms"] === undefined ? 10_000 : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("--timeout-ms must be an integer from 100 to 60000.");
  let run: RunOptions | undefined;
  let popupPolicy: BrowserOptions["popupPolicy"];
  if (values["popup-policy"] !== undefined && values["popup-policy"] !== "stay" && values["popup-policy"] !== "follow-single") throw new Error("--popup-policy must be stay or follow-single.");
  popupPolicy = values["popup-policy"];
  const runKeys = ["task", "start-url", "model", "provider", "endpoint", "api-key-env", "codex-command", "reasoning-effort", "max-output-tokens", "max-steps", "max-calls", "output-schema", "partial-schema", "run-timeout-ms", "checkpoint", "resume", "reconciled"] as const;
  if (positionals[0] === "run") {
    const provider = (values.provider ?? "openai-compatible") as RunProvider;
    if (!PROVIDERS.has(provider)) throw new Error("--provider must be openai-compatible, codex, anthropic, or ollama.");
    if ((!values.task?.trim() && !values.resume) || !values.model?.trim() || (provider === "openai-compatible" && !values.endpoint?.trim())) {
      throw new Error(provider === "openai-compatible" ? "run requires --task (or --resume), --model and --endpoint. The endpoint must support chat-completions tool calls." : "run requires --task (or --resume) and an explicit --model.");
    }
    if (provider === "codex" && ["endpoint", "api-key-env", "max-output-tokens"].some(key => values[key as keyof typeof values] !== undefined)) throw new Error("--endpoint, --api-key-env and --max-output-tokens do not apply to --provider codex; use the existing Codex login.");
    if (provider !== "codex" && (values["codex-command"] !== undefined || values["reasoning-effort"] !== undefined)) throw new Error("--codex-command and --reasoning-effort require --provider codex.");
    if (provider === "openai-compatible" && values["max-output-tokens"] !== undefined) throw new Error("--max-output-tokens applies only to --provider anthropic or ollama.");
    if (values["codex-command"] !== undefined && !values["codex-command"].trim()) throw new Error("--codex-command must be a nonempty executable name or path.");
    const reasoningEffort = values["reasoning-effort"] as CodexReasoningEffort | undefined;
    if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) throw new Error("--reasoning-effort must be none, minimal, low, medium, high, xhigh, max, or ultra; support depends on the selected model.");
    const maxOutputTokens = values["max-output-tokens"] === undefined ? undefined : Number(values["max-output-tokens"]);
    if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1_000_000)) throw new Error("--max-output-tokens must be an integer from 1 to 1000000.");
    if (values.reconciled !== undefined && (!values.resume || !values.reconciled.trim())) throw new Error("--reconciled requires --resume and an explicit note describing the checked business state.");
    if (values.resume && cdpUrl) throw new Error("--resume restores isolated contexts and cannot use --cdp-url.");
    const envName = values["api-key-env"] ?? "TABLAZE_API_KEY";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error("--api-key-env must name an environment variable.");
    const limit = (key: "max-steps" | "max-calls" | "run-timeout-ms", fallback: number, max: number) => {
      if (values.resume && values[key] === undefined) return undefined;
      const value = values[key] === undefined ? fallback : Number(values[key]);
      if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${key} must be an integer from 1 to ${max}.`);
      return value;
    };
    run = { task: values.task, startUrl: values["start-url"] === undefined ? undefined : normalizeStartUrl(values["start-url"]), provider, model: values.model, endpoint: values.endpoint, apiKey: provider === "codex" ? undefined : process.env[envName] || undefined, codexCommand: values["codex-command"], reasoningEffort, maxOutputTokens, maxSteps: limit("max-steps", 30, 1000), maxToolCalls: limit("max-calls", 100, 10000), ...(values["output-schema"] !== undefined ? { finalOutputSchema: loadOutputSchema(values["output-schema"]) } : {}), ...(values["partial-schema"] !== undefined ? { partialOutputSchema: loadOutputSchema(values["partial-schema"], "--partial-schema") } : {}), timeoutMs: limit("run-timeout-ms", 300000, 86400000), checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined, resumePath: values.resume ? resolve(values.resume) : undefined, reconciled: values.reconciled };
  } else if (runKeys.some(key => values[key] !== undefined)) throw new Error("Agent options require the run command.");
  return { command: positionals[0] ?? "stdio", options: { headless: !values.headed, channel, executablePath: executablePath ? resolve(executablePath) : undefined, cdpUrl, profileDir: values["profile-dir"] !== undefined ? resolve(values["profile-dir"]) : undefined, expectedProfileId: values["profile-id"], timeoutMs, popupPolicy, navigationPolicy, secrets, captureNetwork: values["capture-network"] ?? false, recordVideo: values["record-video"] ?? false, allowPageScript: values["page-script"] ?? false }, run };
}

function channelExecutable(channel: string): string | undefined {
  if (channel === "chromium") return chromium.executablePath();
  if (process.platform === "darwin") {
    const apps: Record<string, string> = { chrome: "Google Chrome", "chrome-beta": "Google Chrome Beta", "chrome-dev": "Google Chrome Dev", "chrome-canary": "Google Chrome Canary", msedge: "Microsoft Edge", "msedge-beta": "Microsoft Edge Beta", "msedge-dev": "Microsoft Edge Dev", "msedge-canary": "Microsoft Edge Canary" };
    const app = apps[channel];
    return app ? `/Applications/${app}.app/Contents/MacOS/${app}` : undefined;
  }
  if (process.platform === "linux") {
    const bins: Record<string, string> = { chrome: "/opt/google/chrome/chrome", "chrome-beta": "/opt/google/chrome-beta/chrome", "chrome-dev": "/opt/google/chrome-unstable/chrome", msedge: "/opt/microsoft/msedge/msedge", "msedge-beta": "/opt/microsoft/msedge-beta/msedge", "msedge-dev": "/opt/microsoft/msedge-dev/msedge" };
    return bins[channel];
  }
  if (process.platform === "win32") {
    const suffixes: Record<string, string> = { chrome: "Google/Chrome/Application/chrome.exe", "chrome-beta": "Google/Chrome Beta/Application/chrome.exe", "chrome-dev": "Google/Chrome Dev/Application/chrome.exe", "chrome-canary": "Google/Chrome SxS/Application/chrome.exe", msedge: "Microsoft/Edge/Application/msedge.exe", "msedge-beta": "Microsoft/Edge Beta/Application/msedge.exe", "msedge-dev": "Microsoft/Edge Dev/Application/msedge.exe", "msedge-canary": "Microsoft/Edge SxS/Application/msedge.exe" };
    const suffix = suffixes[channel];
    if (!suffix) return undefined;
    const candidates = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((path): path is string => Boolean(path)).map(path => join(path, suffix));
    return candidates.find(existsSync) ?? candidates[0];
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
  catch { return false; }
}

function detectedBrowserVersion(executable: string | undefined): string | null {
  if (!executable || process.platform !== "darwin") return null;
  const appRoot = executable.match(/^(.*\.app)\/Contents\//)?.[1];
  if (!appRoot) return null;
  try {
    const plist = readFileSync(join(appRoot, "Contents", "Info.plist"), "utf8");
    return plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch { return null; }
}

function doctor(options: BrowserOptions): void {
  const playwrightPackage = JSON.parse(readFileSync(require.resolve("playwright/package.json"), "utf8"));
  const registry = JSON.parse(readFileSync(join(dirname(require.resolve("playwright-core/package.json")), "browsers.json"), "utf8"));
  const managed = registry.browsers.find((entry: { name: string }) => entry.name === "chromium");
  const executable = options.cdpUrl ? undefined : options.executablePath ?? (options.channel ? channelExecutable(options.channel) : chromium.executablePath());
  const installed = executable ? isExecutableFile(executable) : null;
  const bundled = !options.cdpUrl && !options.executablePath && (!options.channel || options.channel === "chromium");
  const output = {
    tablaze_version: SERVER_VERSION, node_version: process.version, platform: process.platform, architecture: process.arch,
    playwright_version: playwrightPackage.version, mode: options.cdpUrl ? "cdp" : "isolated",
    browser: { source: options.cdpUrl ? "external-cdp" : options.executablePath ? "executable" : options.channel ?? "managed-chromium", executable: executable ?? null, installed, detected_version: detectedBrowserVersion(executable), expected_managed_version: bundled ? managed?.browserVersion ?? null : null, expected_managed_revision: bundled ? managed?.revision ?? null : null },
    headless: options.cdpUrl ? null : options.headless, timeout_ms: options.timeoutMs, popup_policy: options.popupPolicy ?? "stay", record_video: options.recordVideo ?? false,
    navigation_policy: { enabled: options.navigationPolicy !== undefined, allowed_origin_count: options.navigationPolicy?.allowedOrigins?.length ?? null, blocked_origin_count: options.navigationPolicy?.blockedOrigins?.length ?? 0 },
    secrets: { enabled: options.secrets !== undefined, alias_count: options.secrets?.secrets.length ?? 0, allow_sensitive_artifacts: options.secrets?.allowSensitiveArtifacts ?? false },
    ready: options.cdpUrl ? null : installed,
    next_step: options.cdpUrl ? "CDP configuration supplied. No connection was attempted; endpoint details are omitted." : installed ? "The browser executable exists. Run an MCP smoke test to verify launch permissions." : "Run tablaze setup, or select an installed browser with --channel chrome.",
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (installed === false) process.exitCode = 1;
}

async function setup(): Promise<void> {
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`Chromium setup failed (${signal ?? code ?? "unknown"}).`)));
  });
}

interface RunCheckpointFile { version: 1; savedAt: string; agent: AgentCheckpoint; browser: BrowserWorkspace }
async function loadRunCheckpoint(path: string): Promise<RunCheckpointFile> {
  if ((await stat(path)).size > 64 * 1024 * 1024) throw new Error("Checkpoint file exceeds 64 MiB.");
  const encoded = await readFile(path, "utf8");
  let value: RunCheckpointFile;
  // SyntaxError messages can quote private cookies, tokens or page history.
  try { value = JSON.parse(encoded) as RunCheckpointFile; }
  catch { throw new Error("Run checkpoint must contain valid JSON."); }
  if (!value || value.version !== 1 || !value.browser || value.browser.version !== 1 || !Array.isArray(value.browser.sessions)) throw new Error("Invalid run checkpoint envelope.");
  return { ...value, agent: parseAgentCheckpoint(value.agent) };
}
async function saveRunCheckpoint(path: string, value: RunCheckpointFile): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.tablaze-${randomUUID()}.tmp`);
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error("Checkpoint file exceeds 64 MiB.");
    await writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

async function main(): Promise<void> {
  const { command, options, run } = parseOptions();
  if (command === "help") { process.stdout.write(HELP); return; }
  if (command === "version") { process.stdout.write(`${SERVER_VERSION}\n`); return; }
  if (command === "doctor") { doctor(options); return; }
  if (command === "setup") { await setup(); return; }
  if (command === "run" && run) {
    const saved = run.resumePath ? await loadRunCheckpoint(run.resumePath) : undefined;
    if (saved && run.task && run.task !== saved.agent.task) throw new Error("A resumed run must retain the saved task.");
    if (saved && saved.agent.outputSchemaHash !== (run.finalOutputSchema === undefined ? undefined : compileFinalOutput(run.finalOutputSchema).hash)) throw new Error("A resumed run must supply its original --output-schema file before browser restoration.");
    if (saved && saved.agent.partialSchemaHash !== (run.partialOutputSchema === undefined ? undefined : compileFinalOutput(run.partialOutputSchema).hash)) throw new Error("A resumed run must supply its original --partial-schema file before browser restoration.");
    if (saved && run.startUrl !== undefined && run.startUrl !== saved.agent.initialization?.url) throw new Error("A resumed run cannot add or change its saved startUrl.");
    if (saved?.agent.executionIdentity) throw new Error("This checkpoint requires its application's bound tool registry. Resume it through the SDK with the original context and tool contracts; the CLI cannot restore these handlers.");
    if (saved && options.popupPolicy !== undefined && options.popupPolicy !== (saved.browser.popupPolicy ?? "stay")) throw new Error("A resumed run must retain its saved popup policy.");
    if (saved?.agent.requiresCompletionPolicy) throw new Error("This checkpoint requires its application validateCompletion policy. Resume through the library with that policy; the CLI cannot restore executable application code.");
    if (saved?.agent.requiresPartialPolicy) throw new Error("This checkpoint requires its application validatePartial policy. Resume through the library with that policy; the CLI cannot restore executable application code.");
    if (saved && (saved.agent.steps >= (run.maxSteps ?? saved.agent.limits.maxSteps) || saved.agent.toolCalls >= (run.maxToolCalls ?? saved.agent.limits.maxToolCalls) || saved.agent.elapsedMs >= (run.timeoutMs ?? saved.agent.limits.timeoutMs))) {
      process.stdout.write(`${JSON.stringify({ status: "limit_reached", reason: "The saved run has exhausted the requested budget; no browser or model was started. Increase the relevant limit explicitly to continue.", steps: saved.agent.steps, tool_calls: saved.agent.toolCalls, planner_calls: saved.agent.plannerCalls, ...(saved.agent.partialSchemaHash ? { partials: saved.agent.partials } : {}) }, null, 2)}\n`);
      process.exitCode = 1; return;
    }
    const uncertain = saved ? [...new Set([...saved.agent.ambiguousCalls.map(call => call.id), ...(saved.agent.pendingTool?.mutating ? [saved.agent.pendingTool.call.id] : [])])] : [];
    if (uncertain.length && !run.reconciled) {
      process.stdout.write(`${JSON.stringify({ status: "needs_input", reason: "The saved run has actions with unknown outcomes. Check the business state before using --reconciled with an explicit note; no browser or model was started.", unresolved_tool_calls: uncertain, ...(saved!.agent.partialSchemaHash ? { partials: saved!.agent.partials } : {}) }, null, 2)}\n`);
      process.exitCode = 2; return;
    }
    const usage: Record<string, unknown>[] = [];
    const providerDiagnostics: Record<string, unknown>[] = [];
    const onUsage = (entry: AgentModelUsage) => { usage.push({ ...entry }); };
    const httpPlannerOptions = { endpoint: run.endpoint, model: run.model, apiKey: run.apiKey, maxOutputTokens: run.maxOutputTokens, onUsage };
    const codexPlanner = run.provider === "codex" ? createCodexPlanner({
      model: run.model, codexCommand: run.codexCommand, reasoningEffort: run.reasoningEffort, onUsage,
      onDiagnostic: diagnostic => { providerDiagnostics.push({ ...diagnostic }); },
    }) : undefined;
    const planner = codexPlanner ?? (run.provider === "anthropic" ? createAnthropicPlanner(httpPlannerOptions)
      : run.provider === "ollama" ? createOllamaPlanner(httpPlannerOptions)
      : createOpenAICompatiblePlanner({ ...httpPlannerOptions, endpoint: run.endpoint! }));
    const { server, engine, dispose } = createServer(options);
    const connection = await connectAgentTools(server);
    const controller = new AbortController();
    let report: Record<string, unknown> | undefined;
    let cleanupFailure: { code: string; message: string } | undefined;
    const recordCleanupFailure = (error: unknown, fixed?: { code: string; message: string }) => {
      if (!cleanupFailure) {
        cleanupFailure = fixed ?? (error instanceof BrowserError ? { code: error.code, message: error.message } : { code: "CLEANUP_FAILED", message: "Browser or MCP resource cleanup failed." });
        process.stderr.write(`Tablaze cleanup failed (${cleanupFailure.code}): ${cleanupFailure.message}\n`);
      }
      process.exitCode = 1;
    };
    const abort = () => controller.abort(new Error("Task interrupted."));
    process.once("SIGINT", abort); process.once("SIGTERM", abort);
    try {
      let restored: Awaited<ReturnType<typeof engine.restoreWorkspace>> | undefined;
      if (saved) {
        const start = performance.now();
        let expired = false;
        const stopRestoring = () => { void dispose().catch(recordCleanupFailure); };
        const timer = setTimeout(() => { expired = true; stopRestoring(); }, (run.timeoutMs ?? saved.agent.limits.timeoutMs) - saved.agent.elapsedMs);
        controller.signal.addEventListener("abort", stopRestoring, { once: true });
        try {
          if (controller.signal.aborted) throw new Error("Task interrupted before browser restoration.");
          restored = await engine.restoreWorkspace(saved.browser);
          if (expired || controller.signal.aborted) throw new Error("Task interrupted or exhausted its time budget while restoring browser state.");
          saved.agent.elapsedMs += performance.now() - start;
        } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", stopRestoring); }
      }
      let workspace: BrowserWorkspace = await engine.exportWorkspace();
      const checkpointPath = run.checkpointPath ?? run.resumePath;
      const result = await runAgent({ task: run.task ?? saved!.agent.task, startUrl: run.startUrl, planner, tools: connection.tools, maxSteps: run.maxSteps, maxToolCalls: run.maxToolCalls, timeoutMs: run.timeoutMs, finalOutputSchema: run.finalOutputSchema, partialOutputSchema: run.partialOutputSchema, signal: controller.signal,
        resume: saved?.agent, resumeSessionMap: restored?.sessionMap,
        resumeFeedback: restored ? `Browser contexts were recreated from the saved workspace. A session marked requires_reauthentication did not restore its login state or original URLs: use an address authorized by the user task and log in again with the available secret aliases before continuing. Other sessions restored their saved cookies/localStorage/IndexedDB and URLs. DOM, form drafts and sessionStorage were not restored. Old refs are invalid. Observe every needed tab before acting. Reauthentication does not reconcile unknown earlier writes. Restored sessions: ${JSON.stringify(restored.snapshots.map(snapshot => ({ session_id: snapshot.session_id, tab_id: snapshot.tab_id, tabs: snapshot.tabs, url: snapshot.url, requires_reauthentication: snapshot.requires_reauthentication === true })))}` : undefined,
        reconciliation: run.reconciled ? { resolvedCallIds: uncertain, note: run.reconciled } : undefined,
        onCheckpoint: checkpointPath ? async checkpoint => {
          const persistenceStart = performance.now();
          if ((checkpoint.phase === "decision" || checkpoint.phase === "terminal") && !checkpoint.pendingTool && !checkpoint.ambiguousCalls.length) workspace = await engine.exportWorkspace();
          await saveRunCheckpoint(checkpointPath, { version: 1, savedAt: new Date().toISOString(), agent: { ...checkpoint, elapsedMs: Math.round(checkpoint.elapsedMs + performance.now() - persistenceStart) }, browser: workspace });
        } : undefined,
        onEvent: event => { if (event.type === "planning") process.stderr.write(`Tablaze: planning step ${event.step}\n`); },
      });
      // Default CLI output omits raw prompts, tool arguments and page history.
      report = { status: result.status, reason: result.reason, ...(result.failure ? { failure: result.failure } : {}), summary: result.summary, ...(result.status === "succeeded" && result.data !== undefined ? { data: result.data } : {}), ...(run.partialOutputSchema ? { partials: result.partials } : {}), question: result.question, steps: result.steps, tool_calls: result.toolCalls, planner_calls: result.plannerCalls, checkpoint: checkpointPath, model_usage: usage, ...(codexPlanner ? { provider_diagnostics: providerDiagnostics } : {}), verification: result.evidence.map(item => ({ tool_call_id: item.toolCallId, session_id: item.sessionId, checks: item.checks })) };
      if (result.status !== "succeeded") process.exitCode = result.status === "needs_input" ? 2 : 1;
    } finally {
      process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
      try { await dispose(); } catch (error) { recordCleanupFailure(error); }
      try { await connection.close(); } catch (error) { recordCleanupFailure(error); }
      // Cancellation can return before the local inference child flushes its
      // final usage. Drain it before serializing the report, including failures.
      try { await codexPlanner?.close(); }
      catch { recordCleanupFailure(undefined, { code: "CODEX_CLEANUP_FAILED", message: "Codex planner cleanup did not complete." }); }
      if (report && options.recordVideo) report.recordings = engine.recordings();
      if (cleanupFailure) {
        process.exitCode = 1;
        if (report) report = { ...report, agent_status: report.status, agent_reason: report.reason, status: "failed", reason: "Resource cleanup did not complete; inspect the cleanup error.", cleanup: { status: "incomplete", ...cleanupFailure } };
      }
      if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return;
  }
  const { server, dispose } = createServer(options);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 8_000);
    deadline.unref();
    try {
      try { await dispose(); }
      catch (error) { process.stderr.write(error instanceof BrowserError ? `Tablaze cleanup failed (${error.code}): ${error.message}\n` : "Tablaze: browser cleanup failed.\n"); process.exitCode = 1; }
      try { await server.close(); }
      catch { process.stderr.write("Tablaze: MCP transport cleanup failed.\n"); process.exitCode = 1; }
    } finally { clearTimeout(deadline); }
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.stdin.once("end", () => { void shutdown(); });
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  const message = error instanceof Error ? error.message.replace(/(https?:\/\/|wss?:\/\/)[^\s]+/gi, "[endpoint]") : "Startup failed.";
  process.stderr.write(`Tablaze: ${message}\n`);
  process.exitCode = 1;
});
