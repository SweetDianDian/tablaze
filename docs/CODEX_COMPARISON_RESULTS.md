# Codex comparison smoke — 2026-09-22

**Tablaze has not demonstrated superiority.** On these two development tasks, both engines produced the intended business state without duplicate writes. Browser Use completed both runs normally; Tablaze completed the popup run normally but hit its deadline before returning a final completion on the form run.

这轮结果暴露了 Tablaze 的规划和验收效率差距，不能解释成双方完整任务成功率都是 100%。

| Task | Engine | Independent business outcome | Agent result | Time | Model calls | Input / output tokens |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Form | Tablaze | Passed, one correct write | Deadline before final completion | 180.334 s | 7 | 111,243 / 2,155 |
| Form | Browser Use | Passed, one correct write | Succeeded | 78.013 s | 3 | 50,848 / 750 |
| Popup | Tablaze | Passed, one approval | Succeeded | 144.497 s | 7 | 116,363 / 1,144 |
| Popup | Browser Use | Passed, one approval | Succeeded | 98.203 s | 4 | 70,990 / 955 |

Normal completion **and** independent acceptance: Tablaze 1/2, Browser Use 2/2. Neither engine falsely reported success or produced duplicate writes in this sample. A Tablaze verification succeeded before the form deadline, but the subsequent finish decision was not accepted before the deadline. The cancelled inference's reported usage is retained.

## Conditions and evidence

- Browser Use 0.13.10, pinned commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`; official source-archive SHA-256 and [installed dependencies](evidence/browser-use-environment.txt) are retained.
- Tablaze unreleased local development tree; the [raw report](evidence/codex-matched-smoke-v1.json) records exact source/dist/lock/task/judge hashes. Later improvements must use new reports rather than overwrite this result.
- Both retain their own complete Agent execution loop. One shared inference bridge invokes Codex CLI 0.155.0-alpha.9.2 with model `gpt-6-astra`, reasoning effort `ultra`, existing CLI-managed ChatGPT authentication and HTTP transport. No separate provider key is used.
- Same installed Chrome 153.0.8010.53, isolated profiles, viewport 1280×800, task seed 1, 12 planning steps, 180-second task limit and 250,000 reported-token stopping budget per attempt. The tool-call ceiling currently applies only to Tablaze; output-token and temperature controls are unverified in the CLI bridge.
- Server records judge submitted values and exact write counts, independently of model summaries. [Derived analysis](evidence/codex-matched-smoke-analysis.json) distinguishes business state from normal Agent completion and hashes the unchanged raw report. Original full traces remain in `artifacts/comparison/codex-matched-smoke-v1/` locally.

The two tasks are visible development fixtures, each attempted once per engine. Order was Tablaze then Browser Use for each pair. This is not a frozen randomized experiment, confidence interval, cost-price comparison, or general success-rate estimate. Tokens include the Codex CLI instruction wrapper. Small-sample timings must not be generalized to other tasks, models or network conditions.

## Findings to address

The form trace shows a general interface problem: the planner checked input values using page-text assertions, but page text deliberately excludes raw form values. It then used two structured-extraction calls to discover selectors before switching to correct value assertions. Ref-based value checks and clearer tool descriptions can reduce that detour without weakening acceptance.

The popup trace performed an extra snapshot between an action and verification. Future work should reduce unnecessary observation rounds while preserving fresh references and explicit verification. Both changes need unknown-task regressions and new matched runs; this report must remain unchanged.

```sh
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /tmp/tablaze-comparison-env/bin/python \
  --tasks form,popup --repeat 1 --max-steps 12 --max-tool-calls 30 \
  --timeout-ms 180000 --token-budget 250000 --output artifacts/comparison/NEW_RUN
```

See [setup and transport boundaries](../bench/comparison/README.md) and the [full comparison contract](BROWSER_USE_COMPARISON.md).
