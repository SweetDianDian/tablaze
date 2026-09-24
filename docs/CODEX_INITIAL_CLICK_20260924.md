# 预设点击配对对照：Tablaze 与 Browser Use

日期：2026-09-24。Tablaze 使用干净提交 [`59ffc59`](https://github.com/SweetDianDian/tablaze/commit/59ffc59901ec2b90c6f79254dc34a6cf554cffc6)（工作树补丁 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`）；Browser Use Python Agent 0.13.10 固定在 [`d8110c5`](https://github.com/browser-use/browser-use/tree/d8110c5ff87ccba887aaa726cdb780f2f84bef8d)。双方使用同一 Codex CLI `0.155.0-alpha.9.2`、`gpt-6-astra / ultra`、1280×800 的独立 Chrome、40 步、180 秒截止时间和 150,000 已报告 token 上限。Browser Use 的可选任务后模型评审在两侧配对中关闭。

任务要求揭示一次页面中的种子代码、填入 Code 字段并恰好提交一次。代码没有写入任务提示。两个框架都收到可信预设“导航至该页，然后点击 Reveal code”：Tablaze 按唯一可访问名称从新快照定位控件；固定版本的 Browser Use 接收其公开 `initial_actions=[navigate, click(index=1)]`。服务端独立记录揭示请求和提交，只有**一次揭示、一次正确提交**才算通过。每侧每种子使用独立浏览器与服务端状态，运行顺序交替。

| 种子 | Tablaze 全程 / Agent 完成 | Browser Use 全程 / Agent 完成 | 模型调用 Tablaze / Browser Use | 独立业务验收 |
| ---: | ---: | ---: | ---: | --- |
| 131 | 68.562 / 68.404 秒 | 62.911 / 62.094 秒 | 4 / 3 | 双方通过；各揭示 1 次、提交 1 次 |
| 132 | 73.044 / 72.874 秒 | 60.464 / 59.653 秒 | 4 / 3 | 双方通过；各揭示 1 次、提交 1 次 |
| 133 | 63.503 / 63.348 秒 | 85.058 / 84.211 秒 | 4 / 3 | 双方通过；各揭示 1 次、提交 1 次 |

双方均为 **3/3 服务端通过、3/3 Agent 正常成功、3/3 截止前完整返回**，重复揭示与重复提交均为零。全程中位数为 **68.562 秒 Tablaze / 62.911 秒 Browser Use**，Agent 完成中位数为 **68.404 / 62.094 秒**；Tablaze 在两组较慢、一组较快。Tablaze 三组均使用 4 次规划调用，Browser Use 均为 3 次。输入 token 中位数分别为 **69,994 / 56,493**，输出 token 中位数为 **823 / 812**。全程包含启动、任务、清理与独立验收；Agent 完成时间截至框架报告完成。两侧评审关闭，因而没有把 Browser Use 任务后评审时间混入差额。

原始轨迹揭示了比最终通过率更具体的差别。Tablaze 三组的 `tab_open` 和 `tab_click_named` 都在第一次模型调用前成功，首次模型观察已经包含揭示出的代码。Browser Use 三组的初始动作记录都只执行了 `navigate`，排队的 `click(index=1)` 未执行；模型随后在任务步骤中点击 Reveal code，再填入代码并提交。固定源码的 `navigate` [标记为终止动作序列](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/tools/service.py#L503-L507)，其 [`multi_act` 在此标记后停止后续动作](https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/browser_use/agent/service.py#L2813-L2821)。这是该**固定版本、该动作排列**的可复现行为，不代表 Browser Use 当前所有版本或其它入口不能预先点击。

Tablaze 的额外模型轮次来自提交后的 `tab_snapshot`，随后才调用 `tab_verify`；在这三组中，提交操作即时返回的快照还显示旧的 `Ready` 状态，稍后的快照才显示 `Saved successfully`。它没有重复写入，但多消耗一次观察/规划。Browser Use 在模型补做揭示后以 3 次模型调用结束。预设点击提前完成并未在这个任务里形成稳定速度优势；优化方向是在保持明确验收和零重复写入的前提下减少提交后多余的规划往返。

正式[原始结果](evidence/initial-click-20260924/results-paired.json) SHA-256 为 `fb7d429827d4c82bc2b7a9fa7040135a17eba95bf07781f975ff356d1c9a969a`，[六条轨迹](evidence/initial-click-20260924/README.md)保留初始动作、模型决策和工具结果。种子 130 的[单组试跑](evidence/initial-click-20260924/results-pilot.json)另存且不计入上表；它也双方通过，但 Tablaze 为 62.050 秒、4 次模型调用，Browser Use 为 59.410 秒、3 次模型调用。[完整 Node 24 + Chrome 回归](evidence/development-tests-initial-click-comparison-node24.txt)在测量前通过 **551/551**，日志 SHA-256 为 `0dc5fecde1cdcf14fe68b5dc6a7b04e8d3a20c47c7d49062cf5196f0151c177e`。

这是一项公开、可见的本地合成任务，每侧只有三次正式运行。它证明上述固定配置下的预设点击执行差异与一次正确提交；不足以估计稳定延迟或 p95，也不能证明 Tablaze 功能和效率总体超过 Browser Use。Browser Use 的 Harness、Pi、MCP 与云端入口需要独立比较。
