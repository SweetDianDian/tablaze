# Four-task matched development smoke

Date: 2026-09-24. Two independent matched runs used the **clean committed source** `8eae6c566a77e48ba57d69bc34ca26ed21e1c2fd` before the optional recording implementation. The source-tree SHA-256 in both reports is `b7c1f454dc023f48201245f7a9e138fc0bc33a1cb5bcc57a7ac3bfed01228e66`. Each task/engine pair had a fresh isolated Chrome 153.0.8010.53 browser and fixture reset. Both agents used `gpt-6-astra` at `ultra` through the same Codex CLI inference bridge, with a 160,000 reported-token ceiling, 40 planning steps, a 240-second deadline, trusted Tablaze start URL and Browser Use's default post-task judge. The Browser Use Python Agent was pinned to version 0.13.10, commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`.

| Task, one attempt per engine | Tablaze complete / business | Browser Use complete / business | Tablaze full run / model calls | Browser Use full run / model calls |
| --- | --- | --- | ---: | ---: |
| iframe form, seed 41 | pass / 1 correct write | pass / 1 correct write | 83.799 s / 5 | 52.515 s / 3 |
| interrupted order response, seed 41 | pass / 1 order, 0 duplicates | pass / 1 order, 0 duplicates | 65.939 s / 4 | 78.520 s / 4 |
| virtual list, seed 42 | pass / VIRTUAL-130 once | pass / VIRTUAL-130 once | 74.301 s / 4 | 118.083 s / 5 |
| visual canvas, seed 42 | pass / blue region once | pass / blue region once | 54.428 s / 4 | 66.514 s / 3 |

All eight attempts independently passed the fixture's server-side business judge, completed their Agent run successfully, and returned before the deadline. The canvas traces show a Tablaze `tab_capture` and a real image attachment to the model bridge; the server recorded the resulting coordinates `(210, 120)`, within the blue target. Browser Use clicked `(250, 130)`, also within the target. The virtual-list fixture held only nearby DOM rows; both agents reached and reserved `VIRTUAL-130` exactly once.

The iframe trace explains Tablaze's slower sample: its first `tab_open` snapshot listed a child frame before the child document loaded, requiring `tab_snapshot` in a second model round. It then checked for the entered value as visible page text, which did not match, and used another snapshot and verification before finishing. The incorrect text check did not repeat the write. This identifies a concrete initial-frame observation and planning-efficiency target, not a demonstrated reliability difference.

These are visible development fixtures and **one attempt per engine per task**. Browser Use's default judge is included in its wall time, model calls and token totals; Tablaze has no equivalent post-task model judge in this run. The bridge has unverified temperature and per-call output controls, and the agents have different tool-call ceilings. Both results report `superiorityProven: false`. Four passes apiece do not establish equal production reliability, a stable speed advantage, or the full goal of exceeding Browser Use.

The unmodified [seed 41 report](evidence/current-four/seed41.json) has SHA-256 `68ab9a9f825d201dc6fd4d38e887da59c1109087034956975c212ec4209c8c57`; the [seed 42 report](evidence/current-four/seed42.json) has SHA-256 `247801b0361e847a897a9d6b2935e42ea5627e0931b81a90f55c897aab4a11a4`. [Trace index](evidence/current-four/README.md) links all eight unmodified traces. The new recording feature was implemented afterward and therefore is not covered by these model measurements.

中文结论：四个可见开发任务中，双方各四次完整成功且服务端验收通过。Tablaze 的 iframe 样本明显较慢，其他三题的全程时间较短；每题仅一次，且 Browser Use 默认评审计入总量，因此不能据此宣称整体功能或效率已超过 Browser Use。
