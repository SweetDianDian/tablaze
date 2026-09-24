# Current iframe task: three paired Codex development runs

Date: 2026-09-24. Clean Tablaze source `41988eefbae940db144f58eabec5db410642d46d` (empty patch SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`) was compared with Browser Use Python Agent 0.13.10 pinned to `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`. Both used signed-in Codex CLI `0.155.0-alpha.9.2`, `gpt-6-astra / ultra`, the same 50,000-reported-token per-attempt gate, 40 steps and a 240-second deadline. Tablaze was explicitly given the trusted start URL and `follow-single`; Browser Use retained its default post-task judge. Engine order alternated across seeds. Each attempt reset the fixture and used a fresh Chrome browser.

The visible synthetic task was to save the note **Vega** through a child iframe. Its independent server judge required exactly one accepted `Vega` write and no duplicates. All six attempts passed business, Agent completion and deadline axes.

| Seed | Tablaze whole / Agent done (s) | Browser Use whole / Agent done (s) | Tablaze / Browser Use model calls | Accepted writes each |
| --- | ---: | ---: | ---: | ---: |
| 90 | 49.516 / 49.377 | 57.159 / 40.853 | 3 / 3 | 1 / 1 |
| 91 | 33.331 / 33.192 | 52.687 / 37.193 | 2 / 3 | 1 / 1 |
| 92 | 34.469 / 34.322 | 55.111 / 39.283 | 2 / 3 | 1 / 1 |

The three-pair median whole run was **34.469 s Tablaze versus 55.111 s Browser Use**; median Agent-done time was **34.322 versus 39.283 s**. Browser Use's default model judge ran after Agent completion and is included in its whole-run time and model-call total. Tablaze's Agent was still slower on seed 90: its model asked for `text` to contain `Vega`, but the text check excludes input values. That post-check failed after 5.012 s, and the next model call correctly used a `value` check. On the other two seeds, the first `tab_open` result already selected the child iframe and the Agent completed in two model calls. The source changes that provided first-frame selection and post-check guidance predate this measurement; this report adds evidence, not a new code optimization.

This is one public development task with three seeds, no held-out distribution and no matched Pi/Harness/cloud comparison. Codex CLI has unverified per-call temperature and output-token controls. No p95, broad parity, or superiority is established. The earlier iframe latency sample was on older code and must not be combined with these rows as if they were repeated current runs.

The unmodified [runner result](evidence/iframe-current-20260924/results.json) has SHA-256 `31883e033f5a204c404980e66a9cbd967bc82626d27d973135edabf2ba74b594`. Raw traces: [seed 90 Tablaze](evidence/iframe-current-20260924/iframe-form-0-tablaze.json), [seed 90 Browser Use](evidence/iframe-current-20260924/iframe-form-0-browser-use.json), [seed 91 Tablaze](evidence/iframe-current-20260924/iframe-form-1-tablaze.json), [seed 91 Browser Use](evidence/iframe-current-20260924/iframe-form-1-browser-use.json), [seed 92 Tablaze](evidence/iframe-current-20260924/iframe-form-2-tablaze.json), [seed 92 Browser Use](evidence/iframe-current-20260924/iframe-form-2-browser-use.json).
