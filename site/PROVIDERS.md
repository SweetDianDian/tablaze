# Provider adapters / 模型适配器

Each adapter returns the same `AgentPlanner` used by `runAgent`. Select a model explicitly and supply credentials through trusted application configuration. Native HTTP adapters use the existing bounded decision parser, tool-result projection and Agent verification gate; they add no retries or tool execution of their own. The test suite uses owned local HTTP fixtures and scripted responses, not real Anthropic or Ollama inference. Historical Codex measurements do not measure these adapters.

## Anthropic Messages

```ts
import { createAnthropicPlanner, runAgent } from 'tablaze';

const planner = createAnthropicPlanner({
  model: configuredModel,
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxOutputTokens: 4096,
  onUsage: usage => recordActualUsage(usage),
});
const result = await runAgent({ task, planner, tools });
```

`createAnthropicPlanner(options)` uses native `POST https://api.anthropic.com/v1/messages`. A supplied key becomes `x-api-key`; requests use `anthropic-version: 2023-06-01`. `endpoint` accepts a full HTTP(S) override without embedded credentials. The factory does not read environment variables itself or derive credentials from task content. Official direct access needs appropriate Anthropic credentials; an application proxy may provide authentication separately. See the official [API overview](https://platform.claude.com/docs/en/api/overview).

The adapter sends system instructions separately, translates client tools to `input_schema`, and requests `tool_choice: { type: 'any', disable_parallel_tool_use: true }`. It does not enable extended thinking or server-side tools. The chosen model must support these tool settings; Anthropic documents exceptions, so this is not a claim of support for every model. See [tool definitions and tool choice](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools).

Historical executor call IDs become matching `tool_use.id` and `tool_result.tool_use_id`. All results immediately follow their assistant tool-call group, with errors marked `is_error`. Supported MCP images are embedded inside their corresponding tool results. Input history and checkpoints remain unchanged. The adapter accepts only a completed client-tool response with `stop_reason: 'tool_use'`; truncated, plain-text, unsupported block types and mixed terminal/tool decisions fail rather than implying completion. See [tool-result protocol](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) and [image inputs](https://platform.claude.com/docs/en/build-with-claude/vision).

`maxOutputTokens` becomes `max_tokens`, defaulting to 4096. The local range is 1–1,000,000; the selected model can impose a lower limit. This token setting differs from `maxResponseBytes`. See the official [Messages reference](https://platform.claude.com/docs/en/api/messages/create).

Usage mapping preserves only valid provider-reported nonnegative integer counters:

| Anthropic field | `AgentModelUsage` field |
| --- | --- |
| `input_tokens` | `uncachedPromptTokens` |
| `cache_read_input_tokens` | `cachedPromptTokens` |
| `cache_creation_input_tokens` | `cacheCreationPromptTokens` |
| `output_tokens` | `completionTokens` |
| All three input counters supplied | `promptTokens`: their normalized sum |

If any input component is missing, `promptTokens` remains absent. Missing counters are never filled with zero, and no total-token count or price is inferred. The measured `latencyMs` includes native HTTP handling and protocol conversion. The provider's response ID and model name are retained when present. Counter fields are documented in the [Messages response](https://platform.claude.com/docs/en/api/messages/create).

## Ollama native chat

```ts
import { createOllamaPlanner, runAgent } from 'tablaze';

const planner = createOllamaPlanner({
  model: configuredLocalModel,
  endpoint: 'http://localhost:11434/api/chat',
  supportsImages: modelSupportsImages,
  maxOutputTokens: 2048,
});
const result = await runAgent({ task, planner, tools });
```

`createOllamaPlanner(options)` uses native `/api/chat`, defaulting to `http://localhost:11434/api/chat`. It sends `stream: false` and `think: false`; it does not start Ollama, download a model or choose a model automatically. Optional `apiKey` becomes a Bearer authorization header for a server that requires it. A supplied `maxOutputTokens` maps to `options.num_predict`; omitting it leaves that provider setting absent. The same local positive-integer upper bound applies, without claiming the selected model accepts it. See the official [chat endpoint](https://docs.ollama.com/api/chat).

Ollama documents tool results using `tool_name` and call order, rather than an Anthropic-style result ID. The adapter checks complete ordered groups, sends native object arguments, and retains each executor call ID in the serialized result content used for verification citations. It does not invent an undocumented `tool_call_id` field. The chosen model must support tool calling; a text answer without a valid control/tool call cannot finish an Agent run. See [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling).

For images, the native message contains an `images` array of base64 strings, with matching tool labels in its text. Images follow their complete tool-result group in original order. Set `supportsImages: false` for a text-only model. Supporting tools and supporting vision are separate model capabilities; their combined use has only been tested at the HTTP protocol level here. See [Ollama vision input](https://docs.ollama.com/capabilities/vision).

`prompt_eval_count`, `eval_count` and optional `prompt_eval_cached_count` map directly to `promptTokens`, `completionTokens` and `cachedPromptTokens`. Missing or invalid counts remain absent. There is no synthesized total or pricing estimate. A response must have `done: true` and valid native tool calls; an unfinished or length-stopped response is rejected. See [chat response fields](https://docs.ollama.com/api/chat).

## Codex CLI planner

```ts
import { createCodexPlanner, runAgent } from 'tablaze';

const planner = createCodexPlanner({
  model: configuredModel,
  reasoningEffort: configuredReasoningEffort,
  timeoutMs: 120_000,
  onUsage: usage => recordActualUsage(usage),
  onDiagnostic: diagnostic => recordSafeDiagnostic(diagnostic),
});
try {
  const result = await runAgent({ task, planner, tools });
  inspectResult(result);
} finally {
  await planner.close();
}
```

`createCodexPlanner` returns a callable `CodexPlanner` with an async `close()`. It invokes the installed `codex exec` using the existing CLI-managed login; it does not request an API key, sign in for the user, or silently select a model. Install and authenticate Codex separately before using this adapter. The implementation's exported `CODEX_TESTED_CLI_VERSION` is `0.155.0-alpha.9.2`, the CLI version used for the project's earlier real Codex work and the protocol this adapter targets. Other CLI/model combinations need their own compatibility checks. See the official [non-interactive Codex documentation](https://learn.chatgpt.com/docs/non-interactive-mode) for ephemeral execution, JSONL events and structured output.

If Codex returns a structured function choice whose `arguments_json` string is malformed, the adapter can make **one** format-correction inference call with the same conversation and tool specifications. It dispatches no browser tool from the malformed choice. Both calls count toward the same planner deadline and reported model usage; `provider_diagnostics.formatRetries` records the extra call. Other invalid schemas, unknown tools and process failures remain terminal. A second malformed string also fails. Fixed `responseStage` diagnostics identify the rejected validation boundary without copying model text or arguments. The [three visible live attempts](https://github.com/SweetDianDian/tablaze/blob/main/docs/CODEX_PARTIAL_OUTPUT_SMOKE.md) show the failure that motivated this correction and its observed cost.

Options are `model` (required), `codexCommand` (default `codex`), trusted `codexCommandArgs`, optional `reasoningEffort`, `timeoutMs`, `maxResponseBytes`, `supportsImages`, `onUsage` and `onDiagnostic`. The per-planner-call timeout defaults to 120 seconds; the Agent's cumulative deadline still applies. Output JSON defaults to a 4 MiB cap, configurable up to 64 MiB. These are time and byte limits, not output-token settings. Codex does not accept this adapter's HTTP `endpoint`, `apiKey` or `maxOutputTokens` options. The CLI exposes it as `tablaze run --provider codex --model ...`; see [CLI setup](CODEX.md).

Each request starts a separate ephemeral inference process with a private temporary directory, an output schema and the current conversation/tool specifications. The adapter disables known execution features for the tested CLI, ignores user configuration for this invocation, and rejects observed external-tool events; Tablaze retains browser dispatch and verification. This is not a guarantee that a future CLI cannot introduce a new feature before the adapter observes its event. The executable and its launch configuration must be trusted. The current output schema permits one function decision per planner call. A generic error notification does not terminate an otherwise running turn. Acceptance requires a completed turn, successful process exit, a valid bounded output file, and arguments matching the selected tool schema. It does not interpret an intermediate completion message as a successful process return.

MCP screenshots are materialized as private temporary files and attached through the CLI's image arguments when enabled. Temporary files are removed during request cleanup. The task/history and image files may contain private data while that request runs. The executable path and prefix arguments are trusted application configuration; they must not come from page text or model tool arguments.

Always await `close()` when the application finishes, including after an Agent cancellation. It aborts outstanding inference, waits for process/file cleanup and final reported usage callbacks, rejects incomplete cleanup, and prevents new requests. The runner may return its cancellation status before a subprocess finishes shutting down; `close()` supplies the separate resource-lifecycle boundary. Calling it again returns the same closure result. On POSIX, each request owns a process group that is terminated even after successful inference. Escaped process groups and Windows descendant-process ownership are outside this guarantee.

`onUsage` receives only counters actually reported by completed CLI turn events; missing fields remain absent. Counters from multiple such events are summed only when each event supplies that counter. `onDiagnostic` reports fixed status/code, exit code, terminal-event kind, error-notification count and measured latency. It does not expose stderr, raw provider errors or reasoning text. These callbacks are trusted application hooks; keep them short and handle any sensitive data in normal task results separately.

This is CLI-mediated inference, not a raw OpenAI API equivalent. CLI prompts, process startup, account configuration and output constraints can affect behavior, latency and token usage. Earlier [Codex comparisons](https://github.com/SweetDianDian/tablaze/blob/main/docs/CODEX_COMPARISON_RESULTS_V3.md) and the [terminal-handling follow-up](https://github.com/SweetDianDian/tablaze/blob/main/docs/CODEX_TERMINAL_FOLLOWUP.md) used their recorded harness adapters and source hashes; they do not automatically validate or benchmark this new production planner. Its local process fixtures check control flow and protocol boundaries, not fresh real-model performance.

Codex 适配器要求显式模型，复用现有 CLI 登录，不等同于直接模型 API。应用必须在 `finally` 中等待 `planner.close()`，以完成取消后的子进程、临时文件和用量收尾。已记录的真实比较使用当时固定的 harness 与源码，不能直接视为本次生产适配器的新模型测量。

## Shared native HTTP boundaries

Both native factories accept `model`, `endpoint`, `apiKey`, trusted extra `headers`, `fetch`, `supportsImages`, `maxOutputTokens`, `maxResponseBytes` and `onUsage`. Images default to enabled and must use supported base64 JPEG/PNG/GIF/WebP content. `maxResponseBytes` defaults to 8 MiB and accepts at most 64 MiB. It bounds both the native response before conversion and the converted response; removing unknown metadata cannot evade the native limit. The underlying model request receives the Agent cancellation signal and redirects are rejected.

Unknown envelope metadata is not copied into Agent decisions or diagnostics. HTTP status, invalid JSON/decisions, interrupted responses and size limits use the existing fixed planner failure codes. Raw error bodies, exceptions, endpoint URLs and configured keys are not placed in those diagnostics. Invalid header/key configuration also produces a fixed factory error without echoing header names or values, including before the Agent starts. Normal tool content, model summaries and application usage callbacks retain their existing data-handling responsibilities. Optional caller-configured planner recovery remains separate; neither adapter adds default retry behavior.

The `run` CLI now accepts an explicit backup model across supported providers and optional primary-model retries. It switches after transient failures, or immediately on HTTP 401/402 without repeating the same credential, and stays on the backup for the rest of that run. A 403 or malformed model decision remains terminal by default. Codex process, timeout and failed-turn errors are retryable unless cancellation has begun. Recovery never repeats a browser tool call; the [Agent guide](AGENT.md#running-with-a-model) lists flags and report fields. Local fixtures verified one fallback decision chain and one real-Chrome browser write accepted exactly once by an independent HTTP server; these fixtures do not measure real-model availability, quality, cost or latency.

The compatibility-shaped intermediate request is intercepted in memory to reuse the existing parser and projection; it is never sent to an OpenAI-compatible endpoint. Only the configured native endpoint is fetched. Tests in `tests/providers.test.mjs` exercise actual local HTTP requests plus real in-memory MCP dispatch and verification, including repeated-name result pairing, images, errors, cancellation and response limits. These tests establish wire behavior under fixtures, not live-model quality, performance or general task reliability.

两种适配器都要求显式模型，使用可信配置中的凭据，并保留 Agent 预算、取消、失败分类与验收门槛。Anthropic 的缓存计数缺失时不补零；Ollama 的工具与图片能力取决于所选模型。当前验证仅覆盖本机 HTTP 协议和脚本响应，未运行真实 Anthropic/Ollama 模型，也未改写历史 Codex 对照结论。

The new production Codex path also has a [separate live smoke](https://github.com/SweetDianDian/tablaze/blob/main/docs/CODEX_PROVIDER_SMOKE.md): two visible tasks passed independent business checks and completed successfully (2/2), with zero duplicate writes. This is not a new matched Browser Use comparison.
