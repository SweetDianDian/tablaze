# First canvas image: four matched Codex development pairs

Date: 2026-09-24. Tablaze ran from the clean commit `07a362dba22b242e611df20b8b6109650fe6c36a` (empty patch SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, source-tree SHA-256 `c7c25b8d674226657d9d08b026e2b5a01e6a46aef8d050b89e18ccbf006b46dc`). Browser Use Python Agent was pinned to 0.13.10, commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`. Each attempt used reset fixture state and isolated Chrome; engine order alternated. Both used the same `gpt-6-astra / ultra` Codex CLI inference bridge, a reported 160,000-token ceiling, 40 planning steps and a 240-second deadline. Tablaze initialized the task URL and used `follow-single`. Browser Use's default post-task judge was enabled.

| Seed | Tablaze full / Agent done | Browser Use full / Agent done | Independent server verdict |
| --- | ---: | ---: | --- |
| 54 | 43.948 / 43.801 s | 60.709 / 37.814 s | Both pass; one write each |
| 55 | 39.932 / 39.776 s | 61.113 / 42.578 s | Both pass; one write each |
| 56 | 41.552 / 41.401 s | 64.981 / 44.344 s | Both pass; one write each |
| 57 | 41.495 / 41.360 s | 95.883 / 64.720 s | Tablaze passes with one write; Browser Use fails with **two writes, one duplicate** |

Tablaze passed independent business acceptance, Agent completion and full return **4/4**. Browser Use reported Agent success and returned within the deadline **4/4**, but passed independent business acceptance only **3/4**. On seed 57 its trace first dispatched a canvas click through `evaluate`, then issued a second `click` after the immediate page text still read `Ready`. The server accepted both clicks. Its final report claimed one click and success, so the independent outcome is a **false success**; neither the second write nor this failure is omitted from the dataset.

In all four Tablaze traces, `tab_open` returned an MCP JPEG image with viewport-CSS coordinates, and the model next chose `tab_act.click_xy` directly. **No Tablaze trace called `tab_capture`**. Each Tablaze attempt used three model planning calls (`tab_act`, `tab_verify`, finish after the initialized open) and one accepted write. This directly validates the removed separate capture call on this fixture. The preceding-source canvas attempts used four calls, but their seeds and run time differed, so subtracting latencies across the two studies is not a controlled causal speed estimate.

On the **three jointly successful seeds 54–56**, median whole-run time was **41.552 s Tablaze versus 61.113 s Browser Use**, and median Agent-done time was **41.401 versus 42.578 s**. Tablaze's Agent was slower on seed 54 and faster on seeds 55–56. Browser Use made one default judge model call after Agent completion in every attempt; that work is included in whole-run time, not Agent-done time. The failed seed 57 is reported above and excluded from the jointly successful timing median, not treated as a slow successful Browser Use run. The runner exited nonzero because its all-axes outcome contract detected that business failure, not because preflight or the comparison infrastructure failed.

This is one visible synthetic canvas fixture with four development pairs. The Codex CLI bridge adds its own instructions and lacks verified per-call temperature/output-token controls. These observations do not estimate production success probability, p95 latency, or whole-product superiority across Browser Use's Agent, MCP, Harness, Pi and hosted surfaces. More tasks and repetitions, including visual pages with ordinary controls and changing imagery, remain necessary.

The unmodified [runner report](evidence/canvas-initial-vision-20260924/results.json) has SHA-256 `de480183edbc1a3b0b5c51c3671fc6a8dfe49f098e02451a6cf12ff037d15423`. The [trace index](evidence/canvas-initial-vision-20260924/README.md) links all eight model-visible trajectories, including the failed Browser Use seed 57.

中文结论：四组同模型画布对照中，Tablaze 业务验收 4/4，Browser Use 3/4。Tablaze 四次首次打开均直接给出截图，省去独立 `tab_capture`，每次三轮规划、一次正确写入。Browser Use 种子 57 重复点击，服务端记录两次写入，虽然后续 Agent 宣告成功，独立验收仍判失败。共同成功的三组全程中位数为 41.552 对 61.113 秒，Agent 完成中位数为 41.401 对 42.578 秒；Browser Use 默认评审只计入全程。单一可见开发任务不足以证明稳定性能或整体领先。
