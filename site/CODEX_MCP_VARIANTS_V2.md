# 原生 Codex 工具轨道：Browser Use 的三个 MCP 入口

日期：2026-09-23。以下是**可见开发期任务，每项每侧仅一次**，不是冻结的多任务评测。外部 Agent 均为原生 `codex exec`、`gpt-6-astra` / `ultra`；浏览器是每次独立的本机 Chrome `153.0.8010.53`、1280×713 CSS 视口。服务端独立核对正确写入和重复写入，不能由 Agent 自述替代。

| 任务 / Codex 进程耗时 | Tablaze MCP | Browser Harness MCP | Browser Use `--cli-mcp` | Browser Use `--mcp` 直接工具 |
| --- | ---: | ---: | ---: | ---: |
| Ada / Lisbon 表单，正确写入恰好一次 | 成功，69.331 秒 | 成功，111.232 秒 | 成功，93.260 秒 | 成功，74.824 秒 |
| 蓝色画布，正确点击恰好一次 | 成功，65.037 秒 | 成功，77.263 秒 | 成功，71.074 秒 | 成功，71.326 秒 |
| 虚拟列表 VIRTUAL-130，正确预订恰好一次 | 成功，90.791 秒 | 成功，175.487 秒 | 成功，193.335 秒 | 未完成，195.185 秒；写入 0 |

前两项四侧都通过。虚拟列表中，Tablaze、Harness 和 CLI-MCP 各写入一次正确记录，重复写入均为 0。Browser Use 结构化 `--mcp` 的页面级 `browser_scroll` 未移动嵌套列表；外部 Codex 还尝试了 `retry_with_browser_use_agent`，但**直接工具配置没有给后备 Agent API Key**，它返回缺少 Key。后续对同页的 `javascript:` 导航没有产生预订，最终服务端写入 0。该失败只描述这个隔离的直接工具配置；Harness 的 JS 工具和 CLI-MCP 的 Python 工具在同一任务成功，所以不能说 Browser Use 整体不支持虚拟列表。

这些入口的能力边界不同：Tablaze 给外部 Agent 有界的目标引用、操作和验证；Harness MCP 暴露 JS/CDP 和截图文件路径；CLI-MCP 暴露持久 Python 命名空间和原生截图；结构化 `--mcp` 暴露页面控件及可选的嵌套 Agent。表单、画布和虚拟列表的成功不能覆盖代码执行安全性、真实登录、长任务恢复或 Cloud 能力。Harness 的 JSONL 只有截图文件路径，没有单独的 `view_image` 事件，无法从轨迹单独证明它实际读取像素。画布结果由服务端坐标验证。

同一规范任务文本、同一 Codex CLI `0.155.0-alpha.9.2`、provider 配置和自动审批策略用于直接工具尝试；各入口的 MCP 指令和工具目录自然不同。进程耗时包含 Codex 启动、模型调用、MCP 与自动审批，**不含**外部 Chrome 启动、事后评审和清理；它不是纯浏览器引擎耗时，也不能与旧报告的全程时间直接比较。没有共同的货币成本上限或置信区间。浏览器、配置、下载和 Harness daemon 均用尝试自有临时目录；Browser Use 遥测及 Cloud 同步关闭。Tablaze 原生浏览器运行时没有改动；四侧比较发生于同一天、但脚本随入口扩展，须按各次源码哈希解释，而不能冒充单一冻结批次。

Browser Use `0.13.10` 的固定 checkout 为 `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`；安装包与 checkout 共有的 163 个 Python 文件逐字节一致，缺少的 7 个均为测试文件。Harness 使用固定源码 `afbcc381b963040c19627d788e40c7e7663171ee`，而非同版本但不同字节的原安装 wheel。结构化 `--mcp` 使用自有 config、CDP 地址、profile、下载目录和域名规则；预检证实实际视口为 1280×713。旧[两入口报告](CODEX_NATIVE_MCP_SMOKE.md)及其失败配置尝试继续单独保留。

[本轮汇总和原始 Codex JSONL 轨迹](evidence/native-codex-mcp-variants-v2.json)、[CLI-MCP 预检](evidence/native-mcp-cli-preflight-v2.json)、[结构化 MCP 预检](evidence/native-mcp-structured-preflight-v2.json)记录工具调用、用量、服务端判定及源码信息。`--mcp` 的完整后备 Agent 路径另列在下方，不能将其与上述直接工具列混合计算成功率。

## 结构化 MCP 的完整后备 Agent 路径

后备 Agent 用本机对比网关调用同一 `gpt-6-astra` / `ultra` Codex 模型；外部 Codex 与后备 Agent 的用量分别计数。两次尝试都保留：

| 虚拟列表完整路径 | 首次尝试 | 延长期限后 |
| --- | ---: | ---: |
| 独立业务验收 / 完整返回 | 未通过 / 超时 | 通过 / 成功返回 |
| 服务端正确写入 / 重复写入 | 0 / 0 | 1 / 0 |
| Codex 进程耗时 | 360.009 秒 | 318.247 秒 |
| 外层 Codex 输入 / 输出 tokens | 未形成完整用量 | 394,118 / 1,959 |
| 后备 Agent 模型请求 | 11 次，最后一次取消 | 6 次，均完成 |
| 后备 Agent 输入 / 输出 tokens | 177,585 / 5,119；取消中的请求用量未知 | 111,548 / 2,566 |

首次尝试的外层 MCP 每次工具调用只有 60 秒，两个后备请求均在这个工具期限被切断；外层到 360 秒停止时尚无写入。这是测试器时限不足的尝试，不用来判定完整入口的任务能力。第二次将单次 MCP 工具期限放宽到 300 秒、外层期限放宽到 600 秒；后备 Agent 找到并只预订一次目标行，外层 Codex 验证后完整返回。**完整入口能完成此任务**，但它调用了第二个 Agent，不能把其耗时和 tokens 当成与单 Agent 直接工具路径完全同类的指标。两次和所有直接工具尝试均在[原始汇总](evidence/native-codex-mcp-variants-v2.json)中，失败没有被覆盖。
