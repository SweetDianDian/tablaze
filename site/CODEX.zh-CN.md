# 在 Codex 中使用 Tablaze

[English](CODEX.md) · [项目介绍](https://github.com/SweetDianDian/tablaze/blob/main/README.zh-CN.md)

本指南把本地构建的 Tablaze stdio 服务接入 Codex。依据当前源码、本机 `codex-cli 0.154.0` 的帮助输出，以及 2026-09-22 查阅的 OpenAI 官方文档编写。注册命令成功与浏览器实际可用是两回事，最后还需要完成下方的冒烟任务。

当前开发分支默认提供 16 个 MCP 工具；可信操作者添加 `--capture-network` 后增加第十七个[自有页面响应观察工具](NETWORK.md)。已记录的 0.1.0 发布和 Codex 验收证据来自较早构建，不能用于证明所有新增功能；识别构建时应同时核对 checkout 的提交和工具列表。

## 1. 构建与选择浏览器

使用 Node.js 20+，在源码目录执行：

```sh
npm ci
npm run build
node dist/cli.js --help
node -p 'process.execPath'
```

记录最后一条命令输出的 Node 绝对路径，然后选择浏览器模式：

| 模式 | 准备工作 | 服务附加参数 |
| --- | --- | --- |
| 托管 Chromium | `node dist/cli.js setup`，再运行 `node dist/cli.js doctor` | 无 |
| 已安装 Chrome | `node dist/cli.js doctor --channel chrome` | `--channel chrome` |
| 显示独立 Chrome 窗口 | 同上 | `--channel chrome --headed` |
| 已有 CDP 端点 | 在服务之外配置该端点 | `--cdp-url http://127.0.0.1:9222` |

前三种模式创建服务自有的浏览器资源。`--channel chrome` 选择的是程序，不是你日常使用的 profile。默认临时会话相互隔离，状态在多次调用间保留。仅重启服务不会恢复会话，需要显式导出/导入状态，或使用下文的 checkpoint 流程。CDP 属于主动连接模式，详见第 7 节。

`doctor` 输出 JSON，不启动浏览器。`ready: true` 只表示找到可执行文件，不代表真实导航已经通过。CDP 模式的 `ready` 是 `null`，因为没有尝试连接。`setup` 调用依赖中的官方 Playwright CLI 下载匹配 Chromium；Linux 系统库可能需要另行安装。

收到本地构建的 tarball 时，可安装到指定目录：

```sh
npm install --prefix "/absolute/path/to/tablaze-install" "/absolute/path/to/tablaze-0.1.0.tgz"
node "/absolute/path/to/tablaze-install/node_modules/tablaze/dist/cli.js" doctor --channel chrome
```

后面的配置应使用安装后的脚本路径。tarball 也包含源码与 fixture，方便检查；完整复现请使用带有 lockfile 的源码目录。本预览版尚无公开 registry 安装命令。

## 2. 注册 stdio 命令

替换所有 `/absolute/path/...` 占位符。带空格的路径在 shell 中必须加引号，在 TOML 数组中必须保持为一个字符串。

```sh
codex mcp add tablaze -- "/absolute/path/to/node" "/absolute/path/to/tablaze/dist/cli.js" --channel chrome
codex mcp get tablaze
codex mcp list
```

以上格式已用本机 `codex mcp --help`、`codex mcp add --help` 和 `codex mcp get --help` 核对。Tablaze 使用 stdio，不使用 `--url` 作为 MCP 传输方式，也不需要 MCP OAuth 登录或模型 API Key。

也可以在 Codex 的用户 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml` 中添加配置。CLI 已经写入同名表时，应修改原表，不能重复添加。[官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```toml
[mcp_servers.tablaze]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/tablaze/dist/cli.js", "--channel", "chrome"]
cwd = "/absolute/path/to/tablaze"
startup_timeout_sec = 20
tool_timeout_sec = 75
enabled = true
```

使用托管 Chromium 时，删除 `args` 的最后两项。`startup_timeout_sec` 控制服务初始化等待；浏览器在首次需要它的工具调用中才启动。建议的 `tool_timeout_sec = 75` 为最长 60 秒批次留出返回结果的余量；这是客户端设置，与 Tablaze 的内部预算分开。[OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

在桌面客户端的 MCP 设置中添加时，选择 STDIO，填写同样的 Node 程序和参数。修改命令后重新加载服务或重启客户端。在 Codex 终端界面可用 `/mcp` 查看活动服务；界面名称可能随版本变化。[官方连接说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## 3. 验证连接

向 Codex 发送：

> 这次浏览器任务只使用 Tablaze。先列出会话，再打开 https://example.com，读取标题和链接，验证标题包含“Example Domain”，然后关闭会话。报告实际观察到的 URL 和验收结果；工具失败时给出错误代码。

预期顺序是 `tab_list` → `tab_open` → `tab_extract` → `tab_verify` → `tab_close`。空会话列表正常。仅添加配置不算浏览器验证；指定检查的 `passed` 才是对应证据。

在这里的 MCP 接入方式中，Codex 决定下一次工具调用，Tablaze 通过 Playwright 执行。MCP 启动不调用模型，也不需要模型 API Key。另一个可选入口 `tablaze run` 使用显式配置的模型适配器，见 [Agent 指南](https://github.com/SweetDianDian/tablaze/blob/main/docs/AGENT.md)。

## 4. 先理解三个标识

`tab_open` 返回 `session_id`、`snapshot_id` 和 `elements[].ref`。应一起保存；下面的占位符必须替换为真实响应值。

1. 新快照替代旧版本，旧 `snapshot_id` 失效。
2. 每个批次消耗其版本。下一批使用返回的 `snapshot.snapshot_id`；关闭 `include_snapshot` 时必须手动重观察。
3. 输入前以及可操作性等待后都会复查节点身份与含义；节点替换、目标改变和导航需要重新观察。
4. 不要混用其他会话或 frame 观察结果里的引用。观察子 frame 时使用 `frames` 给出的 `frame_id`。
5. 增量结果包含 `baseline_snapshot_id`、`added`、`changed`、`removed`，范围是预算内返回的元素。没有基线时请求 `mode: "full"`。

同一批次中，只要原文档和目标含义未变，就可以继续使用已有引用。导航或出现新控件后，应拆开工作流，先拿新快照再操作新页面。

## 5. 工具调用例子

以下 JSON 是对应 MCP 工具的**参数**，不是 shell 命令，也不是某次真实执行记录。

**`tab_open`**：只接受 HTTP(S)，拒绝在 URL 中嵌入用户名和密码。

```json
{"url":"https://example.com"}
```

**`tab_snapshot`**：默认全量、150 个元素、6,000 个文字字符和主 frame。上限是 500 个元素、20,000 个字符；`text_limit: 0` 可关闭文字摘要。

```json
{"session_id":"<session_id>","mode":"full","max_elements":100,"text_limit":4000}
```

观察子 frame 时增加 `"frame_id":"<frame_id_from_frames>"`。必须读取 `truncated`、`truncation` 和 `budgets`；被截断快照中没有出现某元素，不等于网页中不存在。

**`tab_act`**：下面的 refs 应来自已经打开并观察过的表单。

```json
{
  "session_id":"<session_id>",
  "snapshot_id":"<snapshot_id>",
  "actions":[
    {"type":"fill","ref":"<destination_ref>","value":"Lisbon"},
    {"type":"select","ref":"<nights_ref>","values":["3"]},
    {"type":"check","ref":"<checkbox_ref>","checked":true},
    {"type":"click","ref":"<search_button_ref>"}
  ],
  "include_snapshot":true,
  "timeout_ms":30000
}
```

其他操作格式：

```json
[
  {"type":"press","ref":"<input_ref>","key":"Enter"},
  {"type":"scroll","direction":"down","pixels":600},
  {"type":"wait","text":"Results","timeout_ms":5000}
]
```

`select.values` 填 option 的 value，不是显示名称；原生 select 的快照包含有界 `options` 列表。填写值最多 10,000 个字符；每次 1–20 个操作。同一会话内串行执行，不同会话可以独立推进。

**`tab_extract`**：`kind` 可为 `text`、`links` 或 `table`；选择器应匹配唯一根元素，作用于最近观察的 frame。

```json
{"session_id":"<session_id>","kind":"links","selector":"body","max_items":50}
```

表格示例为 `{"session_id":"<session_id>","kind":"table","selector":"#results-table","max_items":30}`。项目数量为 1–500，文字预算 20,000 字符；检查 `truncated`。

**`tab_verify`**：URL 必须完全相等；标题和文字使用包含匹配；`value` 与 `count` 精确比较。visible 仅表示可见，不保证未被其他元素遮挡。

```json
{
  "session_id":"<session_id>",
  "checks":[
    {"kind":"url","value":"https://example.com/"},
    {"kind":"title","contains":"Example Domain"},
    {"kind":"text","contains":"Example Domain"},
    {"kind":"visible","selector":"h1"},
    {"kind":"count","selector":"h1","value":1}
  ],
  "timeout_ms":5000
}
```

已经观察到的表单控件可用 `{"kind":"value","ref":"r3","value":"Lisbon"}` 验收，并在 `session_id` 旁传入对应的 `snapshot_id`。操作已返回新快照时，直接使用其中的引用。每项值检查必须在 `ref` 和 CSS `selector` 中二选一；原有 `{"kind":"value","selector":"#destination","value":"Lisbon"}` 格式继续有效。页面文字验收不包含 input、textarea 和 select 的原始值：控件使用 value 检查，保存提示等文案使用 text 检查。节点被替换、身份变化或文档过期时，旧引用会被拒绝。

每次 1–20 项。验收失败返回 `passed: false` 和 `isError: true`；按 `index` 查看各项的 `pass` 与 `actual`。password 和 hidden input 的值不会返回或参与值验收。

**`tab_capture`**：默认截取视口，返回 image block、URL、MIME 类型和字节数。

```json
{"session_id":"<session_id>","full_page":false}
```

当前使用 JPEG；整页超过 3,200 万像素或编码图片超过 4 MiB 时拒绝。截图可能包含私人页面内容。

**`tab_list`**：无参数，列出本服务会话，不枚举日常浏览器中的无关标签页。

```json
{}
```

**`tab_close`**：关闭自有会话并使其标识失效。

```json
{"session_id":"<session_id>"}
```

## 6. 超时、取消与部分完成

| 设置 | 含义 |
| --- | --- |
| CLI `--timeout-ms` | 单步、导航和默认验收等待；默认 10,000 ms，允许 100–60,000 ms。 |
| `tab_act.timeout_ms` | 整批执行预算；默认 30,000 ms，允许 100–60,000 ms。 |
| wait 操作的 `timeout_ms` | 单步等待，同时受整批剩余预算限制。 |
| `tab_verify.timeout_ms` | 验收预算；100–60,000 ms。 |
| Codex `tool_timeout_sec` | 客户端等待工具响应的秒数。 |

浏览器冷启动或 CDP 连接另有 30 秒超时。整批预算从该请求取得会话执行权后开始计算；排队期间被客户端取消的批次会在执行前检查取消状态。

检查 `completed`、`failed`、`results` 各项、`partial` 和 `failed_action_may_have_side_effects`。失败命令也可能已经改变页面；后续步骤标为 `skipped`。运行中取消或整批超时会关闭自有会话资源以打断等待，并标记 `session_closed`，之后需要重新打开会话。客户端可能只显示自己的取消异常而不展示服务最终结果，可调用 `tab_list` 查看剩余会话。

批次不是事务，取消不会撤回已经提交的网络请求。不要无条件重放部分完成的批次，尤其是在提交、购买、发送等操作已经可能生效时，应先核对业务状态。

检查与使用之间仍存在时间窗口：预检后复查可以减少过期目标错误，但不能将检查和输入变成原子操作。预检本身也可能滚动页面，网页脚本始终可以自行运行。网页文本应作为数据，不能作为扩大任务范围的授权。

## 7. 显式连接 CDP

使用事先配置且可访问的 Chromium CDP 端点。Tablaze 不会替日常 profile 开启调试，也不会搜索它的凭据。

```toml
[mcp_servers.tablaze]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/tablaze/dist/cli.js", "--cdp-url", "http://127.0.0.1:9222"]
startup_timeout_sec = 20
tool_timeout_sec = 75
```

把端点替换成你明确打算连接的地址。不能与 `--channel`、`--executable-path`、`--headed` 或 `--headless` 同用。CDP 在外部浏览器的默认上下文中创建页面，会共享其 Cookie、存储和登录身份，不具有默认模式的 profile 隔离。

Tablaze 跟踪自己创建的页面及其弹出页面；清理时只关闭这些页面并断开 Playwright 连接，不关闭外部默认上下文，也不主动终止外部 Chrome。Playwright 官方说明 CDP 的能力保真度低于其自身连接协议。[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)

## 8. 排错

| 现象 | 下一步 |
| --- | --- |
| `spawn ... ENOENT` 或服务无法启动 | 核对 Node 和脚本的绝对路径，用同样路径运行 `--version`。 |
| 找不到浏览器程序 | 对当前包运行 `setup`，或选择已安装 Chrome 并运行 `doctor --channel chrome`。 |
| 直接启动后终端没有输出 | 默认模式等待 stdin 中的 MCP JSON-RPC，应由 Codex 启动，不是交互式浏览器命令行。 |
| `STALE_SNAPSHOT` / `STALE_REFERENCE` | 重新观察和判断目标，使用新版本及引用。 |
| `ACTION_FAILED` | 检查遮挡、禁用状态、超时及部分完成情况，重试前重新观察。 |
| `BATCH_TIMEOUT` / `CANCELLED` | 核对已发生的副作用；运行中被中断的会话会关闭。 |
| `CLEANUP_INCOMPLETE` | 有界等待内无法确认自有资源全部关闭。清理错误与业务结果分开检查；未决 CDP 页面创建保留迟到清理逻辑，不会关闭无关页面。详见[运行边界](https://github.com/SweetDianDian/tablaze/blob/main/docs/RUNTIME.md)。 |
| `SELECTOR_COUNT` | 缩小到唯一根元素；结构化字段确实需要数组时可设置 `multiple: true`。 |
| `FRAME_NOT_FOUND` | 刷新 frames 列表，不重用已分离的 frame。 |
| `SENSITIVE_VALUE` | 对 password/hidden input 改用独立可见结果验收。 |
| `CAPTURE_TOO_LARGE` | 改用视口截图，或缩小要导出为 PDF 的页面。 |
| `PDF_TIMEOUT` | 导出超时会关闭自有标签页；继续前先检查剩余标签页。 |
| `SCHEMA_MISMATCH` / `TYPE_CONVERSION` | 核对字段计划与 schema；系统不会静默转换或补造值。 |
| `TRUNCATED_FIELD` / `EXTRACTION_LIMIT` | 缩小选择器范围或拆分提取。 |
| `UNSUPPORTED_FLOW` | 查看具体流程；原生对话框应提前调用 `tab_dialog`，重试前检查可能已发生的副作用。自有弹窗和下载有对应工具。 |
| CDP 连接失败 | 在服务之外检查端点；错误信息有意省略端点详情。 |

当前源码支持显式上传下载、自有弹窗、预设响应的原生对话框和视口坐标点击。封闭 Shadow DOM 仍不属于 DOM 观察范围，没有通用 eval 工具或完整的持久磁盘 profile。显式 workspace 恢复重建所保存的浏览器状态和 URL，不恢复正在运行的页面内存。快照角色和名称是精简 DOM 元数据，不是完整无障碍实现。具体边界见 [SECURITY.md](SECURITY.md)。

`codex mcp remove tablaze` 移除配置中的服务条目，不会卸载源码或 tarball 安装目录。

## 非交互 CLI 的审批行为

实际 `codex exec` 检查已连接 Tablaze，并成功调用 `tab_list`；但默认非交互审批策略拒绝了 `tab_open`，返回 `MCP tool call requires approval, but approval policy is never`。这是客户端的授权决定，不是浏览器启动失败。`tab_open`、`tab_act` 应继续标为写工具。可使用交互客户端的正常批准流程，或对明确受控的任务选择文档支持的审批审查模式；不要把写工具伪装为只读，也不要关闭审批来得到表面通过的结果。

需要检查实际工具事件和最终任务结果：这次 CLI 虽然以零退出，浏览器任务仍明确报告失败。仅凭进程退出码不能认定任务完成。

随后使用本机 CLI 支持的临时审批设置完成了一次真实模型验收：`tab_list → tab_open → tab_act → tab_verify → tab_close → tab_list`，四步表单操作、五项结果检查全部成功，最终会话数为零。文件系统仍使用 `--sandbox read-only`，调用级设置为 `-c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"'`，没有修改全局配置或关闭审批。这些设置仅说明已验证的受控本机任务；使用前应确认当前客户端支持该模式及任务授权范围。[官方 Auto-review 文档](https://learn.chatgpt.com/docs/sandboxing/auto-review)

[实际工具调用记录](evidence/codex-e2e.json) 保留参数、结果和验证边界。模型连接曾超时后自动回退，因此 233.936 秒总耗时不用于速度宣传。此次结果只证明一个本地固定页面流程；JSONL 未提供逐项审批理由，不能据此推断全部客户端版本或外部网站上的行为。

## 当前开发分支：复杂工作流

下列功能尚未包含在已记录的 0.1.0 发布证据中。服务现在提供 16 个工具：`tab_open`、`tab_snapshot`、`tab_find`、`tab_act`、`tab_extract`、`tab_verify`、`tab_capture`、`tab_list`、`tab_close`、`tab_navigate`、`tab_tabs`、`tab_downloads`、`tab_dialog`、`tab_state`、`tab_pdf`、`tab_extract_structured`。

长页面被截断时，用唯一容器 `selector` 定向观察，或滚动后用 `viewport_only` 读取当前视口。不同范围的增量基线会重置；新的 snapshot_id 会使旧快照失效。

虚拟列表可调用 `tab_find`，传入目标文字、已观察的纵向滚动容器 `container_ref` 和当前 `snapshot_id`。它只在指定 frame 查找，默认最多滚动 40 次（最高 100 次）；找到后返回新的视口快照，应使用其中的 ref 继续操作。`found:false` 且 `limit_reached:true` 仅表示达到本次搜索上限，不代表应用中没有该项。查找会改变滚动位置，但不会点击或提交。

```json
{"session_id":"<session_id>","selector":"#results","viewport_only":true,"max_elements":150}
```

快照会列出当前 `tab_id` 和自有 `tabs`。默认不自动切换弹窗，可先观察列表再显式切换。全局选项 `--popup-policy follow-single` 可在激活动作的有界窗口内，跟随与当前自有 opener 关联的唯一弹窗；多个、后台或迟到的候选仍需显式观察。跟随后返回新快照和 `replan_required`，跳过剩余旧上下文动作。除 `ok` 外还应检查 `batch_complete`，具体关联规则见[运行机制](https://github.com/SweetDianDian/tablaze/blob/main/docs/RUNTIME.md)。

```json
{"session_id":"<session_id>","action":"switch","tab_id":"<tab_id_from_tabs>"}
```

上述参数用于 `tab_tabs`；其他 action 为 `list`、`new`（可带 HTTP(S) url）、`close`（带 tab_id）。`tab_navigate` 使用 `goto`（需要 url）、`back`、`forward`、`reload`，保留同一会话的存储。关闭最后一个标签页即关闭会话。CDP 模式只管理服务创建的页面及其弹窗。

新增 `tab_act` 步骤：

```json
[
  {"type":"hover","ref":"<current_ref>"},
  {"type":"double_click","ref":"<current_ref>"},
  {"type":"upload","ref":"<visible_file_input_ref>","files":["/absolute/path/report.csv"]},
  {"type":"upload_chooser","ref":"<visible_choose_file_button_ref>","files":["/absolute/path/report.csv"]},
  {"type":"drag","ref":"<source_ref>","target_ref":"<destination_ref>"},
  {"type":"scroll","direction":"right","pixels":500,"ref":"<scroll_container_ref>"}
]
```

上传最多 20 个显式本地常规文件，每个不超过 50 MiB；空数组清空选择。可见文件输入框使用 `upload`；由可见按钮触发隐藏 input 的文件选择流程使用 `upload_chooser`，ref 指向已观察到的按钮，工具等待页面的 file-chooser 事件后设置文件。上传会把文件字节交给页面，路径应属于用户授权的任务范围。

`drag` 在两个当前引用之间执行鼠标拖动；滚动调整后，两者中心都必须在视口内，否则返回 `NOT_VISIBLE`。这不保证兼容所有自定义拖拽组件。`scroll` 支持 `up`、`down`、`left`、`right`：不传 ref 时滚动当前观察 frame 的窗口，传入当前容器 ref 时滚动该元素。pixels 为 1–10,000，操作后应检查真实状态，不能仅凭请求已完成认定内容移动。

截图观察后，可用 `{"type":"click_xy","x":120,"y":160}` 操作主标签页视口，仍需当前 snapshot_id。坐标为 CSS 像素，必须在视口内；此操作没有元素 ref 的 DOM 身份校验，页面变化后需要重新观察。跨 frame 的坐标推导由调用方负责，坐标操作前必须观察主 frame。

下载后调用 `tab_downloads`：先传 session_id 列出记录，再传 download_id 和可选 timeout_ms 等待。只有 `status: "completed"` 才有可用 path，pending 不代表成功。下载文件在关闭后保留；正在进行的下载会在清理时取消。

原生对话框需在触发前调用 `tab_dialog`，设置下一次响应：

```json
{"session_id":"<session_id>","action":"accept","prompt_text":"Requested answer"}
```

响应仅使用一次，action 可选 accept/dismiss。没有预设响应的对话框默认取消，批次报告失败与可能的副作用。

使用 `tab_state`（参数 session_id）得到私有 `storage_state` 文件路径，再在 `tab_open` 传入同名字段恢复 cookies、localStorage、IndexedDB。文件含身份凭据；仅支持向隔离上下文导入，不保存 sessionStorage、扩展或现有标签页。

`tab_pdf` 把活动标签页打印为本地 PDF，不是仅导出当前观察的子 frame。参数支持 `format: "A4" | "Letter"` 和 `landscape`，返回路径、字节数、SHA-256、MIME 类型、来源 URL 和 tab ID。超过 50 MiB 时拒绝；使用普通操作超时，导出超时会关闭自有标签页。打印样式可能不同于屏幕显示，需要关注排版时应检查产物。

```json
{"session_id":"<session_id>","format":"A4","landscape":false}
```

`tab_extract_structured` 按命名字段计划读取内容，并用 JSON Schema draft-07 校验输出。每个值附带来源 URL、选择器、匹配序号和转换前原文。支持文字、属性、当前非敏感表单值、带类型的标量和数组；最多 30 个字段，每字段 20 个匹配，总计 100 个。缺少必填字段、敏感值、类型不符或证据截断都会报错。完整示例和依据边界见[结构化提取指南](https://github.com/SweetDianDian/tablaze/blob/main/docs/EXTRACTION.md)；引用原文存在不等于已经证明事实真实。

## 为 `run` 选择规划器

`run` 是可选的独立 Agent 循环。每个提供方都必须显式传入 `--model`；Tablaze 不选择模型，也不会悄悄替换它。为了兼容旧命令，提供方默认是 `openai-compatible`。

| `--provider` | 端点与认证 | 提供方参数 |
| --- | --- | --- |
| `openai-compatible`（默认） | 必须提供完整 chat-completions 路由的 `--endpoint`；可从 `TABLAZE_API_KEY` 或 `--api-key-env` 指定变量读取凭据。 | 端点必须支持函数工具调用。 |
| `codex` | 使用本机 Codex CLI 和已有登录；无需 Tablaze 端点或 API Key 参数。 | `--codex-command` 指定可执行程序，默认 `codex`；可指定 `--reasoning-effort`。 |
| `anthropic` | 默认 `https://api.anthropic.com/v1/messages`；可用 `--endpoint` 指向兼容代理。服务所需凭据从 `TABLAZE_API_KEY` 读取，也可用 `--api-key-env` 选择变量。 | `--max-output-tokens` 对应 `max_tokens`，默认 4096。 |
| `ollama` | 默认 `http://localhost:11434/api/chat`；可用 `--endpoint` 指向另一服务。若配置凭据，则作为 Bearer token 发送。 | 可选 `--max-output-tokens` 对应 `options.num_predict`；默认不发送。 |

Codex 尚未登录时先执行 `codex login`，通过 `codex login status` 检查当前认证方式。Tablaze 复用 CLI 认证，不复制登录文件或配置模型接口；账号权限、用量额度和可能的计费遵循当前 Codex 认证。[官方认证说明](https://learn.chatgpt.com/docs/auth)

```sh
node dist/cli.js run --provider codex --model "<你的Codex模型>" --task "<已授权的任务>" --start-url "https://<你的网站>/" --channel chrome
node dist/cli.js run --provider anthropic --model "<你的Anthropic模型>" --api-key-env ANTHROPIC_API_KEY --max-output-tokens 4096 --task "<已授权的任务>" --channel chrome
node dist/cli.js run --provider ollama --model "<本机已安装的模型>" --task "<已授权的任务>" --channel chrome
```

Codex 推理参数接受 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`，具体支持取决于你明确选定的模型和 CLI；不传时保留 Codex 的设置。其他提供方不能使用 `--codex-command` 或 `--reasoning-effort`；Codex 不能使用 `--endpoint`、`--api-key-env`、`--max-output-tokens`。输出 token 参数仅用于 Anthropic 和 Ollama，本地范围为 1–1,000,000，服务可以执行更小的模型上限。响应字节上限不等于 token 预算；工具和图片支持也取决于模型。

`model_usage` 仅记录提供方实际报告的计数，缺失的计数保持缺失，不推算货币费用。Codex 另返回固定的 `provider_diagnostics` 字段，包括退出状态、终态事件、错误通知数量和耗时，不包含原始 stderr 或提供方错误文本。CLI 会等待 Codex 子进程清理后再输出报告，以记录取消期间实际返回的用量。各提供方沿用相同任务预算、取消、验收和清理规则。Codex 规划会调用本机可执行程序，但不会把任意 CLI 能力作为 Tablaze 浏览器工具开放。

## 保存任务与恢复浏览器

首次执行可指定 `run --start-url <HTTP(S)网址>`，在第一轮模型规划前打开这个明确网址，不从页面或工具内容猜测入口。导航使用同一工具执行链，计入调用和时间预算；恢复不会自动重复已经尝试的初始化，也不能给已有任务追加或更换起始网址。当前 Agent 检查点保存该状态，并支持迁移有效的旧格式。workspace 同时保存弹窗策略，旧文件没有策略字段时使用 `stay`；恢复时明确指定不同策略会被拒绝。

可选自主任务循环在 [Agent 指南](https://github.com/SweetDianDian/tablaze/blob/main/docs/AGENT.md) 中单独配置，与 MCP 模式分开。下面使用默认兼容提供方创建和恢复私有 checkpoint，凭据通过配置的环境变量提供；使用其他提供方时，每次调用都显式传入上文相应的 provider/model 参数：

```sh
node dist/cli.js run --task "<已授权的任务>" --model "<model-id>" --endpoint "https://<provider>/v1/chat/completions" --channel chrome --checkpoint "/absolute/path/private-run.json"
node dist/cli.js run --resume "/absolute/path/private-run.json" --model "<model-id>" --endpoint "https://<provider>/v1/chat/completions" --channel chrome
```

CLI 先写入权限为 0600 的临时文件，再原子重命名到 checkpoint 路径。文件包含完整任务历史和浏览器 cookies、localStorage、IndexedDB，应作为敏感文件保存。库接口 `exportWorkspace()`/`restoreWorkspace()` 及 CLI 恢复会重建隔离上下文、自有标签页 URL 和活动标签页，并分配新的会话标识；不会恢复实时 DOM、未保存表单、sessionStorage、页面 JavaScript 内存、滚动位置、扩展、未完成下载或进行中的事务。恢复 URL 会重新加载网页。旧 ref 和验收证据失效，必须重新观察与验收。workspace 导入要求新的空引擎，不能导入 CDP 外接 profile。

上次修改的结果不确定时，恢复在启动浏览器和模型前返回 `needs_input`。先核对真实业务结果，再显式传入 `--reconciled "<核对方式及观察结果>"`。这个操作员确认既不证明任务完成，也不要求重放提交。库调用方使用 `reconciliation`；若 checkpoint 要求应用的 `validateCompletion` 函数，必须通过库接口重新提供该函数，CLI 不能恢复可执行应用策略。

恢复沿用规划步数、工具调用数、模型规划调用数和已用时间；默认沿用原预算，进程停机时间不计入。库返回的 checkpoint 计入最终持久化等待；CLI 磁盘文件中的已用时间计入写入前的浏览器状态导出，但尚未包含最后一次原子文件写入本身的耗时，因此不是对最后这段 I/O 的精确计时。详见[运行机制](https://github.com/SweetDianDian/tablaze/blob/main/docs/RUNTIME.md)与[checkpoint 安全边界](SECURITY.md)。
