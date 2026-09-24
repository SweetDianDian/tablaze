# Three-task, two-seed raw evidence

The [report](results.json) is a byte-for-byte copy of the runner output (SHA-256 `39f731d3dc94c79f659854f674d09cc163d822fc1b54e7bb652ddaf412948f94`). Each linked trace is also copied without editing. Index `0` is seed 60; index `1` is seed 61.

| Task | Seed 60 Tablaze / Browser Use | Seed 61 Tablaze / Browser Use |
| --- | --- | --- |
| New-tab approval | [Tablaze](popup-0-tablaze.trace.json) / [Browser Use](popup-0-browser-use.trace.json) | [Tablaze](popup-1-tablaze.trace.json) / [Browser Use](popup-1-browser-use.trace.json) |
| Child-iframe form | [Tablaze](iframe-form-0-tablaze.trace.json) / [Browser Use](iframe-form-0-browser-use.trace.json) | [Tablaze](iframe-form-1-tablaze.trace.json) / [Browser Use](iframe-form-1-browser-use.trace.json) |
| Network receipt | [Tablaze](network-receipt-0-tablaze.trace.json) / [Browser Use, incomplete](network-receipt-0-browser-use.trace.json) | [Tablaze](network-receipt-1-tablaze.trace.json) / [Browser Use, incomplete](network-receipt-1-browser-use.trace.json) |

The fixtures are local and synthetic. `results.json` records independent server-side acceptance; Agent-reported completion, end-to-end return and transport errors are separate axes. Browser Use's default post-task judge contributes to its whole-run time on successful tasks.
