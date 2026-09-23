import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AgentMessage, AgentPartial, AgentToolCall, AgentToolExecutionIdentity } from "./agent.js";

export const AGENT_CHECKPOINT_VERSION = 5 as const;

export const executionIdentitySchema = z.object({ registryHash: z.string().regex(/^[a-f0-9]{64}$/), contextHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Validate an explicitly supplied navigation target; never infer one from text. */
export function normalizeStartUrl(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192) throw new Error("startUrl must be an absolute HTTP(S) URL no longer than 8192 characters.");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("startUrl must be an absolute HTTP(S) URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.href.length > 8192) throw new Error("startUrl must use HTTP(S) without embedded credentials and be no longer than 8192 characters.");
  return parsed.href;
}

const startUrlSchema = z.string().min(1).max(8192).refine(value => {
  try { return normalizeStartUrl(value) === value; } catch { return false; }
}, "Invalid canonical start URL.");
const initializationSchema = z.discriminatedUnion("state", [
  z.object({ url: startUrlSchema, state: z.literal("not_started") }).strict(),
  z.object({ url: startUrlSchema, state: z.literal("attempted"), toolCallId: z.string().min(1).max(200) }).strict(),
]);

const callSchema = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200), arguments: z.record(z.unknown()) }).strict();
const messageSchema = z.union([
  z.object({ role: z.enum(["system", "user"]), content: z.string() }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string(), toolCalls: z.array(callSchema).min(1).max(20).optional() }).strict(),
  z.object({ role: z.literal("tool"), toolCallId: z.string().min(1).max(200), name: z.string().min(1).max(200), result: z.unknown().refine(value => CallToolResultSchema.safeParse(value).success).transform(value => CallToolResultSchema.parse(value)) }).strict(),
]);
const legacyCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
  task: z.string().min(1).max(1_000_000),
  systemPrompt: z.string().max(100_000).optional(),
  requiresCompletionPolicy: z.boolean().optional(),
  phase: z.enum(["planning", "before_tool", "after_tool", "decision", "terminal"]),
  createdAt: z.string().datetime(),
  nextCallSequence: z.number().int().min(1).max(1_000_000),
  steps: z.number().int().min(0).max(1_000),
  toolCalls: z.number().int().min(0).max(10_000),
  plannerCalls: z.number().int().min(0).max(7_000),
  elapsedMs: z.number().finite().min(0).max(172_800_000),
  limits: z.object({ maxSteps: z.number().int().min(1).max(1_000), maxToolCalls: z.number().int().min(1).max(10_000), timeoutMs: z.number().int().min(1).max(86_400_000), maxHistoryBytes: z.number().int().min(1).max(128 * 1024 * 1024) }).strict(),
  history: z.array(messageSchema).min(2).max(100_000),
  pendingTool: z.object({ call: callSchema, mutating: z.boolean() }).strict().optional(),
  ambiguousCalls: z.array(callSchema).max(100),
  lastMutationSession: z.string().max(160).optional(),
  stall: z.object({ fingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100), warnings: z.number().int().min(0).max(100) }).strict(),
}).strict();
const versionTwoCheckpointSchema = legacyCheckpointSchema.extend({
  schemaVersion: z.literal(2),
  initialization: initializationSchema.optional(),
}).strict();
const versionThreeCheckpointSchema = versionTwoCheckpointSchema.extend({
  schemaVersion: z.literal(3),
  executionIdentity: executionIdentitySchema.optional(),
}).strict();
const versionFourCheckpointSchema = versionThreeCheckpointSchema.extend({
  schemaVersion: z.literal(4),
  outputSchemaHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
const partialSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  data: z.unknown().refine(value => value !== undefined),
  evidence: z.array(z.object({ toolCallId: z.string().min(1).max(200), sessionId: z.string().min(1).max(160), checks: z.array(z.record(z.unknown())).min(1).max(100) }).strict()).min(1).max(100),
}).strict();
export const PARTIAL_HISTORY_PREFIX = "Executor checked partial: ";
const checkpointSchema = versionFourCheckpointSchema.extend({
  schemaVersion: z.literal(AGENT_CHECKPOINT_VERSION),
  partialSchemaHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requiresPartialPolicy: z.boolean().optional(),
  partials: z.array(partialSchema).max(100),
}).strict();

