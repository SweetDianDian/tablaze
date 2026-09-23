# Executable comparison smoke harness

This runs development tasks, not a superiority experiment. `baseline.json`
remains unmeasured. See the [full comparison contract](../../docs/BROWSER_USE_COMPARISON.md).

## Model-free smoke

```sh
npm run build
node bench/comparison/runner.mjs --engine tablaze-scripted --preflight
node bench/comparison/runner.mjs --engine tablaze-scripted
```

The script uses `runAgent`, actual MCP calls and real Chrome. It knows the fixture
workflows, selectors and canvas coordinates. Results test integration and browser
functionality; they do not measure model planning or visual reasoning. No model
requests or paid calls occur in scripted mode.

The 16 tasks are `form`, `pagination`, `dynamic-menu`, `popup`, `auth-return`, `network-receipt`, `shadow-form`,
`iframe-form`, `large-page`, `virtual-list`, `canvas`, `upload`, `download`, `state`,
`duplicate-write`, and `extraction`. Use `--tasks form,popup --repeat 2 --seed 10`
for a subset. The `state` task checks storage across navigation, not restart or
full authentication parity. The `auth-return` fixture uses two local origins: the provider popup must authorize once and notify the original app tab, which must submit once. It is a synthetic return flow, not a production OAuth service. The duplicate-write fixture commits an order before
returning HTTP 503; the agent must inspect its receipt instead of resubmitting.

The `network-receipt` fixture likewise uses a provider popup, then puts the required reference only in the authenticated JSON network response. Its judge requires one authorization and exactly one correct original-app write. Scripted Tablaze enables `captureNetwork` only for this task; native Codex/MCP comparison uses `--capture-network`. [Measured development smoke and limits](../../docs/CODEX_NETWORK_RECEIPT_SMOKE.md).

Each attempt has isolated server state and a new owned browser. On macOS the
default executable is Google Chrome; other platforms use Playwright Chromium.
Override with `--executable-path` or `TABLAZE_BENCH_BROWSER_PATH`. No personal
profile or existing CDP endpoint is used. Judges inspect server records/write
counts and actual downloaded file hashes, never the agent summary. Judges are
in-process functions, not browser-accessible routes. Fixture data is synthetic.

## Pinned Browser Use

With Python 3.12 and `uv` available:

```sh
uv venv --python 3.12 /tmp/tablaze-comparison-env
uv pip install --python /tmp/tablaze-comparison-env/bin/python \
  'browser-use @ git+https://github.com/browser-use/browser-use@d8110c5ff87ccba887aaa726cdb780f2f84bef8d'
node bench/comparison/runner.mjs --engine matched --preflight \
  --python /tmp/tablaze-comparison-env/bin/python
```

If a Git clone is slow, install the archive for exactly the same commit:

```sh
uv pip install --python /tmp/tablaze-comparison-env/bin/python \
  'browser-use @ https://codeload.github.com/browser-use/browser-use/zip/d8110c5ff87ccba887aaa726cdb780f2f84bef8d'
```

Preflight checks installed version **and Git commit**, or an official HTTPS
GitHub/codeload archive URL naming the exact commit with an installation-recorded
SHA-256. The report retains that archive URL and hash. An unverified local source
directory, mutable branch archive, or unhashed archive is not accepted. Missing dependencies,
interpreter, model settings or credentials produce `not_run`, not a competitor
failure. Matched mode runs neither model adapter until both are ready. It does
not install dependencies or search for credentials automatically.

The Python adapter calls public `Browser`, `ChatOpenAI` and `Agent` APIs, writes
history and action-result counts, and kills only its own temporary browser.
The first real Codex-backed form/popup comparison is now recorded in the
[smoke findings](../../docs/CODEX_COMPARISON_RESULTS.md). This validates those
adapter paths only; syntax and preflight alone do not prove competitor execution.

## Explicit real-model runs

Set the intended provider key as `TABLAZE_BENCH_API_KEY`. Only that named
credential variable is read, and its value is not written to the report.

```sh
node bench/comparison/runner.mjs --engine matched \
  --python /tmp/tablaze-comparison-env/bin/python \
  --endpoint https://YOUR_PROVIDER/v1/chat/completions \
  --model YOUR_EXACT_MODEL_ID --tasks form,popup --repeat 5
```

