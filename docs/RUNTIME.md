# Runtime reference / 运行机制

[English](#english) · [简体中文](#简体中文) · [Project home](../README.md)

## English

### Sessions and observations

Tablaze uses a persistent Playwright Chromium process. Default sessions use separate temporary contexts and retain state while their context/server runs; they are not saved disk profiles. Tablaze does not call a model, and Jev is not integrated.

`tab_open` returns a `session_id`, `snapshot_id` and element refs. A new snapshot supersedes the previous revision. A batch consumes its supplied revision; use the fresh snapshot returned by `tab_act`, or observe again. Refs from another session, frame observation or replaced/navigated document are not interchangeable.

Diffs name their `baseline_snapshot_id` and return `added`, `changed` and `removed` within the returned element budget. Keep that baseline, or request a full snapshot. Truncation means an omitted element may still exist on the page.

### Actions, timeouts and cancellation

Batches contain 1–20 ordered steps. Operations within one session are serialized and a batch stops at its first failure. Read `completed`, `failed`, `results`, `partial` and `failed_action_may_have_side_effects`; a failing command may already have affected the page.

| Setting | Scope |
| --- | --- |
| CLI `--timeout-ms` | Individual action/navigation and default verification waits. Default 10,000 ms; range 100–60,000 ms. |
| `tab_act.timeout_ms` | Total batch execution budget after it acquires the session queue. Default 30,000 ms; maximum 60,000 ms. |
| Client tool timeout | The MCP client's own wait for the response; configure it separately. |

Active cancellation or an expired batch budget closes the owned session to interrupt pending work and skip later actions. A batch cancelled before execution performs no actions. Neither failure nor cancellation rolls back submitted requests or completed effects. Check the resulting business state before repeating an operation.

DOM identity and semantics are checked before input, including after trial actionability waits. Page scripts can still change the DOM between the check and input; this is not an atomic guarantee. Trial checks can scroll the page. `tab_verify` proves only the selected assertions, independently of whether a click completed.

### Browser modes

| Mode | Behavior |
| --- | --- |
| Managed Chromium | `setup` installs the browser matched to the locked Playwright version; startup never downloads it automatically. |
| `--channel chrome` | Selects installed Chrome and launches separate browser resources. It does not attach to normal signed-in tabs. |
| `--cdp-url` | Explicitly attaches to an existing Chromium endpoint and creates owned pages in its default context. Login and storage are shared with that profile. |

CDP cleanup closes owned pages and disconnects; it does not intentionally close unrelated tabs or terminate the external Chrome process. CDP uses Playwright's lower-fidelity attachment path. `doctor` checks configuration/executable availability, not a real browser launch or CDP connection.

### Results, data and current limits

Tools return JSON text and `structuredContent`; failed operations set `isError`. SDK input-validation errors use the SDK's error format. `tab_capture` returns JPEG metadata and an MCP image block. No arbitrary JavaScript execution tool is exposed.

Snapshots omit password/hidden input values, and value checks reject those inputs. Other values, page text, URLs, extracted content and screenshots can contain private information. See [security boundaries and reporting](../SECURITY.md).

Current scope is Chromium, ordinary DOM controls, open shadow roots and explicitly selected frames. The compact snapshot is not a complete accessibility tree. Upload/download workflows, closed shadow roots, native dialogs and new-tab workflows are not supported. Canvas content can be captured, but there is no coordinate-click tool.

[Complete arguments and troubleshooting](CODEX.md) · [Tarball installation](CODEX.md#1-build-and-choose-a-browser) · [Release archives](RELEASE.md) · [Benchmark boundaries](../bench/README.md)

## 简体中文

### 会话与观察

Tablaze 通过 Playwright 持续运行 Chromium。默认会话使用彼此独立的临时上下文，状态在上下文和服务运行期间保留，不是保存到磁盘的 profile。服务自身不调用模型，也未接入 Jev。

`tab_open` 返回 `session_id`、`snapshot_id` 和元素 ref。新快照使旧版本失效；批次消耗传入的版本，下一步使用 `tab_act` 返回的新快照或重新观察。不同会话、frame 观察及已导航或替换文档的引用不能混用。

增量快照标明 `baseline_snapshot_id`，在返回元素预算内报告 `added`、`changed` 和 `removed`。需要保留该基线，否则应请求全量快照。发生截断时，未出现某个元素不等于页面中不存在它。

### 操作、超时与取消

每批包含 1–20 个顺序步骤，同一会话内操作串行执行，批次在首个失败处停止。读取 `completed`、`failed`、`results`、`partial` 和 `failed_action_may_have_side_effects`；失败步骤也可能已经改变页面。

| 设置 | 范围 |
| --- | --- |
| CLI `--timeout-ms` | 单步、导航和默认验收等待；默认 10,000 ms，允许 100–60,000 ms。 |
| `tab_act.timeout_ms` | 从取得会话执行权后计算的整批预算；默认 30,000 ms，最多 60,000 ms。 |
| 客户端工具超时 | MCP 客户端等待响应的时间，需要独立配置。 |

运行中取消或整批预算耗尽，会关闭自有会话以打断等待并跳过后续操作。执行前已取消的批次不执行操作。失败和取消都不会回滚已经提交的请求或完成的副作用，重复操作前应核对业务状态。

输入前检查 DOM 节点身份和语义，包括在可操作性预检等待之后再次检查。页面脚本仍能在检查与输入之间改变 DOM，因此不构成原子保证；预检也可能滚动页面。`tab_verify` 只证明所选断言，与点击是否完成分开判断。

### 浏览器模式

| 模式 | 行为 |
| --- | --- |
| 管理的 Chromium | `setup` 安装与锁定 Playwright 版本匹配的浏览器；服务启动不会自动下载。 |
| `--channel chrome` | 选择本机 Chrome 并启动独立浏览器资源，不接管日常已登录标签页。 |
| `--cdp-url` | 显式连接既有 Chromium 端点，在默认上下文内创建自有页面，共享该 profile 的登录状态和存储。 |

CDP 清理只关闭自有页面并断开连接，不主动关闭无关标签页或终止外部 Chrome；该方式使用 Playwright 保真度较低的连接路径。`doctor` 检查配置及程序是否存在，不执行真实浏览器启动或 CDP 连接。

### 返回结果、数据与当前限制

工具同时返回 JSON 文字和 `structuredContent`，失败操作设置 `isError`；SDK 参数校验错误使用 SDK 格式。`tab_capture` 返回 JPEG 元数据和 MCP image block。服务不提供通用 JavaScript 执行工具。

快照省略 password/hidden input 的值，字段值检查拒绝这些输入。其他字段、页面文字、URL、提取内容和截图仍可能包含私人信息，具体见[安全边界与报告方式](../SECURITY.md)。

当前范围为 Chromium、普通 DOM 控件、开放 Shadow DOM 和显式选择的 frame；精简快照不是完整无障碍树。不支持上传下载流程、封闭 Shadow DOM、原生对话框和新标签页流程。可以截图观察 canvas，但没有坐标点击工具。

[完整参数与排错](CODEX.zh-CN.md) · [安装本地包](CODEX.zh-CN.md#1-构建与选择浏览器) · [发布归档](RELEASE.md) · [基准范围](../bench/README.md)
