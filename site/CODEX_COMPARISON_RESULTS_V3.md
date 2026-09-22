# 第三轮 Codex 对比：初始化、弹窗与更广的任务

日期：2026-09-22。**目标仍未完成，不能据此声称超过 Browser Use。**

本轮使用同一个 Codex 模型，各运行 5 个可见开发任务。双方独立业务验收均为 **5/5**，没有重复写入或虚假成功；但 Tablaze 完整成功结束为 **4/5**，Browser Use 为 **5/5**。Tablaze 的订单任务在观察到正确回执后，第三次推理调用被连接层终止，未完成显式验收和最终报告。保留这个失败，不把它当作更快的成功。

原始结果：[不可改写的运行记录](evidence/codex-matched-smoke-v3.json)，SHA-256 `bcfe874ed7c39d9cc8b1be098b6ab00da0eb66b445768911231145d4d09e8e97`。派生数据、轨迹哈希和关键调用路径见[分析记录](evidence/codex-matched-smoke-v3-analysis.json)。本机完整轨迹保存在 `artifacts/comparison/codex-matched-smoke-v3/`。

该目录中的 `tablaze-runtime.tgz` 保存实测时的运行代码；已逐项核对运行记录中 31 个源码、构建产物和对比适配器哈希。包的 SHA-256 为 `374f7049131b8e75428f9a64dd2f29a776f12489699fb3d50f86bd36fd11b698`，包内文档早于本报告。公开的[实测运行代码归档](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site/evidence/codex-matched-smoke-v3-runtime.tgz)与上述哈希一致，供核对当时版本；它不是当前源码版本或新的 npm 发布。

## 结果

“报告完成”是各适配器观察到 Agent 成功结束的时间；“全程”包括启动、清理、独立业务验收和网关收尾。两列计时起点不同：前者从适配器内部开始，后者从共同外部期限开始，不能用两者之差精确推算评审时长。

| 任务 | Tablaze 报告完成 / 全程（秒） | Browser Use 报告完成 / 全程（秒） | 独立业务验收 |
| --- | ---: | ---: | --- |
| 普通表单 | 45.487 / 45.664 | 40.313 / 58.220 | 双方正确提交一次 |
| 弹窗审批 | 61.960 / 62.133 | 53.297 / 70.208 | 双方正确批准一次 |
| iframe 表单 | 60.062 / 60.227 | 39.273 / 57.984 | 双方正确提交一次 |
| CSV 下载 | 93.081 / 93.255 | 63.298 / 80.975 | 双方真实文件哈希一致 |
| 响应中断后检查订单 | 未报告完成 / 46.226 失败返回 | 62.433 / 84.718 | 双方只记录一笔订单 |

本次 Tablaze 在表单和弹窗的全程时间较短，Browser Use 在 iframe 和下载上较短。在前四项共同成功任务中，Browser Use 的 Agent 都更早报告完成，之后执行默认评审。因此，全程时间和 Agent 报告时间应分开解释，不能删掉评审时间后混用原表中的结论。

| 任务 | Tablaze 模型调用 | Browser Use 模型调用（其中评审） | Tablaze 输入 tokens | Browser Use 输入 tokens |
| --- | ---: | ---: | ---: | ---: |
| 普通表单 | 3 | 3（1） | 43,330 | 50,825 |
| 弹窗审批 | 4 | 4（1） | 59,268 | 70,960 |
| iframe 表单 | 4 | 3（1） | 58,632 | 50,803 |
| CSV 下载 | 5 | 4（1） | 73,580 | 69,927 |
| 响应中断后检查订单 | 3，其中 1 次失败 | 4（1） | 未知 | 70,904 |

Browser Use 的评审用量是总用量的子集，不可重复相加。Tablaze 订单任务的失败调用没有用量数据，因此全程 tokens 保留 `null`；前两次调用的已知用量不能冒充总量。未估算货币成本。

## 本轮功能是否实际生效

- 所有 Tablaze 任务使用调用方明确提供的 `startUrl`，通过正常 `tab_open` 执行链在第 0 步完成初始化，计入工具和时间预算，首次模型规划已能读取快照。
- 弹窗审批真实触发 `follow-single`：从 `t1` 切换到 `t2`，返回新快照和 `replan_required`。之后批准一次并检查 URL、请求号和成功状态，没有再通过工具列举和切换标签页。
- iframe 初始化只观察主框架和子框架元数据；后续 `tab_snapshot(frame_id: f1)` 才取得控件。这次观察有必要的信息增量。
- 下载不是只检查请求或文件名。独立验收读取保留下来的文件，双方 SHA-256 均为 `10f19ca5087c9d2f431fb2905e013a7500afba9b4411a8813daf65374fbc7497`。
- 订单任务中，Tablaze 只点击一次创建，随后读取回执，页面显示 `Orders recorded: 1`。第三次 Codex 调用出现 `error` 事件，旧连接层立即终止进程并记为 `CODEX_TURN_FAILED`。它没有保留原始错误详情，不能据此判断事件本身是否终止性错误，也不能回填不存在的验收或成功声明。原始 `runFailureClass: null` 也不能解释为没有故障，应结合 `agentStatus: failed` 与 `transportErrors`。

## 运行条件与限制

- Codex CLI `0.155.0-alpha.9.2`，`gpt-6-astra`，推理设置 `ultra`，沿用已有 ChatGPT 登录。
- Browser Use `0.13.10`，固定 commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`；本地 Chrome `153.0.8010.53`，视口 1280×800，独立临时浏览器状态。
- 每项任务每引擎一次，seed 1；12 个规划步骤、180 秒共同期限、250,000 token 预算。Tablaze 另有 30 次工具上限，Browser Use 尚无完全相同的工具调用上限。
- Tablaze 显式开启 `initializeUrl=true`、`popupPolicy=follow-single`；Browser Use 保留 `useJudge=true`，使用相同模型单独记录评审调用。默认配置未静默修改。
- 连接层配置的请求与流重试均为 0。CLI 的温度和单次输出 token 上限尚未验证；它包含自身系统提示和调用开销，不等同于直接模型 API。
- 新报告 schema 2 把启动计入共同期限，记录完成与评审阶段，并在超时后保留历史。与前两轮计时边界不同，不能把历史秒数差异全部归因于功能优化。模型调用路径的变化可直接查轨迹。
- 任务可见、样本少、只有一种模型设置，且本轮每对均先运行 Tablaze。没有冻结的完整任务集、随机配对顺序或统计优越性证据。外部 Agent MCP、其他官方变体和云服务仍未完成比较。

复现命令：

```sh
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /private/tmp/tablaze-comparison-env/bin/python \
  --tasks form,popup,iframe-form,download,duplicate-write --repeat 1 \
  --max-steps 12 --max-tool-calls 30 --timeout-ms 180000 --token-budget 250000 \
  --tablaze-initialize-url true --tablaze-popup-policy follow-single \
  --browser-use-judge true --output artifacts/comparison/a-new-output-directory
```

这份报告对应运行时记录的源文件哈希。之后的诊断或连接层修复需要新测试和独立的新运行记录，不能改写本轮 4/5 的结果。

后续已完成[连接层修复后的独立订单复测](CODEX_TERMINAL_FOLLOWUP.md)。新记录与本轮分开保留；本轮原始结果和计数不变。
