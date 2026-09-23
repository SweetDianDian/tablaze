# Iframe feedback: three matched Codex development attempts

Date: 2026-09-24. The tested source was the clean committed `0cfad5a6af82c5a66b591068d61e7d3db0d8f9d1` after preserving the operated child frame in failed `tab_act.post_checks` feedback. The report records empty patch SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` and source-tree SHA-256 `b7a268ca12a027d8dd69dcb86412ac369d01e13ff6fe18743970fe3e8f558596`. Browser Use Python Agent was pinned to 0.13.10, commit `d8110c5ff87ccba887aaa726cdb780f2f84bef8d`. Both engines used fresh isolated Chrome fixtures, `gpt-6-astra / ultra` through the same Codex CLI bridge, a 160,000 reported-token ceiling, 40 planning steps and a 240-second deadline. Tablaze initialized the caller-supplied URL and used `follow-single`; Browser Use's default post-task judge stayed enabled. The single run used seeds 46–48.

| Seed | Tablaze full run / Agent done | Browser Use full run / Agent done | Model calls | Independent server result |
| --- | ---: | ---: | --- | --- |
| 46 | 46.037 / 45.880 s | 52.353 / 38.345 s | Tablaze 3; Browser Use 3 including 1 judge | Both passed; one correct write each, zero duplicates |
| 47 | 48.027 / 47.863 s | 56.132 / 39.114 s | Tablaze 3; Browser Use 3 including 1 judge | Both passed; one correct write each, zero duplicates |
| 48 | 44.858 / 44.704 s | 58.262 / 41.916 s | Tablaze 3; Browser Use 3 including 1 judge | Both passed; one correct write each, zero duplicates |

All six attempts completed their Agent run, passed the independent fixture judge, and returned before the deadline. Each Tablaze trace shows `tab_open`, one explicit child-frame `tab_snapshot`, and one `tab_act` with a form-value check plus a `Saved` text check. The post-checks passed. None of these models made the redundant `Vega` page-text check seen in the [previous seeds 44–45](CODEX_IFRAME_READINESS_SMOKE.md), so these runs did **not** exercise the new failed-check feedback path. Its behavior is instead established by the real-Chrome MCP regression in the [development status](https://github.com/SweetDianDian/tablaze/blob/main/docs/DEVELOPMENT_STATUS.md). The new comparison is a fresh-source outcome, not a controlled estimate of this patch's causal speed effect.

Across these three visible pairs, median whole-run time was **46.037 s for Tablaze versus 56.132 s for Browser Use** (ratio 0.82), but median observed Agent-done time was **45.880 s versus 39.114 s** (Tablaze 1.17× as long). Browser Use's default judge and other post-done work count in whole-run time, explaining why the rankings differ. The provisional 1.25× target is met on the observed Agent-done medians for this one fixture; it is not a statistically supported parity result. Both sides used three model calls in each run, but one Browser Use call was judging after Agent completion. The earlier three pairs used a different committed source and different seeds; subtracting their medians from these is not a controlled before/after improvement.

The Codex CLI bridge still lacks verified per-call temperature and output-token controls. Different framework prompts, tool affordances and default judging remain part of the product comparison. Three development-fixture pairs cannot establish production median or p95, reliability parity, or overall capability superiority. More diverse held-out tasks and matched runs are required.

The unchanged [raw report](evidence/iframe-feedback/results.json) has SHA-256 `97c45c1aca635437b0dd6aae041eea0efd76ff51c1fe7622d8d5c94eee274b6a`. [Trace index](evidence/iframe-feedback/README.md) links all six raw trajectories.

中文结论：三组同模型 iframe 对照双方业务均通过、没有重复写入。Tablaze 全程中位数较短，但 Agent 宣告完成的中位数仍比 Browser Use 长约 17%；对方的默认评审计入全程。新反馈修复的失败路径在这三组中没有触发，不能把时间差归因于该修复，也不能据此声称总体效率或功能超过 Browser Use。
