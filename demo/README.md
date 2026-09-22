# Real MCP demonstration / 真实 MCP 演示

The recorder starts the actual compiled stdio server, connects a real MCP SDK client, drives bundled localhost fixtures, and independently checks the outcomes. A second isolated browser records a presentation of the returned JSON and actual `tab_capture` images.

录制器启动真实 stdio 服务与 MCP SDK 客户端，操作本地测试页面并核对结果。另一个隔离浏览器录制实际响应和 `tab_capture` 截图的展示画面。

## Reproduce / 复现

Run from the source directory after installing dependencies:

```sh
npm ci
npm run build
TABLAZE_BROWSER_CHANNEL=chrome node demo/record.mjs
```

Or install managed Chromium with `node dist/cli.js setup`, then omit the channel variable. Playwright's video support requires its matching FFmpeg helper; normal Playwright browser installation supplies it.

Output is generated in `demo/output/`:

- `tablaze-demo.webm`: normal-speed recording, with bilingual on-screen descriptions.
- `demo-report.json`: every real request/result, tool durations, presentation holds, source SHA-256 hashes and assertions.
- Five JPEG files returned by `tab_capture`.

输出包含正常速度 WebM、完整 JSON 调用记录和五张真实截图。媒体不放入源码 ZIP；先运行录制命令即可生成。部署介绍页时，把视频、截图海报和记录放在站点的 `demo/` 中，并在站点 `release.json` 中设置 `"demo": true`。

For a short harness check only, use `TABLAZE_DEMO_QUICK=1`. It records with short holds and marks `quick_mode: true`; never present that output as the normal-speed launch recording. `TABLAZE_DEMO_OUTPUT` optionally selects a different output directory.

## What is shown / 展示内容

1. SDK handshake discovers eight actual tools.
2. Open the hotel form; use its observed refs in one four-action batch.
3. Independently check URL, title, visible text, field value and result count.
4. Replace the observed target node in the separate lab fixture; verify that the old reference is rejected and the click counter remains zero.
5. Observe again, click the new target and verify counter one.
6. Close both sessions and confirm an empty session list.

The baseline recording is approximately 56 seconds of video, with 54 seconds of labelled reading holds. Its request trace is in [the recorded evidence](../docs/evidence/demo-run.json).

这是实际工具调用和截图的展示录屏，**不是被控页面的连续视频流，也不是 Codex 模型自主选工具的演示**。讲解停留时间明确标注，不计入逐次工具耗时；没有剪辑加速。使用本地场景，不进行外部预订。该录制证明对应断言，不证明任意网站的可靠性或安全沙箱。

Video saving follows [Playwright's documented context-close lifecycle](https://playwright.dev/docs/videos). Regenerate the evidence whenever its recorded source hashes no longer match the code.
