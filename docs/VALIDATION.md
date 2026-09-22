# Preview validation / 预览版验证记录

Date: 2026-09-22. Results below identify their environment and the source or archive they tested.

## Observed results / 已观察结果

- TypeScript build: passed.
- Browser + stdio protocol suite: 21 tests passed, 0 skipped, 0 failed; one additional targeted CDP ownership test passed after the suite (22 tests verified in total).
- Tests include real navigation/form input, independent URL/DOM checks, output budgets, sensitive field masking, old revisions, replaced nodes, changed labels, an overlay, mutation during actionability waiting, changed base URL, dynamic sensitive-field substitution, batch partial failure, diffs, open shadow DOM, frame selection, session isolation, FIFO operations, real JPEG capture, SDK handshake, cancellation, total batch deadline, CDP connection error redaction and CLI diagnostics.
- CDP ownership: tested against a newly launched temporary-profile browser. Disposing the engine closed only its own page; pre-existing pages, storage, pending form state and the external browser remained usable.
- Separate Jev examples have six offline tests. They do not validate a real Jev API call or establish Tablaze compatibility with Jev.
- Clean source ZIP installation: Node 20.16.0, 22.17.0 and 26.8.1 each passed npm ci, build, doctor and all 22 tests (66 total, none skipped). [Machine-readable evidence](evidence/clean-install.json) binds this check to its exact archive SHA-256. Installation used the existing npm cache and installed Chrome.
- Release archives add documentation, demo and release tooling after that matrix. [Equivalence evidence](evidence/release-equivalence.json) confirms unchanged core source, tests, lockfile and TypeScript settings, plus 15 byte-identical compiled runtime files. Compared with the tested archive, the package manifest changes its publication allowlist and public repository metadata (`bugs`, `homepage`, `repository`); the later ZIP itself was not re-run through the three-runtime matrix.
- Runtime: macOS (darwin arm64), installed Chrome 153.0.8010.53. Browser instances are isolated test processes.
- GitHub Actions on Ubuntu passed for Node 20 and 22 with managed Chromium: locked dependency installation, build, browser/MCP tests and package dry run. [Run](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) · [Machine-readable record](evidence/linux-ci.json). Both jobs completed at 2026-09-22T06:53:17Z on commit [`579631a`](https://github.com/SweetDianDian/tablaze/commit/579631abb53ccf2bca027d07ccc09b990fab3b27).

## Local performance / 本机性能

[Raw report](../bench/results/latest.json) and [method](../bench/README.md).

| Metric / 指标 | Median / 中位数 | Samples / 样本 |
| --- | ---: | ---: |
| Cold browser + first page + snapshot / 冷启动及首个页面快照 | 415.013 ms | 5 |
| Warm snapshot / 会话内快照 | 6.326 ms | 15 |
| Four-action batch / 四步操作批次 | 240.455 ms | 5 |
| Outcome verification / 结果验证 | 10.805 ms | 5 |
| Warm snapshot JSON UTF-8 bytes / 快照字节 | 1,401 bytes | 15 |

Five of five runs passed independent outcome checks. Timings measure in-process engine calls on one local form, excluding MCP transport, model inference, browser installation and internet latency. Cold samples start a fresh browser process with the operating-system cache intact. Payload size is measured in UTF-8 bytes.

五次运行均通过独立结果验证。计时范围为单一本地表单上的进程内引擎调用，不含 MCP 传输、模型推理、浏览器安装或外网延迟。冷启动使用新建浏览器进程，保留系统缓存；输出体积以 UTF-8 字节计。

## Reproduce / 复现

From the source checkout:

```sh
npm ci
npm run build
node dist/cli.js setup
npm test
npm run bench
```

To use already installed Chrome, replace setup with `node dist/cli.js doctor --channel chrome`, and prefix the test/benchmark command with `TABLAZE_BROWSER_CHANNEL=chrome`.

Packaged CLI users should download the source archive to run the development suite and benchmark. The preview tarball also includes source and fixtures for inspection; the source archive includes the development lockfile and CI configuration for reproducible development.

## Website checks / 网站检查

The earlier bilingual page passed browser checks for language switching, a four-step illustrative replay, keyboard tab navigation, real clipboard copying, FAQ interaction, raw measurement loading and no horizontal overflow at 390, 768 and 1440 pixels. No JavaScript page errors were observed. These historical checks used the local preview and do not validate the expanded demo player described below.

## Package checks / 安装包检查

The actual preview tarball was installed outside the source checkout using locally cached dependencies. The executable reported version 0.1.0; doctor found the installed Chrome. Public module imports succeeded. A real SDK client then drove the installed stdio server through navigation, input, independent assertions, extraction, screenshot and close (one targeted test passed). The final archive was inspected for expected entrypoints, documentation and absence of node_modules, credentials and build scratch files.

## Complete travel demo / 完整差旅演示

The normal recording completed on 2026-09-22 at 15:23:24 UTC with `status: passed` and `quick_mode: false`, using Node.js 25.9.0 and Chrome 153.0.8010.53 on macOS arm64. It is 125.6 seconds at 1440×900, including 121 seconds of labelled reading holds. [Recorder and method](../demo/README.md) · [Complete request evidence](evidence/demo-run.json).

One continuous localhost workflow passed the following checks:

- A six-action form batch applied all travel filters; the fixture server counted one search. Five browser assertions passed for URL, title, text, field value and result count.
- Replacing the observed approval button produced `STALE_REFERENCE` and zero completed actions. At that point, independent server counters recorded zero popup visits, submissions and orders.
- A fresh snapshot supplied the replacement reference. Explicit `follow-single` policy followed the owned popup; four approval actions completed, three receipt assertions passed, and the server recorded exactly one submission and one order.
- The downloaded CSV was 145 bytes and matched the expected contents and SHA-256. Both owned tabs were closed with their session; `tab_list` returned zero remaining sessions and the server's stderr was empty.

The report records 22 MCP tool calls, eight passing browser assertions and 2,367.54 ms in summed tool-call durations. Those durations exclude presentation holds and model inference. This single local scripted run is not an internet performance benchmark or a Browser Use comparison.

本次正式录制通过验收：同一条差旅流程完成六步批次、五项结果检查、旧引用拒绝且无审批写入、重新观察恢复、弹窗内四步审批、三项回执检查，以及 CSV 实际字节和哈希核对。最终一份订单、一个已核对文件、两个自有标签页关闭，剩余会话为零。视频长 125.6 秒，含 121 秒讲解停留；22 次 MCP 调用的耗时合计仅描述本地样本。

The workflow is driven by a deterministic MCP SDK script with no model inference. The video records a presentation of actual responses and `tab_capture` screenshots, not a continuous feed from the controlled browser tab. Fixture counters and local file reads are independent recorder checks, not additional MCP tools. No external booking or payment occurs. Historical development-suite results (including the 353-test run) and model/Browser Use reports retain their own source versions and scope; this recording does not rerun or extend those results.

流程由确定性的 MCP SDK 脚本驱动，未调用模型。录像呈现真实响应与截图，并非被控浏览器标签页的连续视频流；服务器计数与本地文件读取是录制器的独立检查，不是额外 MCP 工具。历史 353 项测试及模型、Browser Use 对照仍对应各自版本，不能作为本次视频的新结果。

### Expanded website QA / 新版演示页面验收

The local Chrome checks passed at 390, 768 and 1440 pixels in both languages, with zero page errors or horizontal overflow. All seven chapters sought to their reported times and updated the active state; language switching retained progress. Overlay playback, native pause, Enter/Space controls, reduced-motion behavior and no autoplay passed. Missing-report playback, disabled-demo loading and failed-video download fallback also passed. A complete accelerated decode check reached the end of the unchanged 125.6-second media without a video error; playback rate was reset to one. [Website QA evidence](evidence/demo-site-qa-v2.json).

新版页面已通过本地 Chrome 验收：390 / 768 / 1440 像素、中英文、七章跳转与高亮、切换语言保留进度、原生暂停和键盘操作均通过，无横向溢出或页面错误。缺少报告、关闭演示、视频加载失败的回退路径，以及不自动播放和减少动画偏好已检查。视频完整解码至结尾没有错误；加速仅用于校验，发布视频未修改。

## Real Codex acceptance / Codex 实际验收

A real Codex CLI 0.154.0 model selected six MCP calls, completed four form actions and passed five URL/title/text/value/count checks, then closed its session and confirmed zero remaining sessions. The task used read-only filesystem sandboxing with invocation-only on-request/auto_review settings. The [sanitized evidence](evidence/codex-e2e.json) records the client, tool calls, results and an earlier navigation rejection. Coverage is one local fixture task through the CLI.

## Remaining evidence / 待补证据

- Windows and alternate Chrome/Edge channel results; additional Linux distributions beyond the Ubuntu CI runner.
- Matched third-party benchmark comparisons.
- Internet-site reliability, long-running sessions, heavy pages and popup/file workflows.
- Broader Codex end-to-end coverage across client versions and external websites, including desktop UI acceptance. Current model-driven evidence is from Codex CLI.
- Real Jev API execution (separate optional example, not part of Tablaze).

Source is public in the [GitHub repository](https://github.com/SweetDianDian/tablaze), with a passing [Ubuntu CI run](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909). npm publication is pending.
