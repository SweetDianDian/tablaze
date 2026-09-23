# Reproducible local benchmark / 可复现本地基准

This benchmark runs real Chromium against the public fixture in `tests/fixture.mjs`. No model API key, external website or logged-in browser is used. It measures the engine in-process; it does not measure MCP transport or agent reasoning.

基准使用真实 Chromium 操作仓库内的公开网页 fixture，不使用模型 API、外部网站或用户已登录的浏览器。测量直接调用的浏览器引擎，不包含 MCP 传输和 Agent 推理。

```sh
npm ci
npx playwright install chromium
npm run bench
```

To launch an independently owned, headless installed Chrome instead of managed Chromium:

如需使用本机安装的 Chrome，以下命令会启动独立的无头进程：

```sh
TABLAZE_BROWSER_CHANNEL=chrome TABLAZE_BENCH_REPEATS=5 npm run bench
```

Default: five repetitions. Set `TABLAZE_BENCH_REPEATS` to an integer from 1 to 100. Results go to `bench/results/latest.json` and a timestamped JSON archive. A failed repetition remains in the report and makes the command exit nonzero. The report is saved after every repetition.

默认重复五次；可设为 1–100 次。输出包括 `bench/results/latest.json` 和带时间戳的原始记录。失败样本保留，每次重复后保存报告；任意样本失败时命令以非零状态退出。

| Measurement / 指标 | Boundary / 范围 |
| --- | --- |
| Cold open / 冷启动 | A new engine and browser process, page/context creation, local navigation and first snapshot. Process-cold; OS caches may be warm. / 新引擎与浏览器进程、页面和上下文、导航及首次快照；操作系统缓存可能已预热。 |
| Warm snapshots / 热快照 | Three observations of the already open session. / 在现有会话内连续观察三次。 |
| Four-action batch / 四步批次 | Fill Lisbon, select three nights, check free cancellation, click Search stays; includes navigation and returned snapshot. / 填写城市、选择三晚、勾选免费取消、点击搜索；包含导航及返回快照。 |
| Verification / 验收 | Fresh checks of actual URL, title, displayed filters, field value and the Casa Flora result count. / 独立检查真实 URL、标题、筛选条件、字段值和结果数量。 |
| JSON bytes / JSON 字节 | UTF-8 size of each serialized result, not token counts. / 返回结果序列化后的 UTF-8 字节数，不等于 token 数。 |

The JSON contains all attempts, environment and browser versions, raw timings and payload sizes. Summary distributions use verified successful samples only and are explicitly labelled; success counts always include every attempt. Installation, inference, internet latency and the final untimed browser-version probe are excluded. This fixture measures a small repeatable workflow, not general browser reliability or superiority over other tools.

JSON 包含全部样本、环境及浏览器版本、原始耗时和输出体积。耗时摘要只汇总验收成功的样本，并明确标注；成功计数包含全部尝试。安装、推理、互联网延迟及最后的浏览器版本探测不计入耗时。这是小型固定流程的测量，不代表通用任务成功率，也不证明优于其他工具。

There is no cross-product speed claim. Any future comparison must pin both versions, use the same environment, goals, browser state and independent outcome checks, retain all failures and disclose cold/warm boundaries.

本基准不宣称跨产品速度优势。后续对照实验应固定双方版本、环境、目标、浏览器状态和独立验收条件，保留失败样本，并注明冷启动与热调用边界。
## Real-model mechanism check

`bench/codex-partial-output-smoke.mjs` runs a checked-partial task with real Codex inference, local Chrome and an independent server judge. It requires an explicit model, Codex executable and new output path. See [the three visible attempts](../docs/CODEX_PARTIAL_OUTPUT_SMOKE.md); this is not a Browser Use comparison.
