import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTool, AgentToolCall, AgentToolCatalog, AgentToolClient, AgentToolDispatchResult, AgentToolExecutionIdentity } from "./agent.js";
import { BrowserEngine, type BrowserBinding, type BrowserBindingGuard } from "./browser.js";

type Awaitable<T> = T | Promise<T>;
export type CustomToolEffect = "read" | "write";
export interface CustomToolExecutionContext<C> {
  /** Trusted application value, never taken from model arguments or serialized by the registry. */
  readonly context: C;
  /** Stable Agent call ID. Applications can use it as an idempotency key; it is not automatic deduplication. */
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly binding?: BrowserBinding;
  /** Recheck the captured application and browser identity after an await and before an external effect. */
  assertCurrent(): Promise<void>;
}
declare const contextType: unique symbol;
export interface CustomTool<C = unknown> {
  readonly name: string;
  readonly version: string;
  readonly [contextType]?: (context: C) => void;
}
export interface CustomToolDefinition<I extends z.AnyZodObject, O extends z.AnyZodObject, C> {
  name: string;
  description: string;
  /** Bump when handler behavior or a contract not expressed by its schemas changes. */
  version: string;
  input: I;
  output: O;
  effect: CustomToolEffect;
  /** Exact HTTP(S) origins, including port. Omit for a tool without a site restriction. */
  allowedOrigins?: readonly string[];
  handler: (input: z.output<I>, execution: CustomToolExecutionContext<C>) => Awaitable<z.input<O>>;
}
export type ToolRegistryErrorCode = "INVALID_TOOL_DEFINITION" | "TOOL_NAME_CONFLICT" | "TOOL_REGISTRY_CHANGED" | "TOOL_CONTEXT_CHANGED" | "TOOL_CONTEXT_UNAVAILABLE" | "TOOL_BINDING_CHANGED" | "TOOL_BINDING_UNAVAILABLE" | "TOOL_CATALOG_CLOSED" | "CUSTOM_TOOL_OUTCOME_UNKNOWN";
export class ToolRegistryError extends Error {
  constructor(readonly code: ToolRegistryErrorCode) { super(`Custom tool registry: ${code}.`); this.name = "ToolRegistryError"; }
}
interface StoredTool {
  tool: AgentTool;
  version: string;
  input: z.AnyZodObject;
  output: z.AnyZodObject;
  effect: CustomToolEffect;
  origins?: readonly string[];
  handler: (input: Record<string, unknown>, execution: CustomToolExecutionContext<unknown>) => Awaitable<unknown>;
}
const definitions = new WeakMap<object, StoredTool>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
function jsonObject(value: unknown, maxBytes = 1024 * 1024): Record<string, unknown> {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error("Invalid JSON data.");
    if (item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Invalid JSON data.");
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("JSON data exceeds its size limit.");
  return JSON.parse(encoded);
}
function exactOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value.includes("*")) throw new Error();
    return url.origin;
  } catch { throw new ToolRegistryError("INVALID_TOOL_DEFINITION"); }
}
function outputEnvelope(schema: Record<string, unknown>): AgentTool["outputSchema"] {
  // Zod's local references must retain their meaning when the output is nested in the MCP envelope.
  const relocate = (value: unknown): unknown => Array.isArray(value) ? value.map(relocate) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "$ref" && typeof child === "string" && child.startsWith("#") ? `#/properties/data${child.slice(1)}` : relocate(child)])) : value;
  return { type: "object", properties: { ok: { const: true }, data: relocate(schema) as Record<string, unknown>, session_id: { type: "string" } }, required: ["ok", "data"], additionalProperties: false };
}
function publicTool(value: AgentTool): AgentTool {
  const plain = jsonObject({ name: value.name, ...(value.description !== undefined ? { description: value.description } : {}), inputSchema: value.inputSchema, ...(value.outputSchema !== undefined ? { outputSchema: value.outputSchema } : {}), ...(value.annotations !== undefined ? { annotations: value.annotations } : {}) });
  if (typeof plain.name !== "string" || !plain.name || typeof plain.inputSchema !== "object" || plain.inputSchema === null || Array.isArray(plain.inputSchema)) throw new ToolRegistryError("INVALID_TOOL_DEFINITION");
  return plain as AgentTool;
}
function dataResult(data: Record<string, unknown>, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}
function rejected(code: string, contextChanged = false): AgentToolDispatchResult {
  return { result: dataResult({ ok: false, error: { code, message: "The tool was not dispatched. Refresh the tool catalog and current context before continuing." }, ...(contextChanged ? { replan_required: true } : {}) }, true), outcome: "not_started", contextChanged };
}
async function abortable<T>(operation: () => Awaitable<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let remove = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Tool execution cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), cancelled]); }
  finally { remove(); }
}

