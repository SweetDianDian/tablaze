# Security boundaries / 安全边界

Tablaze is a local browser runtime, not a security sandbox. This document covers the current development branch with 16 MCP tools and an optional Agent runner; the historical 0.1.0 release has an earlier capability set. Its browser can read pages, submit forms, and make network requests with the identity available to its selected browser context. MCP tool annotations describe behavior; they do not themselves enforce user authorization.

Tablaze 是本地浏览器运行时，不是安全沙箱。本页描述当前开发分支的 16 个 MCP 工具与可选 Agent 运行器，历史 0.1.0 发布包覆盖较早的能力范围。浏览器可以读取页面、提交表单，并使用所选上下文的身份发起网络请求。MCP 工具注解只描述行为，本身不执行用户授权控制。

## Isolation and ownership / 隔离与资源归属

Default mode launches a browser controlled by the server and creates separate temporary contexts. Context state lasts while the context is open unless explicitly exported through storage-state or workspace checkpoint APIs. `--channel chrome` chooses a browser binary, not the user's ordinary profile.

Explicit `--cdp-url` mode creates owned pages in an external browser's default context. Login state and storage are shared with that profile. Cleanup closes owned pages and disconnects; it does not deliberately close unrelated tabs or the external browser. Keep the endpoint accessible only to parties you intend to grant browser control. Tablaze does not add CDP authentication or a domain/network allowlist.

默认模式创建独立临时上下文；除非显式导出存储状态或工作区检查点，否则状态只在上下文存续期间保留。`--channel chrome` 仅选择程序。显式 CDP 模式则在外部浏览器默认上下文中创建自有页面，共享其登录状态与存储；清理关闭自有页面并断开连接，不主动关闭无关标签页或浏览器。调试端点意味着浏览器控制权限，Tablaze 不替它增加身份验证，也不提供域名或网络访问白名单。

## Data returned to clients / 返回客户端的数据

Snapshot metadata omits password/hidden input values; explicit value verification rejects those inputs. Errors remove Playwright call logs and redact selected input values and endpoint URLs. CDP connection errors omit the configured endpoint. These are specific protections, not general data-loss prevention.

Other input values, page text, accessible names, URLs (including their query parameters), extracted records, assertion evidence, screenshots and PDF artifacts can contain personal data or credentials rendered by the website. Tool responses are sent to the MCP client, whose model and retention settings apply. An explicitly referenced hidden accessibility label may form part of an accessible name. For [configured scoped credentials](docs/SECRETS.md), known textual forms are redacted and binary artifacts are blocked after a fill by default. Page scripts can transform or send a received secret in ways Tablaze cannot recognize. The MCP server does not call a model provider or require a model API key; the optional Agent runner has a separate, explicitly configured model connection.

快照省略 password/hidden input 的值，值验收拒绝这些输入；错误会移除 Playwright 调用日志并处理部分输入值和端点，CDP 连接错误省略配置地址。这些是具体防护，不是全面的数据防泄漏系统。其他字段值、文字、无障碍名称、带查询参数的 URL、验收证据、截图和 PDF 仍可能含私人信息；工具响应会进入 MCP 客户端。显式引用的隐藏无障碍标签可能构成名称。[定向凭据](docs/SECRETS.md)会遮盖已知文字形式，填写后默认阻止二进制产物；但网页脚本仍可用无法识别的方式转换或发送收到的值。MCP 服务不调用模型或要求模型 API key；可选 Agent 运行器使用独立、显式配置的模型连接。

[`tab_extract_structured` and the source extraction API](docs/EXTRACTION.md) validate schema and provenance within their documented limits. DOM evidence records the actual frame URL, selector and raw value; model extraction validates exact quotes in the supplied sources for each populated leaf. These checks do not authenticate a website, establish that its statements are true, or make page instructions trusted application policy.

[`tab_extract_structured` 与来源提取 API](docs/EXTRACTION.md)在文档规定的范围内检查 schema 与来源。DOM 证据记录实际 frame URL、选择器和原始值；模型提取为每个已填充叶值检查给定来源中的精确引用。这不验证网站身份、不证明网站陈述真实，也不将页面指令变为可信的应用策略。

## Actions and cancellation / 操作与取消

References bind a snapshot revision to observed DOM nodes and semantic metadata. Checks run again after actionability waits, but the page can change between checking and input. This time-of-check/time-of-use window is not eliminated. Trial checks can scroll and trigger page logic. No arbitrary eval tool is exposed, but clicking a website's controls still executes that website's scripts.

Action batches stop at the first error. An active cancellation or total-budget expiry closes the owned session to interrupt pending work and skip later actions. It does not undo earlier submissions or stop network requests already accepted elsewhere. A failed step may have side effects even when it was not counted as completed. Read partial-result fields and verify the business state before retrying.

