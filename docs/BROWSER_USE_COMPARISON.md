# Beyond Browser Use: scope, baseline, and evidence

Status: **work in progress; superiority has not been demonstrated**. This document
turns the objective “Tablaze's functionality must exceed Browser Use” into an
implementation and comparison contract. Adding browser commands, passing the
Tablaze regression suite, or outperforming one local form does not complete it.

## Baseline recorded on 2026-09-22

| Component | Pinned source | Package version in that source | Comparison role |
| --- | --- | --- | --- |
| Browser Use | [`d8110c5ff87ccba887aaa726cdb780f2f84bef8d`](https://github.com/browser-use/browser-use/tree/d8110c5ff87ccba887aaa726cdb780f2f84bef8d) | [`0.13.10`](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/pyproject.toml) | Autonomous agent library |
| Browser Harness | [`afbcc381b963040c19627d788e40c7e7663171ee`](https://github.com/browser-use/browser-harness/tree/afbcc381b963040c19627d788e40c7e7663171ee) | [`0.1.13`](https://github.com/browser-use/browser-harness/blob/afbcc381b963040c19627d788e40c7e7663171ee/pyproject.toml) | Browser tools for an existing agent, including MCP |
| Tablaze starting point | [`d88210a25608ae494d74f1c461674d596f86c5f6`](https://github.com/SweetDianDian/tablaze/tree/d88210a25608ae494d74f1c461674d596f86c5f6) | `0.1.0` | Original eight-tool MCP and browser engine |

The two competitor commits were obtained from live `git ls-remote … HEAD`, not
inferred from a cached GitHub page. These are pinned source baselines, not a claim
that their package versions are the latest registry releases. Record the exact
Tablaze revision and any patch digest when actually running comparisons. Ongoing
working-tree changes are not graded by the starting-point column below.

Browser Use now presents an open-source agent, an external-agent CLI, and hosted
services. Its README also links TypeScript agent and JavaScript harness projects.
The named Python agent and its Browser Harness integration are mandatory initial
comparators. Before a broad “exceeds Browser Use” release claim, review the linked
official variants for additional material capability gaps; passing one track
cannot establish product-wide superiority. [Official product map](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/README.md)

Cloud browser hosting, proprietary models, managed proxies, managed CAPTCHA
services, fleet operations and hosted Agent APIs form a separate service track.
Local OSS comparisons must use local browsers on both sides. Tablaze must not be
advertised as exceeding the entire cloud product without testing equivalent
services. No paid account, model key, subscription, or cloud access is assumed.
[Cloud boundary](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/README.md)

## Capability matrix and outcome requirements

“Present” here describes documented/source capability, not measured reliability.
The Tablaze column refers only to the pinned starting revision. Each missing or
partial area remains open until its public entry point and outcome tests pass.

| Capability | Browser Use / Harness evidence | Tablaze starting point | Required Tablaze outcome |
| --- | --- | --- | --- |
| Autonomous task execution | Agent loop, bounded steps, action batches and run history [A] | External client supplies planning | Task API and CLI run an unknown multi-step task through observation, decisions, tools, verification and an evidence-backed final result. |
| Models and structured responses | Direct OpenAI, Anthropic, Google, Ollama and other adapters [M] | No model integration | Provider-neutral interface; direct hosted-provider and local/compatible endpoint support; validated responses, deadlines, usage and cancellation. Record provider coverage honestly; one endpoint is not all-provider parity. |
| Visual operation | Screenshots in agent context; coordinate click implementation [A, T] | Screenshot output only | Model can choose DOM or screenshot-based interaction, operate an unlabeled canvas, and verify the resulting state. Screenshot availability alone does not pass. |
| Navigation and tabs | Navigation, tab switching/closing, history; MCP tab helpers [T, H] | One active page per session; unexpected new-tab flow unsupported | Navigate, back, forward, reload, popup discovery, switch and close; preserve ownership and invalidate references across documents/tabs. |
| Forms and rich controls | Input, selection, keys, scrolling, file upload [T] | Basic form actions | Delayed menus, autocomplete, multi-select, hover, double click, nested scroll containers, drag/drop, dialog decisions and frame controls complete real flows. |
| Large/complex documents | Targeted search and element discovery; browser DOM machinery [T] | Bounded snapshot; frames; open Shadow DOM with inconsistent readers | Find and act beyond the first snapshot budget; virtual lists; consistent observation/extraction/verification across nested open shadow roots and frames; explicit unsupported cases. |
| Extraction and artifacts | LLM extraction, structured completion, file operations and PDF output [T, A] | Bounded text/links/table extraction | Schema-validated facts with source URL/evidence; multi-page aggregation; correct file contents; PDF export and usable artifact handles. |
| Upload/download | Upload action; configurable download directory [T, B] | Unsupported | Upload exact permitted files; track multiple downloads and completion/failure; verify bytes/hash and downloaded contents. |
| Authentication and persistence | Profiles, cookies/local storage, existing Chrome/CDP [B] | Warm temporary contexts; explicit shared CDP profile | Export/import state, restart and reuse the intended identity; isolated accounts; explicit profile ownership; authenticated popup return flow. State export is not full persistent-profile parity. |
| Extensibility | Registered typed custom actions; Harness JavaScript, raw CDP and HTTP helpers [C, H] | Fixed tools | Typed custom tool registry and constrained escape hatches capable of advanced site workflows; schema validation, domain/context binding and meaningful failures. A fixed action list cannot replace this. |
| Recovery and long tasks | Planning, stall replanning, loop detection, message compaction, retry/fallback, pause/resume and history replay [A, P] | Guarded refs, stop-on-failure, cancellation | Re-observe stale targets, recover from navigation/model failures, detect loops, checkpoint/resume, preserve evidence and avoid duplicate committed writes. |
| Observability | Agent history/cost data; recording, traces and HAR configuration [A, B] | Tool results; demo recording script | Per-run trace of decisions, actions, verification, timing, usage and artifacts; portable replay/debug view; credentials kept out of default logs. |
| Permissions and identity | Domain restrictions, sensitive data handling, available file paths [A, B] | URL/ref checks; client controls authorization | Enforce configured navigation/file/domain limits across redirects, popups and extensions; carry scoped credentials without logging them. Test policy behavior separately from task success. |
| Evaluation and distribution | Official task benchmark and packaged agent/CLI [E] | Unit/browser tests and local engine microbenchmark | Reproducible installs and full-task benchmark adapters, independent outcome judges, paired results and reported uncertainty. |

Current development adds [exact-origin navigation policy](NAVIGATION_POLICY.md)
through trusted CLI/SDK configuration. It covers HTTP(S) document requests,
including redirect hops, frames and popups, only in owned isolated browsers;
external CDP is excluded. Non-document requests remain unrestricted, and loss
of the interception connection can release a paused request before the browser
closes. This is not a network firewall. Broader network/file limits and scoped
secret handling remain open, so this increment does not complete the permissions
row or alter any historical comparison result.

Sources:

- **A:** [Agent parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters).
- **B:** [Browser parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters).
- **C:** [Custom tools](https://docs.browser-use.com/open-source/customize/tools/add).
- **H:** [Pinned Browser Harness MCP tools](https://github.com/browser-use/browser-harness/blob/afbcc381b963040c19627d788e40c7e7663171ee/docs/MCP.md).
- **M:** [Supported model integrations](https://docs.browser-use.com/open-source/supported-models).
- **P:** [Pinned autonomous runtime](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/agent/service.py).
- **T:** [Pinned Browser Use tool implementations](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/tools/service.py). This source includes capabilities beyond the shorter documentation list, including targeted page search, element discovery and PDF output.
- **E:** [Official benchmark repository](https://github.com/browser-use/benchmark).

The HTML docs are live references and may diverge from source. The pinned source
and actual runtime registry win if they disagree. For example, vision defaults
must be set explicitly for experiments, not copied from differing documentation
versions. Do not disable competitors' useful features to manufacture a win.

## Build order

1. **Complete the execution layer.** Fix observation consistency and target reach;
   implement tabs, navigation, dialogs, files and durable state with outcome
   checks. Preserve existing reference, cancellation and resource-ownership
   invariants. These features unblock tasks immediately but do not replace an
   autonomous agent.
2. **Add the agent runtime.** Share the same engine across MCP, SDK and a task CLI.
   Implement model adapters, a typed decision/tool interface, visual decisions,
   schema extraction, custom tools, budget accounting and explicit success checks.
3. **Make long tasks recoverable.** Add progress events, traces, bounded retries,
   state checkpoints, provider fallback and reconciliation after ambiguous writes.
   Expose cancellation through all entry points.
4. **Run matched experiments and close the observed failures.** Keep the public
   claim open until parity and superiority gates are proven. Failures in any
   mandatory family remain work, even if the overall mean improves.
5. **Review service breadth.** Record hosted/cloud and official TypeScript/JS
   differences explicitly. Either implement and evaluate required equivalents or
   keep the broad product objective incomplete; do not silently redefine it as
   “a smaller MCP with more tools.”

## Reproducible comparison protocol

There are two mandatory OSS tracks:

- **Agent track:** Tablaze's autonomous runner versus Browser Use `Agent`, with
  the same task, model version, provider, inference settings and browser build.
- **Tool track:** One unchanged external agent harness drives Tablaze MCP or
  Browser Harness MCP. Keep its model, reasoning settings, tool policy and context
  budget identical; only the browser tool backend and its necessary tool schema
  documentation change.

The Browser Use package additionally exposes [`--mcp` typed tools](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/mcp/server.py)
and [`--cli-mcp` Python execution plus screenshots](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/mcp/cli_mcp.py).
Include these official entry points in the tool-track capability audit. Run them
as separately labeled variants where the external agent supports their execution
model; do not use a weaker entry point as a proxy for every Browser Use tool mode.

For baseline installation in a dedicated scratch environment, these are real
package entry points (network/Python dependencies are needed):

```sh
uv venv --python 3.12 /tmp/tablaze-comparison-env
uv pip install --python /tmp/tablaze-comparison-env/bin/python \
  'browser-use @ git+https://github.com/browser-use/browser-use@d8110c5ff87ccba887aaa726cdb780f2f84bef8d' \
  'browser-harness[mcp] @ git+https://github.com/browser-use/browser-harness@afbcc381b963040c19627d788e40c7e7663171ee'
/tmp/tablaze-comparison-env/bin/python -c \
  'from importlib.metadata import version; print(version("browser-use"), version("browser-harness"))'
```

Do not attach this benchmark to a personal browser profile. Give each adapter its
own benchmark Chromium/profile and feed it a resettable task environment. The
development smoke runner below now supplies initial adapters, resettable
fixtures and independent judges. A full superiority experiment still requires
the frozen evaluation set and matched repetitions specified below.

Use each product's public interface. Preserve its normal prompt/strategy rather
than forcing both products into Tablaze's own action sequence. Allow framework
implementation differences and capture them. Run separate explicitly labeled
ablation experiments if testing identical low-level actions.

### Workloads and independent judges

Develop a 24-task smoke suite first. It diagnoses missing features and validates
adapters; **it is not a superiority benchmark**. Freeze a separate evaluation set
before tuning against its outcomes:

- At least **60 deterministic tasks** spread across forms, dynamic UI, tabs and
  navigation, frames/shadow DOM, virtual lists, visual controls, files, auth/state,
  extraction, and recovery/policy boundaries. Include long tasks of 20–50 logical
  steps and fault injection, not only isolated button actions.
- At least **40 representative application tasks** across at least 5 distinct
  resettable applications/site families. Include research with source checking,
  authenticated data entry, file workflows and multi-page reconciliation. Use
  test accounts and resettable data; real transactions are unnecessary.
- Freeze tasks, environment images, judge versions, seeds, capability tags and
  prompt text hashes before the measured run. Hold out UI/data variants from
  development and include those in the frozen set.
- For writes, judge server-side records, exact field values and write counts.
  For files, judge hash/content. For extraction, compare against held-out facts
  and provenance. For visual tasks, inspect the actual application state.
  Screenshots and the agent saying “done” are supporting traces, not the judge.

The official Browser Use benchmark adds an external cross-check. Its repository
offers framework adapters and encrypted task sets, with different live tasks and
rubric-based judging. Follow its instructions and do not publish decrypted task
text or ground truth. Some runs need model/provider credentials; unavailable
credentials mean **not run**, never “passed” or “unsupported by the competitor.”
[Benchmark methodology and runner](https://github.com/browser-use/benchmark#re-verifying-framework-results)

### Controls and repeat counts

Run a separate 20-task pilot to debug adapters and estimate paired variance.
Pilot tasks/results are not counted in the final claim. Pre-register a sample
size and stopping rule after the pilot; the following are minimum floors, not a
guarantee of statistical power:

- **Five paired repetitions per frozen task, per engine, per model, per track**;
  at least two model configurations shared by both engines. Repeats measure
  stochastic reliability and do not become independent new tasks.
- Randomize engine order within matched task/seed pairs. Reset website data,
  cookies and files identically; explicitly separate cold, warm and resumed runs.
- Pin browser version, OS/container, viewport, locale, network conditions,
  provider endpoint, model snapshot, temperature/reasoning settings, retry policy,
  task deadline, maximum steps, token ceiling and permitted file/domain access.
  Use a configurable model name; do not silently substitute one.
- Record total wall time, LLM latency, browser latency, all billed tokens (include
  extraction/judging separately), action/tool counts, retries, invalid actions,
  completion rate, false success, duplicate writes and artifact correctness.
- Count unsupported features and exhausted budgets as failures. A pre-defined
  site outage may invalidate both paired attempts; retain the reason and counts.
  Never remove one product's failure after seeing the score.

Use a paired, task-clustered bootstrap (at least 10,000 resamples) for confidence
intervals so repetitions of one task do not inflate the sample size. Report each
capability family and model separately, together with aggregate scores. Correct
multiple per-family comparisons with a pre-registered method. These are proposed
project acceptance rules, not borrowed claims about competitor performance.

### Full completion gates

All gates must have direct evidence before this objective can be marked complete:

1. **Capability coverage:** every matrix family has a documented public workflow,
   negative/error behavior and real-browser end-to-end evidence. Remaining cloud
   or official-variant gaps are explicitly resolved for the intended broad claim.
2. **Task correctness:** both OSS tracks complete all required types of work;
   final outcomes are judged independently. No unresolved duplicate-write,
   credential-leak or false-success regressions in adversarial fixtures.
3. **Measured improvement:** on the pre-registered full set, mean paired success
   improvement is at least **5 percentage points**, and the 95% lower confidence
   bound is above zero for each OSS track. Per-model and per-family evidence must
   exclude a regression worse than the pre-registered **5-point** margin; collect
   more data if uncertainty is too large. A pooled win cannot hide a failed area.
4. **Practical cost:** compare median and p95 latency and token cost on all tasks
   and on matched successes. Meet pre-registered budgets and disclose tradeoffs;
   faster engine microcalls alone do not establish faster or cheaper task runs.
5. **Reproduction:** a clean environment can install the pinned versions, run
   documented commands and reproduce the judges, report and raw non-sensitive
   traces. Missing credentials are reported as missing execution evidence.
6. **Claim audit:** the report states the exact versions, task populations,
   provider/model settings, limitations and service scope. A feature checklist,
   mock-model test, benchmark scaffold or preliminary result is not “stronger
   than Browser Use.”

## Executable development smoke and machine-readable record

The [smoke runner](../bench/comparison/README.md) executes 13 diverse local tasks
through the actual Tablaze agent/MCP/browser path with an explicitly scripted
planner. It also provides real-model Tablaze and pinned Browser Use Agent
adapters, a shared model-settings gateway, prerequisite checks and per-attempt
reports. Server-side outcomes and file hashes are judged independently of the
agent summary. Run `node bench/comparison/runner.mjs --engine tablaze-scripted`
after building. These scripted fixture results do not measure autonomous model
performance, and the complete evaluation gates above remain open.

[`bench/comparison/baseline.json`](../bench/comparison/baseline.json) records the
fixed sources, pending tracks, required evidence fields and acceptance floors.
It remains a baseline manifest, **not a completed benchmark**. The smoke runner
writes its own attempt reports and does not change the manifest's measured
flags. Missing prerequisites are `not_run`; unavailable metrics stay null.
Real-model comparison supports an explicitly configured provider endpoint or
the authenticated Codex CLI bridge shared by both full Agent implementations.
The first [Codex smoke results](CODEX_COMPARISON_RESULTS.md) expose incomplete
Tablaze task closure and higher latency/token use on these two attempts. This
is preliminary execution evidence; the full comparison gates remain open.

The [second Codex smoke](CODEX_COMPARISON_RESULTS_V2.md) reduced Tablaze's form
path to four model calls and normal completion. Both engines reached and reported
the two business outcomes. Browser Use's popup run timed out after its successful
done action, during its default post-task judge. Raw run status, actual business
acceptance and observed completion are retained separately; this is not a
general superiority result or an identical post-processing-policy comparison.