/** Register a trusted handler; only its public schemas and description reach a planner. */
export function defineTool<I extends z.AnyZodObject, O extends z.AnyZodObject, C = unknown>(definition: CustomToolDefinition<I, O, C>): CustomTool<C> {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(definition.name) || /^(?:agent_|tab_)/.test(definition.name) || typeof definition.description !== "string" || !definition.description.trim() || definition.description.length > 10_000 || typeof definition.version !== "string" || !definition.version.trim() || definition.version.length > 100 || !["read", "write"].includes(definition.effect) || !(definition.input instanceof z.ZodObject) || !(definition.output instanceof z.ZodObject) || typeof definition.handler !== "function") throw new ToolRegistryError("INVALID_TOOL_DEFINITION");
  if (definition.allowedOrigins !== undefined && (!Array.isArray(definition.allowedOrigins) || !definition.allowedOrigins.length || definition.allowedOrigins.length > 100)) throw new ToolRegistryError("INVALID_TOOL_DEFINITION");
  const origins = definition.allowedOrigins === undefined ? undefined : Object.freeze([...new Set(definition.allowedOrigins.map(exactOrigin))].sort());
  // Object roots always reject unexpected fields, including attempted context or identity injection.
  const input = definition.input.strict(), output = definition.output.strict();
  const inputSchema = jsonObject(zodToJsonSchema(input, { target: "jsonSchema7" }));
  const outputSchema = jsonObject(zodToJsonSchema(output, { target: "jsonSchema7" }));
  if (inputSchema.type !== "object" || outputSchema.type !== "object") throw new ToolRegistryError("INVALID_TOOL_DEFINITION");
  const tool = publicTool({ name: definition.name, description: definition.description, inputSchema: inputSchema as AgentTool["inputSchema"], outputSchema: outputEnvelope(outputSchema), annotations: { readOnlyHint: definition.effect === "read", destructiveHint: definition.effect === "write", idempotentHint: false, openWorldHint: true } });
  const registered = Object.freeze({ name: definition.name, version: definition.version }) as CustomTool<C>;
  definitions.set(registered, { tool, version: definition.version, input, output, effect: definition.effect, origins, handler: definition.handler as StoredTool["handler"] });
  return registered;
}

export interface ToolRegistryOptions<C> {
  base: AgentToolClient;
  tools: readonly CustomTool<C>[];
  /** A trusted resolver. Its id must identify the principal, tenant and application policy epoch. */
  getContext: () => Awaitable<{ id: string; value: C }>;
  browser?: { engine: BrowserEngine; getSessionId: () => Awaitable<string | undefined> };
}

