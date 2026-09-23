# Four-task, two-seed raw evidence

The [report](results.json) is a byte-for-byte copy of the comparison runner output (SHA-256 `cda7cf0190600e44b206319bf81a80534b4339877edddd5b384b588a3e8fefac`). Each linked trace is likewise copied without editing. Index `0` is seed 52; index `1` is seed 53.

| Task | Seed 52 Tablaze / Browser Use | Seed 53 Tablaze / Browser Use |
| --- | --- | --- |
| Form | [Tablaze](form-0-tablaze.trace.json) / [Browser Use](form-0-browser-use.trace.json) | [Tablaze](form-1-tablaze.trace.json) / [Browser Use](form-1-browser-use.trace.json) |
| Virtual list | [Tablaze](virtual-list-0-tablaze.trace.json) / [Browser Use](virtual-list-0-browser-use.trace.json) | [Tablaze](virtual-list-1-tablaze.trace.json) / [Browser Use](virtual-list-1-browser-use.trace.json) |
| Canvas | [Tablaze](canvas-0-tablaze.trace.json) / [Browser Use](canvas-0-browser-use.trace.json) | [Tablaze](canvas-1-tablaze.trace.json) / [Browser Use](canvas-1-browser-use.trace.json) |
| Interrupted-response order | [Tablaze](duplicate-write-0-tablaze.trace.json) / [Browser Use](duplicate-write-0-browser-use.trace.json) | [Tablaze](duplicate-write-1-tablaze.trace.json) / [Browser Use](duplicate-write-1-browser-use.trace.json) |

The fixtures are local, synthetic and visible to the adapters. The Browser Use traces include its default judge; report `completion.agentDoneAtMs` separates that post-Agent work from Agent completion.
