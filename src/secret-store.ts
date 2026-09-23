import { createHash } from "node:crypto";
import { compileNavigationPolicy, type CompiledNavigationPolicy } from "./navigation-policy.js";

export interface BrowserSecretDefinition {
  name: string;
  version: string;
  allowedOrigins: readonly string[];
  allowedTopOrigins?: readonly string[];
  resolve: (signal: AbortSignal) => string | Promise<string>;
}

export interface BrowserSecretOptions {
  contextId: string;
  secrets: readonly BrowserSecretDefinition[];
  getContextId?: () => string | Promise<string>;
  allowSensitiveArtifacts?: boolean;
}

export type SecretErrorCode =
  | "SECRET_CONFIG_INVALID" | "SECRET_NOT_FOUND" | "SECRET_ORIGIN_BLOCKED"
  | "SECRET_CONTEXT_CHANGED" | "SECRET_CANCELLED" | "SECRET_RESOLUTION_FAILED"
  | "SECRET_VALUE_INVALID" | "SECRET_LIMIT_EXCEEDED" | "SECRET_STORE_CLOSED";

const MESSAGES: Record<SecretErrorCode, string> = {
  SECRET_CONFIG_INVALID: "Invalid secret configuration.",
  SECRET_NOT_FOUND: "The requested secret is unavailable.",
  SECRET_ORIGIN_BLOCKED: "The secret is unavailable for this document or top-level origin.",
  SECRET_CONTEXT_CHANGED: "The trusted secret context changed.",
  SECRET_CANCELLED: "The secret operation was cancelled.",
  SECRET_RESOLUTION_FAILED: "The secret resolver or trusted context check failed.",
  SECRET_VALUE_INVALID: "The secret resolver returned an invalid value.",
  SECRET_LIMIT_EXCEEDED: "The secret retention limit was reached.",
  SECRET_STORE_CLOSED: "The secret store is closed.",
};

/** Errors never include resolver output, caller IDs, origins, or an underlying cause. */
export class SecretError extends Error {
  readonly code: SecretErrorCode;
  constructor(code: SecretErrorCode) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : "SECRET_RESOLUTION_FAILED";
    super(MESSAGES[safeCode]);
    this.name = "SecretError";
    this.code = safeCode;
  }
}

export interface CompiledSecretStore {
  readonly hash: string;
  readonly contextId: string;
  readonly allowSensitiveArtifacts: boolean;
  /** Covers each supported encoded form of a maximum-length resolved value. */
  readonly padding: number;
  aliases(frameOrigin: string, topOrigin: string): string[];
  assertContext(signal: AbortSignal): Promise<void>;
  resolve(name: string, frameOrigin: string, topOrigin: string, signal: AbortSignal): Promise<string>;
  redact(text: string): string;
  /** Redact an original-text prefix without promoting trailing lookahead. */
  redactPrefix(text: string, rawLimit: number): string;
  contains(text: string): boolean;
  close(): void;
}

const MAX_ALIASES = 32;
const MAX_ORIGIN_RULES = 200;
const MAX_VALUE_UNITS = 2_048;
const MAX_VALUES = 128;
const MAX_VALUE_BYTES = 65_536;
const PADDING = 24_576;
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function invalid(): never { throw new SecretError("SECRET_CONFIG_INVALID"); }

function properties(value: unknown, allowed: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !allowed.includes(key))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !("value" in descriptors[key as string]))) invalid();
  return descriptors;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  if (Reflect.ownKeys(value).some(key => key !== "length" &&
    (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid();
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !("value" in entry)) invalid();
    return entry.value;
  });
}

function identifier(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}

function scope(value: unknown): { policy: CompiledNavigationPolicy; count: number } {
  const values = array(value, MAX_ORIGIN_RULES);
  if (!values.length) invalid();
  return { policy: compileNavigationPolicy({ allowedOrigins: values as string[] }), count: values.length };
}

interface Definition {
  readonly name: string;
  readonly version: string;
  readonly frame: CompiledNavigationPolicy;
  readonly top: CompiledNavigationPolicy;
  readonly resolver: BrowserSecretDefinition["resolve"];
}

