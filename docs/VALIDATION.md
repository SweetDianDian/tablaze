# Preview validation / 预览版验证记录

Date: 2026-09-22. These results describe this checkout and machine only.

## Observed results / 已观察结果

- TypeScript build: passed.
- Browser + stdio protocol suite: 21 tests passed, 0 skipped, 0 failed; one additional targeted CDP ownership test passed after the suite (22 tests verified in total).
- Tests include real navigation/form input, independent URL/DOM checks, output budgets, sensitive field masking, old revisions, replaced nodes, changed labels, an overlay, mutation during actionability waiting, changed base URL, dynamic sensitive-field substitution, batch partial failure, diffs, open shadow DOM, frame selection, session isolation, FIFO operations, real JPEG capture, SDK handshake, cancellation, total batch deadline, CDP connection error redaction and CLI diagnostics.
- CDP ownership: tested against a newly launched temporary-profile browser. Disposing the engine closed only its own page; pre-existing pages, storage, pending form state and the external browser remained usable.
- Separate Jev examples have six offline tests. They do not validate a real Jev API call or establish Tablaze compatibility with Jev.
- Clean source ZIP installation: Node 20.16.0, 22.17.0 and 26.8.1 each passed npm ci, build, doctor and all 22 tests (66 total, none skipped). [Machine-readable evidence](evidence/clean-install.json) binds this check to its exact archive SHA-256. Installation used the existing npm cache and installed Chrome.
- Release archives add documentation, demo and release tooling after that matrix. [Equivalence evidence](evidence/release-equivalence.json) confirms unchanged core source, tests, lockfile and TypeScript settings, plus 15 byte-identical compiled runtime files. Compared with the tested archive, the package manifest changes its publication allowlist and public repository metadata (`bugs`, `homepage`, `repository`); the later ZIP itself was not re-run through the three-runtime matrix.
- The GitHub upload adds repository metadata and public documentation links without changing the browser runtime. Historical tests remain bound to their recorded archive/source hashes; these metadata updates do not constitute another installation or browser test run.
- Runtime: macOS (darwin arm64), installed Chrome 153.0.8010.53. Browser instances are isolated test processes.
- CI for Linux / Node 20 and 22 is prepared; its first hosted result after the initial GitHub push is pending.

## Local performance / 本机性能

[Raw report](../bench/results/latest.json) and [method](../bench/README.md).

| Metric / 指标 | Median / 中位数 | Samples / 样本 |
| --- | ---: | ---: |
| Cold browser + first page + snapshot / 冷启动及首个页面快照 | 415.013 ms | 5 |
| Warm snapshot / 会话内快照 | 6.326 ms | 15 |
| Four-action batch / 四步操作批次 | 240.455 ms | 5 |
| Outcome verification / 结果验证 | 10.805 ms | 5 |
| Warm snapshot JSON UTF-8 bytes / 快照字节 | 1,401 bytes | 15 |

Five of five runs passed independent outcome checks. The engine is called in-process. These timings exclude MCP transport, model inference, browser installation, and internet websites. A cold sample uses a fresh browser process, not an empty operating-system cache. Byte counts are not token counts. Five runs of one local form do not demonstrate reliability on arbitrary sites or superiority over competing products.

五次运行均通过独立结果验证。测量直接调用浏览器引擎，不含 MCP 传输、模型推理、浏览器安装或外网访问；冷启动指新建浏览器进程，不是清空系统缓存。字节数不是 token 数。这些结果不能推出任意网站上的成功率，也不能证明优于其他产品。

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

The bilingual page passed browser checks for language switching, a four-step illustrative replay, keyboard tab navigation, real clipboard copying, FAQ interaction, raw measurement loading and no horizontal overflow at 390, 768 and 1440 pixels. No JavaScript page errors were observed. This is a local preview result; it does not claim a public deployment.

## Package checks / 安装包检查

The actual preview tarball was installed outside the source checkout using locally cached dependencies. The executable reported version 0.1.0; doctor found the installed Chrome. Public module imports succeeded. A real SDK client then drove the installed stdio server through navigation, input, independent assertions, extraction, screenshot and close (one targeted test passed). The final archive was inspected for expected entrypoints, documentation and absence of node_modules, credentials and build scratch files.

## Reproducible demo / 可复现演示

A normal-speed recording presents actual SDK responses and browser screenshots. The video is 56.08 seconds at 1440×900; labelled reading pauses are excluded from individual tool durations. The run includes a four-action hotel batch, five independent checks, replacement-node rejection, fresh-observation recovery and zero remaining sessions. It does not contain model inference or a continuous controlled-tab video feed. [Recorder](../demo/README.md) · [Recorded request evidence](evidence/demo-run.json).

The introduction page was updated with this playable video and larger body text; 390/768/1440 pixel layouts and both languages passed checks, with no JavaScript page errors.

## Real Codex acceptance / Codex 实际验收

A real Codex CLI 0.154.0 model selected six MCP calls, completed four form actions and passed five URL/title/text/value/count checks, then closed its session and confirmed zero remaining sessions. It used read-only filesystem sandboxing and invocation-only on-request/auto_review settings, with no global configuration change or approval bypass. The initial default non-interactive policy rejected navigation; both outcomes are preserved in the [sanitized evidence](evidence/codex-e2e.json). This is one local fixture task, not a performance benchmark or arbitrary-site reliability result.

## Remaining evidence / 待补证据

- Windows/Linux and alternate Chrome/Edge channel results.
- Matched third-party benchmark comparisons.
- Internet-site reliability, long-running sessions, heavy pages and popup/file workflows.
- Broader Codex end-to-end coverage across client versions and external websites.
- Real Jev API execution (separate optional example, not part of Tablaze).

The public [GitHub repository](https://github.com/SweetDianDian/tablaze) has been created and its first source push is being prepared. npm is not published. No third-party adoption, star count or successful Linux CI result is claimed here.
