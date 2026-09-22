# Real MCP demonstration / 真实 MCP 演示

The current website recording is **154.104 seconds at 2880×1800**, with eleven segments of Chinese synthesized narration, optional captions and seven chapter shortcuts. Larger form text and a wider browser surface make the actual controls readable. Lossless presentation PNG frames are encoded directly to H.264/AAC MP4 once; the video is not made by enlarging or recompressing the previous WebM.

官网当前演示为 **154.104 秒、2880×1800**，包含十一段中文合成旁白、可选字幕和七个章节。表单文字与浏览器展示区已放大，高清展示帧直接一次编码为 H.264/AAC MP4，并非把上一版 WebM 放大或再次压缩。点击播放后默认有声，也可使用明确的声音开关。

## Reproduce / 复现

Install the source dependencies and build the runtime. For the narrated recipe, use macOS with its Tingting voice and an FFmpeg executable that includes `libx264` and AAC:

```sh
npm ci
npm run build
node demo/narrate.mjs /absolute/path/narration
TABLAZE_BROWSER_CHANNEL=chrome \
TABLAZE_DEMO_FFMPEG=/absolute/path/ffmpeg \
TABLAZE_DEMO_NARRATION=/absolute/path/narration/narration.json \
node demo/record.mjs
```

`narrate.mjs` synthesizes the checked-in [Chinese script](narration.zh-CN.json) locally into eleven AIFF files, measures every duration and writes the manifest. It never plays through the speakers or sends text to a speech API. Other systems can supply an equivalent manifest with `index`, `id`, `text`, absolute `file`, `duration_seconds`, `voice` and `rate`. It must contain all eleven ordered segments. `TABLAZE_DEMO_OUTPUT` optionally selects the output directory.

`narrate.mjs` 使用仓库内的中文稿件本地合成 AIFF，逐段测量时长后生成清单，不通过扬声器播放，也不调用外部语音服务。其他系统可提供相同结构、包含十一段音频的清单。每段画面至少停留至旁白结束，声音和画面使用同一时间轴。

The recorder starts the actual compiled stdio server, connects a real MCP SDK client and completes one continuous travel workflow in a localhost fixture. It verifies browser results, server counters and downloaded bytes. An isolated presentation browser renders actual returned JSON and `tab_capture` images. At each display update it saves a lossless 2× PNG; those frames retain the observed timeline. `render-video.mjs` produces 2880×1800 H.264 at CRF 16/12 fps and AAC narration at 48 kHz, targeting −16 LUFS. The embedded browser captures remain the engine's original 1280×800 JPEG screenshots; the larger form typography improves their legibility, not their native resolution. Frame scheduling is quantized to 1/12 second and is not a continuous browser video feed.

录制器通过真实 MCP SDK 完成整条任务，再用实际响应和截图呈现过程。每次展示更新保存 2 倍像素的无损 PNG，并按原时间轴编码；嵌入的网页截图仍为引擎返回的原始 1280×800 JPEG，表单字体放大提高了可读性，没有冒称网页截图本身是 2880 像素。视频帧时间对齐到十二分之一秒，不是被控页面的连续视频流。

Output defaults to `demo/output/`:

- `tablaze-demo-hd.mp4`: the current high-resolution recording with Chinese narration.
- `narration.zh-CN.vtt`: eleven optional caption cues synchronized to the actual audio.
- `demo-report.json`: all requests/results, tool timing, source/frame/audio/video hashes, chapter timing and independent assertions.
- Five original JPEG captures, `poster.png`, and the verified `wayfar-itinerary.csv`.
- `frames/` and `frames.ffconcat`: local lossless presentation inputs, retained for inspection.

When publishing, copy the MP4, VTT, report, CSV and five captures into the website's `demo/` directory, and copy `poster.png` as `poster-hd.png`. Set `release.json` to `"demo": true`. Generated videos, audio and frames are not bundled in the source ZIP; the script and reproduction instructions are included.

Without narration configuration, the original silent WebM recipe remains available. `TABLAZE_DEMO_QUICK=1` is only for a short harness check and cannot be used with narrated publication. Do not present quick-mode output as the normal-speed website recording.

## What is shown / 展示内容

1. The SDK discovers fifteen tools and opens the travel form in one session.
2. One six-action batch sets Lisbon, three nights, two travelers, a €900 budget and free cancellation, then searches. Server counters confirm one search with those filters.
3. Five assertions check the resulting URL, title, visible text, city value and matching hotel count.
4. The fixture replaces the observed approval button. Its stale reference is rejected with zero completed actions; server counters confirm zero approval popup visits, submissions and orders at that point.
5. A fresh snapshot supplies a new reference. Explicit `follow-single` policy follows the owned approval popup, then four actions complete its form.
6. Three receipt assertions pass. The server independently confirms one submission and one order.
7. The saved CSV's bytes and SHA-256 match the expected contents. Both owned tabs close and zero sessions remain.

同一条差旅流程展示：六步批量填表、五项结果验收、目标变化后拒绝旧引用且没有审批写入、重新观察恢复、跟随自有弹窗、四步审批、三项回执检查、CSV 内容和哈希核对，以及关闭两个所属标签页。

## Recorded result / 本次结果

The current run passed on **2026-09-23 (Asia/Shanghai)**: 22 MCP calls, eight browser assertions, one approval order, one matching 145-byte CSV and zero remaining sessions. The 154.104-second video includes 138.063 seconds of presentation holds and 117.117 seconds of narration. Recorded tool calls total 2,161.036 ms; the display, narration and holds are excluded. This is one local scripted sample, not a model or Browser Use speed comparison.

本次正式录制通过：22 次 MCP 调用、八项浏览器检查、一份审批订单、一个内容匹配的 145 字节 CSV，零遗留会话。视频 154.104 秒，其中讲解停留约 138.063 秒、旁白约 117.117 秒；实际工具耗时合计 2,161.036 毫秒，不能作为模型执行能力或 Browser Use 的速度对比。

[Complete trace](../docs/evidence/demo-run.json) · [33 website checks](../docs/evidence/demo-site-qa-v3.json) · [Decoded narration evidence](../docs/evidence/demo-narration-v3.json)

All 33 local website checks pass, including 2880×1800 video metadata, an actual decoded audio track, initially unmuted playback, keyboard sound control, eleven caption cues, complete video decode and all seven chapter jumps. The encoded AAC was fully decoded separately: mean volume −16.7 dBFS, peak −1.4 dBFS. These checks establish audio in the file and player; local device volume is controlled by the viewer.

This deterministic SDK demonstration does not invoke a reasoning model, make external bookings or payments, or prove general website reliability or superiority over Browser Use. Source hashes bind the trace to the recorded runtime. The earlier [short v1](../docs/evidence/demo-run-v1.json) and [silent 126-second v2](../docs/evidence/demo-run-v2.json) traces remain historical records.
