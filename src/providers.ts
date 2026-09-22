import { createOpenAICompatiblePlanner, type AgentMessage, type AgentModelUsage, type AgentPlanner } from "./agent.js";

export interface NativePlannerOptions {
  model: string;
  /** Full native HTTP endpoint; credentials must not be embedded in its URL. */
  endpoint?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  supportsImages?: boolean;
  maxResponseBytes?: number;
  /** Provider output-token setting, distinct from the response byte limit. */
  maxOutputTokens?: number;
  onUsage?: (usage: AgentModelUsage) => void;
}
export interface AnthropicPlannerOptions extends NativePlannerOptions {}
export interface OllamaPlannerOptions extends NativePlannerOptions {}

type JsonObject = Record<string, unknown>;
type ProjectedMessage = { role: string; content: string | null | JsonObject[]; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; tool_call_id?: string };
type ProjectedRequest = { messages: ProjectedMessage[]; tools: Array<{ type: string; function: { name: string; description?: string; parameters: JsonObject } }> };
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const encoder = new TextEncoder();

function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  return result;
}
function endpoint(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("endpoint must be an absolute HTTP(S) URL without embedded credentials."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("endpoint must be an absolute HTTP(S) URL without embedded credentials.");
  return parsed;
}
function imageSource(value: string): { type: "base64"; media_type: string; data: string } {
  const parsed = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!parsed || !parsed[2]) throw new Error("Unsupported image output.");
  return { type: "base64", media_type: parsed[1], data: parsed[2] };
}

/** Validate whole result groups before translating provider-specific associations. */
function toolNames(messages: ProjectedMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  let pending: Array<{ id: string; name: string }> = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const call = pending.shift();
      if (!call || call.id !== message.tool_call_id) throw new Error("Tool results are unpaired.");
      continue;
    }
    if (pending.length) throw new Error("Tool results are incomplete.");
    if (message.role === "assistant" && message.tool_calls) {
      pending = message.tool_calls.map(call => {
        if (names.has(call.id)) throw new Error("Repeated tool-call ID.");
        names.set(call.id, call.function.name);
        return { id: call.id, name: call.function.name };
      });
    }
  }
  if (pending.length) throw new Error("Tool results are incomplete.");
  return names;
}

function anthropicRequest(projected: ProjectedRequest, history: readonly AgentMessage[], supportsImages: boolean): JsonObject {
  toolNames(projected.messages);
  const messages: Array<{ role: "user" | "assistant"; content: JsonObject[] }> = [];
  const system: JsonObject[] = [];
  const originals = new Map(history.filter(message => message.role === "tool").map(message => [message.toolCallId, message]));
  const append = (role: "user" | "assistant", content: JsonObject[]) => {
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of projected.messages) {
    if (message.role === "system") { system.push({ type: "text", text: message.content }); continue; }
    if (message.role === "tool") {
      const result = JSON.parse(message.content as string) as JsonObject;
      const content: JsonObject[] = [{ type: "text", text: message.content }];
      if (supportsImages) for (const item of originals.get(message.tool_call_id!)?.result.content ?? []) {
        if (item.type === "image") content.push({ type: "image", source: imageSource(`data:${item.mimeType};base64,${item.data}`) });
      }
      const structured = result.structuredContent;
      append("user", [{ type: "tool_result", tool_use_id: message.tool_call_id, content, ...(result.isError === true || object(structured) && structured.ok === false ? { is_error: true } : {}) }]);
      continue;
    }
    // The shared projection attaches images after complete tool groups. Above,
    // Anthropic embeds those exact images inside their corresponding results.
    if (message.role === "user" && Array.isArray(message.content)) continue;
    const content: JsonObject[] = typeof message.content === "string" && message.content ? [{ type: "text", text: message.content }] : [];
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    append(message.role as "user" | "assistant", content);
  }
  return { system, messages, tools: projected.tools.map(tool => ({ name: tool.function.name, ...(tool.function.description === undefined ? {} : { description: tool.function.description }), input_schema: tool.function.parameters })), tool_choice: { type: "any", disable_parallel_tool_use: true } };
}

