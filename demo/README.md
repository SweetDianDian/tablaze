# Real MCP demonstration / 真实 MCP 演示

The recorder starts the actual compiled stdio server, connects a real MCP SDK client, and completes one continuous travel workflow in the bundled localhost fixture. It checks browser results, fixture server counters and downloaded file bytes. A second isolated browser records a presentation of the returned JSON and actual `tab_capture` images.

录制器启动真实 stdio 服务与 MCP SDK 客户端，在同一个本地差旅场景中完成筛选、审批和文件交付，并核对页面结果、服务器计数与下载文件字节。另一个隔离浏览器录制实际响应和 `tab_capture` 截图的展示画面。

## Reproduce / 复现

Run from the source directory after installing dependencies:

```sh
npm ci
npm run build
TABLAZE_BROWSER_CHANNEL=chrome node demo/record.mjs
```

Or install managed Chromium with `node dist/cli.js setup`, then omit the channel variable. Playwright's video support requires its matching FFmpeg helper; normal Playwright browser installation supplies it.

For the compact website video, also set `TABLAZE_DEMO_FFMPEG` to an absolute FFmpeg executable path (the matching Playwright helper works). The recorder re-encodes the presentation at 1440×900, 5 fps and VP8 CRF 18, preserving its timeline. It keeps `tablaze-demo-original.webm` locally and records the original, encoder and published-video hashes plus the exact encoding arguments. Shorter-than-200-ms presentation transitions may be omitted; the complete MCP trace remains in the report.

官网精简版额外设置 `TABLAZE_DEMO_FFMPEG=/绝对路径/ffmpeg`，保持分辨率与时间轴，以 5 fps、VP8 CRF 18 重编码。原始视频保留在本地，报告分别记录原片、编码器、发布视频的哈希与实际参数。小于 200 毫秒的展示过渡可能被省略，完整调用记录仍保留。

Here `timestamps_preserved` denotes normal presentation speed, not identical per-frame timestamps: constant-frame-rate encoding quantizes frames to a 200 ms grid. This run's original video is 125.64 seconds and its published version is 126 seconds; the extra 0.36 seconds is tail-frame padding, not acceleration.

`timestamps_preserved` 指保持正常展示速度，并非逐帧时间戳完全相同。固定帧率会将帧时间对齐到 200 毫秒网格；本次原片 125.64 秒、发布版 126 秒，多出的 0.36 秒是尾帧补齐，没有加速。

Output is generated in `demo/output/`:

- `tablaze-demo.webm`: normal-speed recording, with bilingual on-screen descriptions.
- `demo-report.json`: every real request/result, tool durations, presentation holds, seven chapter positions, source/media SHA-256 hashes and assertions.
- Five JPEG files returned by `tab_capture`, plus `poster.png` from the presentation.
- `wayfar-itinerary.csv`: a retained copy of the downloaded file whose bytes were checked.

输出包含正常速度 WebM、完整 JSON 调用记录、七个章节位置、五张真实截图、展示海报及已核对的 CSV。生成的 `demo/output/` 与视频不放入源码 ZIP；先运行录制命令即可生成。部署介绍页时，将视频、`poster.png`、`demo-report.json` 和 `wayfar-itinerary.csv` 原样复制到站点的 `demo/` 中，再在站点 `release.json` 中设置 `"demo": true`。

For a short harness check only, use `TABLAZE_DEMO_QUICK=1`. It records with short holds and marks `quick_mode: true`; never present that output as the normal-speed launch recording. `TABLAZE_DEMO_OUTPUT` optionally selects a different output directory.

## What is shown / 展示内容

1. The SDK handshake discovers fifteen tools; the recorder opens the travel form in one session.
2. One six-action batch sets Lisbon, three nights, two travelers, a €900 budget and free cancellation, then searches. Server counters confirm one search with the expected filters.
3. Five independent assertions check the resulting URL, title, visible text, city field value and matching hotel count.
4. The fixture replaces the observed approval button on that result page. The stale call returns `STALE_REFERENCE` with zero completed actions; server counters confirm zero approval popup visits, submissions and orders at that point.
5. A fresh snapshot supplies the new reference. With `follow-single` explicitly enabled, the next click follows the owned approval popup; the recorder observes that page before sending four approval actions.
6. Three receipt checks confirm the completed page, approval ID and amount. The server independently confirms one submission and one order.
7. Download the CSV, read the saved file and compare its actual bytes and SHA-256 with the expected contents. Close the session's two owned tabs and confirm zero remaining sessions.

同一条差旅流程依次展示：六步批量填表、五项结果验收、目标变化后拒绝旧引用且没有审批写入、重新观察恢复、`follow-single` 跟随自有弹窗、四步审批、三项回执检查，以及 CSV 字节和哈希核对。最后关闭同一会话内的两个标签页，确认没有遗留会话。

## Recorded result / 本次录制结果

The normal recording completed on 2026-09-22 with `status: passed` and `quick_mode: false`. The video is **126 seconds at 1440×900**, including **121 seconds of labelled reading holds**. It records 22 MCP tool calls, eight passing browser assertions, one order and one 145-byte CSV with matching contents and SHA-256. The sum of the recorded tool-call durations is 2,339.659 ms; this is one local scripted sample, excluding reading holds and model inference, not an internet-site or Browser Use speed comparison. See the [complete request evidence](../docs/evidence/demo-run.json).

正式录制于 2026-09-22 完成，`status: passed`、`quick_mode: false`。视频 **126 秒，1440×900**，其中 **121 秒为标注的讲解停留**。记录包含 22 次 MCP 工具调用、八项通过的浏览器断言、一份审批订单，以及内容和 SHA-256 均匹配的 145 字节 CSV。逐次工具耗时合计 2,339.659 毫秒，仅对应这次本地脚本样本，不含讲解停留或模型推理，不能当作外网站点或 Browser Use 的速度对比。

This is a deterministic SDK script with no model inference. The video presents actual tool responses and screenshots; **it is not a continuous video feed from the controlled tab**. Reading holds are labelled and excluded from tool timings; the timeline is not accelerated. The fixture performs no external booking or payment. These assertions demonstrate this workflow, not general website reliability, a security sandbox or model autonomy.

这是确定性的 SDK 脚本演示，没有调用推理模型。视频展示真实工具响应和截图，**不是被控标签页的连续视频流**。讲解停留明确标注，不计入工具耗时，没有剪辑加速。场景不进行外部预订或付款；此次断言不证明任意网站可靠性、安全沙箱或模型自主执行能力。

The original short recording's trace remains available as [historical v1 evidence](../docs/evidence/demo-run-v1.json); it is not the current website video.

Video saving follows [Playwright's documented context-close lifecycle](https://playwright.dev/docs/videos). Regenerate the evidence whenever its recorded source hashes no longer match the code.
