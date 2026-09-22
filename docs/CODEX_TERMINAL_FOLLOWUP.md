# Codex 连接层修复后的独立订单复测

日期：2026-09-22。**双方本次均完整成功，仍未证明 Tablaze 整体超过 Browser Use。**

这次只复测一个可见开发任务：创建一笔订单，服务端保存后返回中断提示，Agent 必须先检查回执，避免重复提交。双方各运行一次，使用新状态；不是替换第三轮失败的补考分数，也不与旧样本拼接计算成功率。

| 指标 | Tablaze | Browser Use |
| --- | ---: | ---: |
| 独立服务端验收 / Agent 成功 / 期限内返回 | 全部通过 | 全部通过 |
| 服务端写入 / 重复写入 | 1 / 0 | 1 / 0 |
| Agent 报告完成（秒） | 59.247 | 75.354 |
| 全程（秒） | 59.415 | 93.706 |
| 模型调用（其中默认评审） | 4（0） | 4（1） |
| 输入 / 输出 tokens | 59,123 / 664 | 70,868 / 1,002 |
| 缓存输入 tokens，已含于输入 | 0 | 9,600 |

完成时间从适配器内部计时，全程从共同外部期限开始，包含启动、清理、独立验收和网关收尾。Browser Use 保留默认评审，该次评审调用约 17.446 秒，用量为输入 14,490、输出 198，已经包含在总量中。一次可见任务的时间差不能推出稳定的性能优势；没有估算货币成本。

## 实际验证到的修复

旧连接层收到任意 `error` 通知就终止 Codex 进程。然而，[官方执行器](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs)可以发出这种通知后继续运行。现在连接层等待同一进程的明确终态；成功要求 `turn.completed`、退出码 0，以及最终响应和工具参数通过 schema 校验。失败终态、超时、取消和意外外部工具仍会终止调用。没有增加自动重试。

本次 **Browser Use 首次规划调用真实出现**以下顺序：

```text
thread.started → turn.started → error → item.completed → turn.completed
exitCode: 0; bridgeFailureCode: null
```

这条响应被正常交给 Browser Use，随后任务、默认评审和清理全部完成。该调用报告输入 18,727、输出 239 tokens，已计入总量。这证明通用 `error` 通知不必然意味着推理失败，也直接验证了双方共用连接层的新处理路径。

诊断没有保留原始错误正文，分类为 `unknown`；不能据此推断网络、额度或服务端原因。记录中的请求和流重试配置均为 0，连接层没有重启本次推理进程，但无法观测的上游内部行为仍属未知。

Tablaze 本次四个模型调用没有错误通知。实际工具路径为初始化打开页面、创建一次订单、检查回执、执行 `tab_verify`；之后模型的 `finish` 引用了通过的验收证据。它验证了新版本的正常完成路径，不能证明第三轮被提前终止的旧请求一定能够恢复。[第三轮结果](CODEX_COMPARISON_RESULTS_V3.md)仍保持 Tablaze 4/5、Browser Use 5/5，不改写旧失败。

## 条件与可复查记录

- Codex CLI `0.155.0-alpha.9.2`，模型 `gpt-6-astra`，推理设置 `ultra`，沿用现有 ChatGPT 登录；两框架使用相同推理连接层。
- Browser Use `0.13.10`，commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`；Chrome `153.0.8010.53`，视口 1280×800。
- seed 1，每引擎一次，先 Tablaze 后 Browser Use；12 步、180 秒、250,000 token 预算。Tablaze 另有 30 次工具上限，Browser Use 尚无完全等价的工具上限。
- Tablaze 开启显式初始化和 `follow-single`；Browser Use 开启默认评审。CLI 温度和单次输出 token 控制未验证，不能当作直接模型 API 比较。
- 运行前完整本地回归 **211/211 通过**；干净临时安装的公开 API、15 个 MCP 工具及构建文件校验通过。这些回归与真实模型结果分开记录。

[原始结果](evidence/codex-terminal-followup-v1.json) SHA-256：`937141051d43ce61ffaafe55f99412827f30623fdd20fb652a7960472d3a58e2`。[分析记录](evidence/codex-terminal-followup-v1-analysis.json)保留轨迹哈希和每次推理的终态、诊断及实际用量。

本机完整轨迹在 `artifacts/comparison/codex-terminal-followup-v1/`。其中 `tablaze-runtime.tgz` 已核对运行记录的全部 31 个源码、构建和适配器文件；包 SHA-256 为 `0dd34298d22cd7ecab0a2d8d704d77cf67bbb442a7f8f2f709c5f413f138640d`。包内文档早于本报告。公开的[实测运行代码归档](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site/evidence/codex-terminal-followup-v1-runtime.tgz)保留同一哈希，供核对当时版本；它不是当前源码版本或新的 npm 发布。

复现时使用新的输出目录：

```sh
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /private/tmp/tablaze-comparison-env/bin/python \
  --tasks duplicate-write --repeat 1 \
  --max-steps 12 --max-tool-calls 30 --timeout-ms 180000 --token-budget 250000 \
  --tablaze-initialize-url true --tablaze-popup-policy follow-single \
  --browser-use-judge true --output artifacts/comparison/a-new-output-directory
```