function ollamaRequest(projected: ProjectedRequest): JsonObject {
  const names = toolNames(projected.messages);
  const messages = projected.messages.map(message => {
    if (message.role === "tool") return { role: "tool", tool_name: names.get(message.tool_call_id!), content: message.content };
    if (Array.isArray(message.content)) {
      const images: string[] = []; const text: string[] = [];
      for (const item of message.content) {
        if (item.type === "text" && typeof item.text === "string") text.push(item.text);
        else if (item.type === "image_url" && object(item.image_url) && typeof item.image_url.url === "string") images.push(imageSource(item.image_url.url).data);
        else throw new Error("Unsupported message content.");
      }
      return { role: message.role, content: text.join("\n"), ...(images.length ? { images } : {}) };
    }
    return { role: message.role, content: message.content ?? "", ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ type: "function", function: { index, name: call.function.name, arguments: JSON.parse(call.function.arguments) } })) } : {}) };
  });
  return { messages, tools: projected.tools };
}

function anthropicResponse(value: unknown): JsonObject {
  if (!object(value)) return {};
  const result: JsonObject = { ...(typeof value.model === "string" ? { model: value.model } : {}), ...(typeof value.id === "string" ? { id: value.id } : {}) };
  if (object(value.usage)) {
    const usage = value.usage;
    const details: JsonObject = {};
    if (integer(usage.input_tokens)) details.uncached_tokens = usage.input_tokens;
    if (integer(usage.cache_read_input_tokens)) details.cached_tokens = usage.cache_read_input_tokens;
    if (integer(usage.cache_creation_input_tokens)) details.cache_creation_tokens = usage.cache_creation_input_tokens;
    const totalInput = integer(usage.input_tokens) && integer(usage.cache_read_input_tokens) && integer(usage.cache_creation_input_tokens) ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : undefined;
    result.usage = { ...(integer(totalInput) ? { prompt_tokens: totalInput } : {}), ...(integer(usage.output_tokens) ? { completion_tokens: usage.output_tokens } : {}), prompt_tokens_details: details };
  }
  if (value.type !== "message" || value.role !== "assistant" || value.stop_reason !== "tool_use" || !Array.isArray(value.content)) return result;
  const calls: JsonObject[] = []; const ids = new Set<string>();
  for (const block of value.content) {
    if (!object(block)) return result;
    if (block.type === "text" && typeof block.text === "string") continue;
    if (block.type !== "tool_use" || typeof block.id !== "string" || !block.id || ids.has(block.id) || typeof block.name !== "string" || !object(block.input) || block.toolset_name !== undefined) return result;
    ids.add(block.id);
    calls.push({ type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) } });
  }
  result.choices = [{ message: { tool_calls: calls } }];
  return result;
}

function ollamaResponse(value: unknown): JsonObject {
  if (!object(value)) return {};
  const result: JsonObject = { ...(typeof value.model === "string" ? { model: value.model } : {}) };
  if ([value.prompt_eval_count, value.eval_count, value.prompt_eval_cached_count].some(integer)) result.usage = {
    ...(integer(value.prompt_eval_count) ? { prompt_tokens: value.prompt_eval_count } : {}),
    ...(integer(value.eval_count) ? { completion_tokens: value.eval_count } : {}),
    ...(integer(value.prompt_eval_cached_count) ? { prompt_tokens_details: { cached_tokens: value.prompt_eval_cached_count } } : {}),
  };
  if (value.error !== undefined || value.done !== true || value.done_reason !== undefined && value.done_reason !== "stop" || !object(value.message) || value.message.role !== "assistant" || !Array.isArray(value.message.tool_calls)) return result;
  const calls: JsonObject[] = [];
  for (const call of value.message.tool_calls) {
    if (!object(call) || call.type !== undefined && call.type !== "function" || !object(call.function) || typeof call.function.name !== "string" || !object(call.function.arguments)) return result;
    calls.push({ type: "function", function: { name: call.function.name, arguments: JSON.stringify(call.function.arguments) } });
  }
  result.choices = [{ message: { tool_calls: calls } }];
  return result;
}

