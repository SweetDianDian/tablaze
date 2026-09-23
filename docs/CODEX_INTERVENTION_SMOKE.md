# Live Codex pause and steering: independent development smoke

Date: 2026-09-23. One visible form task exercised the SDK `AgentControl` with genuine Codex inference and an isolated Chrome browser. After the first passing `tab_verify`, the operator control reached a pause boundary, added a trusted instruction to check again without resubmitting, and resumed. The Agent returned success with final verification evidence; the fixture server independently recorded exactly one correct `{ "name": "Ada", "city": "Lisbon" }` write and zero duplicates. This is one Tablaze development attempt, **not** a matched Browser Use comparison or a reliability estimate.

| Outcome | Whole run | Planner / tool calls | Reported input / output tokens | Server writes / duplicates |
| --- | ---: | ---: | ---: | ---: |
| Paused, steered, Agent success, independent judge pass | 86.219 s | 5 / 5 | 77,112 / 915 | 1 / 0 |

The runner triggers pause only on a successful browser verification. Its final evidence is a later `tab_verify` call (`call_5`) with passing Name, City and saved-status checks; the control invalidates evidence that existed before the pause. The report records `INTERVENTION_REPLAN` and `STEERING_APPLIED`. The service-side judge checks the actual saved record and write count, independently of the Agent's summary or verification claim.

Conditions: `gpt-6-astra`, reasoning effort `ultra`, Codex CLI `0.155.0-alpha.9.2`, macOS Chrome, isolated local fixture, seed 23, one attempt, no automatic retries, 180-second run deadline, 20 planning steps and 30 tool calls. Whole-run time includes browser startup, model calls, tools and cleanup; it excludes the subsequent independent judge. Token numbers are Codex CLI reports including prompt/process overhead. This attempt does not establish a cross-product speed or success-rate advantage, and it does not exercise cross-process CLI intervention or Pi's same-worker `execute(code)`.

Reproduce from the matching source and build (starts real model inference):

```sh
npm run build
node bench/codex-intervention-smoke.mjs \
  --model gpt-6-astra --reasoning-effort ultra \
  --codex-command /absolute/path/to/codex --channel chrome \
  --output artifacts/comparison/new-intervention-attempt.json
```

The output path must be new. [Raw report with source/build hash and independent server evidence](evidence/codex-intervention-smoke-v1.json), SHA-256 `6204c5314b1546842552855060adad50fc42f737429385a48b59794f770b7f47`.

本次仅验证 Tablaze 的真实 Codex 入口：暂停后重新规划，最终通过验证，服务端只有一次正确写入。它不证明整体超过 Browser Use。
