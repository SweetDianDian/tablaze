import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Browser, CDPSession, Page } from "playwright";
import WebSocket, { type RawData } from "ws";
import type { CompiledNavigationPolicy } from "./navigation-policy.js";

const DEADLINE_MS = 5_000;
const MAX_PENDING = 4_096;
const MAX_SESSIONS = 4_096;
const AUTO_ATTACH = {
  autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
  filter: [{ type: "page", exclude: false }, { type: "iframe", exclude: false }, { exclude: true }],
};

/** Deliberately contains no URL, browser response, local path, or underlying cause. */
export class NavigationGuardError extends Error {
  readonly code = "NAVIGATION_POLICY_FAILED";
  constructor() {
    super("The navigation policy guard is unavailable.");
    this.name = "NavigationGuardError";
  }
}

export interface NavigationGuard {
  assertHealthy(): void;
  contextIdFor(page: Page): Promise<string>;
  blockedRequests(contextId: string): number;
  /** Releases the guard transport. The caller must close its browser first. */
  close(): Promise<void>;
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new NavigationGuardError()), DEADLINE_MS);
    operation.then(value => { clearTimeout(timer); resolve(value); }, () => {
      clearTimeout(timer); reject(new NavigationGuardError());
    });
  });
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NavigationGuardError();
  return value as Record<string, any>;
}

/** Reads only the debugging endpoint of the supplied, newly launched owned browser. */
async function endpointFor(browser: Browser): Promise<string> {
  let bootstrap: CDPSession | undefined;
  let finished = false;
  const pending = browser.newBrowserCDPSession();
  void pending.then(session => {
    if (finished) void session.detach().catch(() => {});
  }, () => {});
  try {
    bootstrap = await bounded(pending);
    const response = await bounded(bootstrap.send("Browser.getBrowserCommandLine"));
    const args = response.arguments;
    if (!Array.isArray(args) || !args.every(arg => typeof arg === "string") ||
        !args.includes("--remote-debugging-port=0") || !args.includes("--enable-automation")) throw new NavigationGuardError();
    const profiles = args.filter(arg => arg.startsWith("--user-data-dir="));
    if (profiles.length !== 1) throw new NavigationGuardError();
    const profile = profiles[0].slice("--user-data-dir=".length);
    if (!isAbsolute(profile)) throw new NavigationGuardError();
    const file = await open(join(profile, "DevToolsActivePort"), "r");
    let contents: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4_096) throw new NavigationGuardError();
      const buffer = Buffer.alloc(4_097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4_096) throw new NavigationGuardError();
      contents = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    const match = /^(\d{1,5})\r?\n(\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n?$/.exec(contents);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535) throw new NavigationGuardError();
    return `ws://127.0.0.1:${Number(match[1])}${match[2]}`;
  } finally {
    finished = true;
    if (bootstrap) await bounded(bootstrap.detach());
  }
}