/** Read the native body within the same cap, preserving shared safe error categories. */
function translatedResponse(response: Response, maxBytes: number, translate: (value: unknown) => JsonObject): Response {
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) {
            // The shared parser reports its existing RESPONSE_TOO_LARGE code.
            controller.enqueue(new Uint8Array(maxBytes + 1)); controller.close();
            await reader.cancel().catch(() => {}); return;
          }
          chunks.push(chunk.value);
        }
        let value: JsonObject;
        try { value = translate(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { value = {}; }
        controller.enqueue(encoder.encode(JSON.stringify(value))); controller.close();
      } catch { controller.error(new Error("Native model response could not be read.")); }
      finally { reader.releaseLock(); }
    },
    cancel() { return reader.cancel().catch(() => {}); },
  }), { status: response.status, headers: { "content-type": "application/json" } });
}

function nativePlanner(provider: "anthropic" | "ollama", options: NativePlannerOptions): AgentPlanner {
  if (typeof options.model !== "string" || !options.model.trim()) throw new Error("model must be nonempty.");
  if (options.apiKey !== undefined && (typeof options.apiKey !== "string" || !options.apiKey.trim())) throw new Error("apiKey must be a nonempty string when supplied.");
  const target = endpoint(options.endpoint ?? (provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : "http://localhost:11434/api/chat"));
  const maxBytes = limit(options.maxResponseBytes, 8 * 1024 * 1024, 64 * 1024 * 1024, "maxResponseBytes");
  const maxTokens = options.maxOutputTokens === undefined && provider === "ollama" ? undefined : limit(options.maxOutputTokens, 4096, 1_000_000, "maxOutputTokens");
  const request = options.fetch ?? globalThis.fetch;
  let headers: Headers;
  try {
    headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    if (provider === "anthropic") { headers.set("anthropic-version", "2023-06-01"); if (options.apiKey) headers.set("x-api-key", options.apiKey); }
    else if (options.apiKey) headers.set("authorization", `Bearer ${options.apiKey}`);
  } catch {
    // Undici's validation errors embed invalid header names/values. Factories
    // run before the Agent diagnostic boundary, so never forward that exception.
    throw new Error("Invalid provider header configuration.");
  }
  return async input => {
    // This endpoint is intercepted in memory. Only target is passed to fetch.
    const planner = createOpenAICompatiblePlanner({ model: options.model, endpoint: "http://tablaze-adapter.invalid/v1/chat/completions", supportsImages: options.supportsImages, maxResponseBytes: maxBytes, onUsage: options.onUsage,
      fetch: async (_internal, init) => {
        let body: JsonObject;
        try {
          const projected = JSON.parse(init!.body as string) as ProjectedRequest;
          body = { model: options.model, ...(provider === "anthropic" ? { ...anthropicRequest(projected, input.messages, options.supportsImages !== false), max_tokens: maxTokens } : { ...ollamaRequest(projected), think: false, ...(maxTokens === undefined ? {} : { options: { num_predict: maxTokens } }) }), stream: false };
        } catch { return Response.json({}); }
        const response = await request(target, { method: "POST", redirect: "error", signal: init?.signal, headers, body: JSON.stringify(body) });
        return translatedResponse(response, maxBytes, provider === "anthropic" ? anthropicResponse : ollamaResponse);
      },
    });
    return planner(input);
  };
}

/** Native Anthropic Messages protocol; no provider SDK, retries or implicit model. */
export function createAnthropicPlanner(options: AnthropicPlannerOptions): AgentPlanner { return nativePlanner("anthropic", options); }
/** Native Ollama chat protocol. The selected model must support the requested tools/images. */
export function createOllamaPlanner(options: OllamaPlannerOptions): AgentPlanner { return nativePlanner("ollama", options); }