Real-model commands can incur provider charges. Pass `--allow-anonymous`
explicitly for a local endpoint without a key. `--engine tablaze` and
`--engine browser-use` select individual real-model adapters. Scripted/model
attempts are labeled separately and never ranked against each other.

Both model adapters use an owned loopback gateway. It preserves their prompts
and response schemas while enforcing the same model, temperature (default 0),
optional `--reasoning-effort` and `--max-output-tokens` (default 4096). Actual
usage and latency are measured at the HTTP boundary. `--token-budget` defaults
to 50,000: no further request starts after reported usage reaches it, although
an in-flight request can exceed it. If a response omits usage, usage fields
become `null` and additional requests stop because the ceiling cannot be checked.

Both disable provider transport retries. `--timeout-ms` and `--max-steps` bound
the runs. `--max-tool-calls` currently applies only to Tablaze; this asymmetry is
recorded in every Browser Use attempt and prevents a full comparability claim.
Framework-level behavior remains intact and can be inspected in traces.

Engine settings are explicit and retained in `environment.engineOptions` and
each attempt's `engineOptions`:

| Option | Default | Effect |
| --- | --- | --- |
| `--browser-use-judge true\|false` | `true` | Preserves Browser Use's post-task model judge unless explicitly disabled. |
| `--tablaze-initialize-url true\|false` | `false` | Supplies the fixture service's trusted attempt URL to the public `runAgent({startUrl})` option before planning. No URL is extracted from task text. |
| `--tablaze-popup-policy stay\|follow-single` | `stay` | Selects the public `createServer({popupPolicy})` behavior. `follow-single` follows a unique eligible action popup and replans from its snapshot. |

For an explicitly configured initialization/popup experiment, append
`--tablaze-initialize-url true --tablaze-popup-policy follow-single --browser-use-judge true`.
These options do not silently change the defaults used by historical runs. The
scripted adapter also supports them for integration checks, without model calls.

## Same Codex CLI transport for both agents

The optional Codex bridge preserves public Browser Use `Agent` + `ChatOpenAI` and
Tablaze `runAgent` + its existing planner. Both submit their own conversations and
schemas to the same loopback gateway. It invokes Codex only to produce a JSON
decision; the original framework executes browser actions. Inline screenshots
become real `--image` attachments, and the original response/tool schemas are
validated before forwarding decisions. This compares complete agent runtimes,
not only their MCP tool servers.

```sh
node bench/comparison/runner.mjs --engine matched --transport codex --preflight \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /tmp/tablaze-comparison-env/bin/python
# Remove --preflight to execute the chosen model using the signed-in account:
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra --tasks form --repeat 1 \
  --python /tmp/tablaze-comparison-env/bin/python
```

