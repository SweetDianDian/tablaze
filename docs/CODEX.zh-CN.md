# 在 Codex 中使用 Tablaze

[English](CODEX.md) · [项目介绍](../README.zh-CN.md)

本指南把本地构建的 Tablaze stdio 服务接入 Codex。依据当前源码、本机 `codex-cli 0.154.0` 的帮助输出，以及 2026-09-22 查阅的 OpenAI 官方文档编写。注册命令成功与浏览器实际可用是两回事，最后还需要完成下方的冒烟任务。

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

前三种模式创建服务自有的浏览器资源。`--channel chrome` 选择的是程序，不是你日常使用的 profile。默认会话相互隔离，状态在多次调用间保留，但不会跨服务重启保存。CDP 属于主动连接模式，详见第 7 节。

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

Tablaze 内部没有模型客户端。Codex 决定调用什么工具，Tablaze 通过 Playwright 执行。无需 TypeSafe/Jev Key，本版也没有集成 Jev。

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

表单值检查格式为 `{"kind":"value","selector":"#destination","value":"Lisbon"}`。每次 1–20 项。验收失败返回 `passed: false` 和 `isError: true`；按 `index` 查看各项的 `pass` 与 `actual`。password 和 hidden input 的值不会返回或参与值验收。

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
| `SELECTOR_COUNT` | 缩小提取范围，使选择器匹配唯一根元素。 |
| `FRAME_NOT_FOUND` | 刷新 frames 列表，不重用已分离的 frame。 |
| `SENSITIVE_VALUE` | 对 password/hidden input 改用独立可见结果验收。 |
| `CAPTURE_TOO_LARGE` | 改用视口截图。 |
| `UNSUPPORTED_FLOW` | 对话框、新标签页或下载属于未支持流程。 |
| CDP 连接失败 | 在服务之外检查端点；错误信息有意省略端点详情。 |

本版不提供上传、下载、受支持的新标签页/对话框流程、封闭 Shadow DOM、通用 eval 和持久磁盘 profile；Canvas 控件没有坐标操作。快照的角色与名称是精简 DOM 元数据，不是完整的无障碍实现。脱敏和隔离的具体边界见 [SECURITY.md](../SECURITY.md)。

`codex mcp remove tablaze` 移除配置中的服务条目，不会卸载源码或 tarball 安装目录。

## 非交互 CLI 的审批行为

实际 `codex exec` 检查已连接 Tablaze，并成功调用 `tab_list`；但默认非交互审批策略拒绝了 `tab_open`，返回 `MCP tool call requires approval, but approval policy is never`。这是客户端的授权决定，不是浏览器启动失败。`tab_open`、`tab_act` 应继续标为写工具。可使用交互客户端的正常批准流程，或对明确受控的任务选择文档支持的审批审查模式；不要把写工具伪装为只读，也不要关闭审批来得到表面通过的结果。

需要检查实际工具事件和最终任务结果：这次 CLI 虽然以零退出，浏览器任务仍明确报告失败。仅凭进程退出码不能认定任务完成。

随后使用本机 CLI 支持的临时审批设置完成了一次真实模型验收：`tab_list → tab_open → tab_act → tab_verify → tab_close → tab_list`，四步表单操作、五项结果检查全部成功，最终会话数为零。文件系统仍使用 `--sandbox read-only`，调用级设置为 `-c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"'`，没有修改全局配置或关闭审批。这些设置仅说明已验证的受控本机任务；使用前应确认当前客户端支持该模式及任务授权范围。[官方 Auto-review 文档](https://learn.chatgpt.com/docs/sandboxing/auto-review)

[实际工具调用记录](evidence/codex-e2e.json) 保留参数、结果和验证边界。模型连接曾超时后自动回退，因此 233.936 秒总耗时不用于速度宣传。此次结果只证明一个本地固定页面流程；JSONL 未提供逐项审批理由，不能据此推断全部客户端版本或外部网站上的行为。