export interface AgentCheckpoint {
  schemaVersion: typeof AGENT_CHECKPOINT_VERSION;
  runId: string;
  task: string;
  systemPrompt?: string;
  requiresCompletionPolicy?: boolean;
  /** Resume must supply exactly the original final-result schema. */
  outputSchemaHash?: string;
  /** Resume must supply exactly the original partial-result schema and policy. */
  partialSchemaHash?: string;
  requiresPartialPolicy?: boolean;
  partials: AgentPartial[];
  /** Bound runs cannot resume with a different registry or caller context. */
  executionIdentity?: AgentToolExecutionIdentity;
  /** An attempted initializer is never automatically replayed, even after reconciliation. */
  initialization?: z.infer<typeof initializationSchema>;
  phase: "planning" | "before_tool" | "after_tool" | "decision" | "terminal";
  createdAt: string;
  nextCallSequence: number;
  steps: number;
  toolCalls: number;
  plannerCalls: number;
  elapsedMs: number;
  limits: { maxSteps: number; maxToolCalls: number; timeoutMs: number; maxHistoryBytes: number };
  history: AgentMessage[];
  pendingTool?: { call: AgentToolCall; mutating: boolean };
  ambiguousCalls: AgentToolCall[];
  lastMutationSession?: string;
  stall: { fingerprints: string[]; warnings: number };
}

