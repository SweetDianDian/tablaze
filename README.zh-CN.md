<p align="center">
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh">
    <img src="docs/assets/tablaze-banner.svg" alt="Tablaze 闪页 — 精简的浏览器 MCP。观察、操作、验收。" width="100%">
  </a>
</p>

<p align="center">
  <strong><a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh">访问官网 ↗</a></strong> &nbsp; · &nbsp;
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh#demo">观看真实演示</a> &nbsp; · &nbsp;
  <a href="docs/CODEX.zh-CN.md">Codex 接入指南</a> &nbsp; · &nbsp;
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml"><img src="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b7db9a?style=flat-square" alt="MIT 许可证"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A520-80b7ff?style=flat-square" alt="Node.js 20 及以上"></a>
</p>

**让 Agent 真正操作浏览器。** Tablaze / 闪页通过十六个 MCP 工具，让 Codex 等客户端连接 Chromium：观察页面、填写表单、提取结果，再检查任务是否完成。

基于 Playwright，浏览器会话在调用之间持续运行，推理由你的 MCP 客户端完成。MCP 浏览器工具无需额外模型 API Key；可选独立 Agent 循环使用显式配置的规划器。

## 看它完成一次任务

**[观看完整演示，约 2 分 6 秒 →](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh#demo)**

真实 MCP SDK 客户端走完同一条差旅流程：一次批次执行六个表单动作，完成五项结果验收，再遇到被替换的审批按钮。旧引用被拒绝，未打开审批或写入订单；重新观察后，按明确配置跟随弹窗，完成四步审批与三项回执检查。最后核对下载 CSV 的实际字节和 SHA-256，关闭两个自有标签页，确认剩余会话为零。

[![真实 MCP 演示：一份已审批行程、已核对 CSV，以及零剩余会话](docs/assets/demo-poster.png)](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh#demo)

`批量填表` → `验收结果` → `停止并重新观察` → `弹窗审批` → `核对文件`

录像长 154 秒，呈现真实工具响应和截图，配有自然的英语男声旁白和可选字幕，不再叠加模拟鼠标。流程由确定性的 SDK 脚本操作本地场景，未调用推理模型；这是展示录屏，并非被控标签页的连续视频流。

[本地复现录制](demo/README.md) · [查看完整调用记录](docs/evidence/demo-run.json)

## 当前量化记录

[第三轮同模型 Codex 对比](docs/CODEX_COMPARISON_RESULTS_V3.md)包含五个可见开发任务，每项任务每引擎运行一次。双方独立业务验收均为 **5/5**；Tablaze 完整成功结束为 **4/5**，Browser Use 为 **5/5**。Tablaze 的订单已写入，但旧推理连接层随后中断，未完成验收和最终报告；失败调用没有用量数据，因此总 tokens 保留未知。

[连接层修复后的独立订单复测](docs/CODEX_TERMINAL_FOLLOWUP.md)中，双方均完整成功，各创建一笔订单，没有重复写入：

| 独立复测指标 | Tablaze | Browser Use |
| --- | ---: | ---: |
| Agent 报告完成 | 59.247 秒 | 75.354 秒 |
| 全程时间 | 59.415 秒 | 93.706 秒 |
| 模型调用，含评审 | 4 | 4（其中评审 1 次） |
| 输入 / 输出 tokens | 59,123 / 664 | 70,868 / 1,002 |

Browser Use 默认评审已计入总时间和用量。Agent 完成与全程时间的起点不同。这次独立复测不替换原来的 4/5；少量可见样本不能证明整体超过 Browser Use。两份报告均保留原始结果、代码哈希、运行条件与限制。

新增[四任务同模型开发对照](docs/CODEX_CURRENT_FOUR_SMOKE.md)，覆盖 iframe 填写、响应中断后的订单核对、虚拟列表和视觉画布。双方各四次完整成功且通过独立业务验收；Tablaze 的 iframe 样本较慢（83.799 秒对 52.515 秒），另三题全程时间较短。每题每侧仅一次，不能证明稳定效率或整体领先。
初次观察会在有限时间内等待新附加的子 iframe 就绪。主页面没有可操作控件且仅有一个可见、含表单字段的子页面时，第一次 `tab_open` 直接返回子页面的可操作引用；真实 Chrome 回归已用这些引用填写并提交延迟加载的表单。[六组同模型对照](docs/CODEX_IFRAME_DIRECT_OPEN_SMOKE.md)双方业务均通过、零重复写入，Tablaze 六组均省去额外子 frame 快照。全程中位数为 34.128 对 57.526 秒，Agent 完成中位数为 33.973 对 39.778 秒；对方默认评审仅计入全程。单一合成任务不能证明稳定速度或整体领先。
后续[三组 iframe 同模型复测](docs/CODEX_IFRAME_READINESS_SMOKE.md)的独立业务验收双方全部通过，但 Tablaze 可见样本的全程中位数为 79.699 秒，Browser Use 为 56.040 秒。Tablaze 两组因误把输入值当页面文本检查而多用模型回合，目前不能声称效率已接近。
后续动作反馈已在检查失败时保留原操作的子 iframe，下一次决策可直接看到正确页面，无需额外切回 frame。[新三组同模型对照](docs/CODEX_IFRAME_FEEDBACK_SMOKE.md)双方业务各通过 3/3、零重复写入：Tablaze 全程中位数 46.037 秒，对方 56.132 秒；但 Agent 宣告完成的中位数分别为 45.880 和 39.114 秒。这三组都没有触发检查失败，不能把耗时差归因于该修复。

[Browser Use 当前功能与公开问题审计](docs/BROWSER_USE_2026_AUDIT.md)逐项记录 Agent、MCP、Harness、Pi 和云服务的实现与缺口，以及公开问题是否有本地复现和回归测试。密码框现在只显示是否已填，不暴露原值。

[四类任务、双种子 Codex 同模型对照](docs/CODEX_MIXED_FOUR_20260924.md)覆盖表单、虚拟列表、视觉画布和中断后避免重复下单。双方独立业务验收均为 8/8，每次一次正确写入、零重复。Tablaze 可见样本的全程中位数为 56.331 对 61.211 秒，但 Agent 完成中位数为 56.177 对 44.063 秒；Browser Use 默认评审发生在 Agent 完成之后。少量开发样本不证明稳定效率或全面对等。

[画布首次截图的四组 Codex 对照](docs/CODEX_CANVAS_INITIAL_VISION_SMOKE.md)中，Tablaze 独立业务验收 4/4、零重复写入；Browser Use 为 3/4，其中一次宣告成功后仍重复点击。Tablaze 四份轨迹都省去独立 `tab_capture`。共同成功的三组全程中位数为 41.552 对 61.113 秒，Agent 完成为 41.401 对 42.578 秒。单一可见任务不能证明整体领先。

## 开始使用

需要 **Node.js 20+**、npm 和 Git。当前为开发者预览版，npm 尚未发布，请从源码安装：

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
```

<details>
<summary>已安装 Chrome，或者正在使用 Linux？</summary>

已有 Chrome 时可以跳过 `setup`，运行 `node dist/cli.js doctor --channel chrome`，并在下方 Codex 命令末尾追加 `--channel chrome`。这会启动独立浏览器会话。

Linux 使用 `npx playwright install --with-deps chromium` 替代 `setup`，一起安装浏览器和系统依赖。

[浏览器模式与诊断](docs/CODEX.zh-CN.md#1-构建与选择浏览器)

</details>

### 接入 Codex

在克隆后的目录中，注册构建完成的服务：

```sh
codex mcp add tablaze -- "$(node -p 'process.execPath')" "$PWD/dist/cli.js"
codex mcp get tablaze
```

然后告诉 Codex：

> 使用 Tablaze 打开 https://example.com，读取标题和链接，验证页面标题包含“Example Domain”，然后关闭会话。报告这些检查的结果。

[完整接入指南](docs/CODEX.zh-CN.md)包含桌面配置、浏览器选择和排错。其他 MCP 客户端也可以通过 stdio 启动同一个 `node /绝对路径/tablaze/dist/cli.js` 命令。

需要页面内 JavaScript 时，可显式加 `--page-script`，启用 `tab_script`。它拥有页面同源权限，包括读取登录后的数据和发起网络请求；不能与密钥配置、外部 CDP 或导航策略同时使用。每次执行需要当前主框架快照，并返回新快照。详见[页面脚本权限与恢复边界](docs/PAGE_SCRIPT.md)。默认仍为十六个工具。

[独立的原生 Codex 页面脚本复测](docs/CODEX_PAGE_SCRIPT_SMOKE.md)中，Tablaze 与 Browser Use CLI-MCP 各一次通过认证响应任务的服务端验收：每侧恰好一次正确提交、零重复写入。Codex 进程样本分别为 198.359 秒和 239.400 秒；浏览器启动方式不同，不构成受控的速度排名或整体胜出结论。

### 独立执行任务

可选 `run` 命令支持 `codex`、`anthropic`、`ollama`、`openai-compatible` 四类规划器，始终要求明确指定模型。Codex 复用本机 CLI 和已有登录：

```sh
node dist/cli.js run --provider codex --model "<你的Codex模型>" \
  --task "<已授权的任务>" --channel chrome
```

使用 `--output-schema ./result.schema.json` 可要求 Agent 结束前返回符合 JSON Schema 的结构化结果；业务正确性仍需应用验收。恢复运行时须提供相同 Schema。详见 [Agent 约定](docs/AGENT.md)。

使用 `--extraction-model <模型名>` 可让 Agent 在真实页面上调用独立提取模型：`tab_extract_model` 自行读取当前浏览器正文和 URL，拒绝截断证据，并逐字段校验 Schema 与原文引用；完成任务仍需页面核验。提供方可通过 `--extraction-provider` 单独选择。用法与边界见[提取说明](docs/EXTRACTION.md)。

CLI 的 Agent 与 stdio MCP 默认不允许上传任意本机文件。使用可重复的 `--available-file /绝对路径` 授权指定文件；同一会话完成的下载也可用短 ID 再上传。认证任务可通过 `--storage-state-file /绝对路径/state.json` 将受信任的 Playwright 状态导入新的隔离会话，模型不会收到该文件路径。详见[文件策略](docs/FILE_POLICY.md)。

SDK 调用方可用 `createAgentControl()` 在安全边界暂停、加入可信操作员指令，再以新计划继续；未执行的写入会跳过，先前的验证必须重做。详见 [运行中干预](docs/AGENT.md#live-operator-intervention-sdk)。

默认兼容提供方仍需 `--endpoint`。原生 Anthropic 和 Ollama 使用各自协议及默认端点；认证、输出参数和模型能力各有边界。显式配置 `--fallback-model` 后，规划遇到瞬时故障可切换备用模型并在本次运行中继续使用；恢复过程不会重复浏览器操作。详见[提供方配置](docs/PROVIDERS.md)、[CLI 示例](docs/CODEX.zh-CN.md#为-run-选择规划器)和[Agent 验收与恢复](docs/AGENT.md)。Anthropic/Ollama 目前只有本地协议覆盖，尚无真实推理结果；上方历史对比仍对应原来的运行代码哈希。

新 Codex 生产入口另有[独立真实验证](docs/CODEX_PROVIDER_SMOKE.md)：两项任务完整成功并通过服务端验收（2/2），重复写入为 0；不与旧对照数据合并。

新增[虚拟列表同条件任务](docs/CODEX_VIRTUAL_LIST_SMOKE.md)：双方各完整成功一次，独立验收通过且没有重复写入。共同 120,000-token 预算下，Tablaze 全程 86.830 秒，Browser Use 全程 141.597 秒（含默认评审）。单个可见开发任务不能证明整体性能或成功率领先。

[延迟控件开发对照](docs/CODEX_DELAYED_TARGET_SMOKE.md)记录了真实 Codex 在 Tablaze 的一个受保护批次里打开菜单并点击新出现的选项。最后一轮同题尝试双方均一次正确写入、零重复；Tablaze 为 80.715 秒，Browser Use 为 77.720 秒。报告保留了早期角色误猜与恢复轨迹。跨源码阶段的单次样本不能证明稳定速度或整体优势。

另一个[跨来源授权返回任务](docs/CODEX_AUTH_RETURN_SMOKE.md)中，双方也各成功一次，提供方授权和主页面提交均恰好一次。Browser Use 全程 119.515 秒，略快于 Tablaze 的 123.719 秒。该合成弹窗流程不能证明生产登录能力或整体排名。

调试真实运行时，可通过 `--record-video` 为每个自有独立标签页生成私有 WebM；`tab_close` 返回最终路径和 SHA-256，独立 `run` 会在清理后把录像清单写入报告。默认关闭，不叠加模拟光标，也不录声音。详见[真实浏览器录制与隐私边界](docs/RECORDING.md)。

也可选用 `--record-har` 和 `--record-trace` 保存自有会话的网络 HAR 与 Playwright 追踪 ZIP。HAR 默认不存响应正文；可信操作者可显式选择 `--har-content embed|attach` 和 `--har-mode full|minimal`。关闭后返回私有文件路径、大小和 SHA-256。任一模式都可能含敏感请求数据，正文模式还可能保存私密响应。详见[诊断文件说明](docs/DIAGNOSTICS.md)。

可信操作者可设置自有浏览器的视口、屏幕、像素比、User-Agent、语言、时区、移动端行为、触控和页面权限。`--no-viewport` 可让桌面页面跟随浏览器内容区；有头模式还支持 `--window-size` 和 `--window-position`。`--device-preset pixel-7` 或 `pixel-7-pro` 可一键应用一组移动端模拟参数。`doctor` 会报告生效配置但不回显 User-Agent 字符串，外部 CDP 浏览器不会被修改。预设不是完整设备指纹。详见[浏览器配置与限制](docs/BROWSER_CONFIGURATION.md)。
自有浏览器还可配置 `--proxy-server`，可选绕过规则及从环境变量读取的代理密码；[配置说明](docs/BROWSER_CONFIGURATION.md)区分了已测试的 HTTP 路由和仍待验证的代理认证等路径。

## 简单的工作流，明确的控制

| 能力 | 给 Agent 带来什么 |
| --- | --- |
| **持续会话** | 调用之间保留页面状态。默认使用临时隔离上下文，也可显式通过 CDP 连接已有 profile。 |
| **自有持久资料** | 可选使用[专有私有 Chrome 目录](docs/PROFILES.md)，再次打开时核对 profile ID，并拒绝并发占用；浏览器管理的登录状态可跨冷启动保留。 |
| **精简观察** | 全量或增量快照，包含元素引用、文字预算与截断标记。 |
| **引用检查** | 输入前检查快照版本和 DOM 目标；目标变化后重新观察。 |
| **顺序批次** | 一次最多提交 20 个操作，分别报告完成、失败和跳过状态。遇错停止，先前操作仍然生效。 |
| **延迟控件** | 点击已观察到的入口后，在同一受保护批次中等待并点击唯一、准确命名的可见按钮或菜单项；重名时输入前停止。 |
| **明确验收** | 核对实际 URL、标题、文字、字段值、可见性与元素数量。已知的同文档结果可在 `tab_act` 批次结束后直接检查，并在同一次调用中形成 Agent 可引用的证据。 |
| **可选响应日志** | 使用 `--capture-network`，通过第十七个 MCP 工具 [`tab_network`](docs/NETWORK.md) 观察自有页面与弹窗的有界响应；默认关闭，尚非通用 JS/CDP 编程入口。 |
| **可选真实录像** | 使用 `--record-video` 录制自有独立标签页，关闭会话后返回私有 WebM 路径及 SHA-256。[录制范围与限制](docs/RECORDING.md)。 |
| **可选导航策略** | 通过[精确来源允许/拒绝规则](docs/NAVIGATION_POLICY.md)限制自有独立浏览器中的 HTTP(S) 文档请求，覆盖重定向、frame 和弹窗。不支持外部 CDP，也不是网络防火墙。 |

### 十六个工具

| 工具 | 用途 |
| --- | --- |
| `tab_open` | 打开页面并返回首次快照。 |
| `tab_snapshot` | 观察页面、变化或指定 frame。 |
| `tab_find` | 在页面或已观察的虚拟列表容器中滚动查找文字，返回可操作的新快照。 |
| `tab_act` | 受保护的表单操作、显式关联的只读输入框与原生列表选择、拖拽、容器滚动、文件选择与坐标操作；可选动作后检查。 |
| `tab_verify` | 执行页面断言，通过受保护的 ref 或 CSS 选择器验收表单值。 |
| `tab_extract` | 读取文字、链接或表格。 |
| `tab_capture` | 获取 JPEG 截图。 |
| `tab_list` | 查看自有会话。 |
| `tab_close` | 关闭会话并释放资源；启用录像时返回已完成 WebM 的文件元数据。 |
| `tab_navigate` | 在会话内前进、后退、刷新或导航。 |
| `tab_tabs` | 创建、切换和关闭自有标签页，接续弹窗流程。 |
| `tab_downloads` | 查看下载状态与本地文件。 |
| `tab_dialog` | 为下一次原生对话框设置接受或取消响应。 |
| `tab_state` | 导出可用于新会话恢复的登录状态文件。 |
| `tab_extract_structured` | 按 JSON Schema 提取类型化字段，返回 DOM 来源证据。 |
| `tab_pdf` | 导出私有 PDF 文件，返回来源 URL 和 SHA-256。 |

当前开发分支增加定向/视口快照、统一 Shadow DOM 读取、拖拽、容器滚动、文件流程、多标签页、[结构化提取](docs/EXTRACTION.md)和可断点恢复的[模型驱动 Agent](docs/AGENT.md)。`extractWithPlanner` 与 `tablaze-extract` 可为调用方提供的来源文本单独选模型，并检查 Schema 和逐字段原文引用；尚未接入 Agent 的页面任务流程。新增能力尚未发布到 npm，见[一次真实 Codex 提取抽样](docs/MODEL_EXTRACTION_20260924.md)及[开发状态](docs/DEVELOPMENT_STATUS.md)。[Browser Use 对照与未完成验收](docs/BROWSER_USE_COMPARISON.md)明确记录差距，不宣称已超过对方。

## 深入了解

| 文档 | 内容 |
| --- | --- |
| [Codex 接入](docs/CODEX.zh-CN.md) | 可复制的配置、工具参数与排错。 |
| [运行机制](docs/RUNTIME.md#简体中文) | 引用生命周期、批次语义、浏览器模式与当前限制。 |
| [类型化自定义工具](docs/CUSTOM_TOOLS.md) | SDK Schema、可信应用上下文、浏览器绑定与恢复约定。 |
| [模型提供方](docs/PROVIDERS.md) | Codex CLI、原生 Anthropic/Ollama 与兼容 HTTP 的协议、认证及用量。 |
| [导航策略](docs/NAVIGATION_POLICY.md) | 可信 CLI/SDK 配置、仅文档请求的范围、连接中断边界与恢复策略身份。 |
| [定向凭据](docs/SECRETS.md) | 可信别名、精确来源登录填写、遮盖边界与恢复。 |
| [真实浏览器录像](docs/RECORDING.md) | 可选 WebM、CLI/MCP/SDK 获取方式与隐私边界。 |
| [Browser Use 多入口审计](docs/BROWSER_USE_VARIANTS.md) | 区分 Agent、MCP、Harness、Pi 和云服务；源码审计不等于性能测量。 |
| [基准测试](bench/README.md) | 复现本地场景，检查每个原始样本。 |
| [验证记录](docs/VALIDATION.md) | 真实浏览器、SDK 与 Codex 的结果和验证范围。 |
| [安全边界](SECURITY.md) | 数据处理、资源归属与私密漏洞报告。 |
| [发布打包](docs/RELEASE.md) | 生成 npm 安装包和源码归档。 |

[历史 0.1.0 的 Ubuntu Node 20/22 CI](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909)已通过当时的构建、浏览器/MCP 测试和包内容检查；后续[包含提供方适配器的提交 `c9d091a` 的 Ubuntu Node 20/22 CI](https://github.com/SweetDianDian/tablaze/actions/runs/35736979945)两个任务也均已通过。该次运行早于本轮导航策略改动。当前开发分支的验收[单独记录](docs/DEVELOPMENT_STATUS.md)。源码目录中运行 `npm test` 可执行测试；`npm run bench` 单独运行本地基准。

## 参与贡献

带来一个可复现的浏览器案例，改进一份指南，或提交一项聚焦修复。[提交 Issue](https://github.com/SweetDianDian/tablaze/issues) · [提交 Pull Request](https://github.com/SweetDianDian/tablaze/pulls) · [贡献指南](CONTRIBUTING.md)

[MIT 许可证](LICENSE) · [依赖署名与项目来源](NOTICE)
