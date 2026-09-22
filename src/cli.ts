#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { BrowserOptions } from "./browser.js";
import { createServer, SERVER_VERSION } from "./server.js";

const require = createRequire(import.meta.url);
const HELP = `Tablaze / 闪页 — compact browser MCP

Usage / 用法:
  tablaze [options]          Start the stdio MCP server / 启动 MCP
  tablaze doctor [options]   Print JSON diagnostics / 输出诊断
  tablaze setup              Install managed Chromium / 安装 Chromium

Options / 选项:
  --headless                Run headless (default) / 无头模式
  --headed                  Show the isolated browser / 显示独立浏览器
  --channel <name>          Use installed Chrome/Edge / 浏览器渠道
  --executable-path <path>  Use a browser executable / 浏览器程序路径
  --cdp-url <url>           Explicitly attach over CDP / 主动连接 CDP
  --timeout-ms <100-60000>  Action timeout (default 10000) / 操作超时
  --help                    Print this help / 帮助
  --version                 Print the version / 版本

MCP writes protocol messages to stdout; diagnostics use stderr.
The browser is launched lazily. Startup never downloads a browser.
浏览器按需启动；MCP 启动时不会自动下载浏览器。
`;

const CHANNELS = new Set(["chromium", "chrome", "chrome-beta", "chrome-dev", "chrome-canary", "msedge", "msedge-beta", "msedge-dev", "msedge-canary"]);

function parseOptions(): { command: string; options: BrowserOptions } {
  const { values, positionals } = parseArgs({
    options: { headless: { type: "boolean" }, headed: { type: "boolean" }, channel: { type: "string" }, "executable-path": { type: "string" }, "cdp-url": { type: "string" }, "timeout-ms": { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
    allowPositionals: true, strict: true,
  });
  if (values.help) return { command: "help", options: {} };
  if (values.version) return { command: "version", options: {} };
  if (positionals.length > 1 || (positionals[0] && !["doctor", "setup"].includes(positionals[0]))) throw new Error("Expected no command, doctor, or setup. Run tablaze --help.");
  if (values.headless && values.headed) throw new Error("Choose either --headless or --headed.");
  const cdpUrl = values["cdp-url"];
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
  return { command: positionals[0] ?? "stdio", options: { headless: !values.headed, channel, executablePath: executablePath ? resolve(executablePath) : undefined, cdpUrl, timeoutMs } };
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
    headless: options.cdpUrl ? null : options.headless, timeout_ms: options.timeoutMs,
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

async function main(): Promise<void> {
  const { command, options } = parseOptions();
  if (command === "help") { process.stdout.write(HELP); return; }
  if (command === "version") { process.stdout.write(`${SERVER_VERSION}\n`); return; }
  if (command === "doctor") { doctor(options); return; }
  if (command === "setup") { await setup(); return; }
  const { server, dispose } = createServer(options);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 8_000);
    deadline.unref();
    try { await dispose(); await server.close(); }
    catch { process.stderr.write("Tablaze: browser cleanup failed.\n"); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
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
