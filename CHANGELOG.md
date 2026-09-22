# Changelog / 更新记录

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
