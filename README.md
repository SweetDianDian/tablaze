<p align="center">
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site">
    <img src="docs/assets/tablaze-banner.svg" alt="Tablaze — a compact browser MCP. Observe. Act. Verify." width="100%">
  </a>
</p>

<p align="center">
  <strong><a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site">Website ↗</a></strong> &nbsp; · &nbsp;
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site#demo">Watch the demo</a> &nbsp; · &nbsp;
  <a href="docs/CODEX.md">Codex guide</a> &nbsp; · &nbsp;
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml"><img src="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b7db9a?style=flat-square" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A520-80b7ff?style=flat-square" alt="Node.js 20 or later"></a>
</p>

**Give your agent a browser it can work with.** Tablaze connects Codex and other MCP clients to Chromium through sixteen focused tools. Inspect a page, fill a form, extract a result, and check that the task actually succeeded.

Built with Playwright. Browser sessions stay running between calls; your MCP client supplies the reasoning. The MCP browser tools require no additional model API key. The optional standalone Agent loop uses an explicitly configured planner.

## See it work

**[Watch the complete demo — about 2 minutes →](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site#demo)**

A real MCP SDK client completes one travel workflow: six form actions in one batch, five result checks, then a changed approval button. The stale reference is rejected with no approval or order; a fresh snapshot lets the workflow continue through an explicitly followed popup, four approval actions and three receipt checks. Finally, the recorder verifies the downloaded CSV's bytes and SHA-256, closes both owned tabs and confirms zero remaining sessions.

[![Real MCP demo: one approved trip, a verified CSV and zero remaining sessions](docs/assets/demo-poster.png)](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site#demo)

`Batch the form` → `Verify` → `Stop and re-observe` → `Approve in the popup` → `Check the file`

The 154-second recording presents actual tool responses and screenshots with conversational English male narration and optional captions. It contains no simulated cursor. A deterministic SDK script drives the local fixture; no model inference is involved. It is a presentation recording, not a continuous video feed from the controlled tab.

[Reproduce the recording](demo/README.md) · [Inspect the full trace](docs/evidence/demo-run.json)

## Measured development results

The [third matched Codex run](docs/CODEX_COMPARISON_RESULTS_V3.md) used five visible development tasks, one attempt per engine and task. Both engines passed independent business checks **5/5**; Tablaze returned complete success **4/5**, Browser Use **5/5**. Tablaze's order task was interrupted by the old inference bridge after the order was recorded. Its failed call had no usage data, so total tokens remain unknown.

A [separate order follow-up after the bridge fix](docs/CODEX_TERMINAL_FOLLOWUP.md) completed successfully for both engines, each creating one order with no duplicate write:

| Follow-up measurement | Tablaze | Browser Use |
| --- | ---: | ---: |
| Agent reported completion | 59.247 s | 75.354 s |
| End-to-end time | 59.415 s | 93.706 s |
| Model calls, including judging | 4 | 4 (1 judge) |
| Input / output tokens | 59,123 / 664 | 70,868 / 1,002 |

Browser Use's default judge is included in its totals. Agent and end-to-end clocks have different starting boundaries. This single follow-up does not replace the original 4/5 result, and these small, visible samples do not establish overall superiority. Both reports retain raw results, source hashes, settings, and limitations.

A [new four-task matched development smoke](docs/CODEX_CURRENT_FOUR_SMOKE.md) tested iframe input, interrupted-response order recovery, a virtual list and a visual canvas. Both engines completed all four with independent business acceptance; Tablaze's iframe sample was slower (83.799 s versus 52.515 s), while its other three whole-run samples were shorter. Each task ran once per engine, so this does not prove stable efficiency or overall superiority.
The initial iframe observation now gives newly attached child frames a bounded readiness wait; a real-Chrome regression confirms the first `tab_open` can expose a delayed child form. This post-comparison fix has not yet been measured in a new paired model run.

The [current Browser Use capability and public-issue audit](docs/BROWSER_USE_2026_AUDIT.md) tracks what is implemented, what remains missing across Agent/MCP/Harness/Pi/cloud, and which reported defects have a local reproduction or regression. Password fields now reveal only whether a value is present, while keeping its bytes redacted.

## Get started

Requires **Node.js 20+**, npm and Git. This is a developer preview; npm publication is pending, so install from source:

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
```

<details>
<summary>Already have Chrome, or running on Linux?</summary>

For installed Chrome, skip `setup`, run `node dist/cli.js doctor --channel chrome`, and append `--channel chrome` to the Codex command below. This launches a separate browser session.

On Linux, use `npx playwright install --with-deps chromium` in place of `setup` to install the browser and system dependencies.

[Browser modes and diagnostics](docs/CODEX.md#1-build-and-choose-a-browser)

</details>

### Connect Codex

From the cloned directory, register the built server:

```sh
codex mcp add tablaze -- "$(node -p 'process.execPath')" "$PWD/dist/cli.js"
codex mcp get tablaze
```

Then ask Codex:

> Use Tablaze to open https://example.com, read the heading and links, verify that the title contains “Example Domain”, then close the session. Report the result of the checks.

[Complete Codex setup](docs/CODEX.md) covers desktop configuration, browser selection and troubleshooting. Other MCP clients can launch the same `node /absolute/path/to/tablaze/dist/cli.js` command over stdio.

For workflows that need page-origin JavaScript, `--page-script` adds an opt-in `tab_script` tool. It has the page's full authority, including account data and network requests; it is unavailable with configured secrets, external CDP or a navigation policy. Scripts require a current main-frame snapshot and return a fresh one. See [the page-script contract and recovery limits](docs/PAGE_SCRIPT.md). The default catalog remains sixteen tools.

A [separate native-Codex page-script smoke](docs/CODEX_PAGE_SCRIPT_SMOKE.md) passed the independent authenticated-response judge once for both Tablaze and Browser Use CLI-MCP, with one correct write and no duplicates per arm. Codex-process samples were 198.359 s and 239.400 s respectively; browser setup differed, so this is not a controlled speed ranking or overall win.

### Run a standalone task

The optional `run` command supports `codex`, `anthropic`, `ollama`, and `openai-compatible` planners. Always specify a model. Codex reuses the installed CLI and its existing login:

```sh
node dist/cli.js run --provider codex --model "<your-codex-model>" \
  --task "<authorized task>" --channel chrome
```

Use `--output-schema ./result.schema.json` to require a schema-valid JSON deliverable before the Agent can finish; the application should still check business correctness. The same schema is required on resume. See [the Agent contract](docs/AGENT.md).

SDK callers can use `createAgentControl()` to pause at a safe boundary, add trusted steering, and resume with a fresh plan; queued writes are skipped and prior verification must be repeated. See [live operator intervention](docs/AGENT.md#live-operator-intervention-sdk).

The default compatible provider still requires `--endpoint`. Native Anthropic and Ollama use their own protocols and default endpoints; authentication, output settings, and model capabilities differ. See [provider setup and boundaries](docs/PROVIDERS.md), [CLI examples](docs/CODEX.md#choose-a-planner-for-run), and [Agent verification and recovery](docs/AGENT.md). Anthropic/Ollama have local protocol coverage, without live inference results; the earlier comparison results above retain their original runtime hashes.

The new production Codex path also has a [separate live smoke](docs/CODEX_PROVIDER_SMOKE.md): two visible tasks passed independent business checks and completed successfully (2/2), with zero duplicate writes. This is not a new matched Browser Use comparison.

A [new matched virtual-list task](docs/CODEX_VIRTUAL_LIST_SMOKE.md) completed once on each engine with independent acceptance and zero duplicate writes. Under a shared 120,000-token budget, whole-run time was 86.830 s for Tablaze and 141.597 s for Browser Use, including its default judge. This one visible development task does not establish a general performance or success-rate advantage.

The [delayed-control development comparison](docs/CODEX_DELAYED_TARGET_SMOKE.md) records a real Codex run that opened a menu and clicked its newly appearing option in one guarded Tablaze action batch. In the final visible matched attempt, both agents completed with one correct write and zero duplicates; Tablaze took 80.715 s and Browser Use 77.720 s. The report retains an earlier wrong-role failure and recovery. These changing-source samples do not establish a stable speed or overall advantage.

The separate [cross-origin authorization-return task](docs/CODEX_AUTH_RETURN_SMOKE.md) also passed once on each engine with one provider authorization and one app submission. Browser Use's 119.515 s whole run was slightly shorter than Tablaze's 123.719 s. This synthetic popup flow does not establish production login parity or an overall ranking.

For debugging an actual run, `--record-video` optionally records each owned isolated tab as a private WebM. `tab_close` returns finalized paths and SHA-256 digests; the standalone `run` report includes them after cleanup. It is off by default and adds no simulated cursor or audio. See [real browser recording and privacy limits](docs/RECORDING.md).

Trusted operators can set `--viewport`, `--device-scale-factor` and `--permissions` on owned browser contexts; these settings are reported by `doctor` and cannot alter an external CDP browser. See [browser configuration and limits](docs/BROWSER_CONFIGURATION.md).
Owned contexts also accept `--proxy-server` with optional bypass rules and credentials read from an environment variable; the [configuration guide](docs/BROWSER_CONFIGURATION.md) records the tested HTTP routing path and remaining proxy validation.

## A small loop, with useful controls

| Capability | What it gives your agent |
| --- | --- |
| **Warm sessions** | Keep page state between calls. Temporary, isolated browser contexts by default; explicit CDP attachment for an existing profile. |
| **Owned persistent profile** | Opt into a [dedicated private Chrome directory](docs/PROFILES.md) with a required profile ID on reuse and exclusive ownership. Browser-managed login state can survive a cold restart. |
| **Compact observations** | Full or incremental snapshots with element refs, text budgets and visible truncation. |
| **Guarded actions** | Check snapshot revisions and DOM targets before input. Re-observe when a target changes. |
| **Ordered batches** | Send up to 20 actions in one call, with completed, failed and skipped steps. Stops on error; earlier effects remain. |
| **Delayed controls** | After clicking an observed opener, wait for one exact-name visible button or menu item and click it in the same guarded batch. Ambiguous matches stop before input. |
| **Explicit verification** | Check URL, title, text, field values, visibility and counts. Known same-document outcomes can be checked inside `tab_act` after its batch, with passing evidence available to the Agent in that call. |
| **Optional response journal** | Use `--capture-network` to inspect bounded responses from owned pages and popups through a seventeenth MCP tool, [`tab_network`](docs/NETWORK.md). Off by default; not a programmable JS/CDP surface. |
| **Optional real video** | Use `--record-video` for private WebM recordings of owned isolated tabs, finalized with SHA-256 at session close. [Recording scope and limits](docs/RECORDING.md). |
| **Optional navigation policy** | [Exact-origin allow/deny rules](docs/NAVIGATION_POLICY.md) for HTTP(S) document requests, including redirects, frames and popups, in owned isolated browsers. No external CDP; not a network firewall. |

### Sixteen tools

| Tool | Use it to |
| --- | --- |
| `tab_open` | Open a page and receive its first snapshot. |
| `tab_snapshot` | Observe the page, changes or a selected frame. |
| `tab_find` | Search visible text while scrolling a page or observed virtual-list container; return a fresh actionable snapshot. |
| `tab_act` | Guarded form input, drag/drop, container scrolling, file selection and coordinate actions; optional post-action checks. |
| `tab_verify` | Test explicit page assertions and guarded form values by ref or CSS selector. |
| `tab_extract` | Read text, links or tables. |
| `tab_capture` | Capture a JPEG screenshot. |
| `tab_list` | Inspect owned sessions. |
| `tab_close` | Close a session and release its resources; return finalized WebM artifact metadata when recording was enabled. |
| `tab_navigate` | Navigate, go back/forward, or reload without losing session state. |
| `tab_tabs` | Open, switch, and close owned tabs, including popups. |
| `tab_downloads` | Inspect download status and local artifacts. |
| `tab_dialog` | Arm a one-shot accept/dismiss response to a native dialog. |
| `tab_state` | Save authentication state for explicit import into a new session. |
| `tab_extract_structured` | Extract typed fields against a JSON schema with DOM source citations. |
| `tab_pdf` | Export a private PDF artifact with source URL and SHA-256 digest. |

## Explore the project

| Guide | Inside |
| --- | --- |
| [Codex integration](docs/CODEX.md) | Copyable configuration, tool arguments and troubleshooting. |
| [Runtime reference](docs/RUNTIME.md#english) | Reference lifetime, batch semantics, browser modes and current limits. |
| [Typed custom tools](docs/CUSTOM_TOOLS.md) | SDK schemas, trusted application context, browser bindings and recovery contracts. |
| [Model providers](docs/PROVIDERS.md) | Codex CLI, native Anthropic/Ollama and compatible HTTP contracts, authentication and usage. |
| [Navigation policy](docs/NAVIGATION_POLICY.md) | Trusted CLI/SDK configuration, document-only scope, transport-loss limits and checkpoint identity. |
| [Scoped credentials](docs/SECRETS.md) | Trusted aliases, exact-origin login fills, redaction limits and recovery. |
| [Real browser recording](docs/RECORDING.md) | Opt-in WebM artifacts, CLI/MCP/SDK access and privacy limits. |
| [Browser Use variants audit](docs/BROWSER_USE_VARIANTS.md) | Distinguish Agent, MCP, Harness, Pi and cloud comparison targets; source audit, not a benchmark. |
| [Benchmark](bench/README.md) | Reproduce the local workload and inspect every raw sample. |
| [Validation evidence](docs/VALIDATION.md) | Real browser, SDK and Codex results, with their measured scope. |
| [Security](SECURITY.md) | Data handling, resource ownership and private reporting. |
| [Release packaging](docs/RELEASE.md) | Build the npm tarball and source archive. |

The [historical 0.1.0 Ubuntu CI run on Node 20 and 22](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) passed its build, browser/MCP tests and package inspection. The later [Ubuntu Node 20/22 run for commit `c9d091a`](https://github.com/SweetDianDian/tablaze/actions/runs/35736979945), which includes the provider adapters, also passed both jobs. That run predates the navigation-policy increment. Current development validation is recorded [separately](docs/DEVELOPMENT_STATUS.md). To check a source checkout yourself, run `npm test`; use `npm run bench` for the separate local benchmark.

## Contribute

Bring a reproducible browser case, improve a guide, or send a focused fix. [Open an issue](https://github.com/SweetDianDian/tablaze/issues) · [Submit a pull request](https://github.com/SweetDianDian/tablaze/pulls) · [Read the contribution guide](CONTRIBUTING.md)

[MIT licensed](LICENSE) · [Dependency credits and project provenance](NOTICE)

The current development branch adds scoped/viewport snapshots, consistent composed-DOM reading, rich controls, file workflows, tabs, [structured extraction](docs/EXTRACTION.md), and a [model-driven agent loop with checkpoint/resume](docs/AGENT.md). These additions have not yet been published to npm. See [current validation](docs/DEVELOPMENT_STATUS.md). The [Browser Use comparison](docs/BROWSER_USE_COMPARISON.md) records remaining gaps and unmeasured acceptance criteria; it does not claim superiority.
