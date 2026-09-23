# Virtual-list Codex comparison: one matched development task

2026-09-23. **Both engines completed the same virtual-list task once under the 120,000-token setting. This does not establish overall superiority.** The earlier 50,000-token attempts are reported separately below because the shared benchmark gateway rejected later requests at its own budget limit.

The fixture keeps only seven rows in the DOM at a time. The task asks the agent to find `VIRTUAL-130` and create exactly one reservation. The independent server judge checks the persisted record and duplicate-write count, separate from the agent's completion claim. The new `tab_find` primitive searches a bounded page or observed scroll container and returns a fresh actionable snapshot; the scripted harness now contains 14 tasks. This matched run measures autonomous Codex behavior, not the scripted adapter.

| 120,000-token attempt | Tablaze | Browser Use |
| --- | ---: | ---: |
| Independent business / Agent success / before deadline | All passed | All passed |
| Correct records / duplicate writes | 1 / 0 | 1 / 0 |
| End-to-end wall time | 86.830 s | 141.597 s |
| Model calls / tool calls | 6 / 5 | 5 / 5 |
| Input / output tokens | 93,209 / 944 | 91,929 / 2,746 |

Wall time starts at the common external deadline boundary and includes startup, adapter return, cleanup, independent judging and gateway teardown. Browser Use retained its default post-task model judge. Its 16,056 input / 241 output judge tokens are **already included** in its totals. Tablaze used `initializeUrl=false` and popup policy `stay`. Browser Use's additional judge and the frameworks' different step/tool limits mean the timing and token columns are not a controlled measure of browser-engine efficiency. One paired sample cannot establish stable speed or success-rate advantage.

The same fixture was also attempted under a 50,000-token gateway budget. With `gpt-6-astra`/`ultra`, both server judges saw one correct record and no duplicates, but Tablaze's next planner call received HTTP 429 from the **comparison gateway's cumulative token budget**, so only Browser Use reported complete Agent success. With `gpt-5.6-luna`/`high`, Tablaze again reached the correct business state but hit that budget before reporting completion; Browser Use hit the budget before writing a record. These are budget-truncated development attempts, not account-quota failures and not interchangeable with the completed pair.

Both engines used local Chrome at 1280×800, Codex CLI `0.155.0-alpha.9.2` with the existing ChatGPT login, and the same Codex inference bridge and per-pair budget. Browser Use was pinned at `0.13.10`, commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`. The bridge has its own fixed instructions; its temperature and per-call output controls are unverified. The task was visible during development, each engine ran once per setting, and no confidence interval is possible. The pointer-default adjustment made after these runs changes visual presentation only, but the recorded source and patch digests remain those measured at run time.

The [public evidence extract](evidence/codex-virtual-list-smoke-v1.json) includes each attempt's judge state, completion axis, timing, usage, settings, measured source tree and patch digest, and the SHA-256 of the full local raw result. The raw reports and traces are retained locally in `artifacts/comparison/2026-09-23T04-40-39-976Z/`, `2026-09-23T04-44-50-211Z/`, and `2026-09-23T04-49-24-304Z/`; those generated artifacts are not part of the public source tree.

To run a new attempt, use a fresh output directory and the pinned baseline dependencies documented in [the comparison harness](https://github.com/SweetDianDian/tablaze/blob/main/bench/comparison/README.md):

```sh
node bench/comparison/runner.mjs --engine matched --transport codex \
  --model gpt-6-astra --reasoning-effort ultra \
  --python /private/tmp/tablaze-comparison-env/bin/python \
  --tasks virtual-list --repeat 1 --max-steps 40 --max-tool-calls 150 \
  --timeout-ms 180000 --token-budget 120000 \
  --tablaze-initialize-url false --tablaze-popup-policy stay \
  --browser-use-judge true --output artifacts/comparison/a-new-output-directory
```
