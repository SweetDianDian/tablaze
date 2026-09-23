# Delayed named target evidence

These are unchanged copies of local `artifacts/comparison/<run>/results.json` and each arm's `trace.json`. The source commit field names the base Git commit; `patchSha256` and `sourceTreeSha256` record the actual uncommitted runtime state for the two development revisions. Report paths inside the raw JSON remain local capture paths; use the portable trace filenames below.

| Run | Raw report | Tablaze trace | Browser Use trace |
| --- | --- | --- | --- |
| Seed 35, Shadow DOM | [report](shadow-menu-postchecks-final-v1.json) | [trace](shadow-menu-postchecks-final-v1-shadow-form-0-tablaze.trace.json) | [trace](shadow-menu-postchecks-final-v1-shadow-form-0-browser-use.trace.json) |
| Seed 35, delayed menu | [same report](shadow-menu-postchecks-final-v1.json) | [trace](shadow-menu-postchecks-final-v1-dynamic-menu-0-tablaze.trace.json) | [trace](shadow-menu-postchecks-final-v1-dynamic-menu-0-browser-use.trace.json) |
| Seed 36, role-bearing action | [report](dynamic-menu-click-named-v1.json) | [trace](dynamic-menu-click-named-v1-dynamic-menu-0-tablaze.trace.json) | [trace](dynamic-menu-click-named-v1-dynamic-menu-0-browser-use.trace.json) |
| Seed 37, role-free action | [report](dynamic-menu-click-named-v2.json) | [trace](dynamic-menu-click-named-v2-dynamic-menu-0-tablaze.trace.json) | [trace](dynamic-menu-click-named-v2-dynamic-menu-0-browser-use.trace.json) |

No trace was removed for being slower or for the failed role guess. Independent server state in each report is the authority for the one-write, zero-duplicate outcome.
