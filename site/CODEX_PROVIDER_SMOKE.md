# Production Codex provider: independent live smoke

Date: 2026-09-22. **Two tasks passed independent business acceptance and returned verified Agent success (2/2), with zero duplicate writes.** This measures the new public `run --provider codex` path. It is not a Browser Use comparison and does not replace or merge with any earlier run.

## Results

| Visible development task | Business / Agent outcome | Whole run (s) | Model calls | Tool calls | Input / output tokens | Writes / duplicates |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| form | passed / succeeded | 64.030 | 3 | 3 | 43,391 / 462 | 1 / 0 |
| duplicate-write | passed / succeeded | 78.943 | 4 | 4 | 59,401 / 710 | 1 / 0 |

Tool counts include the executor's initial `tab_open`. Every inference ended with `turn.completed` and exit 0; all seven calls reported zero generic error notifications. The CLI returned exit 0 after browser/MCP/planner cleanup for both tasks. Cache-read and cache-creation counts were explicitly reported as zero; this is not a missing-counter estimate. Reasoning counts were 124 and 289 respectively; they are separate reported counters, not added to output-token totals.

The form judge independently recorded exactly `{ "name": "Ada", "city": "Lisbon" }`. The order endpoint records the write and returns an HTTP 503 response with instructions to inspect the receipt. The task was accepted only when the server contained exactly one `{ "order": "one" }` record. Tablaze's own verification also checked rendered receipt text before declaring success. A model statement alone is insufficient.

## Conditions and reproducibility

- Actual model: `gpt-6-astra`, reasoning effort `ultra`, Codex CLI `0.155.0-alpha.9.2`, existing CLI-managed ChatGPT login.
- macOS arm64, Node 25.9.0, Playwright 1.63.0, installed Chrome 153.0.8010.53, headless isolated sessions. Each task starts fresh; no personal browser is attached.
- Visible local fixtures, seed 23, one attempt per task, form before duplicate-write. No automatic retry or fallback. Task deadline 180 seconds, maximum 12 planning steps / 30 tool calls, browser action timeout 5 seconds; executor initialization and `follow-single` popup policy are explicit.
- Whole-run time starts immediately before public CLI launch and ends when that process closes, including browser initialization, inference, tools, verification and cleanup. It excludes the later independent server judge. Provider latencies and actual usage remain per-call in the raw report.
- CLI inference includes Codex prompt/process overhead. No temperature, direct-API token-limit equivalence, monetary cost or general speed improvement is inferred. Anthropic and Ollama were tested with protocol fixtures only.
- Runtime/source hashes were frozen before inference and checked unchanged afterward. The base commit identifies the prior checkout, not all uncommitted measured contents; the report's source/build hashes identify the actual increment.

Reproduce from the matching source/build (this explicitly starts real inference):

```sh
npm ci
npm run build
node bench/codex-provider-smoke.mjs \
  --model gpt-6-astra --reasoning-effort ultra \
  --codex-command /absolute/path/to/codex --channel chrome \
  --output artifacts/comparison/new-provider-attempt/results.json
```

The output path must be new. All attempted tasks, including failures, are retained. The harness uses public CLI output and independent fixture state; it does not expose its judge to the model or script the model's decisions.

[Raw report and source hashes](evidence/codex-provider-smoke-v1.json), SHA-256 `3c83e2d9fefbd01e8dee1a599afee0c2f0f5a41bea3ccf4dd1391234b5eba4bf`.

## What this does not establish

Two known tasks and one model configuration do not establish general reliability, provider parity, long-task performance, or superiority over Browser Use. This production planner has a different prompt/launch implementation from the historical shared comparison bridge. Its timings must not be paired with old Browser Use attempts as a new matched comparison. The original five-task 4/5 versus 5/5 result and separate terminal follow-up remain unchanged. See the [comparison contract](https://github.com/SweetDianDian/tablaze/blob/main/docs/BROWSER_USE_COMPARISON.md) and [variant audit](https://github.com/SweetDianDian/tablaze/blob/main/docs/BROWSER_USE_VARIANTS.md).

本轮新 Codex 入口两项真实任务均完成，服务端独立验收 2/2，重复写入 0 次。表单约 64.030 秒，订单约 78.943 秒。它验证新入口的实际工作能力，不属于与 Browser Use 的新同条件对比，也不证明整体领先。
