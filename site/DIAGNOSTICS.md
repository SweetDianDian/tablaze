# Optional HAR and browser trace artifacts

`--record-har` and `--record-trace` capture an **owned isolated browser session** for debugging. Both are off by default and can be enabled separately or together:

```sh
tablaze --channel chrome --record-har --record-trace
```

For a HAR that includes response content, choose the format explicitly:

```sh
tablaze --channel chrome --record-har --har-content embed
tablaze --channel chrome --record-har --har-content attach --har-mode minimal
```

`omit` remains the default content mode. `embed` writes response content inline in a JSON `.har`; `attach` writes a ZIP containing the HAR manifest and separate response attachments. `--har-mode full` is the default; `minimal` records only the fields needed for HAR routing/replay, so it is less useful for timing diagnostics. The SDK options are `recordHarContent: 'omit' | 'embed' | 'attach'` and `recordHarMode: 'full' | 'minimal'`, both requiring `recordHar: true`. `doctor` reports the selected modes. HAR result metadata names `content_mode` and `har_mode`; attached archives have MIME type `application/zip`.

The SDK accepts `recordHar: true` and `recordTrace: true` in `BrowserEngine` or `createServer`. `tab_close` returns a `diagnostics` array after finalization. Each item has the `session_id`, `kind` (`har` or `trace`), private absolute `path`, `bytes`, `mime_type` and SHA-256. The bytes are not embedded in MCP output. A standalone `tablaze run` includes the finalized array in its JSON report even when the Agent did not call `tab_close`; SDK callers can use `engine.diagnostics()` after `close()` or `dispose()`.

The HAR covers network activity for the owned context, including its tabs and popups. Response bodies are **omitted** by default; `embed` and `attach` can store page content, API data and other sensitive responses. Every mode can still contain request URLs, query strings, request bodies, cookies and authorization headers. The trace is a Playwright ZIP with browser actions, network activity, DOM snapshots and screenshots; it is not a recording of the Agent's private reasoning or a business-success certificate. These artifacts can be large. Both files are finalized before success is reported, have mode `0600` in a private temporary directory, and remain there until the operator removes them. If an expected artifact is missing or empty, `tab_close` reports an error instead of silently claiming success. Tablaze does not automatically redact HAR contents; inspect and sanitize a file before sharing it.

The options require an isolated context owned by Tablaze. External CDP and persistent-profile modes are rejected. With configured secret aliases, the trusted secret configuration must explicitly set `allowSensitiveArtifacts: true`; even without aliases, pages and logins may place sensitive data in these files. Use the bounded [response journal](NETWORK.md) when only selected response metadata is needed. [Browser configuration](BROWSER_CONFIGURATION.md) describes other launch settings.

The content and detail modes match the controls listed in [Browser Use's browser parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters). Tablaze does not yet provide automatic redaction, retention management, live trace viewing or an end-to-end Browser Use comparison. Real-Chrome regressions check default body omission, actual response content in embedded and attached HARs, ZIP manifests and attachments, file permissions, digests, CLI/MCP output and Agent-style disposal. The [full Node 24 + Chrome log](evidence/development-tests-har-modes-node24.txt) records **503/503 passed** (SHA-256 `cd24e7c620e528422fd2668fd4cdb6ec58a9592371d5c7a208a0a5936d407ccb`).

中文：`--record-har` 与 `--record-trace` 可选保存自有隔离浏览器会话的网络 HAR 和 Playwright 追踪。默认关闭；关闭会话后返回私有文件路径、大小及 SHA-256，独立 Agent 运行结束后也能在报告中获取。HAR 正文默认 `omit`；显式选择 `--har-content embed` 会把响应放进 JSON，`attach` 会生成含 HAR 清单和响应附件的 ZIP。`--har-mode minimal` 只保留回放所需字段。URL、请求内容、Cookie 和授权头在任一模式下仍可能敏感，正文模式还会保存页面或 API 数据；分享前需自行检查和脱敏。外部 CDP 和持久 profile 不支持；配置了密钥别名时须由可信配置显式允许敏感文件。文件不会自动过期或删除。
