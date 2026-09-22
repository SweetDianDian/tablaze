# Changelog / 更新记录

## Unreleased / 开发中

- Scoped and viewport snapshots can reach controls beyond the element budget; changing scope resets a diff baseline.
- Snapshot, text verification and extraction share composed DOM traversal, including nested open shadow roots and slots.
- Owned popup/tab workflows, navigation/history, guarded hover/double-click/uploads, and explicit viewport coordinate clicks.
- Download artifacts, one-shot native dialog responses and private local storage-state exports/imports.
- Optional model-independent agent loop with real MCP transport, bounded execution, verification evidence, human-input/failure states and a configurable HTTP model adapter. CLI: `tablaze run --task ... --model ... --endpoint ...`.
- [Typed custom-tool SDK](docs/CUSTOM_TOOLS.md): `defineTool` and `createToolRegistry` add validated Zod input/output contracts, public JSON Schema, trusted application context, exact-origin availability and read/write effect metadata. Unknown write outcomes require reconciliation; handlers are not loaded from CLI checkpoints.
- Browser binding guards and private per-catalog context keys reject stale decisions and invalidate old verification after navigation or tab switches, including switching away and back. Confirmed closure of a verified session preserves verify–close–finish; later mutations invalidate that evidence.
- Safe Agent/CLI failure codes distinguish planner, catalog, application-hook and persistence errors without copying raw exceptions or provider bodies. The comparison Codex bridge waits for a terminal turn after generic error notifications and records process outcomes without adding retries.
- [Independent Codex follow-up](docs/CODEX_TERMINAL_FOLLOWUP.md): both engines completed the duplicate-write task with one write each. A real Browser Use planning request emitted an error notification before completing in the same process, exercising the shared bridge fix. Historical failures remain unchanged; the local regression at that follow-up was 211/211.
- Current full local regression: **264/264 passed**, with no failures, skips or cancellations. This includes the typed custom-tool SDK, browser context keys and bound checkpoint recovery; scripted fixtures do not measure general model ability.
- Version-3 checkpoints bind full tool contracts and trusted principal/tenant/policy identity; strict version-1/2 migration retains unbound compatibility. Bound recovery requires the application SDK and matching identities. Private CLI persistence, browser workspace restoration, cumulative budgets, fresh-observation gates and explicit reconciliation for unknown mutations remain supported, alongside deterministic history compaction, stall feedback, planner-only retry/fallback and reported provider usage.
- Guarded drag/drop, horizontal/vertical container scrolling, hidden file-chooser upload, PDF artifacts, JSON-schema extraction and per-field DOM/source citations.
- Ref-based form-value verification and explicit text/value guidance remove the need to infer CSS selectors for observed controls. Planner requests omit exact duplicate MCP text while keeping complete audit results.
- Explicit initial URLs use the normal Agent dispatcher and cumulative budgets; version-3 checkpoints preserve initialization without replay, including after migration from version 2. Optional owned-popup following stops old-context batches, and session opening accepts cancellation with late-resource cleanup.
- Executable 13-task comparison smoke with independent outcome judges and pinned model adapters. [Three real Codex rounds](docs/CODEX_COMPARISON_RESULTS_V3.md) are recorded. The latest five-task run passed business acceptance on both sides; complete success was Tablaze 4/5 and Browser Use 5/5 because one Tablaze inference was interrupted by the old bridge. Business outcomes, completion declarations, default Browser Use judging and full-run return are distinguished. These small samples do not establish general superiority.
- Existing 0.1.0 performance and release evidence remains historical. No Browser Use superiority or model-driven success rate is established by these changes.
- All recorded real Codex comparisons and the terminal follow-up predate the typed custom-tool SDK and its context/recovery bindings. Their raw results and source hashes remain unchanged; they do not measure the new SDK's model performance.

增加区域/视口观察、统一 Shadow DOM 读取、多标签页、导航、文件流程、原生对话框、状态恢复、可选 Agent 和类型化自定义工具。检查点 v3 绑定工具合同与可信租户，跨规划的浏览器上下文变化使旧证据失效。npm 尚未发布；历史模型测量早于新 SDK，不代表新能力的成功率，也不证明已超过 Browser Use。

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
