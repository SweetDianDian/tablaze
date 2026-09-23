# 原生 Codex Agent 连接两种浏览器 MCP：开发期实测

日期：2026-09-23。**同一个原生 Codex Agent 分别连接 Tablaze MCP 和 Browser Harness MCP，在填写表单及视觉画布两项可见本地任务中，双方各成功 2/2。** 每项、每侧仅运行一次；Tablaze 在这两次更快，但这不足以证明稳定速度优势或整体功能强于 Browser Use。

| 独立服务端验收 | Tablaze MCP | Browser Harness MCP |
| --- | ---: | ---: |
| 填写 Ada / Lisbon，恰好提交一次 | 通过，69.331 秒 | 通过，111.232 秒 |
| 点击蓝色画布矩形，恰好提交一次 | 通过，65.037 秒 | 通过，77.263 秒 |
| 两项重复写入 | 0 | 0 |
| 表单输入 / 输出 tokens | 94,089 / 444 | 90,466 / 438 |
| 画布输入 / 输出 tokens | 93,352 / 394 | 76,490 / 348 |

这次**没有**把 Codex 当作一次性 JSON 推理接口。两侧均由 `codex exec` 自己运行多轮模型与 MCP 工具调用。Codex CLI `0.155.0-alpha.9.2`、`gpt-6-astra` / `ultra`、相同 provider 配置、相同任务文本、Chrome `153.0.8010.53` 和 1280×800 视口；每个任务、每侧使用单独的临时 Chrome profile 与本地服务端记录。期限为每侧 120–150 秒，计时从启动 Codex 进程到它退出，**不包含**测试器启动 Chrome、事后独立判定和清理；包括 Codex 启动、模型、MCP 和自动审批开销。因此不能与其他报告的“全程时间”直接并列，也不能把差值归因于浏览器引擎。没有统一货币成本核算。

Tablaze 源码为 `69fb1a70a44358be49b6ba8262caa8efccd440d9`。Harness 采用官方固定提交 `afbcc381b963040c19627d788e40c7e7663171ee` 的源码，下载 archive SHA-256 `01b608b17a330b61db69cbb8d8232d2c7dd42c98592f5d837573c51cac71c463`，通过 `PYTHONPATH` 覆盖运行。原先安装的同版本 `0.1.13` wheel 有 5 个 Python 文件与该固定源码不同，包括 MCP 错误处理；它没有作为被测源码。预检实际完成 initialize、tools/list、页面观察、第二次有状态调用、截图和错误形态检查。Tablaze 返回原生 MCP 图像块；Harness 返回可读的 PNG 路径，Codex 的图像查看能力保持开启。Codex JSONL 没有单独记录图像查看事件，因此这些轨迹本身**不能证明** Harness Agent 实际读了截图像素；它在画布任务提交了正确坐标，仍须按此限制解释。

第一次使用 `--sandbox read-only` 时，两侧浏览器 MCP 调用均因 Codex 的 `approval policy is never` 在动作前被拒，表单都没有写入。失败轨迹保留在公开证据中；这属于运行配置阻断，不计入上述成功率。随后双方都使用 `--approve-for-me`，其审批和运行开销计入耗时。表单任务中 Tablaze 调用 4 次 MCP（打开、截图、动作、验证），Harness 调用 8 次（导航、两次截图、坐标点击与输入）；画布两侧均调用 4 次。独立判定以服务端记录为准，不依据 Agent 自述。

[完整汇总与四次成功、两次配置失败的 JSONL 轨迹](evidence/native-codex-mcp-smoke-v1.json)、[MCP 预检记录](evidence/native-mcp-preflight-v1.json)及 [`codex-mcp-runner.mjs`](https://github.com/SweetDianDian/tablaze/blob/main/bench/comparison/codex-mcp-runner.mjs)保留参数、工具事件、用量和独立判定。工作区还有尚未运行的 `browser-use --cli-mcp`、`browser-use --mcp`、Browser Harness JS、Pi 与 Cloud 轨道；这些结果不能代表它们。要证明“功能强于 Browser Use”，仍需覆盖有区分度的任务、重复实验、失败恢复与服务能力，并报告不确定性。
