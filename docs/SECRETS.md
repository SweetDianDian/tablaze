# Scoped credentials / 定向凭据

Tablaze can fill a login field without putting its plaintext value in an MCP action or model prompt. A trusted operator defines an alias, an exact allowed frame origin and, optionally, exact allowed top-level origins. The browser resolves the value only when `fill_secret` targets a current observed input on an allowed page. This works in isolated browsers, including cross-origin login frames; it is unavailable with external CDP attachment.

Tablaze 可以填写登录字段，而不把明文放进 MCP 操作或模型提示。可信操作者定义别名、允许的 iframe 精确来源，以及可选的顶层页面精确来源。只有 `fill_secret` 指向当前已观察且来源获准的输入框时，浏览器才解析凭据。独立浏览器支持跨域登录 iframe；外部 CDP 连接不支持此功能。

## CLI configuration / 命令行配置

Keep the value in an environment variable, and put **only its variable name** in a trusted UTF-8 JSON file:

把值放进环境变量，可信 UTF-8 JSON 文件中**只写变量名**：

```json
{
  "contextId": "my-account",
  "secrets": [{
    "name": "login_password",
    "version": "1",
    "allowedOrigins": ["https://login.example.com"],
    "allowedTopOrigins": ["https://app.example.com"],
    "env": "TABLAZE_LOGIN_PASSWORD"
  }]
}
```

`allowedOrigins` matches the document containing the input. `allowedTopOrigins` matches its top-level document; if omitted, it inherits `allowedOrigins`. Matching uses normalized, exact HTTP(S) origins, including the port. Wildcards, paths and credentials in origin rules are rejected. Choose origins you trust to receive the value: the receiving page and its scripts can read and send it elsewhere. A navigation policy can restrict document navigation, but it is not a network firewall.

`allowedOrigins` 匹配输入框所在文档；`allowedTopOrigins` 匹配顶层文档，省略时沿用前者。规则仅接受正规化后的 HTTP(S) 精确来源，端口也参与匹配；不接受通配符、路径或带凭据的网址。请只允许你信任的页面：收到凭据的页面及其脚本可以读取并转发它。导航策略能限制文档导航，但不是网络防火墙。

```sh
export TABLAZE_LOGIN_PASSWORD='your local value'
node dist/cli.js doctor --channel chrome --secret-config ./private-secrets.json
node dist/cli.js --channel chrome --secret-config ./private-secrets.json
```

For an autonomous run, pass the same flag to `run`, then on `--resume`. The file is read once at startup; the environment variable is read only when an allowed action needs it. `doctor` reports alias count and artifact policy, not alias names, origin rules, variable names or values. The configuration is operator-supplied; never take it from a webpage or model output. `--secret-config` cannot be combined with `--cdp-url` or `setup`.

自主运行时，把同一个参数传给 `run` 和后续的 `--resume`。文件仅在启动时读取一次；只有获准操作需要凭据时才读取环境变量。`doctor` 只报告别名数量和产物策略，不输出别名、来源规则、变量名或值。配置必须由操作者提供，不应采纳网页或模型生成的配置；`--secret-config` 不能与 `--cdp-url` 或 `setup` 同用。

## MCP and SDK / 工具与库

After `tab_open` or `tab_snapshot`, the snapshot lists `available_secrets` for the observed frame. The model passes an alias, not a value:

`tab_open` 或 `tab_snapshot` 后，快照的 `available_secrets` 列出当前 frame 可用的别名。模型传别名，不传明文：

```json
{
  "session_id": "SESSION_ID",
  "snapshot_id": "CURRENT_SNAPSHOT_ID",
  "actions": [{ "type": "fill_secret", "ref": "OBSERVED_INPUT_REF", "secret": "login_password" }]
}
```

The action checks the observed ref, control type, frame/top origins and document identity around resolution. It accepts writable text-like inputs and textareas. The page receives the value through its native setter and input/change events. It may copy the value into visible text or a URL; Tablaze redacts known raw, whitespace-normalized, URI and JSON-escaped forms from normal text/metadata responses. A secret-bearing structured extraction is rejected because its citations require exact source values. Redaction does not cover arbitrary encodings, hashes, substrings, pixel content or network exfiltration.

操作会检查已观察的引用、控件类型、frame 与顶层来源，以及解析前后的文档身份。支持可写的文本类输入框和 textarea。网页通过原生 setter 及 input/change 事件收到值；它可能把值复制到可见文字或 URL。Tablaze 会从普通文字和元数据响应中遮盖已知的原文、空白正规化、URI 和 JSON 转义形式。结构化提取若包含凭据会被拒绝，因为其引用必须保留原始来源值。遮盖不能覆盖任意编码、哈希、片段、像素内容或网络外传。

SDK callers may pass `secrets: { contextId, secrets: [{ name, version, allowedOrigins, allowedTopOrigins?, resolve }] }` to `BrowserEngine` or `createServer`. The resolver is trusted application code; its return value must be a nonempty string of at most 2,048 UTF-16 units. An optional `getContextId` must still match the configured `contextId` when resolving and restoring. The SDK accepts the same exact-origin and alias limits as the CLI.

SDK 调用方可向 `BrowserEngine` 或 `createServer` 传入 `secrets: { contextId, secrets: [{ name, version, allowedOrigins, allowedTopOrigins?, resolve }] }`。resolver 是可信应用代码；返回值须为非空、最多 2,048 个 UTF-16 单元的字符串。可选的 `getContextId` 在解析和恢复时仍须匹配配置的 `contextId`。SDK 与 CLI 使用相同的精确来源和别名限制。

## Artifacts, recovery and uncertain writes / 产物、恢复与未决写入

After an attempted secret fill, screenshots, PDFs and storage-state exports are blocked by default. A workspace checkpoint omits that session's cookies/storage and page URLs and marks it `requiresReauthentication`; resume reopens blank tabs for a fresh login. A trusted operator can explicitly set `allowSensitiveArtifacts: true`, accepting that binary artifacts and saved authentication state may contain the value. Keep those artifacts and checkpoints private.

尝试填写凭据后，默认阻止截图、PDF 和登录状态导出。工作区检查点会省略该会话的 Cookie、存储及页面 URL，标记 `requiresReauthentication`；恢复时打开空白标签页，重新登录。可信操作者可显式设置 `allowSensitiveArtifacts: true`，自行承担二进制产物与保存的登录状态可能含凭据的风险。请妥善保管这些产物和检查点。

Restore requires the same secret context, alias names, versions, origin scopes and artifact policy; the checkpoint keeps their identity hash, not plaintext values. If a write may have reached the page but its acknowledgement was lost, the Agent records `outcome_unknown`. On resume, inspect the real business state and provide an explicit reconciliation note before further actions; never blindly replay a submission.

恢复要求上下文、别名、版本、来源范围和产物策略一致；检查点只保存这些配置的身份哈希，不保存明文。如果写入可能已经到达网页、但回执丢失，Agent 会记录 `outcome_unknown`。恢复前应检查实际业务状态并提供明确的核对说明，不要盲目重放提交。
