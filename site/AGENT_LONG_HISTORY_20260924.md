# Agent long-history development measurement — 2026-09-24

The Agent now proactively compacts older complete tool groups before the serialized planning history exceeds 256 KiB. It retains the original task, trusted operator messages, six recent groups and active verification or ambiguous-write evidence. `historyCompaction: false` restores full history up to the 16 MiB hard cap; callers can change `triggerBytes` and `keepRecentGroups`.

The [repeatable benchmark](https://github.com/SweetDianDian/tablaze/blob/main/bench/agent-long-history.mjs) made 200 local planning decisions and 199 changing, read-only snapshot calls with a 2,048-character observation in each result. Both modes ran the same code and workload; `full` disabled proactive compaction. Five fresh Node processes per mode ran sequentially on the same host. The [ten raw JSON rows](evidence/agent-long-history-20260924.jsonl) have SHA-256 `c7e183c82a0b619f0c125d30a2fd2b6deeb5b65f00af5ad4189cfd9e1aa7ee2f`. Medians are:

| Local metric | Full history | Default proactive compaction | Change |
| --- | ---: | ---: | ---: |
| Final planner-input JSON bytes | 923,672 | 245,454 | −73.4% |
| Sum of planner-input JSON bytes across 200 calls | 92,687,070 | 28,337,798 | −69.4% |
| Wall time for whole no-model run | 424.542 ms | 144.259 ms | −66.0% |
| Tool dispatches / final status | 199 / `needs_input` | 199 / `needs_input` | unchanged |

Run with `node bench/agent-long-history.mjs 200 2048 full` or replace `full` with `default`. The planner-input byte sum is **not** provider prompt tokens: models may tokenize, cache or trim history differently. This benchmark excludes Chrome, network, model inference, DOM traversal, real task quality and Browser Use. The wall-time difference is local executor work for this fixture only. It does not establish Browser Use parity or a production speedup.

The focused recovery regression checks that an old successful verification remains citable after compaction and that a resulting checkpoint parses. A separate case protects trusted operator steering from being omitted. The [full Node 24 + Chrome log](evidence/development-tests-long-history-node24.txt) records **495/495 passed** (SHA-256 `73a812e5041400ab48eaa9b3f268a860f405c2ac41b93318511893576f9271cd`). Actual model behavior on long tasks, prompt-token usage and current Browser Use latency remain to be measured with matched browser tasks and independent outcome judges.
