# Optional agent runner

Tablaze can execute a bounded observe–act–verify loop in addition to exposing browser MCP tools. `runAgent` accepts an injected planner and an MCP-compatible tool client. The planner decides the next action; browser tools remain responsible for schema validation, reference guards, and execution. The library requires a supplied planner and has no default model. The CLI defaults to the OpenAI-compatible protocol for backward compatibility, requires an explicit model, and makes no model call during MCP startup.

## Running with a model

Choose `--provider openai-compatible|codex|anthropic|ollama` and an explicit `--model`. The default `openai-compatible` accepts a complete **Chat Completions** endpoint; it does not infer a provider from the model name or implement native Anthropic/Responses protocols. Native Anthropic Messages and Ollama chat have separate adapters. Codex uses the installed CLI and its existing login. See [provider contracts and usage mappings](PROVIDERS.md) and [CLI options](CODEX.md#choose-a-planner-for-run).

For a compatible endpoint, set `TABLAZE_API_KEY` in your environment if required, then run:

```sh
tablaze run \
  --task "Open https://example.com and verify its title contains Example Domain." \
  --start-url https://example.com \
  --provider openai-compatible \
  --model "$TABLAZE_MODEL" \
  --endpoint "$TABLAZE_MODEL_ENDPOINT" \
  --channel chrome \
  --max-steps 30 \
  --max-calls 100 \
  --run-timeout-ms 300000
```

`--endpoint` is required only for the compatible provider. Native Anthropic and Ollama use their documented defaults unless a full endpoint is supplied. HTTP credentials come from `TABLAZE_API_KEY` or `--api-key-env MY_MODEL_KEY`; there is no API-key value flag. Codex rejects both endpoint and API-key flags and instead reuses CLI authentication. Agent-specific options require the `run` command. Standard browser options remain available. `--timeout-ms` controls browser actions; `--run-timeout-ms` bounds the whole agent run. The CLI emits planning progress on stderr and one JSON report on stdout. Exit status is `0` for verified success, `2` for required human input, and `1` for failure, cancellation, budget exhaustion, or incomplete resource cleanup. It attempts browser and MCP cleanup before publishing the report, and also awaits Codex planner cleanup when that provider is selected.

Local uploads in `run` and stdio MCP are denied by default. Repeat `--available-file /absolute/path` to authorize individual files. The Agent sees short IDs in `snapshot.available_files` and can also upload a completed download from the same session. A trusted `--storage-state-file /absolute/private/state.json` imports existing authentication state into new isolated sessions without exposing that file path to the model. [File policy](FILE_POLICY.md) covers the limits and checkpoint binding.

For Codex, select the model without configuring an HTTP endpoint:

```sh
node dist/cli.js run --provider codex --model "<your-codex-model>" \
  --task "<authorized task>" --channel chrome
```

For a backup model, add `--fallback-provider` and `--fallback-model`. The CLI uses the same provider when `--fallback-provider` is omitted. For a backup Codex installation or account, `--fallback-codex-command` selects its executable. For an HTTP backup, use `--fallback-endpoint` when it differs from the primary endpoint, and `--fallback-api-key-env` to name its credential variable. A cross-provider HTTP backup defaults to `TABLAZE_FALLBACK_API_KEY`. Provider-specific backup settings use `--fallback-reasoning-effort` or `--fallback-max-output-tokens`. `--planner-retries 1` permits one retry of a transient primary-model failure, with an optional `--planner-retry-delay-ms`; omit it to switch directly to the backup. For example:

```sh
node dist/cli.js run --provider codex --model "<primary-model>" \
  --fallback-provider codex --fallback-model "<backup-model>" \
  --task "<authorized task>" --channel chrome
```

The CLI keeps using the backup for later decisions in the same run. HTTP 401/402 can switch to an explicitly configured backup without retrying the failed credential; 403 remains terminal. Transient Codex timeout, process and turn failures can retry or switch, but cancellation cannot. Only model planning is repeated: an uncertain browser action is never replayed by recovery. When recovery is configured, the JSON report includes `planner_metrics` and `fallback_used`; a backup Codex planner also has `fallback_provider_diagnostics`. These fields record actual attempts and do not imply task success. Resuming a checkpoint starts a new CLI run and selects the configured primary again.

For page data extraction, `--extraction-model` selects an independent model and adds `tab_extract_model` to the Agent's tool catalog. `--extraction-provider` defaults to the primary provider; the corresponding endpoint, key environment variable, Codex command, reasoning effort and output-limit flags are available when applicable. The tool reads actual browser text and frame URL through `tab_extract`, rejects incomplete text, and checks JSON Schema and exact source quotes before returning data. Extracted data alone cannot finish a run: the Agent must still cite passing page verification. The report marks actual extraction-model usage with `role: "extraction"`. See [extraction and provenance](EXTRACTION.md#use-a-separate-extraction-model).

To require a machine-readable deliverable, pass a local draft-7 JSON Schema file to `--output-schema`:

```json
{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}
```

```sh
node dist/cli.js run --provider codex --model "<your-codex-model>" \
  --task "Read and verify the page title." --start-url https://example.com \
  --output-schema ./title.schema.json --channel chrome
```

The file must be a regular UTF-8 JSON file of at most 64 KiB. Final `data` must be JSON-safe, at most 2 MiB, and pass the supplied schema; otherwise the Agent asks the model to correct it and cannot report success. The result and successful CLI JSON report include `data`. Schema validity only checks shape and types: browser verification evidence from `tab_verify` or passing `tab_act.post_checks`, plus an optional application `validateCompletion` hook, still determine whether the claimed values satisfy the task. Treat final data as potentially sensitive page data. The schema digest is saved in checkpoints; resume requires the same schema file and rejects a different schema before browser restoration.

For long tasks, `--partial-schema ./partial.schema.json` enables `agent_publish`. The model can publish one JSON-safe, schema-valid unit under a unique key after citing current passing `tab_verify` or `tab_act.post_checks` call IDs. A trusted SDK caller can add `validatePartial({ task, key, data, evidence, history })` to enforce application-specific acceptance. Accepted units are append-only in `result.partials`, CLI reports, and checkpoints, including `needs_input`, cancellation, failure, or exhausted limits. They do **not** imply final task success. Each entry retains its verification checks at publication time; a later page change does not retroactively revalidate the entry. On resume, old verification cannot authorize a new publication: observe and verify again. The partial ledger allows at most 100 entries and 2 MiB total. Resume requires the exact original partial schema and, when used, the application hook again; CLI cannot restore an SDK hook. Both accepted data and its retained publication note may contain sensitive page values, and the checkpoint is a trusted local artifact rather than an authenticated receipt. This is checkpoint-backed partial output, not a separately durable file export or a cost limit.

Anthropic's `--max-output-tokens` maps to `max_tokens` and defaults to 4096. Ollama sends `options.num_predict` only when the flag is supplied. Codex's `--codex-command` defaults to `codex`; `--reasoning-effort` is optional and must be supported by the selected model/CLI. Inapplicable provider flags are rejected. These settings are independent of byte, time, and tool-call budgets. No adapter silently substitutes a model.

If cleanup fails after the Agent returns, the CLI reports `status: "failed"`, preserves the original result in `agent_status` and `agent_reason`, and adds `cleanup: { status: "incomplete", code, message }`. Verification evidence is retained; a cleanup error does not erase a verified business result or count as successful disposal. Cleanup errors also appear on stderr, including when browser restoration was interrupted before an Agent result existed. Browser disposal reports `CLEANUP_INCOMPLETE` when cleanup cannot be confirmed within two seconds. An attached CDP connection may remain alive to clean up a late owned page, so this bounded result does not guarantee that the CLI process has exited. See [runtime cancellation and ownership](RUNTIME.md) for the resource boundary.

`--start-url` optionally opens one explicitly supplied HTTP(S) URL before the first model decision. It rejects embedded credentials; URLs are never automatically extracted from task prose, pages, tool results, or model output. The opening is a real `tab_open` through the same MCP client, call IDs, write-ahead checkpoints, error handling, and tool/time/history budgets as later calls. Initialization emits tool events at step `0`, consumes one tool call, and consumes no planning step or model call. Its actual snapshot is available to the first planner request. A missing `tab_open` tool fails before planning, and an exhausted initialization budget cannot silently start the planner.

`--popup-policy stay|follow-single` is a browser option available to both stdio MCP and `run`; `stay` is the default. The library equivalent is `createServer({ popupPolicy: "follow-single" })`. Following considers a unique new popup from the acted-on owned page during a bounded observation window. After a switch, the action returns a fresh snapshot and `replan_required: true`; remaining actions and later tools in that decision are skipped. `ok: true` can describe the completed action while `batch_complete: false` identifies skipped actions. Plan from the new snapshot and still verify the business outcome. Popup association within this window does not establish that an asynchronous business operation has completed; a later observation or bounded verification may be needed.

The default CLI report excludes raw task prompts, tool arguments, and conversation history. It includes the model's terminal summary/question, optional schema-validated final data, checked partial data when configured, and verification check results, which can themselves contain page data; it is **not** a redacted export. The CLI applies the default mechanical verification gate. Use the programmatic `validateCompletion` and `validatePartial` hooks when exact task-specific acceptance rules are required.

```ts
import {
  createServer, connectAgentTools, createOpenAICompatiblePlanner, runAgent,
} from "tablaze";

const runtime = createServer({ headless: true, channel: "chrome" });
const connection = await connectAgentTools(runtime.server);
try {
  const result = await runAgent({
    task: "Open https://example.com and verify that its page title contains Example Domain.",
    startUrl: "https://example.com", // Optional explicit initialization; never inferred from task text.
    tools: connection.tools,
    planner: createOpenAICompatiblePlanner({
      endpoint: process.env.TABLAZE_MODEL_ENDPOINT!, // Full /v1/chat/completions URL
      model: process.env.TABLAZE_MODEL!,
      apiKey: process.env.TABLAZE_API_KEY,
    }),
    maxSteps: 30,
    maxToolCalls: 100,
    timeoutMs: 300_000,
    validateCompletion: ({ evidence }) => evidence.some(item =>
      Array.isArray(item.arguments.checks) && item.arguments.checks.some(check =>
        check.kind === "title" && check.contains === "Example Domain")),
  });
  console.log(result.status, result.summary ?? result.reason);
} finally {
  await connection.close();
  await runtime.dispose();
}
```

With the Codex SDK factory, always close the caller-owned planner after `runAgent`, including when the Agent returns cancellation before its subprocess exits:

```ts
const planner = createCodexPlanner({ model: configuredModel });
try {
  const result = await runAgent({ task, planner, tools });
  inspectResult(result);
} finally {
  await planner.close();
}
```

Import `createCodexPlanner` from `tablaze`. Its `close()` cancels outstanding requests, waits for process/file cleanup and reported-usage callbacks, and prevents new calls. Incomplete planner cleanup produces `CODEX_CLEANUP_FAILED`; the CLI preserves the original Agent outcome separately from this cleanup failure. A malformed Codex `arguments_json` value can trigger one extra format-only inference call, with no browser dispatch before validation; both calls count toward the same deadline and usage. See [Codex lifecycle and authentication](PROVIDERS.md#codex-cli-planner).

### Live operator intervention (SDK)

Create one `AgentControl` for one active `runAgent` call. `pause()` resolves `true` when the Agent reaches a safe planning/tool boundary, or `false` if it finishes first. After a successful pause, a trusted caller can inspect the application or browser, call `steer(text)` to refine the original task, and then call `resume()`:

```ts
import { createAgentControl, runAgent } from "tablaze";

const control = createAgentControl();
const running = runAgent({ task, planner, tools, control });
if (await control.pause()) {
  control.steer("The approved record is WF-001. Verify it before finishing.");
  control.resume();
}
const result = await running;
```

An already-running tool can finish; pause cannot roll it back. A pending model decision is discarded, and later calls in its queued tool batch are recorded as skipped before replanning. Pause or steering invalidates prior verification and observed references, so the Agent must observe and verify again. If pause arrives during write-ahead persistence, the current call is stopped before dispatch; a crash at that precise point may still leave a conservative uncertain-call checkpoint requiring reconciliation. Operator text is bounded to 10 KiB per instruction and 32 KiB pending, becomes part of history/checkpoints, and must not contain credentials. The caller must keep steering within the original authorized task; browser guards, verification, and `validateCompletion` still apply. The cumulative run deadline keeps counting while paused; the caller can cancel via the existing `signal`. This is an in-process SDK control, not a cross-process CLI command or a persistent JavaScript worker.

The application supplies the task and retains responsibility for authorization. A website cannot authorize a task change. Page text and images are marked as untrusted inputs in the model instructions; this is a prompt-level defense, not a guarantee against prompt injection. Do not enable tools or accounts outside the intended task scope.

## Provider-independent planning

An `AgentPlanner` receives `{ task, messages, tools, step, signal, finalOutputSchema?, partialOutputSchema? }`. `tools` is the discovered public catalog, including JSON input/output schemas and annotations. A standard MCP client discovers it once per invocation; the optional bound execution interface below refreshes it for each decision. The `messages` contain actual results, `isError`, structured output, and image blocks. Implement a planner using any model/provider or a deterministic policy:

```ts
const planner = async ({ messages, tools, signal }) => {
  // Call your provider with these schemas and the retained history.
  return {
    type: "tools",
    calls: [{ name: "tab_open", arguments: { url: "https://example.com" } }],
  };
};
```

Supported decisions:

| Decision | Fields | Effect |
| --- | --- | --- |
| `tools` | `calls: [{ name, arguments }]` | Execute 1–20 calls sequentially. |
| `finish` | `summary`, `evidence: [toolCallId]`, optional `data` | Request completion with actual verification evidence and, when configured, schema-valid JSON data. |
| `publish` | `key`, `data`, `evidence: [toolCallId]` | Store one checked, schema-valid partial when `partialOutputSchema` is configured; continue the task. |
| `human_input` | `question` | Return `needs_input`; no further actions execute. |
| `fail` | `reason` | Return `failed`; no further actions execute. |

The built-in planners expose those terminal decisions as `agent_finish`, `agent_request_input`, and `agent_fail` function tools. With a partial schema they also expose the nonterminal `agent_publish` control tool. A terminal or publication decision must appear alone. Normal calls receive executor-generated IDs containing a persistent run ID and increasing call sequence; cite those IDs for verification. Malformed injected planner decisions produce feedback and consume a planning step. By default an HTTP/provider exception or malformed HTTP response fails the run. Optional planner recovery is described below; tool execution is never automatically retried.

Use `createMcpToolClient(client)` with an already-connected SDK `Client` for stdio or remote MCP. Use `connectAgentTools(server)` with a fresh `McpServer` for the same protocol and validation over in-memory transport. Its `close()` is explicit. `runAgent` does not close a caller-owned client or browser automatically, so an application can inspect a failure or continue after human input. Dispose resources in `finally` when finished.

To add a custom action, register it on the MCP server before connecting, with an input schema and accurate annotations. It appears in the discovered catalog automatically. A custom `AgentToolClient` can expose a different tool runtime; it is responsible for validating input against its schemas. Tool implementations, schema metadata, planner implementations, application hooks, and the MCP endpoint are trusted code, unlike page content.

### Bound execution and dynamic catalogs

An `AgentToolClient` can additionally supply both `getExecutionIdentity({ signal })` and `prepareTools({ signal })`. Supplying only one is rejected. The identity contains `registryHash` and `contextHash`, each a lowercase SHA-256 digest. The runtime must hash its complete stable registry contract, including versions, input/output schemas, effects and origin policies, and bind the caller's tenant/context identity independently of page or model text. The visible tool subset is not the registry identity: ordinary navigation can change availability without changing the registered contracts. Hash comparison does not authenticate an untrusted checkpoint file or identify a tenant from its URL.

`prepareTools` returns an `AgentToolCatalog` containing public `tools`, a trusted `metadata` map with `{ effect: "read" | "write", sessionId? }`, a private `contextKey`, `assertCurrent()`, `dispatch(call, { signal })`, and `close()`. Metadata covers the complete registry, including tools unavailable in the current page context, so pending effects can be checked on resume. Each decision, including explicit initialization, gets a new catalog. The planner receives only copied `name`, `description`, `inputSchema`, `outputSchema` and `annotations` fields. Metadata, context leases and dispatch functions are never passed to it.

`contextKey` is a stable lowercase SHA-256 digest of the current execution binding across leases, including browser document and activation generations where applicable. A change between decisions invalidates earlier evidence and snapshot references, including a tab switch away and back. This closes the gap between releasing an old lease and preparing the next one. Evidence that was current when a successful `tab_close` confirmed `closed: true` for its exact session is retained across context-only changes, preserving verify–close–finish. Any later mutation still invalidates it; an uncertain close or `tab_tabs` close has no exception. The key stays in runner memory and is not persisted or passed to the planner; resumed runs already require fresh evidence. The registry/caller identity used for resume stays distinct from this changing browser context. A context key does not detect arbitrary DOM changes or make verification atomic.

After planning, the runner calls `assertCurrent`, including before a proposed finish. Rejection discards the old decision and invalidates prior evidence before replanning. The dispatcher must independently recheck its captured context immediately before invoking a handler: the page can change while the runner saves its write-ahead checkpoint. It receives the executor-generated `call.id`, suitable for an application idempotency key. Context checks must include the trusted tenant/context boundary as well as the relevant browser document, tab, frame and origin; same-origin tenant changes must not silently reuse a lease. A handler that awaits before submitting an external write must retain its captured credentials/target or recheck them itself. This protocol does not make webpage scripts and remote side effects atomic.

Dispatch returns a private envelope `{ result, outcome, contextChanged?, sessionId? }`. Only its `result` becomes tool output. `outcome: "not_started"` means the runtime rejected the call before the handler ran and does not create mutation ambiguity. A write with an unknown outcome, invalid result, thrown exception or failure after entry requires trusted reconciliation. Public `readOnlyHint` cannot override the trusted effect metadata. `contextChanged: true` stops remaining calls in that decision, clears old evidence and triggers replanning; it is not evidence of task success. A dispatch attempt consumes one tool-call budget unit even when its guard rejects it; later skipped calls do not. Custom output validation remains the runtime's responsibility, and custom success never substitutes for browser verification and the application policy.

Catalog discovery, dispatch and identity checks share cancellation and the cumulative deadline. Every acquired catalog is closed after its decision; the terminal path closes it before saving and returning a result. Close has a five-second cleanup bound, and cancellation or deadline expiry during it cannot return success. A noncooperating preparation that resolves after cancellation is also asked to close its late lease; the already-returned cancelled result cannot guarantee that delayed cleanup completed. The runner does not close the caller-owned tool client.

## Completion and failures

`succeeded` requires a model `finish` decision citing a real, successful `tab_verify` response or a completed `tab_act` batch with passing `post_checks`. The verification must have `passed: true`, nonempty check results that all pass, the same number of results as requested checks, a matching session, and no `isError` or `ok: false`; post-check result kinds must also match the requested kinds. An action result alone, invented IDs, and failed checks cannot complete a run. A later `tab_verify` of the same session replaces earlier evidence, even when it fails.

Page-text checks exclude raw `input`, `textarea` and `select` values. Verify an observed form control with a `value` check using its `ref` and the latest `snapshot_id`; use `text` checks for rendered status messages. A value check accepts exactly one of `ref` or `selector`. Ref checks require `snapshot_id`, reject stale references, and do not expose password or hidden fields. For example, using references and expected outcomes from the current task:

```ts
await tools.callTool({
  name: "tab_verify",
  arguments: {
    session_id: currentSnapshot.session_id,
    snapshot_id: currentSnapshot.snapshot_id,
    checks: [
      { kind: "value", ref: observedField.ref, value: expectedValue },
      { kind: "text", contains: expectedStatus },
    ],
  },
}, { signal });
```

When the expected same-document outcome is known before acting, `tab_act` may include 1–20 `post_checks` and an optional `verify_timeout_ms` (100–60,000 ms). The action batch runs once. Only after every action completes does `tab_verify`'s browser-side checker run against the original snapshot refs, waiting for asynchronous status changes. The result contains `verification`; passing checks can be cited using the `tab_act` toolCallId. Failed checks leave the completed actions intact and return `replan_required: true`, skipping later queued tools without declaring the write unknown. A failed action or followed popup never runs the post-checks. The post-check timeout is separate from the action budget. Ref checks fail if their document or node changes, so use a fresh snapshot and separate `tab_verify` for navigation. A value in an input is not page text unless visibly echoed outside the control.

For a delayed button or menu item revealed by an observed opener, `click_named` can follow a completed activating action inside that same `tab_act` batch. It waits for one visible exact accessible name across those two roles, checks that the same element remains before input, and rejects missing, ambiguous or replaced targets. It does not accept arbitrary selectors or replace normal ref-based input. If the opener succeeded but the named target failed, the opener's effect remains; re-observe rather than replaying it. A post-check that would already pass before the final action is not business-outcome evidence.

The agent instructions favor the latest snapshot already returned by a tool, including the snapshot nested in an action result. If the result already contains passing post-checks, no extra observation or verification call is needed. Otherwise use `tab_verify` on a current observation when the expected outcome is known. Observe again when references are stale, required information is absent or truncated, or a later page change invalidates the observation. These instructions guide planning and do not establish a general model reliability or speed improvement.

New mutations invalidate earlier verification. The final cited evidence must include the session of the latest mutation when that session is available. A successful `tab_close` is treated as cleanup, allowing verify–close–finish. A failed close invalidates prior evidence because its effects are uncertain. Tools without `readOnlyHint: true` are conservatively treated as mutations. This global invalidation can require repeating checks during workflows involving multiple sessions; it does not establish a business transaction across those sessions.

These mechanical checks do **not** prove that a model selected assertions covering every part of the user's request. For example, the presence of a page title does not prove an invoice was submitted. Use `finalOutputSchema` on `runAgent` to require JSON data and `validateCompletion` to require task-specific checks and outcomes. The hook receives `{ task, summary, data?, evidence, history }`; return `true` to accept, `false` or a corrective string to replan. The default does not infer business semantics or establish a comparative task success rate.

Any MCP `isError: true` or structured `ok: false` stops the current tool-call batch. Later calls in that batch are recorded as skipped. Ordinary reported failures return to the planner; a stale reference requires a new observation. If a mutating tool throws or returns a malformed result, its effects are unknown: the runner stops with `needs_input` and records the call as ambiguous. It never automatically repeats a mutating action.

Structured `replan_required: true` also stops later calls in the same decision, even when the preceding tool succeeded. Skipped calls do not consume the tool-call budget. This allows a tool to report a successful tab transition without dispatching queued calls against the old context; it does not satisfy the completion gate.

Return states are `succeeded`, `failed`, `needs_input`, `cancelled`, and `limit_reached`. A result includes cumulative step/tool/planner counts, in-memory history, event trace, a versioned checkpoint, per-attempt planner metrics, and cited evidence on success. `onEvent` can update an application UI while planning and tools progress. `onMetrics` records each primary/fallback planner attempt's step, latency, and success/error outcome. These are measured execution times, not token or cost estimates. These two hooks and the completion policy are synchronous trusted callbacks; keep them short.

An unrecovered infrastructure or application exception also produces an optional `failure` object, exposed unchanged in the CLI report. It contains only `phase`, a fixed `code`, `retryable`, and an optional numeric `httpStatus`. For example, an HTTP 502 response produces `{ phase: "planner", code: "PLANNER_HTTP_ERROR", retryable: true, httpStatus: 502 }`. It does not reveal the provider's response body or establish the upstream cause of that response. No raw exception, message, stack, cause, URL, credential, or arbitrary exception property is copied into this diagnostic.

| Phase | Diagnostic codes |
| --- | --- |
| `planner` | `PLANNER_FAILED`, `PLANNER_PROCESS_FAILED`, `PLANNER_TRANSPORT_FAILED`, `PLANNER_HTTP_ERROR`, `PLANNER_INVALID_RESPONSE`, `PLANNER_RESPONSE_TOO_LARGE`, `PLANNER_RESPONSE_READ_FAILED`, `PLANNER_TOOL_NAME_CONFLICT` |
| `catalog` | `TOOL_CATALOG_FAILED`, `TOOL_CATALOG_INVALID`, `TOOL_NAMES_DUPLICATED`, `INITIALIZATION_TOOL_MISSING`, `EXECUTION_IDENTITY_INVALID`, `EXECUTION_IDENTITY_MISMATCH`, `TOOL_CATALOG_CLOSE_FAILED` |
| `application` | `EVENT_HOOK_FAILED`, `METRICS_HOOK_FAILED`, `COMPLETION_HOOK_FAILED`, `RETRY_POLICY_FAILED`, `USAGE_HOOK_FAILED` |
| `persistence` | `CHECKPOINT_PERSISTENCE_FAILED`, `CHECKPOINT_PERSISTENCE_TIMEOUT` |
| `executor` | `EXECUTOR_FAILED` for an otherwise unclassified execution exception |

`retryable` means the current known policy recognizes a failure as eligible for retry, including an explicit `shouldRetry` override for planner failures. It does not promise that another attempt will succeed or that any retry was made; default retries remain zero. Unknown generic failures report `false`, which does not establish permanent failure. Recovered planner attempts remain visible in metrics and do not leave a terminal `failure`. An explicit model `fail` decision, ordinary tool-error feedback, or cancellation without another failure does not acquire an infrastructure diagnosis. Existing result statuses and completion requirements remain authoritative.

The retained `events` array records `{ type: "failure", step, failure }`. This diagnostic event bypasses `onEvent`, so reporting a broken callback cannot recursively invoke it. If final persistence also fails, that becomes the result's latest `failure` and both diagnoses remain in events. Diagnostics are not added to history or the checkpoint schema, and are not inherited as a failure of a resumed run. Application-supplied summaries, task text, tool results, and the rest of the audit trace retain their existing data-handling rules; this diagnostic format is not a redactor for those fields.

## Checkpoints and safe resume

Use `onCheckpoint: async checkpoint => { ... }` to save `AgentCheckpoint` JSON. The runner awaits this callback before dispatching each tool, after results, at completed decisions, and at termination. `phase` is `planning`, `before_tool`, `after_tool`, `decision`, or `terminal`. The callback has a five-second deadline: a failing or noncooperating persistence operation stops further dispatch, and is not retried. That final persistence deadline can extend a cancelled run's return time; cancellation or timeout during the final callback cannot return success. Persistence callbacks should write atomically and must not independently reorder writes. The returned checkpoint includes all awaited final-save time. An already-written file records elapsed time at its write boundary and cannot include its own eventual I/O completion latency; a subsequent checkpoint accounts for earlier waits.

`before_tool` records the call before its effect can start. Its `pendingTool` is conservatively uncertain even if a process crashes before dispatch. Every serialized assistant/tool group is complete: unresolved calls have explicit `OUTCOME_UNKNOWN` results, and calls not reached yet have `NOT_DISPATCHED` results. These placeholders never claim an action succeeded. No stored pending call or later batch call is replayed on resume.

Pass a loaded object to `resume`, or validate it first with `parseAgentCheckpoint`. Version, bounded JSON size, original task boundary, message pairing, call IDs/sequences, pending calls, and budget counters are checked. The resumed `task` must exactly match. The run ID, call sequence, cumulative steps, tool calls, planner calls, and active elapsed time continue; process downtime is not counted. Limits default to saved limits. A trusted caller can explicitly increase them; completed counts never reset. The original application `systemPrompt` is inherited unless the caller explicitly replaces it. If the original run installed `validateCompletion`, the checkpoint records `requiresCompletionPolicy`; resuming without supplying that function again is rejected before any execution. Functions cannot be serialized, and the caller must supply the intended policy implementation. Do not load checkpoint files from untrusted authors: schema validation detects invalid structure, not forged provenance or a maliciously rewritten history.

Checkpoint version `5` preserves optional initialization as `not_started` or `attempted`, with the latter pointing to the first standalone `tab_open` call. `attempted` means the call was registered; actual execution, results, and uncertainty remain represented by its paired history, pending call, and ambiguity entries. Once registered, initialization is never automatically replayed, including after reconciliation or persistence failure. Only a saved `not_started` initializer can run on resume. A resumed `startUrl`, if supplied, must equal the saved canonical URL; an existing run cannot acquire a new initialization URL. Strictly valid version `1` through `4` checkpoints migrate to version `5` without inventing newer contracts. Version `5` saves `outputSchemaHash` and `partialSchemaHash` when configured; a resumed run must provide the same schemas, and a previously unconfigured run cannot acquire either. Accepted partials and their matching publication notes are retained across compaction. The initialization history group is also retained so its identity and counters remain verifiable.

A bound run saves `executionIdentity: { registryHash, contextHash }`. Resume requires the paired execution methods and exact identity equality before catalog preparation or planning. Missing or different bindings cannot be waived by reconciliation, and an old unbound checkpoint cannot gain a registry on resume. A claimed pending read is retained until its effect is checked against trusted registry metadata; a mismatch blocks execution. Fresh leases are always acquired, old refs and completion evidence remain invalid, and earlier calls are never replayed. Legacy clients without the bound interface continue to resume unbound checkpoints.

On every resume, completion evidence is reset. A model cannot finish using an old passing check. Historical browser references are invalid: calls using a saved snapshot are rejected until a new `tab_snapshot` (or equivalent fresh observation) returns a current snapshot. `resumeSessionMap: { oldSessionId: newSessionId }` supplies IDs for recreated contexts, and `resumeFeedback` supplies trusted restoration context. Original history is retained as history; session IDs and previous outcomes are not silently rewritten.

An unresolved `ambiguousCalls` entry, including a pending mutation, causes `needs_input` **before any planner or tool call**. Only the application can clear it by supplying `reconciliation: { resolvedCallIds, note }` after checking actual business effects. A model statement or webpage instruction cannot clear this gate. This acknowledgment does not mark the task complete or authorize replay; fresh observations and verification are still required.

The CLI pairs agent checkpoints with browser state:

```sh
tablaze run --task "Your authorized task" --output-schema ./result.schema.json \
  --model "$TABLAZE_MODEL" --endpoint "$TABLAZE_MODEL_ENDPOINT" \
  --channel chrome --checkpoint ./private-run.json

tablaze run --resume ./private-run.json --output-schema ./result.schema.json \
  --model "$TABLAZE_MODEL" --endpoint "$TABLAZE_MODEL_ENDPOINT" \
  --channel chrome
```

The checkpoint file is written via a private temporary file and atomic rename. It contains full history and browser cookies, localStorage, and IndexedDB and must be treated as a credential-bearing file. Browser restoration creates fresh isolated contexts and tabs from stored URLs and storage. It does not restore DOM, form drafts, sessionStorage, unfinished downloads, or in-flight network transactions. Observing restored pages is required. Browser state is refreshed at settled decision/terminal boundaries; write-ahead checkpoints may still carry the previous browser-state snapshot. HTTP model credentials are read again from the configured environment; Codex reuses its current CLI login. Provider/model options must be supplied on each CLI invocation.

The browser workspace also records its popup policy. Resume inherits it; older workspaces default to `stay`. An explicit CLI `--popup-policy` that differs from the saved policy is rejected before browser restoration. Restoring a saved tab reloads its URL as part of workspace restoration, independently of the at-most-once initialization call; neither mechanism rolls back remote effects or makes page-load side effects idempotent.

An ambiguous CLI resume exits with `needs_input` and code `2` without starting a browser or model. After independently checking actual effects, `--reconciled "Description of the checked outcome"` acknowledges the saved ambiguous calls. It is an explicit operator acknowledgment, not an automated recovery strategy. `--checkpoint` can select a new destination during resume; otherwise the resumed file is updated. Use `--max-steps`, `--max-calls`, or `--run-timeout-ms` explicitly to extend an exhausted saved budget.

## Stalls, planner recovery, and usage

Repeated actual read results or errors can indicate a loop. The detector hashes tool arguments and outputs, ignoring volatile snapshot/ref/timing fields, and detects repeated consecutive patterns up to eight calls long. Defaults require three repeats, provide one corrective replan, then stop with `needs_input` if the pattern repeats. Generic successful mutation receipts are not treated as proof of unchanged page state. Configure `stallDetection: { repeatThreshold, maxWarnings }` for a workload. Detection does not guarantee absence of a loop, and legitimate polling may need different thresholds or a purpose-built wait action.

`plannerRecovery: { maxRetries, retryDelayMs, fallback, stickyFallback, shouldRetry }` is optional. By default there are zero retries and no fallback. When enabled, only retryable planner failures are retried, then at most one fallback planner attempt runs for that step. `stickyFallback: true` keeps that backup for the remainder of this run. The HTTP adapter marks network `TypeError`s and HTTP `408`, `429`, and `5xx` as retryable. HTTP 401/402 are fallback-eligible, but are not retried against the same credentials; 403 is neither by default. Transient Codex timeouts, process exits and failed turns are retryable unless cancelled. Invalid responses are not automatically retried. Custom planners can throw `AgentPlannerError(message, true)` or an application can supply `shouldRetry`; the third `AgentPlannerError` argument can mark a non-retryable error as fallback-eligible. Retries consume planner calls, wall time, and potentially provider charges, but never repeat tool dispatch. Step limits count decisions; `plannerCalls` and metrics count every attempt.

The planners' `onUsage` callback reports `step`, model, optional response ID, measured latency, and only supported counters actually returned by their provider. The compatible adapter preserves reported prompt/completion/total/cache/reasoning counters. Anthropic separately retains uncached, cached and cache-creation input counts and normalizes `promptTokens` only when all three are present. Ollama maps its native evaluation counters. Codex aggregates a counter only when every retained completed-turn event supplied it, including a format-correction call. Missing counters stay absent; no total or price is invented. See [exact usage mappings](PROVIDERS.md). A provider response can report usage even when its subsequent decision is invalid. Missing/error responses can still incur charges that are not observable through this callback. CLI JSON includes reported `model_usage` records for the current invocation; it is not a billing ledger across all resumptions. Codex additionally emits fixed `provider_diagnostics` with process exit, terminal-event kind, error-notification count, format-retry count, validation stage when relevant, and latency. Raw stderr, provider errors and reasoning text are omitted. The CLI drains Codex cleanup before serializing these records, including usage received during cancellation.

## Budgets and cancellation

Defaults are 30 planning steps, 100 tool calls, five minutes, and 16 MiB of serialized conversation history. `maxSteps`, `maxToolCalls`, `timeoutMs`, and `maxHistoryBytes` are configurable. These are not token or monetary budgets. The hard history limit ends the run when compaction cannot fit protected content. An individual tool result can transiently exceed the limit; remaining calls in that decision are then skipped.

By default, history is compacted before planning once it exceeds 256 KiB. The default keeps the task, all trusted operator messages, six recent complete message groups, and active verification/ambiguity evidence; older tool groups become metadata containing only IDs, names, success/error outcomes and omission counts. Configure `historyCompaction: { triggerBytes, keepRecentGroups }` to adjust this behavior, or `historyCompaction: false` to retain the full history until the hard byte limit. Compaction does not invent a natural-language summary of page facts. If protected groups still exceed the hard budget, the run stops. Removed page details must be observed again before relying on them. This byte threshold is not a model-token or provider-cost guarantee.

An `AbortSignal` propagates to the planner and MCP request. A race also bounds waiting when a planner or tool ignores its signal. A cancelled result can contain `inFlightToolCall`, identifying an action whose effects remain uncertain. Cancellation does not undo completed actions, forcibly stop a noncooperating external tool, or guarantee that all browser operations are interrupted. In particular, individual browser tools differ in cancellation support; `tab_open` and `tab_act` handle cancellation directly. Applications that own the runtime can call `dispose()` to release it after cancellation. Never replay a cancelled mutation without examining the current state.

The compatible HTTP adapter sends one nonstreaming request per attempt, propagates the signal, rejects redirects, and caps its response at 8 MiB by default. The native Anthropic/Ollama adapters also default to 8 MiB and bound both the original native body and its converted response. Codex uses a separate ephemeral CLI process, defaults to a 120-second per-request deadline and a 4 MiB final-response cap; the overall Agent deadline still applies. Byte limits are not output-token budgets.

Image projection follows each protocol: compatible requests place images after the matching assistant/tool-result group; Anthropic embeds images in their corresponding tool results; Ollama attaches an ordered native image array with tool labels; Codex passes private temporary image files with message associations. `supportsImages: false` disables image forwarding for a text-only model. Tool calling and vision remain model-dependent. Plain assistant text without a valid tool/control decision does not complete a run.

For model requests only, the shared projection omits an MCP text block when its text exactly equals `JSON.stringify(structuredContent)` and the block has no properties other than `type` and `text`. Structured output, errors, call IDs, distinct or annotated text, and image ordering are retained. Text-only tool results remain intact. This removes redundant serialization without changing audit history, checkpoints, or completion evidence; it does not establish a measured token or latency reduction.

## Data handling and verification scope

No trace file is written unless an application installs `onCheckpoint` or the CLI uses `--checkpoint`/`--resume`. In-memory history and events include arguments, page text, URLs, structured results, and screenshots, and therefore may contain sensitive data. HTTP requests send retained history to the configured endpoint; Codex sends it through the separately authenticated local CLI. Compatible and configured Ollama keys use Bearer authorization, while Anthropic uses `x-api-key`; these keys are not added to history. Codex uses its existing login rather than a Tablaze API key, and its request-scoped private files can contain screenshots and model output until cleanup. Do not put credentials in prompts, endpoint URLs, or custom headers that you log. Treat `onEvent` output and any exported trace as sensitive. Endpoint error response bodies are not surfaced in run results.

`tests/providers.test.mjs` uses local native HTTP fixtures and in-memory MCP. `tests/provider-cli.test.mjs` exercises provider flags, reported usage, fake Codex executables, cancellation cleanup, checkpoint preflight and a real isolated Chrome verification. Codex process fixtures test JSONL termination, output/schema checks and safe diagnostics. These are protocol and lifecycle checks; native Anthropic/Ollama inference remains untested. The new production Codex planner has a [separately recorded two-task live smoke](https://github.com/SweetDianDian/tablaze/blob/main/docs/CODEX_PROVIDER_SMOKE.md). Earlier model comparison reports retain their original adapters and source hashes. The [Browser Use variants audit](https://github.com/SweetDianDian/tablaze/blob/main/docs/BROWSER_USE_VARIANTS.md) distinguishes Agent, MCP, Harness, Pi and cloud comparison targets; it is not a measured result against all those entry points.

`tests/agent-start-url.test.mjs` covers explicit initialization through actual MCP, step-zero accounting, cancellation and ambiguity, at-most-once resume, strict checkpoint migration, compaction, and decision interruption. It also starts real Chrome through separate CLI processes against a local scripted model endpoint, checking initialization history and inherited popup policy across restoration.

`tests/agent-diagnostics.test.mjs` exercises failure classification through actual MCP and scripted HTTP responses, including absent default retries, trusted retry-policy overrides, catalog and application-hook failures, persistence timeouts, unchanged resume schema, and omission of seeded secrets from diagnostics. The CLI tests also check a local HTTP 502 response end to end without copying its upstream error body into the report.

`tests/agent-bound-tools.test.mjs` uses real in-memory MCP dispatch with a deterministic execution-lease fixture. It verifies changing catalogs, private-metadata projection, context changes during planning and write-ahead persistence, uncertain writes, completion rechecks, identity-bound resume and migration, pending-effect validation, initialization, and lease release. These fixtures test the generic runner contract; the execution provider must independently implement and validate its context guards and output schemas.

`tests/agent.test.mjs` uses deterministic planners, the actual in-memory MCP protocol, a real isolated-browser form workflow, local HTTP model-protocol fixtures, failure cases, and cancellation tests. `tests/agent-cli.test.mjs` adds a spawned CLI with a local scripted Chat Completions endpoint and a real Chrome form, plus status/exit-code, argument validation, and report-content checks. `tests/agent-recovery.test.mjs` tests write-ahead uncertainty, safe resume, counters, compaction, stalls, retry/fallback, and usage accounting through MCP and scripted model responses. `tests/agent-resume-cli.test.mjs` verifies storage restoration across actual CLI processes, unique fresh sessions, no replay of completed effects, explicit reconciliation after interruption, and exhausted-budget preflight. Independent recovery-review tests cover policy continuity and cancellation during final persistence. `tests/planner-projection.test.mjs` checks exact duplicate removal, preservation of distinct text/errors/images, and unchanged audit results and checkpoints using scripted HTTP responses. These prove control-flow and protocol behavior under those fixtures. They do **not** measure live model planning quality, real-world task success, prompt-injection resistance, or superiority to another browser agent. No paid model request is needed for the test suite. A meaningful comparison requires a disclosed live-model task benchmark with matched models, tasks, budgets, and repeated runs.

The new production Codex path also has a [separate live smoke](https://github.com/SweetDianDian/tablaze/blob/main/docs/CODEX_PROVIDER_SMOKE.md): two visible tasks passed independent business checks and completed successfully (2/2), with zero duplicate writes. This is not a new matched Browser Use comparison.