/** Validate bounded JSON and complete assistant/tool-result groups before trusting a saved run. */
export function parseAgentCheckpoint(value: unknown, options: { maxBytes?: number } = {}): AgentCheckpoint {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) throw new Error("Invalid checkpoint size limit.");
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new Error("Checkpoint must contain JSON data."); }
  if (!encoded || Buffer.byteLength(encoded) > maxBytes) throw new Error("Checkpoint exceeds the size limit.");
  let raw = JSON.parse(encoded);
  if (raw?.schemaVersion === 1) {
    const legacy = legacyCheckpointSchema.safeParse(raw);
    if (!legacy.success) throw new Error("Invalid version 1 agent checkpoint.");
    // V1 had no initializer. Validate its exact old shape before migrating.
    raw = { ...legacy.data, schemaVersion: 2 };
  }
  if (raw?.schemaVersion === 2) {
    const legacy = versionTwoCheckpointSchema.safeParse(raw);
    if (!legacy.success) throw new Error("Invalid version 2 agent checkpoint.");
    // Older runs have no execution identity. Never infer a tenant/registry binding.
    raw = { ...legacy.data, schemaVersion: 3 };
  }
  if (raw?.schemaVersion === 3) {
    const legacy = versionThreeCheckpointSchema.safeParse(raw);
    if (!legacy.success) throw new Error("Invalid version 3 agent checkpoint.");
    raw = { ...legacy.data, schemaVersion: 4 };
  }
  if (raw?.schemaVersion === 4) {
    const legacy = versionFourCheckpointSchema.safeParse(raw);
    if (!legacy.success) throw new Error("Invalid version 4 agent checkpoint.");
    raw = { ...legacy.data, schemaVersion: AGENT_CHECKPOINT_VERSION, partials: [] };
  }
  const parsed = checkpointSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid or unsupported agent checkpoint.");
  const checkpoint = parsed.data as AgentCheckpoint;
  if (checkpoint.partials.length && !checkpoint.partialSchemaHash) throw new Error("Checkpoint partials require their original schema hash.");
  if (checkpoint.requiresPartialPolicy && !checkpoint.partialSchemaHash) throw new Error("Checkpoint partial policy requires its original schema hash.");
  if (Buffer.byteLength(JSON.stringify(checkpoint.partials)) > 2 * 1024 * 1024) throw new Error("Checkpoint partial results exceed the size limit.");
  if (new Set(checkpoint.partials.map(partial => partial.key)).size !== checkpoint.partials.length) throw new Error("Checkpoint repeats a partial key.");
  const publicationNotes = checkpoint.history.flatMap(message => message.role === "assistant" && message.content.startsWith(PARTIAL_HISTORY_PREFIX) ? [message.content] : []);
  if (publicationNotes.length !== checkpoint.partials.length || checkpoint.partials.some(partial => !publicationNotes.includes(PARTIAL_HISTORY_PREFIX + JSON.stringify(partial)))) throw new Error("Checkpoint partial results do not match their retained publication history.");
  if (checkpoint.steps > checkpoint.limits.maxSteps || checkpoint.toolCalls > checkpoint.limits.maxToolCalls) throw new Error("Checkpoint counters exceed their recorded budgets.");
  const initialCalls = checkpoint.initialization?.state === "attempted" ? 1 : 0;
  if (checkpoint.toolCalls > checkpoint.steps * 20 + initialCalls || checkpoint.plannerCalls > checkpoint.steps * 7 || checkpoint.nextCallSequence > checkpoint.steps * 20 + initialCalls + 1) throw new Error("Checkpoint counters are inconsistent.");
  if (checkpoint.history[0].role !== "system" || checkpoint.history[1].role !== "user" || checkpoint.history[1].content !== checkpoint.task) throw new Error("Checkpoint is missing its original task boundary.");
  const ids = new Map<string, AgentToolCall>();
  let expected: AgentToolCall[] = [];
  let recordedAttempts = 0;
  for (let index = 0; index < checkpoint.history.length; index++) {
    const message = checkpoint.history[index];
    if (index > 0 && message.role === "system") throw new Error("Checkpoint contains an unexpected system message.");
    if (message.role === "tool") {
      const call = expected.shift();
      if (!call || call.id !== message.toolCallId || call.name !== message.name) throw new Error("Checkpoint tool results are unpaired or out of order.");
      const error = message.result.structuredContent?.error;
      const code = error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined;
      if (code !== "NOT_DISPATCHED" && code !== "CALL_SKIPPED") recordedAttempts++;
      continue;
    }
    if (expected.length) throw new Error("Checkpoint contains an incomplete tool-call group.");
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        if (ids.has(call.id)) throw new Error("Checkpoint repeats a tool-call ID.");
        ids.set(call.id, call);
        const prefix = `${checkpoint.runId}_call_`;
        if (!call.id.startsWith(prefix) || !/^\d+$/.test(call.id.slice(prefix.length)) || Number(call.id.slice(prefix.length)) >= checkpoint.nextCallSequence) throw new Error("Checkpoint tool-call sequence is invalid.");
      }
      expected = [...message.toolCalls];
    }
  }
  if (expected.length) throw new Error("Checkpoint contains an incomplete tool-call group.");
  if (recordedAttempts > checkpoint.toolCalls) throw new Error("Checkpoint tool counter is smaller than its recorded attempts.");
  if (checkpoint.initialization?.state === "not_started") {
    if (checkpoint.steps || checkpoint.toolCalls || checkpoint.plannerCalls || checkpoint.nextCallSequence !== 1 || ids.size || checkpoint.pendingTool || checkpoint.ambiguousCalls.length) throw new Error("An unstarted initializer cannot have execution history or consumed counters.");
  } else if (checkpoint.initialization?.state === "attempted") {
    const initialization = checkpoint.initialization;
    const initial = ids.get(initialization.toolCallId);
    const firstGroup = checkpoint.history.find(message => message.role === "assistant" && message.toolCalls);
    if (initialization.toolCallId !== `${checkpoint.runId}_call_1` || !initial || initial.name !== "tab_open" || initial.arguments.url !== initialization.url || Object.keys(initial.arguments).length !== 1 || firstGroup?.role !== "assistant" || firstGroup.toolCalls?.length !== 1 || firstGroup.toolCalls[0].id !== initial.id) throw new Error("Initializer must identify the first, standalone tab_open call with the saved URL.");
  }
  const ambiguousIds = new Set<string>();
  for (const call of [...checkpoint.ambiguousCalls, ...(checkpoint.pendingTool ? [checkpoint.pendingTool.call] : [])]) {
    const recorded = ids.get(call.id);
    if (!recorded || JSON.stringify(recorded) !== JSON.stringify(call)) throw new Error("Checkpoint pending/ambiguous call is absent from its history.");
  }
  for (const call of checkpoint.ambiguousCalls) {
    if (ambiguousIds.has(call.id)) throw new Error("Checkpoint repeats an ambiguous call.");
    ambiguousIds.add(call.id);
  }
  if (checkpoint.phase === "before_tool" && !checkpoint.pendingTool) throw new Error("A before-tool checkpoint must identify its pending call.");
  return checkpoint;
}

