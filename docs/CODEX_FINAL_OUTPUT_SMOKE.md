# Codex final-output contract: independent live smoke

Date: 2026-09-23. One visible extraction task used the public `run --provider codex --output-schema` path with real Codex inference. The Agent returned schema-valid `{ "total": 29 }`, and the fixture server independently recorded exactly one submission of `29`. The Agent also cited a passing browser verification after the write. This is **one Tablaze development attempt**, not a Browser Use comparison or a reliability estimate.

| Outcome | Whole run | Model calls | Tool calls | Reported input / output tokens | Server writes / duplicates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Agent success, schema-valid data, independent judge pass | 76.945 s | 4 | 4 | 60,773 / 1,205 | 1 / 0 |

The fixture table contained 3 pencils at 5 and 2 pads at 7, so the accepted total was 29. The JSON Schema required an object with a nonnegative numeric `total` and no additional fields; it did not reveal the expected value to the model. The server judge checked the recorded write count and exact value, and the report additionally checked that final `data.total` matched that server record. Neither the model's summary nor JSON shape alone was counted as business acceptance.

Conditions: `gpt-6-astra`, reasoning effort `ultra`, Codex CLI `0.155.0-alpha.9.2`, macOS Chrome, isolated local fixture, seed 23, one attempt, no automatic retries, 180-second run deadline, 12 planning steps and 30 tool calls. Whole-run time includes CLI launch, browser startup, inference, browser tools and cleanup; it excludes the subsequent independent judge. Token numbers are Codex CLI reports including prompt/process overhead. This run does not supply a matched competitor latency or success-rate measurement.

Reproduce from the matching source and build (starts real model inference):

```sh
npm run build
node bench/codex-final-output-smoke.mjs \
  --model gpt-6-astra --reasoning-effort ultra \
  --codex-command /absolute/path/to/codex --channel chrome \
  --output artifacts/comparison/new-final-output-attempt.json
```

The output path must be new. The runner records a completed attempt even when its acceptance checks fail. [Raw report with source/build hash and server evidence](evidence/codex-final-output-smoke-v1.json), SHA-256 `d7ed77098bed96cde663919e1feb6abf58fb22a2ef369d8df7c4d95a5941d9d0`.

这次仅验证 Tablaze 的真实 Codex 入口：结构化结果为 29，服务端独立验收通过且只有一次提交。它不能证明整体强于 Browser Use。
