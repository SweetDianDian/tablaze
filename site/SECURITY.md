# Security boundaries / 安全边界

Tablaze 0.1.0 is a local preview, not a security sandbox. Its browser can read pages, submit forms, and make network requests with the identity available to its selected browser context. MCP tool annotations describe behavior; they do not themselves enforce user authorization.

Tablaze 0.1.0 是本地预览版，不是安全沙箱。浏览器可以读取页面、提交表单，并使用所选上下文的身份发起网络请求。MCP 工具注解只描述行为，本身不执行用户授权控制。

## Isolation and ownership / 隔离与资源归属

Default mode launches a browser controlled by the server and creates separate temporary contexts. The contexts retain state only while open. `--channel chrome` chooses a browser binary, not the user's ordinary profile.

Explicit `--cdp-url` mode creates owned pages in an external browser's default context. Login state and storage are shared with that profile. Cleanup closes owned pages and disconnects; it does not deliberately close unrelated tabs or the external browser. Keep the endpoint accessible only to parties you intend to grant browser control. Tablaze does not add CDP authentication or a domain/network allowlist.

默认模式创建独立临时上下文；`--channel chrome` 仅选择程序。显式 CDP 模式则在外部浏览器默认上下文中创建自有页面，共享其登录状态与存储；清理关闭自有页面并断开连接，不主动关闭无关标签页或浏览器。调试端点意味着浏览器控制权限，Tablaze 不替它增加身份验证，也不提供域名或网络访问白名单。

## Data returned to clients / 返回客户端的数据

Snapshot metadata omits password/hidden input values; explicit value verification rejects those inputs. Errors remove Playwright call logs and redact selected input values and endpoint URLs. CDP connection errors omit the configured endpoint. These are specific protections, not general data-loss prevention.

Other input values, page text, accessible names, URLs (including their query parameters), extracted records, assertion evidence, and screenshots can contain personal data or credentials rendered by the website. They are sent to the MCP client, whose model and retention settings apply. An explicitly referenced hidden accessibility label may form part of an accessible name. Page scripts may copy a secret into visible text; Tablaze cannot reliably recognize that transformation. The tool itself does not call a model provider or require a model API key.

快照省略 password/hidden input 的值，值验收拒绝这些输入；错误会移除 Playwright 调用日志并处理部分输入值和端点，CDP 连接错误省略配置地址。这些是具体防护，不是全面的数据防泄漏系统。其他字段值、文字、无障碍名称、带查询参数的 URL、验收证据和截图仍可能含私人信息，并会进入 MCP 客户端。显式引用的隐藏无障碍标签可能构成名称；页面若把秘密复制到可见文字中，服务无法可靠识别。模型与留存规则由客户端决定，Tablaze 自身不调用模型。

## Actions and cancellation / 操作与取消

References bind a snapshot revision to observed DOM nodes and semantic metadata. Checks run again after actionability waits, but the page can change between checking and input. This time-of-check/time-of-use window is not eliminated. Trial checks can scroll and trigger page logic. No arbitrary eval tool is exposed, but clicking a website's controls still executes that website's scripts.

Action batches stop at the first error. An active cancellation or total-budget expiry closes the owned session to interrupt pending work and skip later actions. It does not undo earlier submissions or stop network requests already accepted elsewhere. A failed step may have side effects even when it was not counted as completed. Read partial-result fields and verify the business state before retrying.

引用将快照版本与观察到的节点、语义元数据关联，等待后再次检查，但无法消除检查到输入之间的竞态。预检可能滚动并触发逻辑；虽然没有通用 eval 工具，网页控件仍会执行网页脚本。取消和超时关闭自有会话、停止后续操作，但不撤回已经生效的提交或外部请求。失败步骤也可能有副作用，重试前应检查部分完成字段与业务结果。

## Reporting / 报告方式

Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SweetDianDian/tablaze/security/advisories/new). Private reporting is enabled for this repository. Send a minimal sanitized reproduction through that channel instead of a public issue.

Include the version, environment, isolated reproduction, observed impact, and expected boundary. Do not include production tokens, browser profiles, unrelated personal data, or a live exploit against a third party. No response-time or support-lifetime commitment has been established yet.

本仓库已启用 [GitHub 私密漏洞报告](https://github.com/SweetDianDian/tablaze/security/advisories/new)。请通过该入口提交最小脱敏复现。报告包含版本、环境、隔离复现、实际影响和预期边界，不附生产凭据、用户 profile、无关个人数据或针对第三方的实际攻击。当前尚未建立响应时限或长期维护承诺。
