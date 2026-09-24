#!/usr/bin/env node
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
import { normalizeStartUrl, uniqueTaskStartUrl, parseAgentCheckpoint, type AgentCheckpoint } from "./checkpoint.js";
import { compileNavigationPolicy, type NavigationPolicy } from "./navigation-policy.js";
import { loadSecretConfig } from "./secret-config.js";
import { compileFinalOutput } from "./final-output.js";
import { DEVICE_PRESETS, devicePresetOptions, type DevicePreset } from "./device-presets.js";
import type { ExtractionSchema } from "./extraction.js";
import { createModelExtractionToolClient } from "./model-extraction.js";

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
  --record-har              Save an owned-session network HAR / 保存会话网络 HAR
  --har-content <mode>      omit (default), embed or attach / HAR 内容保存方式
  --har-mode <mode>         full (default) or minimal / HAR 记录详情
  --record-trace            Save an owned-session Playwright trace / 保存会话浏览器追踪
  --viewport <WIDTHxHEIGHT>  Browser viewport, 320–3840 × 240–2160 / 页面视口
  --no-viewport            Let the content follow the real browser window / 页面跟随浏览器窗口
  --window-size <WxH>       Headed browser window size / 有头窗口尺寸
  --window-position=<X,Y>  Headed browser window position / 有头窗口位置
  --device-preset <name>    pixel-7 or pixel-7-pro / 一键移动设备预设
  --screen <WIDTHxHEIGHT>    Emulated screen size / 模拟屏幕尺寸
  --device-scale-factor <n>  Browser pixel ratio, 0.5–4 / 设备像素比
  --user-agent <text>       Browser user agent / 浏览器标识
  --locale <tag>            BCP 47 page locale / 页面语言地区
  --timezone <name>        IANA page time zone / 页面时区
  --mobile                 Enable mobile viewport behavior / 移动端视口行为
  --touch                  Enable touch input / 触控输入
  --permissions <names>     Comma-separated browser permissions / 浏览器权限
  --proxy-server <url>      HTTP(S)/SOCKS5 proxy for owned contexts / 自有浏览器代理
  --proxy-bypass <hosts>    Comma-separated proxy bypass rules / 代理绕过规则
  --proxy-username <name>   Proxy username, if required / 代理用户名
  --proxy-password-env <n>  Read proxy password from this env var / 从环境变量读取代理密码
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
  --available-file <path>  Repeat for each exact local file the Agent may upload
  --storage-state-file <path>  Load trusted Playwright auth state into each new isolated session
  --help                    Print this help / 帮助
  --version                 Print the version / 版本