引用将快照版本与观察到的节点、语义元数据关联，等待后再次检查，但无法消除检查到输入之间的竞态。预检可能滚动并触发逻辑；虽然没有通用 eval 工具，网页控件仍会执行网页脚本。取消和超时关闭自有会话、停止后续操作，但不撤回已经生效的提交或外部请求。失败步骤也可能有副作用，重试前应检查部分完成字段与业务结果。

## Custom tool context / 自定义工具上下文

The [typed custom-tool SDK](docs/CUSTOM_TOOLS.md) treats registered handlers, effects, schemas and the application identity resolver as trusted code. It supplies credentials and tenant context outside model arguments and filters custom tools by optional exact origins. Those restrictions are not a browser network firewall or sandbox for executable handlers. A handler can still expose secrets in its output or logs, ignore cancellation, or send requests outside its declared intent; applications remain responsible for the implementation and authorization.

Browser guards and private context keys detect changes to the owned active main document and tab-activation history, including switching away and back. They do not grant access authority over cross-origin child frames, freeze ordinary DOM changes, or make an external write atomic. Recheck the captured context after waits and before submitting a write, and enforce idempotency or concurrent-update conditions at the destination service. An entered write with an unknown result is preserved for reconciliation and never automatically retried.

[类型化自定义工具 SDK](docs/CUSTOM_TOOLS.md) 将处理函数、读写分类、schema 和应用身份解析器视为可信代码。凭据和租户上下文独立于模型参数传入，可选精确 origin 规则过滤自定义工具，但这不是浏览器网络防火墙或可执行代码沙箱。处理函数仍可能在输出或日志泄密、忽略取消或发送超出意图的请求；应用负责实现与授权。

浏览器 guard 和私有 contextKey 检测自有活动主文档及标签页激活历史变化，包括切走再切回；它们不授予跨域子 frame 权限、不冻结普通 DOM 改动，也不使外部写入原子化。处理函数应在等待后、提交前重查已捕获上下文，目标服务负责幂等与并发写条件。已经进入处理函数的未知写入保留为待核对操作，不自动重试。

## Checkpoints and recovery / 检查点与恢复

CLI checkpoints contain full Agent messages, tool arguments/results and browser storage, including cookies and possible localStorage/IndexedDB credentials. They are plaintext JSON, written through a temporary file with mode `0600` and atomic rename; they are not encrypted or signed. The checkpoint parser validates structure and limits, not authorship. Use checkpoints you trust and protect their containing directory and copies. Custom library persistence callbacks are responsible for their own file permissions and storage policy.

