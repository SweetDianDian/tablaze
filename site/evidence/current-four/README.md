# Four-task development evidence

The reports below are copied without rewriting from `artifacts/comparison/` after their runs. They pin committed source `8eae6c5`, fixture hashes, model/adapter settings, independent server-side outcomes and all transport requests. The traces are synthetic local browser tasks; paths and random loopback ports reflect the run environment. [Interpretation and limits](../../CODEX_CURRENT_FOUR_SMOKE.md).

| Run | Report | Tablaze traces | Browser Use traces |
| --- | --- | --- | --- |
| Seed 41 | [results](seed41.json) | [iframe](iframe-form-0-tablaze.trace.json), [order](duplicate-write-0-tablaze.trace.json) | [iframe](iframe-form-0-browser-use.trace.json), [order](duplicate-write-0-browser-use.trace.json) |
| Seed 42 | [results](seed42.json) | [virtual list](virtual-list-0-tablaze.trace.json), [canvas](canvas-0-tablaze.trace.json) | [virtual list](virtual-list-0-browser-use.trace.json), [canvas](canvas-0-browser-use.trace.json) |
