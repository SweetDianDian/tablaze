# Read-only listbox raw evidence

The [report](results.json) is a byte-for-byte copy of the runner output (SHA-256 `47bd01494cbda8f9e0df85b561326b19525b0deebe51b485a2b79a7db0b3ccfd`). Each linked trace is also copied without editing. Index 0 is seed 70, index 1 is seed 71, and index 2 is seed 72.

| Seed | Tablaze | Browser Use |
| --- | --- | --- |
| 70 | [trace](readonly-listbox-0-tablaze.trace.json) | [incomplete, Codex transport cancellation](readonly-listbox-0-browser-use.trace.json) |
| 71 | [trace](readonly-listbox-1-tablaze.trace.json) | [trace](readonly-listbox-1-browser-use.trace.json) |
| 72 | [trace](readonly-listbox-2-tablaze.trace.json) | [trace](readonly-listbox-2-browser-use.trace.json) |

The fixture is local and synthetic. Independent server writes determine business acceptance; Agent completion and complete-run return are separate axes. Browser Use's default post-task judge contributes to its whole-run time on successful tasks.
