# Release status / 发布状态

Snapshot: 2026-09-22. The public [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze) repository has been created; its initial source push is being prepared. This remains a developer preview, with npm publication and the first Linux CI result pending.

| Requirement / 要求 | Evidence / 证据 | State / 状态 |
| --- | --- | --- |
| Eight usable browser MCP tools / 八个可用浏览器工具 | Real stdio SDK tests drive isolated Chrome through input, assertions, capture and cleanup. | Verified locally / 本机已验证 |
| Guarded actions and resource ownership / 引用与资源归属 | 22 browser/protocol regressions, including cancellation and independent CDP ownership. | Verified locally / 本机已验证 |
| Fresh source install on supported Node lines / 支持版本干净安装 | Node 20.16, 22.17 and 26.8 each passed 22 tests from separate extractions of the tested source archive identified in the evidence. [Evidence](evidence/clean-install.json). | Verified on macOS / macOS 已验证 |
| Linux hosted CI / Linux 托管 CI | Workflow exists for Node 20/22 with managed Chromium in the public repository's initial source commit. No hosted run has been verified yet. | Awaiting first push/run / 待首次推送与运行 |
| Real Codex model-selected calls / Codex 模型实际调用 | One real CLI/model flow: 4 actions, 5 checks, cleanup to zero sessions; normal on-request/auto_review policy. [Evidence](evidence/codex-e2e.json). | Verified on local fixture / 本机固定页面已验证 |
| Honest performance evidence / 性能证据 | Five local fixture repetitions, full raw data and source hashes; excludes MCP/model/internet. | Verified within stated scope / 限声明范围 |
| Bilingual docs and introduction / 双语文档与介绍页 | English/Chinese guides; responsive private Site; playable actual SDK trace recording. | Implemented / 已实现 |
| Release artifacts / 发布文件 | Script produces reviewed npm/source archives and SHA-256 manifest. | Prepared / 已准备 |
| Public owner and support channel / 公开归属和维护入口 | GitHub owner is SweetDianDian. [Issues](https://github.com/SweetDianDian/tablaze/issues) and [pull requests](https://github.com/SweetDianDian/tablaze/pulls) are the contribution routes. [Private vulnerability reporting](https://github.com/SweetDianDian/tablaze/security/advisories/new) is enabled and verified; npm ownership remains to be established. | GitHub/reporting confirmed; npm pending / GitHub 与报告入口已确认，npm 待确认 |
| GitHub/npm public publication / 公开发布 | Public GitHub repository created; initial source push in preparation. No npm registry release. | Repository created; npm unpublished / 仓库已创建，npm 未发布 |
| Adoption and tens of thousands of stars / 使用与数万 Star | Requires real public adoption over time; no adoption or star count has been invented. | Not achieved / 未达到 |

The next steps are the initial source push and the first hosted CI result. npm publication remains separate and requires actual package ownership/access. Repository metadata and documentation updates do not change the browser runtime. Existing installation evidence describes the archive identified in its JSON record; it is not a new installation result for every subsequent documentation commit.

下一步是首次源码推送和确认托管 CI 结果；私密漏洞报告入口已启用并验证，npm 发布另需真实包归属及权限。新增仓库元数据与文档不代表浏览器运行代码变化。安装证据仍对应记录中的旧归档，不应当作每次后续文档提交的新安装结果。

Supporting material: [launch plan](LAUNCH_PLAN.md), [bilingual launch copy](LAUNCH_COPY.md), [release packaging](RELEASE.md), [validation scope](VALIDATION.md), [recorded SDK demonstration](../demo/README.md).
