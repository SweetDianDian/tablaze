# Optional HAR and browser trace artifacts

`--record-har` and `--record-trace` capture an **owned isolated browser session** for debugging. Both are off by default and can be enabled separately or together:

```sh
tablaze --channel chrome --record-har --record-trace
```

The SDK accepts `recordHar: true` and `recordTrace: true` in `BrowserEngine` or `createServer`. `tab_close` returns a `diagnostics` array after finalization. Each item has the `session_id`, `kind` (`har` or `trace`), private absolute `path`, `bytes`, `mime_type` and SHA-256. The bytes are not embedded in MCP output. A standalone `tablaze run` includes the finalized array in its JSON report even when the Agent did not call `tab_close`; SDK callers can use `engine.diagnostics()` after `close()` or `dispose()`.

The HAR is full network metadata for the owned context, including its tabs and popups. Response bodies are **omitted** by default. It can still contain request URLs, query strings, request bodies, cookies and authorization headers. The trace is a Playwright ZIP with browser actions, network activity, DOM snapshots and screenshots; it is not a recording of the Agent's private reasoning or a business-success certificate. These artifacts can be large. Both files are finalized before success is reported, have mode `0600` in a private temporary directory, and remain there until the operator removes them. If an expected artifact is missing or empty, `tab_close` reports an error instead of silently claiming success.

The options require an isolated context owned by Tablaze. External CDP and persistent-profile modes are rejected. With configured secret aliases, the trusted secret configuration must explicitly set `allowSensitiveArtifacts: true`; even without aliases, pages and logins may place sensitive data in these files. Use the bounded [response journal](NETWORK.md) when only selected response metadata is needed. [Browser configuration](BROWSER_CONFIGURATION.md) describes other launch settings.

This feature matches the basic local HAR/trace export workflow in [Browser Use's browser parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters), but does not yet provide configurable HAR body modes, automatic redaction, retention management, live trace viewing or an end-to-end Browser Use comparison. A real-Chrome regression checks an actual HAR request/status, omitted response body, ZIP signature, file permissions, digest, MCP close output and Agent-style disposal.

中文：`--record-har` 与 `--record-trace` 可选保存自有隔离浏览器会话的网络 HAR 和 Playwright 追踪。默认关闭；关闭会话后返回私有文件路径、大小及 SHA-256，独立 Agent 运行结束后也能在报告中获取。HAR 默认不保存响应正文，但 URL、请求内容、Cookie 和授权头仍可能包含敏感信息。追踪包含 DOM 与截图。外部 CDP 和持久 profile 不支持；配置了密钥别名时须由可信配置显式允许敏感文件。文件不会自动过期或删除。