This transport pins the verified CLI version `0.155.0-alpha.9.2`; use
`--codex-command PATH` to select that installation. It reuses CLI-managed login
without opening, copying or logging auth files. Model calls consume the account's
normal usage. Each invocation runs in a fresh temporary directory with user
configuration ignored, a read-only sandbox and explicit disabled tool features.
An unexpected tool event invalidates the call and terminates its process. JSONL
events supply actual usage; missing usage remains unknown. These options use the
documented [Codex non-interactive interface](https://learn.chatgpt.com/docs/non-interactive-mode).

The fixed custom provider `tablaze-comparison` uses Responses over HTTP with
`requires_openai_auth=true`, `supports_websockets=false`, and request/stream retries
set to zero. This avoids an observed WebSocket connection failure while retaining
CLI-managed OpenAI auth. The report records the provider override, model, effort,
CLI version, prompt/schema/image hashes, event types and returned usage. The bridge
itself never retries model calls.

The bridge records top-level `error` and `item.error` as diagnostics while waiting
for the same process's terminal event. The official exec processor emits error
notifications while retaining its Running state; its message-only JSONL projection
does not preserve the upstream retry discriminator. See the
[OpenAI event processor](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
and [notification definition](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/notification.rs).
Success requires `turn.completed`, exit code zero, and a valid final response.
`turn.failed`, abnormal exit, cancellation, deadline, invalid output, or actual
external tool activity still fail the inference. This does not restart the CLI
or change the zero-retry provider settings.

Diagnostics retain only allowlisted structured codes/categories and explicitly
reported booleans; missing classification is `unknown`/`null`. Raw error messages,
stderr content and arbitrary error properties are not stored or classified by
text. Process metadata includes the exit signal and bridge failure code. Failed
requests also retain the same prompt/schema/image hashes as successful requests.
Whole-run token totals remain unknown when a dispatched request reports no usage.
`transportRequests` retains successful transport records; failed records remain
in `transportErrors`, and `modelCalls` counts gateway dispatch attempts. The
historical v3 `error` event has no retained payload, so its underlying cause and
whether the turn could have continued cannot be reconstructed from that report.

CLI system instructions and process startup remain additional overhead on both
sides. The bridge has no verified per-call output token or temperature control:
`maxOutputTokens` and temperature are reported as `null` for this transport.
The recorded cumulative usage budget and wall-time/step limits still apply.
Results from this bridge must not be described as a direct raw-API model comparison.

## Reports and tests

Reports default to ignored `artifacts/comparison/<timestamp>/results.json`;
choose another directory with `--output DIR`. Records include all failures,
source/patch/lock/task/judge hashes, reset IDs, environment, independent outcomes,
false success, elapsed time, available usage/tool counts, artifacts and traces.
Source hashing includes new uncommitted runtime/harness files and the actual
`dist/*.js` files executed, so stale build artifacts are detectable. Unknown metrics
are `null`; scripted model calls have measured zero tokens. Baseline manifest
measured flags are never updated by this smoke runner.
An output directory containing `results.json` is rejected, preserving prior
evidence. Historical `codex-matched-smoke-v1` and `v2` reports are not rewritten.

Exit codes: 0 for passing independently judged business outcomes, 1 for failures/configuration
errors, 2 when every requested attempt is `not_run`. `--preflight` only reports
structured prerequisites and does not execute browser/model tasks.

```sh
npm run build
TABLAZE_BROWSER_CHANNEL=chrome node --test --test-concurrency=1 tests/comparison.test.mjs
node --test tests/codex-transport.test.mjs
node --test tests/comparison-phases.test.mjs
```

These tests check judge rejection, file contents, reset isolation, equal gateway
settings, missing prerequisites and all 15 real-browser scripted workflows.
They make no paid model calls. The broader 24-task smoke target, frozen full
evaluation set, matched real-model repetitions and shared external-agent MCP
track remain open. `superiorityProven` always stays false in this harness.

Reports with `schemaVersion: 2` expose three separate outcomes:

- `businessPassed`: the final independent fixture judge passed. This does not
  measure the first instant the business operation completed.
- `agentDoneObserved` / `agentSuccessObserved`: the framework reported done and
  its success value was observed. Browser Use uses the public `on_step_end`
  callback and `AgentHistoryList`, before post-task judging; Tablaze uses its
  accepted `runAgent` result. A proposed Tablaze finish rejected by verification
  is retained as `proposedReport`, without counting as accepted completion.
- `runReturnedBeforeDeadline`: the Agent call returned, owned cleanup completed,
  the adapter process did not fail, and the complete measured attempt stayed
  within the configured deadline. A cancelled Agent call can return normally,
  so this field alone does not establish successful completion.

`allAxesPassed` requires all three, including observed agent success. Legacy
`summary.passed`, `completedAndPassed` and `unfinishedWithPassedOutcome` keep their
business outcome / `agentStatus` meanings. In particular, `completedAndPassed`
does not by itself assert return before the deadline. CLI exit status still uses
business acceptance, so a zero exit code alone does not establish full completion.
`agentFailure` preserves the Agent's terminal structured diagnostic when present;
`runFailureClass` consumes it and falls back to a non-null status class for a
failed/unfinished Agent result. A recovered historical transport error does not
make a successful final Agent result a failed run.

The common absolute deadline now starts before gateway/adapter startup. Browser
startup, action execution, Browser Use post-task judging, adapter cleanup, final
independent fixture judging, and gateway teardown all count toward the new
`runReturnedBeforeDeadline` wall-time check. Cancellation and owned cleanup have
bounded grace periods after that deadline; Browser Use's parent process also
enforces a hard limit 30 seconds after its execution budget and kills its owned
process group on failure. Synchronous history serialization remains covered by
that parent limit. This timing scope differs from historical v1/v2 runs and must
not be presented as the same measurement. `historicalTimingComparable` is false.

The Browser Use adapter preserves `use_judge=True` by default, using a separate
instance of the same configured model. A subclass of public `ChatOpenAI.ainvoke`
records `judge_model` directly; it does not wrap private Agent methods or change
the judge's decision. The broader `post_done_processing` phase is inferred from
observing done before `Agent.run` returns, and may include work other than the
judge. `timeoutPhase` is captured before cancellation, so cleanup/finally blocks
cannot overwrite the interrupted phase. Both success and failure traces retain
phase events, actual history/action counts and completion metadata; progress is
atomically saved after steps and phase transitions for parent-process recovery.
No outcome is parsed from stderr.

`judgeModelCalls` and `judgeUsage` describe only the observed judge invocations;
the latter reads public `ChatInvokeCompletion.usage`. They are a subset of the
whole-run gateway totals, not an extra cost to add or automatically subtract.
Missing/cancelled response usage is `null`, while no judge invocations have
measured zero judge calls. No estimate replaces missing token data. The
[second Codex smoke](../../docs/CODEX_COMPARISON_RESULTS_V2.md) motivated this
separation: a business state and an observed `done(success=True)` can precede a
timeout during later processing. The original report remains intact.

The phase tests use fake Python modules and fake SDK process boundaries, plus
the local fixture service. They cover completion before judge timeout, missing
usage, exceptions, bounded cleanup, retained progress after process failure,
explicit option plumbing and rejection of unaccepted finish proposals. They do
not launch Chrome or call a model.

## Native Codex with external browser MCP tools

[`mcp-preflight.mjs`](mcp-preflight.mjs) and [`codex-mcp-runner.mjs`](codex-mcp-runner.mjs)
exercise a **separate tool track**. The latter uses Codex's native multi-round
agent loop and stdio MCP configuration, rather than the Chat Completions
inference bridge used by the framework-agent runner above. Set
`TABLAZE_HARNESS_PIN_SOURCE` to the verified fixed Harness checkout's `src`
directory before either script. The scripts default to the comparison venv's
installed `browser-harness-mcp`, `browser-harness` and `browser-use` entry points;
override those absolute paths through `TABLAZE_HARNESS_MCP`,
`TABLAZE_HARNESS_CLI` and `TABLAZE_BROWSER_USE_CLI` if necessary. Check that
the installed Browser Use package matches the fixed checkout before measuring.

```sh
TABLAZE_HARNESS_PIN_SOURCE=/absolute/pinned/browser-harness/src \
TABLAZE_PREFLIGHT_ARMS=tablaze,harness,browser-use-cli-mcp,browser-use-mcp \
TABLAZE_PREFLIGHT_REPORT=/absolute/output/preflight.json \
node bench/comparison/mcp-preflight.mjs

TABLAZE_HARNESS_PIN_SOURCE=/absolute/pinned/browser-harness/src \
TABLAZE_MCP_ARMS=tablaze,harness,browser-use-cli-mcp,browser-use-mcp \
TABLAZE_MCP_TIMEOUT_MS=210000 \
TABLAZE_MCP_REPORT=/absolute/output/virtual.json \
node bench/comparison/codex-mcp-runner.mjs virtual-list
```

Each arm gets a separate local fixture attempt, temporary Chrome profile and
isolated server directories. Codex uses its existing CLI login; never put a
real API key in the report. `browser-use-mcp` configures no nested LLM, so it
measures direct structured tools only. `browser-use-mcp-full` is a separate
variant: its optional nested Agent uses the local Codex inference gateway and
reports outer and nested usage separately. The nested tool has a longer timeout
than a direct call. These development smoke scripts have no held-out task
freeze, repeated trials or confidence intervals. Their process-time clock
excludes Chrome startup, final judging and teardown; do not merge their times
with the main runner's end-to-end results. Preserve all failed attempts.