Workspace restoration recreates isolated contexts and owned tab URLs in a new empty engine, using new session IDs. It reloads pages instead of preserving their live DOM, drafts, sessionStorage, JavaScript memory, scroll positions, pending downloads or transactions. It cannot import into an external CDP profile. Previous refs and completion evidence are invalidated; fresh observations and checks are required. Reopening saved URLs may itself trigger website behavior. See [runtime restoration boundaries](docs/RUNTIME.md#checkpoints-and-restoration).

A crash or cancellation after a mutating tool starts can leave an unknown outcome. Resume does not automatically retry that call. The CLI reports `needs_input` before browser/model startup until the operator checks the business state and supplies an explicit `--reconciled` note; library callers supply reconciliation. That note is not proof of success or permission to repeat a submission. A checkpoint that requires an application `validateCompletion` policy must be resumed through the library with that policy, rather than through the CLI.

Runtime budgets carry forward; stopped-process time is excluded. The returned library checkpoint includes final persistence waiting. CLI disk checkpoints include browser export time before the save, but not the final atomic write's own duration. Checkpoint timing is not an exact audit of all persistence wall time.

Version-3 bound checkpoints require the same complete registry contract and trusted principal/tenant/policy identity before planning or dispatch. Reconciliation cannot waive a mismatch, and the CLI rejects bound checkpoints before browser restoration because it cannot reconstruct their handlers. Valid version-1/2 checkpoints migrate unbound; they cannot gain a registry on resume. Stored identity hashes check continuity, not authenticity, and do not make a guessable tenant identifier secret. Bump declared tool versions when relevant executable behavior changes; a schema hash cannot detect arbitrary handler-code changes.

CLI 检查点包含完整 Agent 消息、工具参数与结果、浏览器存储，以及 cookies 和可能存在于 localStorage/IndexedDB 中的凭据。文件是明文 JSON，通过权限为 `0600` 的临时文件与原子重命名保存，没有加密或签名。解析器检查结构和范围，不验证作者身份；只使用可信检查点，并保护所在目录与副本。自定义库持久化回调需要自行落实文件权限和保存策略。

工作区恢复在新的空引擎中重建隔离上下文及自有标签页 URL，并分配新的 session ID。它重新加载页面，不保存实时 DOM、草稿、sessionStorage、JavaScript 内存、滚动位置、待完成下载或事务，也不能导入外部 CDP profile。旧引用和验收证据失效，必须重新观察和检查；重新打开 URL 本身也可能触发网页逻辑。详见[运行机制的恢复边界](docs/RUNTIME.md#检查点与恢复)。

修改操作开始后发生崩溃或取消，可能留下未知结果。恢复不会自动重试该操作。CLI 会在启动浏览器或模型前返回 `needs_input`，直至操作者核对业务状态并提供显式 `--reconciled` 说明；库调用方使用 reconciliation。说明不证明成功，也不授权重新提交。要求应用 `validateCompletion` 策略的检查点必须通过库恢复并提供该策略，不能通过 CLI 恢复。

运行预算继续累计，不计进程停止时间。库返回的检查点包含最终持久化等待；CLI 磁盘检查点计入保存前的浏览器导出耗时，但尚未计入最后原子写入本身的耗时，不能作为全部持久化墙钟时间的精确审计。

版本 3 的绑定检查点要求在规划或执行前匹配完整工具合同与可信主体/租户/策略身份，reconciliation 不能豁免不匹配。CLI 无法重建处理函数，因此在恢复浏览器前拒绝绑定检查点。有效版本 1/2 迁移为未绑定记录，恢复时不能增加注册表。保存的身份摘要检查连续性，不验证真实性，也不会使可猜测的租户标识变成秘密。处理逻辑有相关变化时应提高声明版本；schema 摘要不能检测任意代码变化。

## Reporting / 报告方式

Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SweetDianDian/tablaze/security/advisories/new). Private reporting is enabled for this repository. Send a minimal sanitized reproduction through that channel instead of a public issue.

Include the version, environment, isolated reproduction, observed impact, and expected boundary. Do not include production tokens, browser profiles, unrelated personal data, or a live exploit against a third party. No response-time or support-lifetime commitment has been established yet.

本仓库已启用 [GitHub 私密漏洞报告](https://github.com/SweetDianDian/tablaze/security/advisories/new)。请通过该入口提交最小脱敏复现。报告包含版本、环境、隔离复现、实际影响和预期边界，不附生产凭据、用户 profile、无关个人数据或针对第三方的实际攻击。当前尚未建立响应时限或长期维护承诺。

## Development workflow additions / 当前开发分支扩展

Owned popup tabs are retained and can be selected explicitly; cleanup closes all owned pages and cancels their pending downloads. It does not enumerate or adopt unrelated external CDP tabs. Coordinate clicks use the observed main tab and viewport CSS pixels, but cannot validate a specific DOM target. Use a fresh screenshot and check outcomes.

Uploads take explicit local paths and expose those file bytes to the target page. `upload_chooser` clicks an observed visible button to handle its file chooser, including a hidden file input behind it. There is no file-root allowlist or built-in user approval system; MCP clients remain responsible for authorization. `drag` uses observed source/destination refs, and horizontal or vertical `scroll` can target an observed container ref; these actions can trigger page scripts and require outcome checks. Downloads, `tab_pdf` output and storage-state exports are local artifacts created with mode `0600`. Completed artifacts survive shutdown, should be moved if needed long-term, and should be deleted when no longer needed. Storage-state JSON contains cookies and potentially localStorage/IndexedDB secrets; its content is not returned by `tab_state`, but a later page can access restored state. A CDP export includes the selected shared profile's state.

The optional Agent loop sends the task, tool outputs and optional screenshots to the explicitly configured model endpoint. Its in-memory history/event hooks may contain inputs and page data. Default CLI output omits full history and arguments, but summaries and assertion evidence can still contain private data. The runtime's verification gate enforces cited successful checks, not automatic proof that those checks establish the entire business objective. Applications can supply validateCompletion for task-specific acceptance.

自有弹窗会保留并可显式切换；清理关闭所有自有页面并取消未完成下载，不接管无关 CDP 标签页。坐标操作绑定被观察的主标签页，但不能校验具体 DOM 目标。上传会把显式本地文件交给网页；`upload_chooser` 可点击已观察的可见按钮，处理按钮背后隐藏文件输入触发的选择器。当前没有文件根目录白名单或内置审批系统，调用方仍需落实用户授权。`drag` 使用已观察的源与目标引用，水平或垂直 `scroll` 可指定容器引用；这些操作仍能触发页面脚本，必须检查结果。下载、`tab_pdf` 和状态文件以 `0600` 权限创建，在关闭后保留；状态文件可能含身份凭据，使用后应按需移动或删除。可选 Agent 会把任务、工具结果和截图发送给配置的模型端点；历史记录、摘要和验收证据都可能含私人信息。验收门槛检查有效的通过记录，业务成功条件仍需应用通过 `validateCompletion` 明确约束。