/** Complete an interrupted group with explicit uncertainty; never invent a successful outcome. */
export function checkpointHistory(history: readonly AgentMessage[], pending?: AgentToolCall): AgentMessage[] {
  const complete: AgentMessage[] = [];
  let expected: AgentToolCall[] = [];
  const drain = () => {
    for (const call of expected) {
      const data = { ok: false, error: { code: call.id === pending?.id ? "OUTCOME_UNKNOWN" : "NOT_DISPATCHED", message: call.id === pending?.id ? "Execution may have started; the saved checkpoint contains no result. Trusted reconciliation is required before further mutations." : "This call was not dispatched before the checkpoint; it must not be automatically replayed." } };
      complete.push({ role: "tool", toolCallId: call.id, name: call.name, result: { isError: true, content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } });
    }
    expected = [];
  };
  for (const message of history) {
    if (message.role === "tool") { complete.push(message); expected.shift(); continue; }
    drain(); complete.push(message);
    if (message.role === "assistant" && message.toolCalls) expected = [...message.toolCalls];
  }
  drain();
  return structuredClone(complete);
}

const summaryPrefix = "Executor history compaction (metadata only; omitted content is not evidence): ";
/** Remove whole old tool groups; retain the task, recent groups, and referenced verification groups. */
export function compactAgentHistory(history: readonly AgentMessage[], options: { maxBytes: number; keepRecentGroups: number; protectedCallIds: readonly string[] }): AgentMessage[] | undefined {
  const groups: AgentMessage[][] = [];
  for (let index = 2; index < history.length; index++) {
    const message = history[index];
    const group = [message];
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        const result = history[++index];
        if (!result || result.role !== "tool" || result.toolCallId !== call.id) return undefined;
        group.push(result);
      }
    }
    groups.push(group);
  }
  const protectedIds = new Set(options.protectedCallIds);
  const kept: AgentMessage[][] = []; const metadata: Record<string, unknown>[] = []; let omittedGroups = 0;
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    const protectedGroup = group.some(message => message.role === "tool" && protectedIds.has(message.toolCallId) || message.role === "assistant" && message.content.startsWith(PARTIAL_HISTORY_PREFIX));
    if (index >= groups.length - options.keepRecentGroups || protectedGroup) { kept.push(group); continue; }
    omittedGroups++;
    for (const message of group) {
      if (message.role === "tool") {
        const data = message.result.structuredContent;
        const error = data && typeof data.error === "object" && data.error !== null ? data.error as Record<string, unknown> : undefined;
        metadata.push({ id: message.toolCallId, tool: message.name, isError: message.result.isError === true, ...(typeof data?.ok === "boolean" ? { ok: data.ok } : {}), ...(typeof error?.code === "string" ? { errorCode: error.code.slice(0, 100) } : {}) });
      } else if (message.role === "user" && message.content.startsWith(summaryPrefix)) {
        // Preserve the number of already-omitted groups; never promote old summaries to evidence.
        try { const previous = JSON.parse(message.content.slice(summaryPrefix.length)); if (Number.isInteger(previous.omittedGroups)) omittedGroups += previous.omittedGroups - 1; } catch { /* A damaged old summary is not trusted. */ }
      }
    }
  }
  if (!omittedGroups) return undefined;
  const summary: AgentMessage = { role: "user", content: summaryPrefix + JSON.stringify({ omittedGroups, recentOmittedToolOutcomes: metadata.slice(-50), note: "Arguments, page content, and older outcomes were dropped deterministically. Observe current state for any missing fact." }) };
  const compacted = [history[0], history[1], summary, ...kept.flat()];
  return Buffer.byteLength(JSON.stringify(compacted)) <= options.maxBytes ? structuredClone(compacted) : undefined;
}
