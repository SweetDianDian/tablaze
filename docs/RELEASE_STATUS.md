# Release status / 发布状态

**0.1.0 · Developer preview · 2026-09-22**

Source is public at [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze). [Hosted CI](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) passed on Ubuntu with Node.js 20 and 22. Install from source; npm publication is pending.

源码已公开，Ubuntu 上 Node.js 20 / 22 的托管 CI 已通过；当前从源码安装，npm 尚未发布。

| Area / 项目 | Verified result / 已确认结果 |
| --- | --- |
| Browser tools / 浏览器工具 | Eight stdio MCP tools; 22 local browser/protocol regressions cover actions, verification, cancellation and CDP resource ownership. / 八个工具，22 项本机浏览器与协议回归。 |
| Clean installation / 干净安装 | macOS: Node 20.16, 22.17 and 26.8 each passed all 22 tests from the source archive named in the [record](evidence/clean-install.json). / 三个 Node 版本均通过 22 项测试。 |
| Linux CI | Ubuntu, Node 20 / 22, managed Chromium: locked dependency installation, build, browser/MCP tests and package dry run passed. [Run](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) · [Record](evidence/linux-ci.json). |
| Codex integration / Codex 接入 | One real Codex CLI model task completed 4 form actions and 5 checks, then closed all its sessions. [Record](evidence/codex-e2e.json). / 已验证一次真实 CLI 模型任务。 |
| Performance / 性能 | Five local runs passed; raw timings and environment are in the [benchmark](../bench/README.md). / 五次本地基准均通过，记录包含环境与原始数据。 |
| Documentation and demo / 文档与演示 | English/Chinese guides, private introduction Site and a recorded SDK workflow. / 双语指南、私有介绍页与真实 SDK 流程录制。 |
| Distribution / 分发 | Public GitHub source, local source/npm archives and SHA-256 manifest. No npm registry release yet. / GitHub 源码已公开，本地归档已准备，npm 待发布。 |
| Support / 反馈 | [Issues](https://github.com/SweetDianDian/tablaze/issues) · [Pull requests](https://github.com/SweetDianDian/tablaze/pulls) · [Private vulnerability report](https://github.com/SweetDianDian/tablaze/security/advisories/new). Private reporting is enabled. / 私密漏洞报告已启用。 |

The first hosted run validated commit [`579631a`](https://github.com/SweetDianDian/tablaze/commit/579631abb53ccf2bca027d07ccc09b990fab3b27); both jobs finished successfully on 2026-09-22 at 06:53:17 UTC. Historical installation and benchmark records retain their original archive/source hashes.

首次托管 CI 对应提交 `579631a`；两个任务均于 2026-09-22 06:53:17 UTC 成功结束。已有安装和基准记录仍以各自的归档或源码哈希为准。

Remaining work: npm package publication, Windows and alternate browser-channel coverage, and broader Codex acceptance including the desktop UI. The verified Codex run used the CLI. Public adoption will be measured after release.

后续工作包括 npm 发布、Windows 与其他浏览器渠道验证，以及更广的 Codex 验收；桌面 UI 尚未验证，当前证据来自 CLI。实际使用情况将在发布后记录。

[Validation](VALIDATION.md) · [Release packaging](RELEASE.md) · [Launch copy](LAUNCH_COPY.md) · [SDK demonstration](../demo/README.md)
