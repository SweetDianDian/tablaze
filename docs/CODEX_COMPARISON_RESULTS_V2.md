# Codex 第二轮对比 — 2026-09-22

**Tablaze 的表单验收路径已缩短，但尚未证明整体超过 Browser Use。** 本轮双方都完成了两项业务操作、都报告了完成、都没有重复写入。Tablaze 两次完整运行均在时限内返回；Browser Use 的弹窗操作已成功，随后在额外模型评估阶段超时。

| 任务 | 框架 | 独立业务验收 | 完整运行返回 | 含清理耗时 | 模型调用 | 输入 / 输出 token |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 表单 | Tablaze | 通过，一次正确提交 | 成功 | 68.936 秒 | 4 | 56,139 / 724 |
| 表单 | Browser Use | 通过，一次正确提交 | 成功 | 58.909 秒 | 3 | 50,801 / 664 |
| 弹窗 | Tablaze | 通过，一次批准 | 成功 | 111.528 秒 | 7 | 104,930 / 1,164 |
| 弹窗 | Browser Use | 通过，一次批准 | 已报告成功，后续评估超时 | 181.831 秒 | 8 | 未知 / 未知 |

表格记录整次运行，不能把 Browser Use 的最后一行解释为“没有批准”或“没有报告完成”。其第 7 步执行了 `done(success=True)` 并输出成功；默认开启的收尾 judge 随后又调用同一模型，完整 `agent.run()` 被外层 180 秒限制取消。超时适配器原始状态仍保留为 `failed`，没有事后改写成功或扣除 judge 的时间。

阶段判断依据保留的[执行日志](evidence/codex-matched-smoke-v2-browser-use-popup.log)和[固定版本调用顺序](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/agent/service.py#L2484)。被取消的第 8 次调用没有保留请求正文、完整 usage 或判决，因此总 token 保持未知。其他 Browser Use 运行也使用默认 judge；模型调用数包含评估，不能全部视为规划步数。

## 本轮修复与可复核变化

- `tab_verify` 支持 `value + ref + snapshot_id`，保留 CSS selector 格式。检查观察节点和文档身份，并在其他断言等待结束后重读值，撤销过期证据。密码和隐藏输入仍不参与值验收。
- Agent 明确区分控件值与页面文字。已有当前快照且信息充分时直接验收；状态信息尚未出现时继续观察。
- 模型请求仅移除与结构化结果完全相同、没有注释或其他字段的 MCP 文本副本。完整历史、图片顺序、错误、证据和检查点保持原样。

表单轨迹由上一轮的 7 次模型调用、180 秒超时，变为本轮的 4 次调用、68.936 秒正常完成。实际执行路径是 `tab_open → tab_act → tab_verify → agent_finish`，值检查直接使用观察到的 Name/City 引用，没有选择器猜测或结构化提取绕路。这是一个开发样本的前后变化，不是统计性能提升幅度。

弹窗仍使用 7 次模型调用。进一步检查发现，前后两轮点击后的即时快照都还是 `Ready`，后续快照才出现 `Saved successfully`。因此那次观察提供了新证据，不能简单删掉；后续工作应改善异步页面状态的等待与采集。

## 条件、证据与限制

- 同一 Codex CLI `0.155.0-alpha.9.2`、模型 `gpt-6-astra`、推理强度 `ultra`、既有 ChatGPT 登录和 HTTP 推理通道；保留各自完整 Agent 执行循环。
- Browser Use `0.13.10`，固定 commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`；Tablaze 使用本地未发布代码。Chrome `153.0.8010.53`，独立环境，视口 `1280×800`。
- 两项已知开发任务各尝试一次，seed 1，每对先运行 Tablaze；上限为 12 规划步、180 秒和 250,000 已报告 token。工具调用上限只约束 Tablaze；CLI 的 temperature 和单次输出 token 控制未经验证。
- Browser Use 默认自动初始导航、模型步前重新观察、点击后自动切换新标签页并在完成后调用 judge。Tablaze 显式导航、切换和验收。相同模型不代表这些执行与收尾策略相同；正式评估需要明确区分阶段。
- 结果由服务端记录与精确写入次数独立判定；模型自报完成不能替代业务验收。两轮样本均可见，不能作为未知任务成功率、价格成本或整体竞争力的估计。网络与模型波动也影响计时。
- [原始 v2 报告](evidence/codex-matched-smoke-v2.json)、[分阶段解释及摘要哈希](evidence/codex-matched-smoke-v2-analysis.json)、[第一轮原始结论](CODEX_COMPARISON_RESULTS.md)均保留。实际源代码、编译结果、锁文件、任务和判定器的哈希位于原始报告；完整本地轨迹位于 `artifacts/comparison/codex-matched-smoke-v2/`。

全量回归 **148/148 通过**，包括真实 Chrome 中的旧引用、iframe、Shadow DOM、敏感字段及延迟值变化测试。干净安装、公开 API 与 15 个 MCP 工具目录检查通过。[验证清单](evidence/development-validation.json)和[测试日志](evidence/development-tests.txt)记录具体范围；这些机制测试不等同于模型能力评估。本轮没有推送 GitHub 或发布 npm。

## 下一步

优先补齐调用方明确指定初始 URL 的执行入口、可选且有归属检查的弹窗跟随策略，以及分开记录业务完成、Agent 完成声明和整体返回的评测指标。同时保留异步状态验收，继续覆盖未参与本轮调试的更复杂任务。完整能力差距仍见 [Browser Use 对比契约](BROWSER_USE_COMPARISON.md)。

```sh
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /private/tmp/tablaze-comparison-env/bin/python \
  --tasks form,popup --repeat 1 --max-steps 12 --max-tool-calls 30 \
  --timeout-ms 180000 --token-budget 250000 \
  --output artifacts/comparison/NEW_RUN
```
