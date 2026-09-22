import { createHash } from "node:crypto";

/** Exact HTTP(S) origins. An absent allowlist permits HTTP(S); an empty one permits none. */
export interface NavigationPolicy {
  allowedOrigins?: readonly string[];
  blockedOrigins?: readonly string[];
}

export type NavigationPolicyErrorCode = "NAVIGATION_POLICY_INVALID" | "NAVIGATION_BLOCKED";

/** Public errors deliberately exclude the supplied URL, configuration, and underlying cause. */
export class NavigationPolicyError extends Error {
  readonly code: NavigationPolicyErrorCode;

  constructor(code: NavigationPolicyErrorCode) {
    const safeCode = code === "NAVIGATION_BLOCKED" ? code : "NAVIGATION_POLICY_INVALID";
    super(safeCode === "NAVIGATION_BLOCKED" ? "Navigation is blocked by the configured policy." : "Invalid navigation policy configuration.");
    this.name = "NavigationPolicyError";
    this.code = safeCode;
  }
}

export interface CompiledNavigationPolicy {
  /** Canonical, independently copied and deeply frozen configuration. */
  readonly policy: Readonly<NavigationPolicy>;
  /** Versioned canonical JSON; includes configured origins, so treat it as configuration data. */
  readonly identity: string;
  /** SHA-256 of identity; array order and duplicate origins do not change it. */
  readonly hash: string;
  isAllowed(url: string): boolean;
  assertAllowed(url: string): void;
}

const MAX_ORIGINS = 200;

function invalid(): never { throw new NavigationPolicyError("NAVIGATION_POLICY_INVALID"); }

function canonicalOrigin(value: unknown): string {
  // Require an explicit authority. WHATWG URL alone repairs backslashes, whitespace,
  // omitted slashes and dot paths, which are inappropriate for an origin allowlist.
  if (typeof value !== "string" || value.length > 8192 || /[\s\\\u0000-\u001f\u007f*]/u.test(value) || !/^https?:\/\/[^/?#]+\/?$/i.test(value)) invalid();
  const authority = value.slice(value.indexOf("//") + 2).replace(/\/$/, "");
  if (authority.includes("@")) invalid();
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin === "null") invalid();
  // Percent-encoded wildcard hostnames can be decoded by the URL parser.
  if (parsed.hostname.includes("*")) invalid();
  return parsed.origin;
}

function originList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) invalid();
  const origins: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !("value" in entry)) invalid();
    origins.push(canonicalOrigin(entry.value));
  }
  return origins;
}

function targetOrigin(value: string): string | undefined {
  if (typeof value !== "string" || value !== value.trim() || /[\\\u0000-\u001f\u007f]/u.test(value) || !/^https?:\/\//i.test(value)) return undefined;
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/, 1)[0];
  if (!authority || authority.includes("@")) return undefined;
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || parsed.username || parsed.password || parsed.origin === "null") return undefined;
  return parsed.origin;
}

/** Undefined preserves the caller's existing navigation behavior; {} enables HTTP(S)-only policy. */
export function compileNavigationPolicy(policy: NavigationPolicy): CompiledNavigationPolicy;
export function compileNavigationPolicy(policy?: NavigationPolicy): CompiledNavigationPolicy | undefined;
export function compileNavigationPolicy(policy?: NavigationPolicy): CompiledNavigationPolicy | undefined {
  if (policy === undefined) return undefined;
  try {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) invalid();
    const prototype = Object.getPrototypeOf(policy);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(policy);
    if (keys.some(key => key !== "allowedOrigins" && key !== "blockedOrigins")) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(policy);
    for (const key of keys) if (!("value" in descriptors[key as string])) invalid();
    const allowedInput = originList(descriptors.allowedOrigins?.value);
    const blockedInput = originList(descriptors.blockedOrigins?.value);
    if ((allowedInput?.length ?? 0) + (blockedInput?.length ?? 0) > MAX_ORIGINS) invalid();
    const allowedOrigins = allowedInput === undefined ? undefined : Object.freeze([...new Set(allowedInput)].sort());
    const blockedOrigins = Object.freeze([...new Set(blockedInput ?? [])].sort());
    const normalized = Object.freeze({ ...(allowedOrigins === undefined ? {} : { allowedOrigins }), blockedOrigins });
    const identity = JSON.stringify({ version: 1, allowedOrigins: allowedOrigins ?? null, blockedOrigins });
    const hash = createHash("sha256").update(identity).digest("hex");
    const allowed = allowedOrigins === undefined ? undefined : new Set(allowedOrigins);
    const blocked = new Set(blockedOrigins);
    const isAllowed = (url: string): boolean => {
      try {
        const origin = targetOrigin(url);
        return origin !== undefined && !blocked.has(origin) && (allowed === undefined || allowed.has(origin));
      } catch { return false; }
    };
    return Object.freeze({
      policy: normalized,
      identity,
      hash,
      isAllowed,
      assertAllowed(url: string): void { if (!isAllowed(url)) throw new NavigationPolicyError("NAVIGATION_BLOCKED"); },
    });
  } catch {
    // URL and reflection errors can contain caller data. Never surface them or attach a cause.
    throw new NavigationPolicyError("NAVIGATION_POLICY_INVALID");
  }
}