interface Pending {
  sessionId?: string;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface TargetSession { contextId: string; parent?: string; targetId: string }
class DetachedTarget extends Error {}

/**
 * Installs before any contexts/pages are created. Only use with an owned Chromium
 * launched with --remote-debugging-port=0 and --enable-automation. Fetch pauses
 * every Document redirect hop without proxying responses. This is a document
 * navigation policy, not a network firewall: subresources are outside its scope.
 * Chrome can resume paused requests when a CDP connection is lost; teardown on
 * transport failure is best effort and cannot promise atomic fail-closed behavior.
 */
export async function startNavigationGuard(browser: Browser, policy: CompiledNavigationPolicy): Promise<NavigationGuard> {
  let ws: WebSocket | undefined;
  let failed = false;
  let closing = false;
  let sequence = 0;
  let closePromise: Promise<void> | undefined;
  let failureShutdown: Promise<void> | undefined;
  const pending = new Map<number, Pending>();
  const sessions = new Map<string, TargetSession>();
  const blocked = new Map<string, number>();
  const arming = new Set<Promise<void>>();

  const rejectPending = (reason: Error, sessionIds?: Set<string>) => {
    for (const [id, entry] of pending) {
      if (sessionIds && (!entry.sessionId || !sessionIds.has(entry.sessionId))) continue;
      pending.delete(id); clearTimeout(entry.timer); entry.reject(reason);
    }
  };
  const fail = () => {
    if (failed || closing) return;
    failed = true;
    rejectPending(new NavigationGuardError());
    // Keep the interception connection until browser shutdown is attempted. Losing
    // this connection first could release requests that Chrome already paused.
    failureShutdown = bounded(browser.close()).catch(() => {}).finally(() => ws?.terminate());
  };
  const disconnected = () => {
    rejectPending(new DetachedTarget());
  };
  browser.on("disconnected", disconnected);

  const assertHealthy = () => {
    if (failed || closing || !browser.isConnected() || ws?.readyState !== WebSocket.OPEN) throw new NavigationGuardError();
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => {
    if (closing || ws?.readyState !== WebSocket.OPEN) return Promise.reject(new NavigationGuardError());
    if (pending.size >= MAX_PENDING) { fail(); return Promise.reject(new NavigationGuardError()); }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new NavigationGuardError()); fail();
      }, DEADLINE_MS);
      pending.set(id, { sessionId, resolve, reject, timer });
      ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (!error) return;
        const entry = pending.get(id);
        if (entry) { pending.delete(id); clearTimeout(entry.timer); entry.reject(new NavigationGuardError()); }
        fail();
      });
    });
  };
  const handleFailure = async (error: unknown, sessionId?: string) => {
    if (closing || !browser.isConnected() || error instanceof DetachedTarget || (sessionId && !sessions.has(sessionId))) return;
    if (sessionId) {
      // Chrome can answer a command before delivering its target-detached event.
      // Confirm target closure using protocol state, never an error-message regex.
      const target = sessions.get(sessionId);
      try {
        const response = object(await send("Target.getTargets"));
        if (!Array.isArray(response.targetInfos)) throw new NavigationGuardError();
        if (!sessions.has(sessionId) || !response.targetInfos.some(info => object(info).targetId === target?.targetId)) {
          detach(sessionId); return;
        }
      } catch {
        if (closing || !browser.isConnected() || !sessions.has(sessionId)) return;
      }
    }
    fail();
  };
  const detach = (sessionId: string) => {
    const detached = new Set([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, entry] of sessions) {
        if (entry.parent && detached.has(entry.parent) && !detached.has(id)) { detached.add(id); changed = true; }
      }
    }
    const contexts = new Set<string>();
    for (const id of detached) {
      const entry = sessions.get(id);
      if (entry) contexts.add(entry.contextId);
      sessions.delete(id);
    }
    for (const context of contexts) {
      if (![...sessions.values()].some(entry => entry.contextId === context)) blocked.delete(context);
    }
    rejectPending(new DetachedTarget(), detached);
  };
  const message = (raw: RawData) => {
    if (closing) return;
    try {
      const value = object(JSON.parse(raw.toString()));
      if (typeof value.id === "number") {
        const entry = pending.get(value.id);
        if (!entry) return;
        pending.delete(value.id); clearTimeout(entry.timer);
        if (value.error) entry.reject(new NavigationGuardError());
        else entry.resolve(value.result);
        return;
      }
      if (value.method === "Target.detachedFromTarget") {
        const params = object(value.params);
        if (typeof params.sessionId !== "string") throw new NavigationGuardError();
        detach(params.sessionId);
      } else if (value.method === "Target.attachedToTarget") {
        const params = object(value.params);
        const info = object(params.targetInfo);
        const id = params.sessionId;
        const parent = typeof value.sessionId === "string" ? value.sessionId : undefined;
        const contextId = typeof info.browserContextId === "string" ? info.browserContextId : parent ? sessions.get(parent)?.contextId : undefined;
        if (typeof id !== "string" || typeof info.targetId !== "string" || !contextId || (info.type !== "page" && info.type !== "iframe")) throw new NavigationGuardError();
        if (sessions.has(id)) return;
        if (sessions.size >= MAX_SESSIONS || (!blocked.has(contextId) && blocked.size >= MAX_SESSIONS)) throw new NavigationGuardError();
        sessions.set(id, { contextId, parent, targetId: info.targetId });
        if (!blocked.has(contextId)) blocked.set(contextId, 0);
        const task = (async () => {
          await send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, id);
          await send("Target.setAutoAttach", AUTO_ATTACH, id);
          await send("Runtime.runIfWaitingForDebugger", {}, id);
        })().catch(error => handleFailure(error, id)).finally(() => arming.delete(task));
        arming.add(task);
      } else if (value.method === "Fetch.requestPaused") {
        const params = object(value.params);
        const request = object(params.request);
        const id = value.sessionId;
        const target = typeof id === "string" ? sessions.get(id) : undefined;
        if (!target || typeof params.requestId !== "string" || typeof request.url !== "string") throw new NavigationGuardError();
        const denied = failed || !policy.isAllowed(request.url);
        if (denied) blocked.set(target.contextId, (blocked.get(target.contextId) ?? 0) + 1);
        void send(denied ? "Fetch.failRequest" : "Fetch.continueRequest", {
          requestId: params.requestId, ...(denied ? { errorReason: "BlockedByClient" } : {}),
        }, id).catch(error => handleFailure(error, id));
      }
    } catch { fail(); }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    browser.off("disconnected", disconnected);
    rejectPending(new NavigationGuardError());
    ws?.terminate();
    closePromise = Promise.allSettled([...arming]).then(() => {
      sessions.clear(); blocked.clear();
    });
    return closePromise;
  };

  try {
    const endpoint = await bounded(endpointFor(browser));
    ws = new WebSocket(endpoint, { handshakeTimeout: DEADLINE_MS, maxPayload: 1_048_576, perMessageDeflate: false, followRedirects: false });
    ws.on("message", message);
    ws.on("error", fail);
    ws.on("close", () => { if (!closing && browser.isConnected()) fail(); else rejectPending(new DetachedTarget()); });
    await bounded(new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", () => reject(new NavigationGuardError()));
      ws!.once("close", () => reject(new NavigationGuardError()));
    }));
    await send("Target.setAutoAttach", AUTO_ATTACH);
    await Promise.all([...arming]);
    assertHealthy();
    return {
      assertHealthy,
      blockedRequests: contextId => blocked.get(contextId) ?? 0,
      async contextIdFor(page) {
        assertHealthy();
        let session: CDPSession | undefined;
        let finished = false;
        const connecting = page.context().newCDPSession(page);
        void connecting.then(value => { if (finished) void value.detach().catch(() => {}); }, () => {});
        try {
          session = await bounded(connecting);
          const { targetInfo } = await bounded(session.send("Target.getTargetInfo"));
          assertHealthy();
          if (typeof targetInfo.browserContextId !== "string" || !blocked.has(targetInfo.browserContextId)) throw new NavigationGuardError();
          return targetInfo.browserContextId;
        } catch {
          if (!page.isClosed()) fail();
          throw new NavigationGuardError();
        } finally {
          finished = true;
          if (session) {
            try { await bounded(session.detach()); }
            catch {
              if (!page.isClosed() && browser.isConnected()) { fail(); throw new NavigationGuardError(); }
            }
          }
        }
      },
      close,
    };
  } catch {
    fail();
    await failureShutdown;
    await close();
    throw new NavigationGuardError();
  }
}