/** Compose typed tools with an MCP client, including dynamic per-plan site filtering and guarded dispatch. */
export function createToolRegistry<C>(options: ToolRegistryOptions<C>): AgentToolClient {
  if (!options.base || typeof options.base.listTools !== "function" || typeof options.base.callTool !== "function" || typeof options.getContext !== "function" || !Array.isArray(options.tools) || options.tools.length > 100 || options.base.getExecutionIdentity || options.base.prepareTools) throw new ToolRegistryError("INVALID_TOOL_DEFINITION");
  const custom = new Map<string, StoredTool>();
  for (const registered of options.tools) {
    const value = definitions.get(registered);
    if (!value || value.origins && !options.browser) throw new ToolRegistryError("INVALID_TOOL_DEFINITION");
    if (custom.has(value.tool.name)) throw new ToolRegistryError("TOOL_NAME_CONFLICT");
    custom.set(value.tool.name, value);
  }
  let identity: AgentToolExecutionIdentity | undefined;
  const readContext = async (signal: AbortSignal) => {
    try {
      const context = await abortable(options.getContext, signal);
      if (!context || typeof context.id !== "string" || !context.id.trim() || context.id.length > 1000) throw new Error();
      return { hash: digest({ contextId: context.id }), value: context.value };
    } catch { signal.throwIfAborted(); throw new ToolRegistryError("TOOL_CONTEXT_UNAVAILABLE"); }
  };
  const currentSession = async (signal: AbortSignal): Promise<string | undefined> => {
    if (!options.browser) return undefined;
    try {
      const value = await abortable(options.browser.getSessionId, signal);
      if (value !== undefined && (typeof value !== "string" || !value || value.length > 160)) throw new Error();
      return value;
    } catch { signal.throwIfAborted(); throw new ToolRegistryError("TOOL_BINDING_UNAVAILABLE"); }
  };
  const acquire = async (sessionId: string, signal: AbortSignal): Promise<BrowserBindingGuard | undefined> => {
    try { return await options.browser!.engine.acquireBinding(sessionId, { signal }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "BINDING_ORIGIN_UNSUPPORTED") return undefined;
      signal.throwIfAborted(); throw new ToolRegistryError("TOOL_BINDING_UNAVAILABLE");
    }
  };
  const contract = async (signal: AbortSignal) => {
    const base = (await abortable(() => options.base.listTools({ signal }), signal)).map(publicTool);
    const names = new Set<string>();
    for (const tool of base) {
      if (names.has(tool.name) || custom.has(tool.name) || tool.name.startsWith("agent_")) throw new ToolRegistryError("TOOL_NAME_CONFLICT");
      names.add(tool.name);
    }
    const registryHash = digest({ protocol: 1, base: [...base].sort((a, b) => a.name.localeCompare(b.name)), custom: [...custom.values()].sort((a, b) => a.tool.name.localeCompare(b.tool.name)).map(value => ({ tool: value.tool, version: value.version, effect: value.effect, allowedOrigins: value.origins ?? null })), browserBound: Boolean(options.browser) });
    const context = await readContext(signal);
    const next = { registryHash, contextHash: context.hash };
    if (identity && identity.registryHash !== next.registryHash) throw new ToolRegistryError("TOOL_REGISTRY_CHANGED");
    if (identity && identity.contextHash !== next.contextHash) throw new ToolRegistryError("TOOL_CONTEXT_CHANGED");
    identity ??= Object.freeze(next);
    return { base, context, identity };
  };
  const prepareTools = async ({ signal }: { signal: AbortSignal }): Promise<AgentToolCatalog> => {
    const prepared = await contract(signal);
    const sessionId = await currentSession(signal);
    let guard: BrowserBindingGuard | undefined;
    if (sessionId && options.browser) guard = await acquire(sessionId, signal);
    if (guard && (typeof guard.contextKey !== "string" || !/^[a-f0-9]{64}$/.test(guard.contextKey))) { await guard.close(); throw new ToolRegistryError("TOOL_BINDING_UNAVAILABLE"); }
    const contextKey = digest({ caller: prepared.identity.contextHash, sessionId: sessionId ?? null, browserKey: guard?.contextKey ?? null });
    const controller = new AbortController();
    let closed = false;
    const abort = () => controller.abort(signal.reason ?? new Error("Tool catalog cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const close = async () => {
      if (closed) return;
      closed = true; controller.abort(new Error("Tool catalog closed."));
      signal.removeEventListener("abort", abort);
      await guard?.close();
    };
    const assertCurrent = async () => {
      if (closed) throw new ToolRegistryError("TOOL_CATALOG_CLOSED");
      controller.signal.throwIfAborted();
      const current = await contract(controller.signal);
      if (current.identity.contextHash !== prepared.identity.contextHash) throw new ToolRegistryError("TOOL_CONTEXT_CHANGED");
      if (await currentSession(controller.signal) !== sessionId) throw new ToolRegistryError("TOOL_BINDING_CHANGED");
      if (guard) {
        try { await guard.assertCurrent(); }
        catch { controller.signal.throwIfAborted(); throw new ToolRegistryError("TOOL_BINDING_CHANGED"); }
      } else if (sessionId && options.browser) {
        const current = await acquire(sessionId, controller.signal);
        if (current) { await current.close(); throw new ToolRegistryError("TOOL_BINDING_CHANGED"); }
      }
      controller.signal.throwIfAborted();
    };
    try { await assertCurrent(); }
    catch (error) { await close(); throw error; }
    const visible = new Map([...custom].filter(([, value]) => !value.origins || guard && value.origins.includes(guard.binding.origin)));
    const tools = [...prepared.base, ...[...visible.values()].map(value => value.tool)].map(publicTool);
    const available = new Set(tools.map(tool => tool.name));
    const metadata = new Map([...prepared.base, ...[...custom.values()].map(value => value.tool)].map(tool => [tool.name, { effect: custom.get(tool.name)?.effect ?? (tool.annotations?.readOnlyHint === true ? "read" as const : "write" as const), ...(custom.has(tool.name) && guard ? { sessionId: guard.binding.sessionId } : {}) }]));
    const dispatch = async (call: AgentToolCall, { signal: callSignal }: { signal: AbortSignal }): Promise<AgentToolDispatchResult> => {
      const operation = new AbortController();
      const executionSignal = AbortSignal.any([controller.signal, callSignal, operation.signal]);
      const assertExecutionCurrent = async () => {
        executionSignal.throwIfAborted();
        await abortable(assertCurrent, executionSignal);
        executionSignal.throwIfAborted();
      };
      try {
        const spec = visible.get(call.name);
        const known = metadata.get(call.name);
        if (!known || !available.has(call.name)) return rejected("TOOL_NOT_AVAILABLE");
        try { await assertExecutionCurrent(); }
        catch { return rejected("TOOL_CONTEXT_CHANGED", true); }
        const contextChanged = async () => { try { await assertExecutionCurrent(); return false; } catch { return true; } };
        if (!spec) {
          try {
            const result = CallToolResultSchema.parse(await abortable(() => options.base.callTool({ name: call.name, arguments: call.arguments }, { signal: executionSignal }), executionSignal));
            const value = result.structuredContent;
            const returnedSession = typeof value?.session_id === "string" && value.session_id.length > 0 && value.session_id.length <= 160 ? value.session_id : undefined;
            return { result, outcome: "completed", contextChanged: await contextChanged(), ...(returnedSession ? { sessionId: returnedSession } : {}) };
          } catch {
            return { result: dataResult({ ok: false, error: { code: "TOOL_CALL_FAILED", message: "The base tool did not return a valid result. Its effects may already have occurred." } }, true), outcome: "unknown", contextChanged: await contextChanged() };
          }
        }
        let input: Record<string, unknown>;
        try {
          const parsed = await abortable(() => spec.input.safeParseAsync(jsonObject(call.arguments)), executionSignal);
          if (!parsed.success) return rejected("CUSTOM_TOOL_INPUT_INVALID");
          input = parsed.data;
        } catch { return rejected("CUSTOM_TOOL_INPUT_INVALID"); }
        // Validation/refinements and context resolution may await: check the captured lease again before entering the handler.
        try { await assertExecutionCurrent(); }
        catch { return rejected("TOOL_CONTEXT_CHANGED", true); }
        let code = "CUSTOM_TOOL_FAILED";
        let handlerStarted = false;
        try {
          const output = await abortable(() => { handlerStarted = true; return spec.handler(input, Object.freeze({ context: prepared.context.value, callId: call.id, signal: executionSignal, ...(guard ? { binding: guard.binding } : {}), assertCurrent: assertExecutionCurrent })); }, executionSignal);
          code = "CUSTOM_TOOL_OUTPUT_INVALID";
          const parsed = await abortable(() => spec.output.safeParseAsync(output), executionSignal);
          if (!parsed.success) throw new Error();
          const data = jsonObject(parsed.data);
          code = "TOOL_CONTEXT_CHANGED";
          await assertExecutionCurrent();
          return { result: dataResult({ ok: true, data, ...(guard ? { session_id: guard.binding.sessionId } : {}) }), outcome: "completed", contextChanged: false, ...(guard ? { sessionId: guard.binding.sessionId } : {}) };
        } catch {
          return { result: dataResult({ ok: false, error: { code, message: "The custom handler did not produce a valid current result. A write may already have occurred; reconcile it before retrying." } }, true), outcome: !handlerStarted ? "not_started" : spec.effect === "write" ? "unknown" : "completed", contextChanged: await contextChanged(), ...(guard ? { sessionId: guard.binding.sessionId } : {}) };
        }
      } finally { operation.abort(new Error("Tool dispatch ended.")); }
    };
    return { tools, metadata, contextKey, dispatch, assertCurrent, close };
  };
  return {
    async getExecutionIdentity({ signal }) { return { ...(await contract(signal)).identity }; },
    prepareTools,
    async listTools({ signal }) { const catalog = await prepareTools({ signal }); try { return catalog.tools; } finally { await catalog.close(); } },
    async callTool(call, { signal }) {
      const catalog = await prepareTools({ signal });
      try {
        const outcome = await catalog.dispatch({ ...call, id: `custom_${randomUUID()}` }, { signal });
        if (outcome.outcome === "unknown") throw new ToolRegistryError("CUSTOM_TOOL_OUTCOME_UNKNOWN");
        return outcome.result;
      } finally { await catalog.close(); }
    },
  };
}
