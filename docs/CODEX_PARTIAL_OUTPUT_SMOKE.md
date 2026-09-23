# Codex checked-partial delivery: three visible live attempts

Date: 2026-09-23. The production `run --provider codex --partial-schema` path used real Codex inference, local Chrome, and an independent fixture-server judge. The task computed and submitted an order total, verified the browser state, published `{ "total": 29 }` under `receipt-total`, then requested input for a separate next record. `needs_input` with a checked partial was the intended incomplete outcome; overall Agent success was not requested.

| Attempt | Source behavior | Server acceptance | Agent outcome | Partial matches server | Whole run | Reported input / output tokens |
| --- | --- | --- | --- | --- | ---: | ---: |
| [1](evidence/codex-partial-output-smoke-v1.json) | Original adapter | One correct write, zero duplicates | `failed`: invalid planner response at step 4 | No partial | 78.666 s | 61,583 / 743 |
| [2](evidence/codex-partial-output-smoke-v2.json) | Fixed-stage diagnostic added | One correct write, zero duplicates | `failed`: malformed `arguments_json` at step 4 | No partial | 77.644 s | 61,486 / 844 |
| [3](evidence/codex-partial-output-smoke-v3.json) | One bounded format correction | One correct write, zero duplicates | `needs_input` after five planner calls | Yes, with passing browser checks | 110.449 s | 93,900 / 1,085 |

The first two attempts exposed a practical failure: a completed business write did not produce the requested deliverable because Codex returned an invalid JSON-encoded argument string. The adapter now allows one extra inference call **only** for that format error. No browser tool from the malformed decision runs, and usage from both inference calls is counted. Attempt 3 used that correction once and published the checked partial; its extra model call cost about 32.8 s and 32,400 reported input tokens relative to attempt 2. Those differences are observations across separate attempts, not a causal performance estimate.

The independent judge saw exactly one server write of `29` in each attempt. Attempt 3's partial data matched that server record, and its retained `tab_verify` result included passing value and text checks. The report kept `status: "needs_input"`, so the partial was not promoted to final success. All three source/build hashes were unchanged within their respective runs. The attempts were visible during development, used different source revisions, and do not estimate a success rate or show superiority over Browser Use Pi.

Conditions: `gpt-6-astra`, reasoning effort `ultra`, Codex CLI `0.155.0-alpha.9.2`, local Chrome, isolated extraction fixture seed 23, 180-second task deadline, 12 planning steps, 30 tool calls, and no browser-action retries. Whole-run time includes CLI launch, browser startup, inference, tools and cleanup; it excludes the subsequent independent judge. Reported usage is not a billing ledger and may omit failed model calls without usage. The partial Schema required one nonnegative numeric `total` and no other fields; it did not reveal the expected value.

Reproduce from the matching source and build (starts real model inference):

```sh
npm run build
node bench/codex-partial-output-smoke.mjs \
  --model gpt-6-astra --reasoning-effort ultra \
  --codex-command /absolute/path/to/codex --channel chrome \
  --output /absolute/path/to/new-attempt.json
```

The output path must be new. The runner records failures as well as accepted runs. Raw SHA-256 values: attempt 1 `6b94a31a136f2a86eecfac181a9d8f8c65812511262890cea1be5a5f6a0b9c2e`, attempt 2 `96329ce5caa23eda87edafa67c1737f658fe701dea955849120d6d04f15e72a8`, attempt 3 `2018e2e6bb3ae1668974662e98d66e58f434380bdeca6c1f3a330c4b55ea8fbd`.

这三次真实 Codex 尝试均由服务端确认只正确写入一次；前两次在交付中途结果前因模型参数字符串格式错误而失败。加入一次有界格式纠正后，第三次发布了与服务端一致、带通过检查记录的中途结果，并按要求返回 `needs_input`。这不是与 Browser Use 的同题对比，也不能据此估计长期成功率。