Agent run options / 任务执行选项:
  --task <text>             Requested task / 任务描述
  --start-url <url>         Open this explicit URL once before planning / 首次规划前打开指定网址
  --direct-open-task-url    Open one unambiguous URL in the task before planning
  --model <id>              Model supporting tools / 支持工具的模型
  --provider <name>         openai-compatible (default), codex, anthropic, ollama
  --endpoint <url>          Full HTTP model endpoint; required for openai-compatible
  --api-key-env <name>      Read key from this env var (default TABLAZE_API_KEY)
  --codex-command <path>    Codex executable (default codex); codex only
  --reasoning-effort <id>   Explicit Codex reasoning effort; model support varies
  --max-output-tokens <n>   Anthropic max_tokens / Ollama num_predict (1-1000000)
  --planner-retries <0-5>   Retry transient model failures before fallback
  --planner-retry-delay-ms <ms>  Delay between transient retries (0-30000)
  --fallback-provider <id>  Backup provider; defaults to primary provider
  --fallback-model <id>     Enable a backup model for eligible failures
  --fallback-endpoint <url> Backup HTTP endpoint; required for a distinct compatible provider
  --fallback-api-key-env <name>  Backup HTTP key environment variable
  --fallback-codex-command <path>  Backup Codex executable
  --fallback-reasoning-effort <id>  Backup Codex reasoning effort
  --fallback-max-output-tokens <n>  Backup Anthropic/Ollama output limit
  --extraction-model <id>  Enable a separate model for browser-bound schema extraction
  --extraction-provider <id>  Extraction provider; defaults to primary provider
  --extraction-endpoint <url>  Extraction HTTP endpoint when distinct from primary
  --extraction-api-key-env <name>  Extraction HTTP key environment variable
  --extraction-codex-command <path>  Extraction Codex executable
  --extraction-reasoning-effort <id>  Extraction Codex reasoning effort
  --extraction-max-output-tokens <n>  Extraction Anthropic/Ollama output limit
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
  task?: string; startUrl?: string; directOpenTaskUrl?: boolean; provider: RunProvider; model: string; endpoint?: string; apiKey?: string;
  codexCommand?: string; reasoningEffort?: CodexReasoningEffort; maxOutputTokens?: number;
  maxSteps?: number; maxToolCalls?: number; timeoutMs?: number; checkpointPath?: string; resumePath?: string; reconciled?: string;
  finalOutputSchema?: ExtractionSchema;
  partialOutputSchema?: ExtractionSchema;
  plannerRetries?: number; plannerRetryDelayMs?: number;
  fallback?: { provider: RunProvider; model: string; endpoint?: string; apiKey?: string; codexCommand?: string; reasoningEffort?: CodexReasoningEffort; maxOutputTokens?: number };
  extraction?: { provider: RunProvider; model: string; endpoint?: string; apiKey?: string; codexCommand?: string; reasoningEffort?: CodexReasoningEffort; maxOutputTokens?: number };
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
    options: { headless: { type: "boolean" }, headed: { type: "boolean" }, "capture-network": { type: "boolean" }, "record-video": { type: "boolean" }, "record-har": { type: "boolean" }, "har-content": { type: "string" }, "har-mode": { type: "string" }, "record-trace": { type: "boolean" }, "device-preset": { type: "string" }, viewport: { type: "string" }, "no-viewport": { type: "boolean" }, "window-size": { type: "string" }, "window-position": { type: "string" }, screen: { type: "string" }, "device-scale-factor": { type: "string" }, "user-agent": { type: "string" }, locale: { type: "string" }, timezone: { type: "string" }, mobile: { type: "boolean" }, touch: { type: "boolean" }, permissions: { type: "string" }, "proxy-server": { type: "string" }, "proxy-bypass": { type: "string" }, "proxy-username": { type: "string" }, "proxy-password-env": { type: "string" }, "page-script": { type: "boolean" }, "profile-dir": { type: "string" }, "profile-id": { type: "string" }, channel: { type: "string" }, "executable-path": { type: "string" }, "cdp-url": { type: "string" }, "timeout-ms": { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" }, task: { type: "string" }, "start-url": { type: "string" }, "direct-open-task-url": { type: "boolean" }, "popup-policy": { type: "string" }, "navigation-policy": { type: "string" }, "secret-config": { type: "string" }, model: { type: "string" }, provider: { type: "string" }, endpoint: { type: "string" }, "api-key-env": { type: "string" }, "codex-command": { type: "string" }, "reasoning-effort": { type: "string" }, "max-output-tokens": { type: "string" }, "planner-retries": { type: "string" }, "planner-retry-delay-ms": { type: "string" }, "fallback-provider": { type: "string" }, "fallback-model": { type: "string" }, "fallback-endpoint": { type: "string" }, "fallback-api-key-env": { type: "string" }, "fallback-codex-command": { type: "string" }, "fallback-reasoning-effort": { type: "string" }, "fallback-max-output-tokens": { type: "string" }, "extraction-provider": { type: "string" }, "extraction-model": { type: "string" }, "extraction-endpoint": { type: "string" }, "extraction-api-key-env": { type: "string" }, "extraction-codex-command": { type: "string" }, "extraction-reasoning-effort": { type: "string" }, "extraction-max-output-tokens": { type: "string" }, "available-file": { type: "string", multiple: true }, "storage-state-file": { type: "string" }, "max-steps": { type: "string" }, "max-calls": { type: "string" }, "output-schema": { type: "string" }, "partial-schema": { type: "string" }, "run-timeout-ms": { type: "string" }, checkpoint: { type: "string" }, resume: { type: "string" }, reconciled: { type: "string" } },
    allowPositionals: true, strict: true,
  });
  if (values.help) return { command: "help", options: {} };
  if (values.version) return { command: "version", options: {} };
  if (positionals.length > 1 || (positionals[0] && !["doctor", "setup", "run"].includes(positionals[0]))) throw new Error("Expected no command, doctor, setup, or run. Run tablaze --help.");
  if (values.headless && values.headed) throw new Error("Choose either --headless or --headed.");
  if (values["page-script"] && (values["secret-config"] || values["cdp-url"] || values["navigation-policy"])) throw new Error("--page-script cannot be combined with --secret-config, --cdp-url, or --navigation-policy.");
  const cdpUrl = values["cdp-url"];
  if (!values["proxy-server"] && (values["proxy-bypass"] !== undefined || values["proxy-username"] !== undefined || values["proxy-password-env"] !== undefined)) throw new Error("Proxy bypass and credentials require --proxy-server.");
  if (cdpUrl && values["proxy-server"]) throw new Error("--proxy-server requires an owned browser, not --cdp-url.");
  const proxyPasswordEnv = values["proxy-password-env"];
  if (proxyPasswordEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(proxyPasswordEnv)) throw new Error("--proxy-password-env must name an environment variable.");
  if (proxyPasswordEnv && process.env[proxyPasswordEnv] === undefined) throw new Error("The named proxy password environment variable is not set.");
  const proxy = values["proxy-server"] === undefined ? undefined : { server: values["proxy-server"], bypass: values["proxy-bypass"], username: values["proxy-username"], password: proxyPasswordEnv ? process.env[proxyPasswordEnv] : undefined };
  if (proxy) {
    let parsed: URL;
    try { parsed = new URL(proxy.server); } catch { throw new Error("--proxy-server must be a valid HTTP(S) or SOCKS5 URL."); }
    if (!['http:', 'https:', 'socks5:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash || proxy.server.length > 2048 || proxy.bypass && proxy.bypass.length > 1024 || proxy.username && proxy.username.length > 512 || proxy.password && proxy.password.length > 512) throw new Error("--proxy-server must be an HTTP(S) or SOCKS5 URL without embedded credentials or a path.");
  }
  const devicePreset = values["device-preset"] as DevicePreset | undefined;
  if (devicePreset !== undefined && !DEVICE_PRESETS.includes(devicePreset)) throw new Error(`--device-preset must be one of ${DEVICE_PRESETS.join(", ")}.`);
  if (devicePreset !== undefined && (values.viewport !== undefined || values["no-viewport"] || values.screen !== undefined || values["device-scale-factor"] !== undefined || values["user-agent"] !== undefined || values.mobile || values.touch)) throw new Error("--device-preset cannot be combined with manual device emulation flags.");
  if (cdpUrl && (devicePreset !== undefined || values.viewport !== undefined || values["no-viewport"] || values["window-size"] !== undefined || values["window-position"] !== undefined || values.screen !== undefined || values["device-scale-factor"] !== undefined || values["user-agent"] !== undefined || values.locale !== undefined || values.timezone !== undefined || values.mobile || values.touch || values.permissions !== undefined)) throw new Error("Browser emulation and permissions require an owned browser context, not --cdp-url.");
  const viewportMatch = values.viewport?.match(/^(\d+)x(\d+)$/i);
  if (values.viewport !== undefined && !viewportMatch) throw new Error("--viewport must use WIDTHxHEIGHT.");
  const viewport = viewportMatch ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) } : undefined;
  if (viewport && (viewport.width < 320 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160)) throw new Error("--viewport width must be 320–3840 and height 240–2160.");
  if (values["no-viewport"] && (viewport || devicePreset || values.screen !== undefined || values.mobile)) throw new Error("--no-viewport cannot be combined with fixed viewport or mobile/screen emulation.");
  const windowSizeMatch = values["window-size"]?.match(/^(\d+)x(\d+)$/i);
  if (values["window-size"] !== undefined && !windowSizeMatch) throw new Error("--window-size must use WIDTHxHEIGHT.");
  const windowSize = windowSizeMatch ? { width: Number(windowSizeMatch[1]), height: Number(windowSizeMatch[2]) } : undefined;
  if (windowSize && (windowSize.width < 320 || windowSize.width > 3840 || windowSize.height < 240 || windowSize.height > 2160)) throw new Error("--window-size width must be 320–3840 and height 240–2160.");
  const windowPositionMatch = values["window-position"]?.match(/^(-?\d+),(-?\d+)$/);
  if (values["window-position"] !== undefined && !windowPositionMatch) throw new Error("--window-position must use X,Y.");
  const windowPosition = windowPositionMatch ? { x: Number(windowPositionMatch[1]), y: Number(windowPositionMatch[2]) } : undefined;
  if (windowPosition && (Math.abs(windowPosition.x) > 10000 || Math.abs(windowPosition.y) > 10000)) throw new Error("--window-position coordinates must be from -10000 to 10000.");
  if ((windowSize || windowPosition) && !values.headed) throw new Error("--window-size and --window-position require --headed.");
  const screenMatch = values.screen?.match(/^(\d+)x(\d+)$/i);
  if (values.screen !== undefined && !screenMatch) throw new Error("--screen must use WIDTHxHEIGHT.");
  const screen = screenMatch ? { width: Number(screenMatch[1]), height: Number(screenMatch[2]) } : undefined;
  if (screen && (screen.width < 320 || screen.width > 3840 || screen.height < 240 || screen.height > 2160)) throw new Error("--screen width must be 320–3840 and height 240–2160.");
  const deviceScaleFactor = values["device-scale-factor"] === undefined ? undefined : Number(values["device-scale-factor"]);
  if (deviceScaleFactor !== undefined && (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0.5 || deviceScaleFactor > 4)) throw new Error("--device-scale-factor must be a number from 0.5 to 4.");
  if (values["user-agent"] !== undefined && (!values["user-agent"].trim() || values["user-agent"].length > 1024 || /[\u0000-\u001f\u007f]/.test(values["user-agent"]))) throw new Error("--user-agent must be a nonempty printable string of at most 1024 characters.");
  if (values.locale !== undefined) { try { if (!values.locale.trim() || values.locale.length > 80) throw new Error(); new Intl.Locale(values.locale); } catch { throw new Error("--locale must be a valid BCP 47 language tag."); } }
  if (values.timezone !== undefined) { try { if (!values.timezone.trim() || values.timezone.length > 100) throw new Error(); new Intl.DateTimeFormat('en-US', { timeZone: values.timezone }); } catch { throw new Error("--timezone must be a supported IANA time zone."); } }
  const permissions = values.permissions === undefined ? undefined : values.permissions.split(',').map(value => value.trim());
  const allowedPermissions = new Set(['geolocation', 'notifications', 'clipboard-read', 'clipboard-write', 'camera', 'microphone', 'midi', 'midi-sysex', 'background-sync', 'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer', 'accessibility-events', 'payment-handler']);
  if (permissions && (permissions.length > 15 || permissions.some(value => !allowedPermissions.has(value)) || new Set(permissions).size !== permissions.length)) throw new Error("--permissions must be a comma-separated unique list of supported permission names.");
  if (values["profile-id"] && !values["profile-dir"]) throw new Error("--profile-id requires --profile-dir.");
  if (values["profile-dir"] !== undefined && !values["profile-dir"].trim()) throw new Error("--profile-dir must name a dedicated directory.");
  if (values["profile-dir"] && cdpUrl) throw new Error("--profile-dir cannot be combined with --cdp-url.");
  if (values["profile-dir"] && values["navigation-policy"]) throw new Error("--profile-dir cannot be combined with --navigation-policy because restored pages can load before the guard starts.");
  if (values["record-video"] && (values["profile-dir"] || cdpUrl)) throw new Error("--record-video requires isolated owned browser contexts; do not combine it with --profile-dir or --cdp-url.");
  if ((values["record-har"] || values["record-trace"]) && (values["profile-dir"] || cdpUrl)) throw new Error("--record-har and --record-trace require isolated owned browser contexts; do not combine them with --profile-dir or --cdp-url.");
  if ((values["har-content"] !== undefined || values["har-mode"] !== undefined) && !values["record-har"]) throw new Error("--har-content and --har-mode require --record-har.");
  if (values["har-content"] !== undefined && !['omit', 'embed', 'attach'].includes(values["har-content"])) throw new Error("--har-content must be omit, embed, or attach.");
  if (values["har-mode"] !== undefined && !['full', 'minimal'].includes(values["har-mode"])) throw new Error("--har-mode must be full or minimal.");
  if (values["profile-dir"] && positionals[0] === "setup") throw new Error("--profile-dir applies to MCP, run, or doctor, not setup.");
  if (values["profile-dir"] && (values.checkpoint || values.resume)) throw new Error("Persistent profiles cannot be combined with CLI checkpoints until profile identity is bound into the checkpoint contract.");
  if (values["navigation-policy"] !== undefined && cdpUrl) throw new Error("--navigation-policy cannot be combined with --cdp-url; it requires isolated browser contexts.");
  if (values["navigation-policy"] !== undefined && positionals[0] === "setup") throw new Error("--navigation-policy applies to MCP, run, or doctor, not setup.");
  if (values["secret-config"] !== undefined && cdpUrl) throw new Error("--secret-config cannot be combined with --cdp-url; it requires isolated browser contexts.");
  if (values["secret-config"] !== undefined && positionals[0] === "setup") throw new Error("--secret-config applies to MCP, run, or doctor, not setup.");
  const availableFilePaths = values["available-file"];
  if (availableFilePaths !== undefined && (positionals[0] === "setup" || positionals[0] === "doctor")) throw new Error("--available-file applies to MCP or run.");
  if (availableFilePaths && (availableFilePaths.length > 20 || availableFilePaths.some(path => !isAbsolute(path) || path.length > 4096))) throw new Error("--available-file requires at most 20 absolute local file paths.");
  const storageStateFile = values["storage-state-file"];
  if (storageStateFile !== undefined && (positionals[0] === "setup" || positionals[0] === "doctor")) throw new Error("--storage-state-file applies to MCP or run.");
  if (storageStateFile !== undefined && (!isAbsolute(storageStateFile) || storageStateFile.length > 4096 || cdpUrl || values["profile-dir"])) throw new Error("--storage-state-file requires an absolute path and a fresh isolated browser context.");
  const secrets = values["secret-config"] === undefined ? undefined : loadSecretConfig(values["secret-config"]);
  if (values["record-video"] && secrets && !secrets.allowSensitiveArtifacts) throw new Error("--record-video with --secret-config requires allowSensitiveArtifacts in the trusted secret configuration.");
  if ((values["record-har"] || values["record-trace"]) && secrets && !secrets.allowSensitiveArtifacts) throw new Error("HAR and trace recording with --secret-config requires allowSensitiveArtifacts in the trusted secret configuration.");
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
  const runKeys = ["task", "start-url", "direct-open-task-url", "model", "provider", "endpoint", "api-key-env", "codex-command", "reasoning-effort", "max-output-tokens", "planner-retries", "planner-retry-delay-ms", "fallback-provider", "fallback-model", "fallback-endpoint", "fallback-api-key-env", "fallback-codex-command", "fallback-reasoning-effort", "fallback-max-output-tokens", "extraction-provider", "extraction-model", "extraction-endpoint", "extraction-api-key-env", "extraction-codex-command", "extraction-reasoning-effort", "extraction-max-output-tokens", "max-steps", "max-calls", "output-schema", "partial-schema", "run-timeout-ms", "checkpoint", "resume", "reconciled"] as const;
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
    const plannerRetries = values["planner-retries"] === undefined ? undefined : Number(values["planner-retries"]);
    if (plannerRetries !== undefined && (!Number.isInteger(plannerRetries) || plannerRetries < 0 || plannerRetries > 5)) throw new Error("--planner-retries must be an integer from 0 to 5.");
    const plannerRetryDelayMs = values["planner-retry-delay-ms"] === undefined ? undefined : Number(values["planner-retry-delay-ms"]);
    if (plannerRetryDelayMs !== undefined && (!Number.isInteger(plannerRetryDelayMs) || plannerRetryDelayMs < 0 || plannerRetryDelayMs > 30_000 || !plannerRetries)) throw new Error("--planner-retry-delay-ms requires --planner-retries from 1 to 5 and a delay from 0 to 30000.");
    const fallbackKeys = ["fallback-provider", "fallback-model", "fallback-endpoint", "fallback-api-key-env", "fallback-codex-command", "fallback-reasoning-effort", "fallback-max-output-tokens"] as const;
    if (fallbackKeys.some(key => values[key] !== undefined) && !values["fallback-model"]?.trim()) throw new Error("Fallback options require a nonempty --fallback-model.");
    const fallbackProvider = (values["fallback-provider"] ?? provider) as RunProvider;
    if (values["fallback-model"] && !PROVIDERS.has(fallbackProvider)) throw new Error("--fallback-provider must be openai-compatible, codex, anthropic, or ollama.");
    if (values["fallback-model"] && fallbackProvider === "codex" && ["fallback-endpoint", "fallback-api-key-env", "fallback-max-output-tokens"].some(key => values[key as keyof typeof values] !== undefined)) throw new Error("HTTP fallback options do not apply to Codex; use the existing Codex login.");
    if (values["fallback-model"] && fallbackProvider !== "codex" && (values["fallback-codex-command"] !== undefined || values["fallback-reasoning-effort"] !== undefined)) throw new Error("Backup Codex options require --fallback-provider codex.");
    if (values["fallback-model"] && fallbackProvider === "openai-compatible" && values["fallback-max-output-tokens"] !== undefined) throw new Error("--fallback-max-output-tokens applies only to Anthropic or Ollama.");
    if (values["fallback-codex-command"] !== undefined && !values["fallback-codex-command"].trim()) throw new Error("--fallback-codex-command must be a nonempty executable name or path.");
    const fallbackReasoningEffort = values["fallback-reasoning-effort"] as CodexReasoningEffort | undefined;
    if (fallbackReasoningEffort !== undefined && !REASONING_EFFORTS.has(fallbackReasoningEffort)) throw new Error("--fallback-reasoning-effort must be a supported Codex reasoning effort.");
    const fallbackMaxOutputTokens = values["fallback-max-output-tokens"] === undefined ? undefined : Number(values["fallback-max-output-tokens"]);
    if (fallbackMaxOutputTokens !== undefined && (!Number.isInteger(fallbackMaxOutputTokens) || fallbackMaxOutputTokens < 1 || fallbackMaxOutputTokens > 1_000_000)) throw new Error("--fallback-max-output-tokens must be an integer from 1 to 1000000.");
    const fallbackEndpoint = values["fallback-endpoint"] ?? (fallbackProvider === provider ? values.endpoint : undefined);
    if (values["fallback-model"] && fallbackProvider === "openai-compatible" && !fallbackEndpoint?.trim()) throw new Error("An openai-compatible fallback requires --fallback-endpoint unless it shares the primary endpoint.");
    const fallbackKeyName = values["fallback-api-key-env"] ?? (fallbackProvider === provider ? envName : "TABLAZE_FALLBACK_API_KEY");
    if (values["fallback-model"] && fallbackProvider !== "codex" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fallbackKeyName)) throw new Error("--fallback-api-key-env must name an environment variable.");
    const fallback = values["fallback-model"] ? { provider: fallbackProvider, model: values["fallback-model"], endpoint: fallbackEndpoint, apiKey: fallbackProvider === "codex" ? undefined : process.env[fallbackKeyName] || undefined, codexCommand: values["fallback-codex-command"] ?? (fallbackProvider === provider ? values["codex-command"] : undefined), reasoningEffort: fallbackReasoningEffort ?? (fallbackProvider === provider ? reasoningEffort : undefined), maxOutputTokens: fallbackMaxOutputTokens ?? (fallbackProvider === provider ? maxOutputTokens : undefined) } : undefined;
    const extractionKeys = ["extraction-provider", "extraction-model", "extraction-endpoint", "extraction-api-key-env", "extraction-codex-command", "extraction-reasoning-effort", "extraction-max-output-tokens"] as const;
    if (extractionKeys.some(key => values[key] !== undefined) && !values["extraction-model"]?.trim()) throw new Error("Extraction options require a nonempty --extraction-model.");
    const extractionProvider = (values["extraction-provider"] ?? provider) as RunProvider;
    if (values["extraction-model"] && !PROVIDERS.has(extractionProvider)) throw new Error("--extraction-provider must be openai-compatible, codex, anthropic, or ollama.");
    if (values["extraction-model"] && extractionProvider === "codex" && ["extraction-endpoint", "extraction-api-key-env", "extraction-max-output-tokens"].some(key => values[key as keyof typeof values] !== undefined)) throw new Error("HTTP extraction options do not apply to Codex.");
    if (values["extraction-model"] && extractionProvider !== "codex" && (values["extraction-codex-command"] !== undefined || values["extraction-reasoning-effort"] !== undefined)) throw new Error("Extraction Codex options require --extraction-provider codex.");
    if (values["extraction-model"] && extractionProvider === "openai-compatible" && values["extraction-max-output-tokens"] !== undefined) throw new Error("--extraction-max-output-tokens applies only to Anthropic or Ollama.");
    if (values["extraction-codex-command"] !== undefined && !values["extraction-codex-command"].trim()) throw new Error("--extraction-codex-command must be a nonempty executable name or path.");
    const extractionReasoningEffort = values["extraction-reasoning-effort"] as CodexReasoningEffort | undefined;
    if (extractionReasoningEffort !== undefined && !REASONING_EFFORTS.has(extractionReasoningEffort)) throw new Error("--extraction-reasoning-effort must be a supported Codex reasoning effort.");
    const extractionMaxOutputTokens = values["extraction-max-output-tokens"] === undefined ? undefined : Number(values["extraction-max-output-tokens"]);
    if (extractionMaxOutputTokens !== undefined && (!Number.isInteger(extractionMaxOutputTokens) || extractionMaxOutputTokens < 1 || extractionMaxOutputTokens > 1_000_000)) throw new Error("--extraction-max-output-tokens must be an integer from 1 to 1000000.");
    const extractionEndpoint = values["extraction-endpoint"] ?? (extractionProvider === provider ? values.endpoint : undefined);
    if (values["extraction-model"] && extractionProvider === "openai-compatible" && !extractionEndpoint?.trim()) throw new Error("An openai-compatible extraction model requires --extraction-endpoint unless it shares the primary endpoint.");
    const extractionKeyName = values["extraction-api-key-env"] ?? (extractionProvider === provider ? envName : "TABLAZE_EXTRACTION_API_KEY");
    if (values["extraction-model"] && extractionProvider !== "codex" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(extractionKeyName)) throw new Error("--extraction-api-key-env must name an environment variable.");
    const extraction = values["extraction-model"] ? { provider: extractionProvider, model: values["extraction-model"], endpoint: extractionEndpoint, apiKey: extractionProvider === "codex" ? undefined : process.env[extractionKeyName] || undefined, codexCommand: values["extraction-codex-command"] ?? (extractionProvider === provider ? values["codex-command"] : undefined), reasoningEffort: extractionReasoningEffort ?? (extractionProvider === provider ? reasoningEffort : undefined), maxOutputTokens: extractionMaxOutputTokens ?? (extractionProvider === provider ? maxOutputTokens : undefined) } : undefined;
    const limit = (key: "max-steps" | "max-calls" | "run-timeout-ms", fallback: number, max: number) => {
      if (values.resume && values[key] === undefined) return undefined;
      const value = values[key] === undefined ? fallback : Number(values[key]);
      if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${key} must be an integer from 1 to ${max}.`);
      return value;
    };
    run = { task: values.task, startUrl: values["start-url"] === undefined ? undefined : normalizeStartUrl(values["start-url"]), directOpenTaskUrl: values["direct-open-task-url"], provider, model: values.model, endpoint: values.endpoint, apiKey: provider === "codex" ? undefined : process.env[envName] || undefined, codexCommand: values["codex-command"], reasoningEffort, maxOutputTokens, plannerRetries, plannerRetryDelayMs, fallback, extraction, maxSteps: limit("max-steps", 30, 1000), maxToolCalls: limit("max-calls", 100, 10000), ...(values["output-schema"] !== undefined ? { finalOutputSchema: loadOutputSchema(values["output-schema"]) } : {}), ...(values["partial-schema"] !== undefined ? { partialOutputSchema: loadOutputSchema(values["partial-schema"], "--partial-schema") } : {}), timeoutMs: limit("run-timeout-ms", 300000, 86400000), checkpointPath: values.checkpoint ? resolve(values.checkpoint) : undefined, resumePath: values.resume ? resolve(values.resume) : undefined, reconciled: values.reconciled };
  } else if (runKeys.some(key => values[key] !== undefined)) throw new Error("Agent options require the run command.");
  return { command: positionals[0] ?? "stdio", options: { headless: !values.headed, channel, executablePath: executablePath ? resolve(executablePath) : undefined, cdpUrl, profileDir: values["profile-dir"] !== undefined ? resolve(values["profile-dir"]) : undefined, expectedProfileId: values["profile-id"], devicePreset, viewport, noViewport: values["no-viewport"], windowSize, windowPosition, screen, deviceScaleFactor, userAgent: values["user-agent"], locale: values.locale, timezoneId: values.timezone, isMobile: values.mobile, hasTouch: values.touch, permissions, proxy, timeoutMs, popupPolicy, navigationPolicy, secrets, availableFilePaths: availableFilePaths ?? [], storageStateFile, captureNetwork: values["capture-network"] ?? false, recordVideo: values["record-video"] ?? false, recordHar: values["record-har"] ?? false, recordHarContent: values["har-content"] as BrowserOptions['recordHarContent'], recordHarMode: values["har-mode"] as BrowserOptions['recordHarMode'], recordTrace: values["record-trace"] ?? false, allowPageScript: values["page-script"] ?? false }, run };
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
  const preset = options.devicePreset ? devicePresetOptions(options.devicePreset) : undefined;
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
    headless: options.cdpUrl ? null : options.headless, timeout_ms: options.timeoutMs, popup_policy: options.popupPolicy ?? "stay", record_video: options.recordVideo ?? false, record_har: options.recordHar ?? false, har_content: options.recordHar ? options.recordHarContent ?? 'omit' : null, har_mode: options.recordHar ? options.recordHarMode ?? 'full' : null, record_trace: options.recordTrace ?? false,
    device_preset: options.devicePreset ?? null, viewport: options.noViewport ? null : options.viewport ?? preset?.viewport ?? { width: 1280, height: 800 }, no_viewport: options.noViewport ?? false, window_size: options.windowSize ?? null, window_position: options.windowPosition ?? null, screen: options.screen ?? preset?.screen ?? null, device_scale_factor: options.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1, user_agent_configured: options.userAgent !== undefined || preset !== undefined, locale: options.locale ?? null, timezone: options.timezoneId ?? null, mobile: options.isMobile ?? preset?.isMobile ?? false, touch: options.hasTouch ?? preset?.hasTouch ?? false, permissions: options.permissions ?? [],
    proxy: { enabled: options.proxy !== undefined, protocol: options.proxy ? new URL(options.proxy.server).protocol.slice(0, -1) : null, has_credentials: !!(options.proxy?.username || options.proxy?.password) },
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
    const requestedStartUrl = run.startUrl ?? (run.directOpenTaskUrl ? uniqueTaskStartUrl(run.task ?? saved?.agent.task ?? "") : undefined);
    if (saved && requestedStartUrl !== undefined && requestedStartUrl !== saved.agent.initialization?.url) throw new Error("A resumed run cannot add or change its saved startUrl.");
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
    const fallbackProviderDiagnostics: Record<string, unknown>[] = [];
    const extractionProviderDiagnostics: Record<string, unknown>[] = [];
    const onUsage = (entry: AgentModelUsage) => { usage.push({ ...entry }); };
    const httpPlannerOptions = { endpoint: run.endpoint, model: run.model, apiKey: run.apiKey, maxOutputTokens: run.maxOutputTokens, onUsage };
    const codexPlanner = run.provider === "codex" ? createCodexPlanner({
      model: run.model, codexCommand: run.codexCommand, reasoningEffort: run.reasoningEffort, onUsage,
      onDiagnostic: diagnostic => { providerDiagnostics.push({ ...diagnostic }); },
    }) : undefined;
    const planner = codexPlanner ?? (run.provider === "anthropic" ? createAnthropicPlanner(httpPlannerOptions)
      : run.provider === "ollama" ? createOllamaPlanner(httpPlannerOptions)
      : createOpenAICompatiblePlanner({ ...httpPlannerOptions, endpoint: run.endpoint! }));
    const fallbackCodexPlanner = run.fallback?.provider === "codex" ? createCodexPlanner({
      model: run.fallback.model, codexCommand: run.fallback.codexCommand, reasoningEffort: run.fallback.reasoningEffort, onUsage,
      onDiagnostic: diagnostic => { fallbackProviderDiagnostics.push({ ...diagnostic }); },
    }) : undefined;
    const fallbackHttpOptions = run.fallback ? { endpoint: run.fallback.endpoint, model: run.fallback.model, apiKey: run.fallback.apiKey, maxOutputTokens: run.fallback.maxOutputTokens, onUsage } : undefined;
    const fallbackPlanner = fallbackCodexPlanner ?? (run.fallback?.provider === "anthropic" ? createAnthropicPlanner(fallbackHttpOptions!)
      : run.fallback?.provider === "ollama" ? createOllamaPlanner(fallbackHttpOptions!)
      : run.fallback ? createOpenAICompatiblePlanner({ ...fallbackHttpOptions!, endpoint: run.fallback.endpoint! }) : undefined);
    const extractionOnUsage = (entry: AgentModelUsage) => { usage.push({ ...entry, role: "extraction" }); };
    const extractionCodexPlanner = run.extraction?.provider === "codex" ? createCodexPlanner({
      model: run.extraction.model, codexCommand: run.extraction.codexCommand, reasoningEffort: run.extraction.reasoningEffort, onUsage: extractionOnUsage,
      onDiagnostic: diagnostic => { extractionProviderDiagnostics.push({ ...diagnostic }); },
    }) : undefined;
    const extractionHttpOptions = run.extraction ? { endpoint: run.extraction.endpoint, model: run.extraction.model, apiKey: run.extraction.apiKey, maxOutputTokens: run.extraction.maxOutputTokens, onUsage: extractionOnUsage } : undefined;
    const extractionPlanner = extractionCodexPlanner ?? (run.extraction?.provider === "anthropic" ? createAnthropicPlanner(extractionHttpOptions!)
      : run.extraction?.provider === "ollama" ? createOllamaPlanner(extractionHttpOptions!)
      : run.extraction ? createOpenAICompatiblePlanner({ ...extractionHttpOptions!, endpoint: run.extraction.endpoint! }) : undefined);
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
      const result = await runAgent({ task: run.task ?? saved!.agent.task, startUrl: run.startUrl, directOpenTaskUrl: run.directOpenTaskUrl, planner, tools: extractionPlanner ? createModelExtractionToolClient(connection.tools, extractionPlanner) : connection.tools, maxSteps: run.maxSteps, maxToolCalls: run.maxToolCalls, timeoutMs: run.timeoutMs, finalOutputSchema: run.finalOutputSchema, partialOutputSchema: run.partialOutputSchema, signal: controller.signal,
        ...((run.plannerRetries !== undefined || fallbackPlanner) ? { plannerRecovery: { maxRetries: run.plannerRetries ?? 0, retryDelayMs: run.plannerRetryDelayMs, fallback: fallbackPlanner, stickyFallback: !!fallbackPlanner } } : {}),
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
      report = { status: result.status, reason: result.reason, ...(result.failure ? { failure: result.failure } : {}), summary: result.summary, ...(result.status === "succeeded" && result.data !== undefined ? { data: result.data } : {}), ...(run.partialOutputSchema ? { partials: result.partials } : {}), question: result.question, steps: result.steps, tool_calls: result.toolCalls, planner_calls: result.plannerCalls, checkpoint: checkpointPath, model_usage: usage, ...(codexPlanner ? { provider_diagnostics: providerDiagnostics } : {}), ...(fallbackCodexPlanner ? { fallback_provider_diagnostics: fallbackProviderDiagnostics } : {}), ...(extractionCodexPlanner ? { extraction_provider_diagnostics: extractionProviderDiagnostics } : {}), ...((run.plannerRetries !== undefined || run.fallback) ? { planner_metrics: result.metrics, fallback_used: result.metrics.some(metric => metric.planner === "fallback") } : {}), verification: result.evidence.map(item => ({ tool_call_id: item.toolCallId, session_id: item.sessionId, checks: item.checks })) };
      if (result.status !== "succeeded") process.exitCode = result.status === "needs_input" ? 2 : 1;
    } finally {
      process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
      try { await dispose(); } catch (error) { recordCleanupFailure(error); }
      try { await connection.close(); } catch (error) { recordCleanupFailure(error); }
      // Cancellation can return before the local inference child flushes its
      // final usage. Drain it before serializing the report, including failures.
      try { await codexPlanner?.close(); }
      catch { recordCleanupFailure(undefined, { code: "CODEX_CLEANUP_FAILED", message: "Codex planner cleanup did not complete." }); }
      try { await fallbackCodexPlanner?.close(); }
      catch { recordCleanupFailure(undefined, { code: "CODEX_CLEANUP_FAILED", message: "Fallback Codex planner cleanup did not complete." }); }
      try { await extractionCodexPlanner?.close(); }
      catch { recordCleanupFailure(undefined, { code: "CODEX_CLEANUP_FAILED", message: "Extraction Codex planner cleanup did not complete." }); }
      if (report && options.recordVideo) report.recordings = engine.recordings();
      if (report && (options.recordHar || options.recordTrace)) report.diagnostics = engine.diagnostics();
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
