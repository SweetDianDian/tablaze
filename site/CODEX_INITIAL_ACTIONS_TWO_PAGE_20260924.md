# 双页面预设导航：Tablaze 与 Browser Use 的配对对照

日期：2026-09-24。Tablaze 使用干净提交 [`5b6f26a`](https://github.com/SweetDianDian/tablaze/commit/5b6f26ace7ffb2c6ae7983343e80597488f4ee4e)，工作树补丁 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。Browser Use Python Agent 0.13.10 固定在 [`d8110c5`](https://github.com/browser-use/browser-use/tree/d8110c5ff87ccba887aaa726cdb780f2f84bef8d)。两侧使用同一 Codex CLI `0.155.0-alpha.9.2`、`gpt-6-astra / ultra`、1280×800 的独立 Chrome、40 步、180 秒截止时间和 150,000 已报告 token 上限。Browser Use 保留默认的任务后模型评审。

任务给出来源页与目标页两个 URL。来源页有一个按种子变化、任务文本中没有的代码；目标页需要收到该代码且**只能提交一次**。模型规划前，Tablaze 的 `runAgent({initialActions})` 和 Browser Use 的 `Agent(initial_actions=[navigate, navigate])` 都打开相同的两页及新标签。Browser Use 的[官方参数说明](https://docs.browser-use.com/open-source/customize/agent/all-parameters)和[官方示例](https://github.com/browser-use/browser-use/blob/main/examples/features/initial_actions.py)记载了其预设动作接口。本次只对照**导航动作**，没有测试 Browser Use 其它类型的预设动作。

每个引擎和种子使用独立浏览器及服务端记录；引擎顺序交替。服务端只在来源页和目标页都被访问、目标页恰好收到一次正确代码时判通过，Agent 自述不参与判定。下表全程时间包含模型调用、Agent 返回、清理及独立验收；Agent 完成时间截至框架观察到完成。Browser Use 的全程时间还包含其默认模型评审，Agent 完成时间不含这一步。时间单位为秒。

| 种子 | Tablaze 全程 / Agent 完成 | Browser Use 全程 / Agent 完成 | Tablaze / Browser Use 模型调用 | 服务端验收 |
| ---: | ---: | ---: | ---: | --- |
| 120 | 65.201 / 65.008 | 100.119 / 72.322 | 4 / 4 | 双方通过，各一次正确写入 |
| 121 | 68.834 / 68.671 | 93.353 / 66.034 | 4 / 4 | 双方通过，各一次正确写入 |
| 122 | 79.934 / 79.778 | 102.818 / 77.739 | 4 / 4 | 双方通过，各一次正确写入 |

双方都是 **3/3 服务端通过、3/3 Agent 正常结束、3/3 截止前完整返回**，没有重复写入。Tablaze 三组的全程均较短，中位全程 **68.834 秒**，Browser Use **100.119 秒**；逐对差值的中位数为 **24.518 秒**。但两者的任务 Agent 阶段接近：Tablaze 只在种子 120 较快，种子 121 和 122 分别晚 **2.636** 和 **2.039 秒**。Browser Use 每组 4 次模型调用中有 **1 次任务后评审**；Tablaze 的 4 次是规划调用。不能把全程差额解释成浏览器操作或 Agent 规划本身的加速。

Tablaze 每组报告的输入 token 为 69,950、69,842、69,761，Browser Use 为 71,263、71,150、71,197；输出 token 分别为 692、797、835 与 1,336、1,323、1,318。调用内容和默认评审不同，token 差额不能直接解释为相同工作的成本节省。Codex CLI 传输有自己的系统指令，也没有独立验证逐次温度及输出 token 控制；这里不是原生模型 API 基准。

正式三组前做过种子 110 的 50,000-token 试跑。两边服务端都收到正确的一次提交，但 Tablaze 在下一轮规划前累计报告约 52,043 token，网关按配置对后续调用返回 HTTP 429，Agent 因此未正常结束；Browser Use 完整结束。此记录[单独保存](evidence/initial-actions-two-page-20260924/results-pilot-50k.json)，不纳入上表或成功率。正式三组为两边一同改用 150,000-token 上限。

这只是**一个公开的本地合成任务、三个种子**。它说明双方的双页面预设导航在此任务可用，且 Tablaze 的全程时间在此批次较短；它不估计稳定延迟、p95、真实网站成功率、任意预设动作对等，也不证明 Tablaze 的总体功能或效率超过 Browser Use。更广任务与 Browser Use Harness、Pi、MCP、云端能力仍需分别验证。[未改写的配对结果](evidence/initial-actions-two-page-20260924/results-paired.json) SHA-256 为 `2146f009e6080476e800144d2e3337c9223025e800bb140d8fdc3d888e2a4c4b`；[轨迹索引](evidence/initial-actions-two-page-20260924/README.md)链接六条正式运行及两条试跑的原始轨迹。