/** Bounded exact/normalized textual redaction; not arbitrary encoding or pixel sanitization. */
export function compileSecretStore(options?: BrowserSecretOptions): CompiledSecretStore | undefined {
  if (options === undefined) return undefined;
  let contextId: string;
  let allowSensitiveArtifacts: boolean;
  let getContextId: BrowserSecretOptions["getContextId"];
  let definitions: readonly Definition[];
  try {
    const fields = properties(options, ["contextId", "secrets", "getContextId", "allowSensitiveArtifacts"]);
    contextId = identifier(fields.contextId?.value, 256);
    getContextId = fields.getContextId?.value;
    if (getContextId !== undefined && typeof getContextId !== "function") invalid();
    allowSensitiveArtifacts = fields.allowSensitiveArtifacts?.value ?? false;
    if (typeof allowSensitiveArtifacts !== "boolean" || fields.allowSensitiveArtifacts?.value === null) invalid();
    let originRules = 0;
    const names = new Set<string>();
    definitions = Object.freeze(array(fields.secrets?.value, MAX_ALIASES).map(value => {
      const item = properties(value, ["name", "version", "allowedOrigins", "allowedTopOrigins", "resolve"]);
      const name = item.name?.value;
      if (typeof name !== "string" || !NAME.test(name) || names.has(name)) invalid();
      names.add(name);
      const version = identifier(item.version?.value, 128);
      const resolver = item.resolve?.value;
      if (typeof resolver !== "function") invalid();
      const frame = scope(item.allowedOrigins?.value);
      const top = item.allowedTopOrigins?.value === undefined ? frame : scope(item.allowedTopOrigins.value);
      // Count caller-supplied rules before normalization. An inherited top scope
      // does not double-count the same definition's origin list.
      originRules += frame.count + (top === frame ? 0 : top.count);
      if (originRules > MAX_ORIGIN_RULES) invalid();
      return Object.freeze({ name, version, frame: frame.policy, top: top.policy, resolver });
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch { throw new SecretError("SECRET_CONFIG_INVALID"); }

  const hash = createHash("sha256").update(JSON.stringify({
    version: 1, contextId, allowSensitiveArtifacts,
    secrets: definitions.map(item => ({ name: item.name, version: item.version,
      allowedOrigins: item.frame.policy.allowedOrigins, allowedTopOrigins: item.top.policy.allowedOrigins })),
  })).digest("hex");
  const byName = new Map(definitions.map(item => [item.name, item]));
  const values = new Set<string>();
  const variants = new Set<string>();
  const lifetime = new AbortController();
  let retainedBytes = 0;
  let closed = false;
  let matcher: RegExp | undefined;
  const assertOpen = () => { if (closed) throw new SecretError("SECRET_STORE_CLOSED"); };
  const check = (signal: AbortSignal) => {
    assertOpen();
    if (!(signal instanceof AbortSignal)) throw new SecretError("SECRET_CONFIG_INVALID");
    if (signal.aborted) throw new SecretError("SECRET_CANCELLED");
  };
  const race = <T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> => {
    check(signal);
    return new Promise<T>((resolve, reject) => {
      const finish = (callback: () => void) => {
        signal.removeEventListener("abort", cancel);
        lifetime.signal.removeEventListener("abort", cancel);
        callback();
      };
      const cancel = () => finish(() => reject(new SecretError(closed ? "SECRET_STORE_CLOSED" : "SECRET_CANCELLED")));
      signal.addEventListener("abort", cancel, { once: true });
      lifetime.signal.addEventListener("abort", cancel, { once: true });
      // Always observe eventual success/rejection, including after cancellation.
      Promise.resolve().then(() => { check(signal); return operation(); }).then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error instanceof SecretError ? error : new SecretError("SECRET_RESOLUTION_FAILED"))),
      );
    });
  };
  const assertContext = async (signal: AbortSignal): Promise<void> => {
    check(signal);
    if (getContextId) {
      let current: unknown;
      try { current = await race(() => getContextId!(), signal); }
      catch (error) {
        if (closed || signal.aborted) check(signal);
        throw new SecretError("SECRET_RESOLUTION_FAILED");
      }
      check(signal);
      if (current !== contextId) throw new SecretError("SECRET_CONTEXT_CHANGED");
    }
    check(signal);
  };
  const register = (value: unknown): string => {
    assertOpen();
    if (typeof value !== "string" || !value || value.length > MAX_VALUE_UNITS) throw new SecretError("SECRET_VALUE_INVALID");
    if (values.has(value)) return value;
    const bytes = Buffer.byteLength(value, "utf8");
    if (values.size >= MAX_VALUES || retainedBytes + bytes > MAX_VALUE_BYTES) throw new SecretError("SECRET_LIMIT_EXCEEDED");
    const next = new Set<string>();
    try {
      for (const text of new Set([value, value.replace(/\s+/gu, " ").trim()])) {
        if (!text) continue;
        next.add(text); next.add(encodeURIComponent(text)); next.add(encodeURI(text));
        next.add(JSON.stringify(text).slice(1, -1));
      }
    } catch { throw new SecretError("SECRET_VALUE_INVALID"); }
    // URI encoding is at most 9 units per well-formed UTF-16 code unit; JSON
    // escaping is at most 6. The public 24,576-unit lookahead exceeds both.
    if ([...next].some(text => text.length > PADDING)) throw new SecretError("SECRET_VALUE_INVALID");
    values.add(value); retainedBytes += bytes;
    for (const text of next) variants.add(text);
    matcher = undefined;
    return value;
  };
  const pattern = (): RegExp | undefined => {
    assertOpen();
    if (!variants.size) return undefined;
    // Look ahead at every original offset: consuming abc would otherwise miss
    // the overlapping bcd in abcd. The longest alternative covers shorter
    // matches at the same start; matches at later starts are merged below.
    if (!matcher) matcher = new RegExp("(?=(" + [...variants].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + "))", "g");
    return matcher;
  };
  const redactPrefix = (text: string, rawLimit: number): string => {
    const expression = pattern();
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 0) throw new SecretError("SECRET_CONFIG_INVALID");
    const limit = Math.min(text.length, rawLimit);
    if (!expression || !limit) return text.slice(0, limit);
    expression.lastIndex = 0;
    const chunks: string[] = [];
    let cursor = 0, start = -1, end = 0;
    const flush = (): boolean => {
      chunks.push(text.slice(cursor, start));
      // This whole overlapping group is sensitive. If any of it crosses the
      // raw boundary, stop before the group rather than expose a partial value.
      if (end > limit) return false;
      chunks.push("[redacted]"); cursor = end;
      return true;
    };
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text)) && match.index < limit) {
      expression.lastIndex = match.index + 1; // A lookahead match consumes no text.
      const nextEnd = match.index + match[1].length;
      if (start < 0) { start = match.index; end = nextEnd; }
      else if (match.index < end) end = Math.max(end, nextEnd);
      else {
        if (!flush()) return chunks.join("");
        start = match.index; end = nextEnd;
      }
    }
    if (start >= 0 && !flush()) return chunks.join("");
    chunks.push(text.slice(cursor, limit));
    return chunks.join("");
  };
  return Object.freeze({
    hash, contextId, allowSensitiveArtifacts, padding: PADDING,
    aliases(frameOrigin: string, topOrigin: string): string[] {
      assertOpen();
      // Aliases are public configuration, but a name identical to a resolved
      // value must not echo that value. Keep unrelated usable names intact.
      return definitions.filter(item => item.frame.isAllowed(frameOrigin) && item.top.isAllowed(topOrigin) && !variants.has(item.name)).map(item => item.name);
    },
    assertContext,
    async resolve(name: string, frameOrigin: string, topOrigin: string, signal: AbortSignal): Promise<string> {
      check(signal);
      const item = byName.get(name);
      if (!item) throw new SecretError("SECRET_NOT_FOUND");
      if (!item.frame.isAllowed(frameOrigin) || !item.top.isAllowed(topOrigin)) throw new SecretError("SECRET_ORIGIN_BLOCKED");
      await assertContext(signal);
      check(signal);
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const value = await race(async () => {
        let resolved: unknown;
        try { resolved = await item.resolver(combined); }
        catch { throw new SecretError("SECRET_RESOLUTION_FAILED"); }
        // A resolver may ignore cancellation. While this store is alive, retain
        // its eventual value before any cancelled result can be delivered.
        return register(resolved);
      }, signal);
      check(signal);
      await assertContext(signal);
      check(signal);
      return value;
    },
    redact(text: string): string {
      return redactPrefix(text, text.length);
    },
    redactPrefix,
    contains(text: string): boolean {
      const expression = pattern();
      return expression ? text.search(expression) !== -1 : false;
    },
    close(): void {
      if (closed) return;
      closed = true; lifetime.abort(); values.clear(); variants.clear(); matcher = undefined; retainedBytes = 0;
    },
  });
}
