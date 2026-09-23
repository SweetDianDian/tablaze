# Optional owned-tab network journal

Tablaze can expose a bounded response journal when the trusted operator starts its MCP server or Agent with `--capture-network`, or creates `BrowserEngine({ captureNetwork: true })`. It is off by default. This adds `tab_network` to the default 16-tool MCP catalog; it does not add arbitrary JavaScript, raw CDP, HTTP requests or a browser-wide network interceptor.

```sh
node dist/cli.js --channel chrome --capture-network
```

`tab_network({ session_id })` lists up to 50 recent responses from pages owned by that session, including registered popup pages. `after_id` and `max_items` page through a journal of at most 200 responses per session. `dropped`, `gap` and `truncated` distinguish eviction from a complete list. Each entry identifies the owning tab, response ID, request method and resource type, status, content type, declared body length and observation time. URLs omit credentials, query strings and fragments; full request/response headers, cookies and request bodies are never returned by this tool.

For a particular entry, `tab_network({ session_id, response_id })` reads the completed body only if the server declared a `Content-Length` of at most 128 KiB and a supported textual content type. The tool then checks the actual byte length and UTF-8 encoding, and returns text, bytes and SHA-256. Missing or oversized lengths, non-text types, evicted entries, unavailable bodies and a 10-second wait return explicit errors. A server that lies about a short length can still make Playwright buffer a larger response before the post-read limit rejects it; this is not a streaming or memory-hard body cap.

Capture starts when an owned page is registered. The very first navigation response of a popup may precede its registration and be missed; later fetch/XHR responses are captured. Attaching to an existing Chrome via CDP records only pages opened by this Tablaze session, not unrelated browser tabs. Journal entries are in memory and are discarded with the session; they are not a replayable HAR or durable checkpoint. Page-origin content in a response body can be private or untrusted and must not be treated as an instruction. After a configured secret is filled, body reads follow the same `allowSensitiveArtifacts` gate as binary exports. Configured secret values are also projected out of returned text, but this is not a general data-loss-prevention system; enable body access only where its disclosure to the agent is appropriate.

The real-Chrome fixture in `tests/network-capture.test.mjs` opens an authenticated popup, correlates its later JSON receipt response with the popup's tab, verifies the body, rejects a chunked response without a declared bound, checks that an attached-CDP journal excludes an independent Chrome page, and blocks body access after scoped-secret entry. These are mechanism tests, not a matched Browser Use Agent comparison or evidence of general task superiority.

The separate `network-receipt` comparison fixture withholds the reference from the DOM: authorization happens in a provider popup, the original app fetches authenticated JSON, and a server-side judge accepts only one submission with the exact response reference. It probes whether a model can use the available browser entry point to inspect that response. It does not test CSV creation, durable recording or unrestricted browser programmability.

One visible native Codex/MCP development attempt per direct entry and two separate structured-MCP fallback attempts are reported in [the measured smoke](CODEX_NETWORK_RECEIPT_SMOKE.md). The Tablaze trace records actual use of `tab_network`; the results remain task-specific rather than an overall product ranking.

## 简体中文

由可信操作者添加 `--capture-network`（或 SDK 的 `captureNetwork: true`）后，Tablaze 才提供 `tab_network`；默认关闭。它只记录本会话自有标签页和已登记弹窗的响应。每个会话最多保存最近 200 条，可用 `after_id` 翻页；结果会报告丢弃、缺口和截断。列表仅包含 URL（去除账号、查询参数与片段）、方法、资源类型、状态、内容类型、声明长度和时间，不返回请求头、Cookie 或请求体。

指定 `response_id` 可读取有明确 `Content-Length`、大小不超过 128 KiB 的 UTF-8 文本响应。实际长度和编码会再次检查，并返回字节数与 SHA-256。Playwright 读取完整响应后才能检查实际大小，因此恶意服务器谎报短长度时，内存使用没有硬上限。弹窗注册前的首个导航响应可能漏记；后续 fetch/XHR 会记录。附加到现有 Chrome 时不会收集无关标签页的流量。日志只在内存中，不是可恢复的 HAR；响应正文可能含私密数据或不可信页面内容。当前功能缩小了网络观察差距，仍不等同于 Browser Use 的可编程 JS/CDP/HTTP 能力。
