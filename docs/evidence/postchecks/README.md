# Original reports and traces

These are synthetic local fixture runs from [the action post-check study](../../CODEX_POSTCHECKS_SMOKE.md). Each `results.json` copy is byte-identical to its run artifact. Report JSON keeps local `tracePath` strings as historical metadata; use the portable links below to inspect the corresponding copies. The data includes source/build and task/judge hashes, per-arm settings, independent write counts, model usage, and phase outcomes. No attempt is a held-out or repeated product-wide ranking.

| Run | Report | Tablaze trace | Browser Use trace |
| --- | --- | --- | --- |
| Initial matched Shadow DOM and menu | [JSON](shadow-menu-codex-v1.json) | [Shadow](shadow-menu-codex-v1-shadow-form-0-tablaze.trace.json), [menu](shadow-menu-codex-v1-dynamic-menu-0-tablaze.trace.json) | [Shadow](shadow-menu-codex-v1-shadow-form-0-browser-use.trace.json), [menu](shadow-menu-codex-v1-dynamic-menu-0-browser-use.trace.json) |
| Feature present, not chosen | [JSON](shadow-menu-codex-postchecks-v1.json) | [Shadow](shadow-menu-codex-postchecks-v1-shadow-form-0-tablaze.trace.json), [menu](shadow-menu-codex-postchecks-v1-dynamic-menu-0-tablaze.trace.json) | [Shadow](shadow-menu-codex-postchecks-v1-shadow-form-0-browser-use.trace.json), [menu](shadow-menu-codex-postchecks-v1-dynamic-menu-0-browser-use.trace.json) |
| First Shadow DOM adoption, one check fails | [JSON](shadow-postchecks-adoption-v1.json) | [Trace](shadow-postchecks-adoption-v1-shadow-form-0-tablaze.trace.json) | — |
| Corrected Shadow DOM adoption | [JSON](shadow-postchecks-adoption-v2.json) | [Trace](shadow-postchecks-adoption-v2-shadow-form-0-tablaze.trace.json) | — |
| Dynamic-menu follow-up | [JSON](menu-postchecks-adoption-v1.json) | [Trace](menu-postchecks-adoption-v1-dynamic-menu-0-tablaze.trace.json) | — |
