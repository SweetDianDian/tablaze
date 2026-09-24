# Runtime reference / 运行机制

[English](#english) · [简体中文](#简体中文) · [Project home](https://github.com/SweetDianDian/tablaze/blob/main/README.md)

## English

This reference describes the current source, its 16 default MCP tools, one optional network-response tool, owned persistent profiles and typed custom-tool SDK. The historical 0.1.0 archive and earlier validation reports cover an earlier capability set; identify the build by its commit and tool catalog. All recorded real Codex comparisons predate the owned-profile increment; they do not measure its model performance. npm publication remains pending.

### Sessions and observations

Tablaze uses a persistent Playwright Chromium process. Default sessions use separate temporary contexts and retain state while their context/server runs; they are not saved disk profiles. Explicit storage-state exports and workspace checkpoints can restore selected state later. The MCP server makes no model calls. The separate optional [`tablaze run` Agent](AGENT.md) uses an explicitly configured model adapter; Jev is not integrated.

`tab_open` returns a `session_id`, `snapshot_id` and element refs. A new snapshot supersedes the previous revision. A batch consumes its supplied revision; use the fresh snapshot returned by `tab_act`, or observe again. Refs from another session, frame observation or replaced/navigated document are not interchangeable.

Diffs name their `baseline_snapshot_id` and return `added`, `changed` and `removed` within the returned element budget. Keep that baseline, or request a full snapshot. Truncation means an omitted element may still exist on the page.

### Actions, timeouts and cancellation

Batches contain 1–20 ordered steps. Operations within one session are serialized and a batch stops at its first failure. Read `completed`, `failed`, `results`, `partial` and `failed_action_may_have_side_effects`; a failing command may already have affected the page.

For a visible readonly text-like input explicitly linked by `aria-controls` or `aria-owns` to one same-root native, single-select listbox (`size > 1`), its snapshot exposes up to 20 `associated_listbox.options`. Use the input ref in `tab_act` with `{type:"select",ref,values:["option-value"]}`. Tablaze clicks the opener and the native option, so the page's click handler runs, then checks that the option was selected and the input changed (or already held that value). It waits up to 500 ms for a delayed field update. Missing or ambiguous links, missing/disabled options and multiple values fail before opening; an obstruction or page change after opening is reported as a partial action, so inspect before retrying. Ordinary `<select>` refs retain native `selectOption` behavior. This does not infer relationships from nearby controls, support cross-root links or guarantee a page's business callback succeeded; verify the final outcome separately.

| Setting | Scope |
| --- | --- |
| CLI `--timeout-ms` | Individual action/navigation and default verification waits. Default 10,000 ms; range 100–60,000 ms. |
| `tab_act.timeout_ms` | Total batch execution budget after it acquires the session queue. Default 30,000 ms; maximum 60,000 ms. |
| Client tool timeout | The MCP client's own wait for the response; configure it separately. |

Active cancellation or an expired batch budget closes the owned session to interrupt pending work and skip later actions. A batch cancelled before execution performs no actions. Neither failure nor cancellation rolls back submitted requests or completed effects. Check the resulting business state before repeating an operation.

`tab_open` also accepts MCP cancellation; the library takes an optional `signal` alongside `storageState`. Cancellation cleans up that opening attempt, including owned contexts/pages that arrive after cancellation. It does not close other sessions, the shared warm browser or the external CDP context. Engine disposal has a 2-second cleanup wait: it closes its isolated browser to interrupt pending RPCs, and reports `CLEANUP_INCOMPLETE` if cleanup cannot be confirmed in time. For an unresolved CDP page acquisition, it retains the connection and late cleanup handler rather than guessing which external pages it owns. If that acquisition never settles, physical cleanup cannot be confirmed. A cleanup error is not successful disposal.

The Agent CLI reports cleanup failure separately from the underlying Agent outcome and exits unsuccessfully when it can close. A retained CDP connection can keep the process alive while late cleanup remains pending; the bounded `dispose()` result is not a guarantee of process exit. No unrelated external page is closed to force that exit.

The operator can opt into `--popup-policy follow-single` (MCP or Agent CLI) or `BrowserOptions.popupPolicy`; the default is `stay`. During an activating action, a 250 ms window associates popups with the current owned opener. Only one candidate is followed; multiple candidates, background openers and late popups remain available for explicit inspection. This association is not proof that the input caused the popup. A successful follow returns a fresh snapshot and `replan_required: true`, and stops remaining actions and Agent calls in that decision. Read `batch_complete`: `ok: true` only says no executed action failed, and can accompany `batch_complete: false` with skipped actions. No skipped action is replayed automatically.

DOM identity and semantics are checked before input, including after trial actionability waits. Page scripts can still change the DOM between the check and input; this is not an atomic guarantee. Trial checks can scroll the page. `tab_verify` proves only the selected assertions, independently of whether a click completed.

Value verification accepts either a CSS selector or an observed ref with its current snapshot ID. Ref reads check node identity and document generation before and after observation. After other checks finish waiting, ref values are read again to revoke outdated evidence; this final read cannot turn a timed-out assertion into success. A current snapshot consumed by an action without a replacement snapshot remains usable for read-only verification; replaced snapshots do not. Text checks omit raw form values. Page scripts can still change state after a check, so verification is not a transaction or a promise that values remain unchanged.

### Browser modes

| Mode | Behavior |
| --- | --- |
| Managed Chromium | `setup` installs the browser matched to the locked Playwright version; startup never downloads it automatically. |
| `--channel chrome` | Selects installed Chrome and launches separate browser resources. It does not attach to normal signed-in tabs. |
| `--cdp-url` | Explicitly attaches to an existing Chromium endpoint and creates owned pages in its default context. Login and storage are shared with that profile. |
| `--profile-dir` | Opt-in [owned persistent profile](PROFILES.md) with a private marker, required ID on reuse and exclusive lock. Browser-managed state survives restart; sessions, refs and Agent progress do not. |

CDP cleanup closes owned pages and disconnects; it does not intentionally close unrelated tabs or terminate the external Chrome process. CDP uses Playwright's lower-fidelity attachment path. `doctor` checks configuration/executable availability, not a real browser launch or CDP connection.

An owned profile is incompatible with external CDP, workspace/state import, CLI checkpoint/resume and document navigation policy. The profile ID binds a directory, not a website account or tenant. Verify active identity before sensitive writes. The profile directory contains credentials and is not encrypted by Tablaze.

### Results, data and current limits

Tools return JSON text and `structuredContent`; failed operations set `isError`. SDK input-validation errors use the SDK's error format. `tab_capture` returns JPEG metadata and an MCP image block. No arbitrary JavaScript execution tool is exposed.

The optional [`tab_network` journal](NETWORK.md) appears only with `--capture-network` / `captureNetwork: true`. It tracks a bounded set of responses from owned pages, can read small declared textual bodies on demand, and does not capture unrelated CDP tabs or provide raw headers, requests, JavaScript or CDP execution.

`tab_pdf` prints the whole active tab to a local PDF artifact, rather than the selected child frame. It accepts A4/Letter, landscape and background options and returns the path, size, SHA-256, URL and tab identity. Output is limited to 50 MiB. Exceeding the configured action timeout closes the owned tab and returns `PDF_TIMEOUT`; print layout can differ from the screenshot.

[`tab_extract_structured`](EXTRACTION.md) applies an explicit field map and JSON Schema to the observed frame. Citations identify the frame URL, selector, match index and raw observed value. Limits are 30 fields, 20 matches per field and 100 elements in total; type, schema, hidden-field and truncation failures are explicit. The separate provider-independent extraction API checks source-bound quotes for every populated leaf. Schema conformance and quote presence establish provenance, not the truth of a source or the correctness of every interpretation.

Snapshots omit password/hidden input values, and value checks reject those inputs. Other values, page text, URLs, extracted content, screenshots and PDFs can contain private information. See [security boundaries and reporting](SECURITY.md).

Current scope is Chromium, ordinary DOM controls, open shadow roots and explicitly selected frames. The compact snapshot is not a complete accessibility tree. Closed shadow roots remain outside DOM observation.

| Workflow | Supported behavior and boundary |
| --- | --- |
| Popups and dialogs | Owned popups remain available through `tab_tabs`. Arm `tab_dialog` before the action that opens a native dialog. |
| Uploads | `upload` sets files on an observed visible file input. `upload_chooser` clicks an observed visible button and handles its file chooser, including a hidden input behind that button. Both require explicit local paths, at most 20 regular files of 50 MiB each. |
| Drag and scroll | `drag` uses source `ref` and `target_ref`; both centers must fit in the viewport after scrolling. `scroll` supports up/down/left/right, with an optional observed container `ref`; without one it scrolls the selected frame window. Check the resulting movement or drop. |
| Coordinates | `click_xy` operates visually inspected content using main-viewport CSS coordinates, without a DOM target identity guarantee. |
| Downloads and state | Completed downloads remain as private temporary artifacts. `tab_state` exports cookies, localStorage and IndexedDB for explicit `tab_open` import; it does not save sessionStorage, extensions or open tabs. |

### Typed custom tools and execution context

The SDK's [`defineTool` and `createToolRegistry`](https://github.com/SweetDianDian/tablaze/blob/main/docs/CUSTOM_TOOLS.md) compose typed application operations with the base MCP client. Custom tools have explicit versions, Zod object input/output validation, public JSON Schema and trusted read/write effects. The application supplies tenant credentials and other execution context separately from model arguments. Only public tool schemas and descriptions reach the planner; handlers can still return or log sensitive data, so this is not a general output redactor.

The registry refreshes available tools for each planning decision. Optional `allowedOrigins` filters custom tools by exact HTTP(S) origin, including port; it does not constrain all browser network requests or install a general domain/file policy. Browser guards bind the owned active main document, current location, navigation generation and tab-activation history. They do not grant authority over cross-origin child frames. Planning completion and dispatch both recheck the captured binding. An executor-only `contextKey` also detects changes between catalogs, including switching away and back, so old refs and evidence cannot silently carry into the new context.

A successful `tab_close` that confirms `closed: true` for the same session may retain that session's then-current verification across context-only changes. Other context-bound evidence is discarded, and any later mutation invalidates even the retained evidence. Arbitrary DOM changes and external writes are not atomic with these checks. A handler that waits before submitting a write must recheck `execution.assertCurrent()` and use its captured target/credentials; the external service remains responsible for idempotency and concurrent-update conditions.

Invalid input or a rejected guard before handler entry returns `not_started`. Entered writes with an exception, invalid output or unknown result require reconciliation; cancellation cannot undo accepted effects. Calls share the Agent's cancellation and budgets and are never automatically replayed. Catalogs close after each decision, and closed or cancelled call contexts cannot become valid again. Custom success still needs the normal browser verification and application completion policy.

### Checkpoints and restoration

The library's `exportWorkspace` / `restoreWorkspace` and the CLI's `run --checkpoint` / `run --resume` preserve selected storage, owned tab URLs and the active tab. Restoration requires a new empty engine in isolated mode; it recreates pages under new session IDs and loads their URLs. It does not restore live DOM, form drafts, JavaScript memory, sessionStorage, scroll positions, extensions, pending downloads or in-flight transactions. Navigating to saved URLs can itself trigger website behavior. CDP workspace import is unsupported. All previous element refs and completion evidence become invalid; resume requires fresh observation and verification.

Workspaces also retain the popup policy; older version-1 workspaces without that field restore `stay`. CLI resume rejects an explicitly conflicting policy. Agent checkpoint version 3 records optional explicit initialization and a bound registry's execution identity. Strictly valid version-1/2 Agent checkpoints migrate as unbound records; version 1 has no initializer and version 2 retains it. `run --start-url` opens only the caller-supplied HTTP(S) URL before the first model decision, using the same tracked tool dispatcher. It consumes tool/time budgets, not a model planning step. An already attempted initializer is never automatically replayed on resume, even after reconciliation. A resumed run cannot add or change its saved initial URL.

A bound registry's checkpoint records SHA-256 digests of the complete base/custom contracts, including versions, schemas, effects and origin policies, and the trusted principal/tenant/policy identifier. Matching digests are required before preparing a catalog or planning; reconciliation cannot waive a mismatch. Pending effects are checked against complete trusted metadata, including currently hidden tools. The application must reconstruct the registry through the SDK; the plain CLI rejects a bound checkpoint before browser restoration, and an old unbound run cannot acquire a registry on resume. Digests check continuity, not file authenticity or arbitrary handler-code changes. The transient browser context key is not persisted; restored runs acquire new guards and new evidence.

An unknown mutating call blocks automatic continuation. The CLI returns `needs_input` before starting a browser or model unless the operator supplies `--reconciled` with a note after checking the actual business state; library callers use the reconciliation option. A reconciliation note does not prove success or authorize replaying an uncertain submission. Checkpoints marked as requiring `validateCompletion` must resume through the library with that application policy; the CLI cannot reconstruct executable application code.

Steps, tool calls, planner calls and elapsed runtime carry forward. Saved limits remain the defaults; time while the process is stopped is excluded. The returned library checkpoint includes the final persistence callback's wait. The CLI's saved elapsed time includes browser-state export before saving, but does not yet include the final atomic file write itself. It is therefore not an exact measure of all wall-clock persistence time.

CLI checkpoint JSON contains full Agent history and browser storage and is written with file mode `0600` through a temporary file and atomic rename. This is sensitive plaintext, not an encrypted browser backup. See [Agent setup and recovery](AGENT.md) and [checkpoint security](SECURITY.md#checkpoints-and-recovery--检查点与恢复).

[Complete arguments and troubleshooting](CODEX.md) · [Tarball installation](CODEX.md#1-build-and-choose-a-browser) · [Release archives](https://github.com/SweetDianDian/tablaze/blob/main/docs/RELEASE.md) · [Benchmark boundaries](https://github.com/SweetDianDian/tablaze/blob/main/bench/README.md)

## 简体中文

本页描述当前源码默认的 16 个 MCP 工具、可选的第十七个[网络响应工具](NETWORK.md)、自有持久 profile 与类型化自定义工具 SDK。历史 0.1.0 归档和早期验证报告覆盖较早的能力范围，请结合提交号与工具目录确认所用构建。已记录的真实 Codex 对照全部早于持久 profile 增量，不代表该功能的模型表现。npm 尚未发布。

### 会话与观察

Tablaze 通过 Playwright 持续运行 Chromium。默认会话使用彼此独立的临时上下文，状态在上下文和服务运行期间保留，不是保存到磁盘的 profile；显式导出的存储状态与工作区检查点可在之后恢复部分状态。MCP 服务不调用模型；独立可选的 [`tablaze run` Agent](AGENT.md) 使用显式配置的模型适配器。目前未接入 Jev。

`tab_open` 返回 `session_id`、`snapshot_id` 和元素 ref。新快照使旧版本失效；批次消耗传入的版本，下一步使用 `tab_act` 返回的新快照或重新观察。不同会话、frame 观察及已导航或替换文档的引用不能混用。

增量快照标明 `baseline_snapshot_id`，在返回元素预算内报告 `added`、`changed` 和 `removed`。需要保留该基线，否则应请求全量快照。发生截断时，未出现某个元素不等于页面中不存在它。

### 操作、超时与取消

每批包含 1–20 个顺序步骤，同一会话内操作串行执行，批次在首个失败处停止。读取 `completed`、`failed`、`results`、`partial` 和 `failed_action_may_have_side_effects`；失败步骤也可能已经改变页面。

若可见的只读文本输入框通过 `aria-controls` 或 `aria-owns` 明确关联同一 DOM 根中的唯一原生单选列表（`size > 1`），快照会在 `associated_listbox.options` 中展示至多 20 个选项。对输入框 ref 调用 `tab_act` 的 `{type:"select",ref,values:["选项值"]}`，Tablaze 会点击入口与原生选项，触发网页的点击回调，并检查选中状态以及输入框值是否变化（或本来就是该值）；延迟更新最多等待 500 毫秒。无关联、关联不唯一、选项不存在或被禁用，以及多值请求，都会在打开前失败。打开后若被遮挡或页面改变，应将结果视为部分执行并先检查再重试。普通 `<select>` 仍使用原生 `selectOption`。不会凭位置猜测关联，也不支持跨 DOM 根关联；业务结果仍需单独验收。

| 设置 | 范围 |
| --- | --- |
| CLI `--timeout-ms` | 单步、导航和默认验收等待；默认 10,000 ms，允许 100–60,000 ms。 |
| `tab_act.timeout_ms` | 从取得会话执行权后计算的整批预算；默认 30,000 ms，最多 60,000 ms。 |
| 客户端工具超时 | MCP 客户端等待响应的时间，需要独立配置。 |

运行中取消或整批预算耗尽，会关闭自有会话以打断等待并跳过后续操作。执行前已取消的批次不执行操作。失败和取消都不会回滚已经提交的请求或完成的副作用，重复操作前应核对业务状态。

`tab_open` 也支持 MCP 取消；库接口可在 `storageState` 旁传入 `signal`。取消会清理这次打开操作的资源，包括取消后才创建完成的自有上下文或页面，不会关闭其他会话、共享的常驻浏览器或外部 CDP 上下文。引擎释放最多等待清理 2 秒：隔离模式先关闭自有浏览器以打断未决 RPC，无法及时确认清理完成时返回 `CLEANUP_INCOMPLETE`。CDP 创建页面的请求未返回时，保留连接和迟到资源清理逻辑，不猜测哪些外部页面属于自己；如果请求永远不结束，就无法确认物理清理完成。清理报错不能视为成功释放。

Agent CLI 将清理失败与原始 Agent 结果分开报告，能退出时返回非零状态。保留的 CDP 连接可能在等待迟到资源清理时继续维持进程，因此 `dispose()` 的有界返回不保证进程也已退出；不会为了强制退出而关闭无关外部页面。

调用方可通过全局 CLI 选项 `--popup-policy follow-single` 或 `BrowserOptions.popupPolicy` 开启弹窗跟随，默认仍是 `stay`。激活动作开始后的 250 毫秒窗口内，仅跟随与当前自有 opener 关联的唯一候选弹窗；多个候选、后台来源或迟到弹窗留待显式观察。这种关联不证明点击与弹窗的唯一因果关系。跟随后返回新快照与 `replan_required: true`，停止本批次剩余动作和 Agent 同一轮决定中的后续调用。必须读取 `batch_complete`：`ok: true` 只表示已经执行的动作未失败，仍可能伴随 `batch_complete: false` 和被跳过的动作；不会自动重放它们。

输入前检查 DOM 节点身份和语义，包括在可操作性预检等待之后再次检查。页面脚本仍能在检查与输入之间改变 DOM，因此不构成原子保证；预检也可能滚动页面。`tab_verify` 只证明所选断言，与点击是否完成分开判断。

值验收支持 CSS 选择器，或附带当前快照 ID 的 ref。引用读取在观察前后检查节点身份和文档版本；其他检查结束等待后，再次读取 ref 值以撤销过期证据，这次读取不能把超时断言改判成功。操作消耗了当前快照但没有生成替代快照时，该快照仍可用于只读验收；被替换的快照无效。文字检查不包含表单原始值。页面脚本仍可能在检查后改变状态，因此验收不构成事务，也不保证值以后保持不变。

### 浏览器模式

| 模式 | 行为 |
| --- | --- |
| 管理的 Chromium | `setup` 安装与锁定 Playwright 版本匹配的浏览器；服务启动不会自动下载。 |
| `--channel chrome` | 选择本机 Chrome 并启动独立浏览器资源，不接管日常已登录标签页。 |
| `--cdp-url` | 显式连接既有 Chromium 端点，在默认上下文内创建自有页面，共享该 profile 的登录状态和存储。 |
| `--profile-dir` | 可选[自有持久 profile](PROFILES.md)：目录有私有标记，重开时必须核对 ID，且拒绝并发占用。浏览器管理的状态可跨重启保存，会话、引用和 Agent 进度不会保留。 |

CDP 清理只关闭自有页面并断开连接，不主动关闭无关标签页或终止外部 Chrome；该方式使用 Playwright 保真度较低的连接路径。`doctor` 检查配置及程序是否存在，不执行真实浏览器启动或 CDP 连接。

自有持久 profile 不能与外部 CDP、工作区/存储导入、CLI 检查点/恢复或文档导航策略组合。profile ID 仅绑定目录，不证明网站当前账户或租户；敏感写入前仍需验证身份。目录包含凭据，Tablaze 不加密它。

### 返回结果、数据与当前限制

工具同时返回 JSON 文字和 `structuredContent`，失败操作设置 `isError`；SDK 参数校验错误使用 SDK 格式。`tab_capture` 返回 JPEG 元数据和 MCP image block。服务不提供通用 JavaScript 执行工具。

`tab_pdf` 将整个活动标签页打印为本地 PDF，不只输出选中的子 frame。可选 A4/Letter、横向及背景，返回路径、大小、SHA-256、URL 和标签页身份。产物上限 50 MiB；超过配置的单步超时会关闭自有标签页并返回 `PDF_TIMEOUT`。打印布局可能与截图不同。

[`tab_extract_structured`](EXTRACTION.md) 对已观察的 frame 应用显式字段映射与 JSON Schema。引用包含 frame URL、选择器、匹配序号和实际读取的原始值。最多 30 个字段、每字段 20 个匹配、总计 100 个元素；类型、schema、隐藏字段和截断错误均显式返回。独立于模型厂商的提取 API 为每个已填充叶值检查绑定来源中的引用文字。schema 合法与引用存在能说明来源，不能证明来源真实或所有解释正确。

快照省略 password/hidden input 的值，字段值检查拒绝这些输入。其他字段、页面文字、URL、提取内容、截图和 PDF 仍可能包含私人信息，具体见[安全边界与报告方式](SECURITY.md)。

当前范围为 Chromium、普通 DOM 控件、开放 Shadow DOM 和显式选择的 frame；精简快照不是完整无障碍树，封闭 Shadow DOM 无法通过 DOM 观察。

| 流程 | 支持行为与边界 |
| --- | --- |
| 弹窗与对话框 | 自有弹窗通过 `tab_tabs` 保留并切换。触发原生对话框前，先用 `tab_dialog` 设置响应。 |
| 上传 | `upload` 向已观察的可见文件输入设置文件；`upload_chooser` 点击已观察的可见按钮并处理其文件选择器，可用于按钮背后的隐藏 input。两者均要求显式本地路径，最多 20 个普通文件，每个最多 50 MiB。 |
| 拖放与滚动 | `drag` 使用源 `ref` 和 `target_ref`，滚动后两者中心必须都位于视口内。`scroll` 支持上、下、左、右，可通过已观察的 `ref` 指定容器；省略时滚动选中 frame 的窗口。需要检查实际滚动或放置结果。 |
| 坐标 | `click_xy` 使用主视口 CSS 坐标操作已通过截图观察的内容，不具备 DOM 目标身份保证。 |
| 下载与状态 | 完成的下载保留为私有临时产物。`tab_state` 导出 cookies、localStorage 和 IndexedDB 供 `tab_open` 显式导入，不保存 sessionStorage、扩展和标签页。 |

### 类型化自定义工具与执行上下文

SDK 的 [`defineTool` 与 `createToolRegistry`](https://github.com/SweetDianDian/tablaze/blob/main/docs/CUSTOM_TOOLS.md) 将类型化业务操作与基础 MCP 客户端组合。自定义工具声明版本、Zod 对象输入/输出、公有 JSON Schema 和可信读写分类。租户凭据及其他执行上下文由应用独立于模型参数提供，规划器只接收公有工具合同。处理函数仍可能在返回值或日志中泄露数据，因此这不是通用输出脱敏机制。

注册表在每次规划前刷新可用工具；`allowedOrigins` 按包含端口的精确 HTTP(S) origin 过滤自定义工具，不约束所有浏览器网络请求，也不提供通用域名或文件策略。浏览器 guard 绑定自有活动主文档、当前位置、导航版本与标签页激活历史，不授予跨域子 frame 权限。规划结束与真正调用处理函数前均重新检查。仅供执行器使用的 `contextKey` 还会检测两次目录之间的变化，包括切走再切回，防止旧引用与验收证据无声进入新上下文。

成功 `tab_close` 明确确认同一会话 `closed: true` 时，该会话当时有效的验收可以在仅上下文变化后保留。其他相关证据被清除，任何后续修改仍使保留证据失效。任意 DOM 改动及外部写入与这些检查并非原子事务；处理函数在等待后、提交前应重查 `execution.assertCurrent()` 并使用已捕获的目标和凭据，幂等与并发写条件仍由业务服务落实。

无效输入或处理函数开始前的 guard 拒绝返回 `not_started`。写处理函数一旦进入，异常、无效输出或未知结果均需要核对；取消不能撤回已被接受的副作用。调用共享 Agent 取消与预算，不自动重放。每轮目录用后关闭，已结束或取消的调用上下文不能重新生效。自定义工具成功仍须经过浏览器验收与应用完成策略。

### 检查点与恢复

库的 `exportWorkspace` / `restoreWorkspace` 与 CLI 的 `run --checkpoint` / `run --resume` 保存部分存储、自有标签页 URL 和活动标签页。恢复要求新的空引擎并使用隔离模式；会分配新的 session ID，重新创建页面并加载 URL。它不恢复实时 DOM、表单草稿、JavaScript 内存、sessionStorage、滚动位置、扩展、待完成下载或进行中的事务。重新访问保存的 URL 本身也可能触发网站逻辑，不支持向 CDP 导入工作区。旧元素 ref 和验收证据全部失效，恢复后必须重新观察与验收。

workspace 也保存弹窗策略；没有该字段的旧版本 1 文件恢复为 `stay`。CLI 拒绝在恢复时明确指定冲突策略。Agent 检查点版本 3 记录可选初始化与绑定注册表的执行身份；严格有效的版本 1/2 文件迁移为未绑定记录，版本 1 没有初始化，版本 2 保留原有初始化。`run --start-url` 只在首次模型决定前打开调用方明确提供的 HTTP(S) 网址，走同一工具执行与记录链，消耗工具和时间预算而不增加模型规划步数。已经尝试的初始化在恢复时不会自动重放，即使已经核对未决结果；已有任务也不能追加或改变起始网址。

绑定注册表的检查点保存完整基础/自定义合同的 SHA-256 摘要，覆盖版本、schema、读写分类、origin 策略，以及可信主体/租户/策略标识的摘要。准备目录或规划前必须匹配，reconciliation 不能豁免不匹配。未决调用的读写分类按完整可信元数据核对，包括当前不可见工具。应用必须通过 SDK 重建注册表；普通 CLI 在恢复浏览器前拒绝绑定检查点，旧未绑定任务也不能在恢复时增加注册表。摘要检查连续性，不验证文件真实性或任意处理函数代码变化。瞬时浏览器 contextKey 不持久化，恢复后重新取得 guard 与证据。

结果未知的修改操作会阻止自动继续。CLI 在启动浏览器或模型前返回 `needs_input`，除非操作者核对实际业务状态后通过 `--reconciled` 提供说明；库调用方使用 reconciliation 选项。说明本身不证明业务成功，也不授权重新执行未决提交。标记为需要 `validateCompletion` 的检查点必须通过库恢复并再次提供应用验收策略；CLI 无法恢复可执行的应用代码。

步骤数、工具调用数、规划调用数和已消耗运行时间累计保留，默认继续使用保存的预算；进程停止期间不计时。库最终返回的检查点包含最后一次持久化回调的等待时间。CLI 写入磁盘的 elapsed time 包含保存前导出浏览器状态的耗时，但尚未包含最后原子写入本身的耗时，因此不是全部持久化墙钟时间的精确计量。

CLI 检查点 JSON 包含完整 Agent 历史和浏览器存储，通过权限为 `0600` 的临时文件与原子重命名保存。它是敏感明文，不是加密的浏览器备份。参见 [Agent 配置与恢复](AGENT.md)及[检查点安全边界](SECURITY.md#checkpoints-and-recovery--检查点与恢复)。

[完整参数与排错](CODEX.zh-CN.md) · [安装本地包](CODEX.zh-CN.md#1-构建与选择浏览器) · [发布归档](https://github.com/SweetDianDian/tablaze/blob/main/docs/RELEASE.md) · [基准范围](https://github.com/SweetDianDian/tablaze/blob/main/bench/README.md)

## Development additions / 当前开发分支

`tab_snapshot.selector` selects exactly one root in the chosen frame. `viewport_only` filters controls and text to the visible viewport; scroll and observe again to reach later controls on long pages. Diff baselines reset when scope changes. Scope is preserved in a batch's returned snapshot unless its document navigated. Text extraction and verification use whitespace-normalized composed text and exclude raw input/textarea/select contents. A text assertion searches beyond the returned evidence excerpt, up to the 30,000-node scan budget; exhausting the scan without finding the text reports OBSERVATION_TRUNCATED.

`tab_snapshot.selector` 选择当前 frame 内唯一根元素，`viewport_only` 仅观察当前视口，长页面可滚动后继续观察。切换范围会重置增量基线。批次返回快照保留观察范围，文档导航后重置。文字提取与验收使用统一的空白归一化组合树文字，排除 input/textarea/select 原始内容；验收可继续搜索证据摘要之后的文字，最多扫描 30,000 个节点。预算耗尽仍未找到时报告 OBSERVATION_TRUNCATED。

Artifact files are created under the operating system temporary directory with private permissions (0600 for files). They survive session and engine shutdown; move needed downloads/state files to a durable location and delete them when no longer needed. State files contain authentication secrets. Restoring state is supported only in isolated mode, not into an externally attached profile. State export in CDP mode includes the selected shared profile's state.

产物文件位于操作系统临时目录，文件权限为 0600，关闭会话和引擎后保留。需要长期使用时移到持久目录，不再需要时删除。状态文件含身份凭据，仅可导入隔离会话；CDP 导出会包含所连接共享 profile 的状态。
