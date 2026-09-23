# Changelog / 更新记录

## Unreleased / 开发中

- Owned contexts can use a trusted HTTP(S)/SOCKS5 proxy. The CLI accepts server/bypass/username plus a password environment-variable name; external CDP is rejected and doctor omits credentials. A local real-Chrome HTTP proxy receipt verifies routing, while authentication, bypass and SOCKS5 remain unverified. [Configuration guide](docs/BROWSER_CONFIGURATION.md).
- Owned browser contexts now accept trusted viewport, device-scale and permission settings from CLI/SDK; `doctor` reports them and external CDP contexts reject them. A real-Chrome check verifies live dimensions, pixel ratio and geolocation grant. [Configuration guide](docs/BROWSER_CONFIGURATION.md).
- [Current Browser Use capability and issue audit](docs/BROWSER_USE_2026_AUDIT.md) separates Python Agent, MCP/Harness/Pi and managed-cloud gaps. Password snapshots now expose only a filled/empty boolean while keeping raw values redacted; a real-browser regression also preserves a disabled select's implicit live selection.
- Opt-in real WebM recording for isolated browser sessions captures every owned tab; finalized artifacts include byte count and SHA-256, with private file permissions and explicit failure on missing media. [Recording guide](docs/RECORDING.md). No synthetic pointer or audio is added.
- [Four-task matched Codex smoke](docs/CODEX_CURRENT_FOUR_SMOKE.md) records server-judged iframe, interrupted-order, virtual-list and canvas attempts: both engines completed 4/4 once each. Tablaze was slower on iframe and faster on the other three whole runs; single samples and Browser Use's default judge do not establish stable speed or overall capability superiority.
- Guarded `tab_act.click_named` can wait for one exact-name visible button or menu item after an observed activating action in the same batch; ambiguity, replacement and navigation stop input. [Real-model development comparison](docs/CODEX_DELAYED_TARGET_SMOKE.md) retains both the initial wrong-role failure and corrected successful use, without a general speed or superiority claim.
- Optional `tab_act.post_checks` runs explicit browser assertions after a complete same-document action batch, allowing one Agent tool call to act and provide completion evidence. Failed checks require replanning without replaying completed actions. [Measured development attempts](docs/CODEX_POSTCHECKS_SMOKE.md) keep matched Browser Use pairs and separate feature-adoption runs distinct; they do not prove overall superiority.
- Scoped and viewport snapshots can reach controls beyond the element budget; changing scope resets a diff baseline.
- Snapshot, text verification and extraction share composed DOM traversal, including nested open shadow roots and slots.
- Owned popup/tab workflows, navigation/history, guarded hover/double-click/uploads, and explicit viewport coordinate clicks.
- Download artifacts, one-shot native dialog responses and private local storage-state exports/imports.
- Optional model-independent agent loop with real MCP transport, bounded execution, verification evidence and human-input/failure states. CLI `run` now selects `--provider codex|anthropic|ollama|openai-compatible`, always with an explicit model; existing compatible commands retain their endpoint requirement.
- [Provider adapters](docs/PROVIDERS.md): a production Codex CLI planner with existing-login reuse and explicit process cleanup; native Anthropic Messages and Ollama chat with protocol-specific tools/images, output settings and reported usage. Invalid provider flags are rejected. Fake-process/local-HTTP regressions are distinct from the separately recorded production-Codex live smoke; Anthropic/Ollama live inference remains untested.
- Independent [production Codex CLI smoke](docs/CODEX_PROVIDER_SMOKE.md): two visible tasks, independent acceptance and complete success 2/2, zero duplicate writes; 64.030 s form and 78.943 s duplicate-write. This is a separate new-provider check, not a new Browser Use comparison.
- [Browser Use variants audit](docs/BROWSER_USE_VARIANTS.md) separates Agent, MCP, Harness, Pi and cloud entry points and identifies additional comparison tracks. Its source inspection does not expand the scope of earlier measured results.
- [Ubuntu Node 20/22 CI](https://github.com/SweetDianDian/tablaze/actions/runs/35731475966) passed both jobs for commit `924491d7d12780559c88c09ed0e2a677b69c4302`. This verifies that earlier source state, before the provider increment; it is not a CI result for the new changes.
- [Typed custom-tool SDK](docs/CUSTOM_TOOLS.md): `defineTool` and `createToolRegistry` add validated Zod input/output contracts, public JSON Schema, trusted application context, exact-origin availability and read/write effect metadata. Unknown write outcomes require reconciliation; handlers are not loaded from CLI checkpoints.
- Browser binding guards and private per-catalog context keys reject stale decisions and invalidate old verification after navigation or tab switches, including switching away and back. Confirmed closure of a verified session preserves verify–close–finish; later mutations invalidate that evidence.
- Safe Agent/CLI failure codes distinguish planner, catalog, application-hook and persistence errors without copying raw exceptions or provider bodies. The comparison Codex bridge waits for a terminal turn after generic error notifications and records process outcomes without adding retries.
- [Independent Codex follow-up](docs/CODEX_TERMINAL_FOLLOWUP.md): both engines completed the duplicate-write task with one write each. A real Browser Use planning request emitted an error notification before completing in the same process, exercising the shared bridge fix. Historical failures remain unchanged; the local regression at that follow-up was 211/211.
- Current full local regression on Node 24.19.0: **481/481 passed**, with no failures, skips or cancellations. This includes real-Chrome proxy routing, browser configuration, redacted form state, recording checks, delayed-target controls, typed custom tools, browser context keys and bound checkpoint recovery; scripted fixtures do not measure general model ability.
- Version-3 checkpoints bind full tool contracts and trusted principal/tenant/policy identity; strict version-1/2 migration retains unbound compatibility. Bound recovery requires the application SDK and matching identities. Private CLI persistence, browser workspace restoration, cumulative budgets, fresh-observation gates and explicit reconciliation for unknown mutations remain supported, alongside deterministic history compaction, stall feedback, planner-only retry/fallback and reported provider usage.
- Guarded drag/drop, horizontal/vertical container scrolling, hidden file-chooser upload, PDF artifacts, JSON-schema extraction and per-field DOM/source citations.
- Ref-based form-value verification and explicit text/value guidance remove the need to infer CSS selectors for observed controls. Planner requests omit exact duplicate MCP text while keeping complete audit results.
- Explicit initial URLs use the normal Agent dispatcher and cumulative budgets; version-3 checkpoints preserve initialization without replay, including after migration from version 2. Optional owned-popup following stops old-context batches, and session opening accepts cancellation with late-resource cleanup.
- Executable 13-task comparison smoke with independent outcome judges and pinned model adapters. [Three real Codex rounds](docs/CODEX_COMPARISON_RESULTS_V3.md) are recorded. The latest five-task run passed business acceptance on both sides; complete success was Tablaze 4/5 and Browser Use 5/5 because one Tablaze inference was interrupted by the old bridge. Business outcomes, completion declarations, default Browser Use judging and full-run return are distinguished. These small samples do not establish general superiority.
- Existing 0.1.0 performance and release evidence remains historical. No Browser Use superiority or general model-driven success rate is established by these changes.
- All recorded real Codex comparisons and the terminal follow-up predate the typed custom-tool SDK and its context/recovery bindings. Their raw results and source hashes remain unchanged; they do not measure the new SDK's model performance.

增加区域/视口观察、统一 Shadow DOM 读取、多标签页、导航、文件流程、原生对话框、状态恢复、可选 Agent 和类型化自定义工具。本轮新增 Codex、Anthropic、Ollama、兼容 HTTP 四类规划器的正式入口；显式模型、协议边界和取消清理分别校验，不把本地桩测试当作真实模型效果。检查点 v3 绑定工具合同与可信租户，跨规划的浏览器上下文变化使旧证据失效。npm 尚未发布；历史模型测量早于新 SDK，不代表新能力的成功率，也不证明已超过 Browser Use。


## 0.1.0 — developer preview / 开发者预览

2026-09-22. Source is available in [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze). [GitHub Actions](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) passed on Ubuntu with Node.js 20 and 22 using managed Chromium. npm publication is pending.

2026-09-22：源码已公开；Ubuntu 上 Node.js 20 / 22 与 managed Chromium 的 GitHub Actions 检查已通过。npm 尚未发布。

- Eight stdio MCP tools for browser sessions, observations, ordered actions, extraction, verification, capture and cleanup.
- Persistent browser process with isolated temporary contexts by default; explicit CDP mode owns only its created pages.
- Full/diff observations with bounded output, DOM identity and revision checks.
- Batches of up to 20 steps; default 30-second total budget, at most 60 seconds, with partial progress and stop-on-error behavior.
- Active cancellation interrupts owned resources; prior side effects are not rolled back.
- CLI setup/doctor, English/Chinese documentation, real browser/protocol regressions, reproducible benchmark and release packaging.
- Bilingual introduction page and a reproducible actual SDK trace recording.
- Public repository links, clone instructions and Issues/PR contribution routes. These documentation and repository metadata additions do not change the browser runtime; prior test evidence remains tied to its recorded archives and hashes.

提供八个 stdio 工具、默认独立会话、有界快照、引用检查、顺序批次、明确验收、诊断命令和双语文档；附真实测试、基准、打包脚本与可复现演示。

This preview does not integrate Jev. Upload/download, closed shadow DOM and complex new-tab workflows are not supported. Checks and browser input are not atomic. See [SECURITY](SECURITY.md) for the actual boundaries and [VALIDATION](docs/VALIDATION.md) for observed coverage.
