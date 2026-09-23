# Four-pair canvas evidence

The [runner report](results.json) is copied byte-for-byte from the comparison output (SHA-256 `de480183edbc1a3b0b5c51c3671fc6a8dfe49f098e02451a6cf12ff037d15423`). The eight traces are likewise unedited. Index `0` is seed 54 through index `3` for seed 57.

| Seed | Tablaze | Browser Use |
| --- | --- | --- |
| 54 | [trace](canvas-0-tablaze.trace.json) | [trace](canvas-0-browser-use.trace.json) |
| 55 | [trace](canvas-1-tablaze.trace.json) | [trace](canvas-1-browser-use.trace.json) |
| 56 | [trace](canvas-2-tablaze.trace.json) | [trace](canvas-2-browser-use.trace.json) |
| 57 | [trace](canvas-3-tablaze.trace.json) | [trace](canvas-3-browser-use.trace.json) — Agent-reported success but two server writes |

The fixture and adapter are visible development work. Server records, Agent completion and full-run return are separate fields in the runner report.
