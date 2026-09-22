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

The bilingual page passed browser checks for language switching, a four-step illustrative replay, keyboard tab navigation, real clipboard copying, FAQ interaction, raw measurement loading and no horizontal overflow at 390, 768 and 1440 pixels. No JavaScript page errors were observed. These checks used the local preview.

## Package checks / 安装包检查

The actual preview tarball was installed outside the source checkout using locally cached dependencies. The executable reported version 0.1.0; doctor found the installed Chrome. Public module imports succeeded. A real SDK client then drove the installed stdio server through navigation, input, independent assertions, extraction, screenshot and close (one targeted test passed). The final archive was inspected for expected entrypoints, documentation and absence of node_modules, credentials and build scratch files.

## Reproducible demo / 可复现演示

A normal-speed recording presents actual SDK responses and browser screenshots. The video is 56.08 seconds at 1440×900; labelled reading pauses are excluded from individual tool durations. The run includes a four-action hotel batch, five independent checks, replacement-node rejection, fresh-observation recovery and zero remaining sessions. The recording presents the SDK trace and browser screenshots; model-driven acceptance is recorded separately below. [Recorder](../demo/README.md) · [Recorded request evidence](evidence/demo-run.json).

The introduction page was updated with this playable video and larger body text; 390/768/1440 pixel layouts and both languages passed checks, with no JavaScript page errors.

## Real Codex acceptance / Codex 实际验收

A real Codex CLI 0.154.0 model selected six MCP calls, completed four form actions and passed five URL/title/text/value/count checks, then closed its session and confirmed zero remaining sessions. The task used read-only filesystem sandboxing with invocation-only on-request/auto_review settings. The [sanitized evidence](evidence/codex-e2e.json) records the client, tool calls, results and an earlier navigation rejection. Coverage is one local fixture task through the CLI.

## Remaining evidence / 待补证据

- Windows and alternate Chrome/Edge channel results; additional Linux distributions beyond the Ubuntu CI runner.
- Matched third-party benchmark comparisons.
- Internet-site reliability, long-running sessions, heavy pages and popup/file workflows.
- Broader Codex end-to-end coverage across client versions and external websites, including desktop UI acceptance. Current model-driven evidence is from Codex CLI.
- Real Jev API execution (separate optional example, not part of Tablaze).

Source is public in the [GitHub repository](https://github.com/SweetDianDian/tablaze), with a passing [Ubuntu CI run](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909). npm publication is pending.
