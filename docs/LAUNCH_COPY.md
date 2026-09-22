# Tablaze launch copy / 闪页首发审稿

Draft date: 2026-09-22. Current status: developer preview, version 0.1.0. The public [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze) repository has been created and its initial source push is being prepared. npm publication and the first Linux CI result are pending. The copy below remains a review draft; other URL fields stay unset until their destinations exist.

草稿日期：2026-09-22。当前为 0.1.0 开发者预览版；公开 [GitHub 仓库](https://github.com/SweetDianDian/tablaze)已创建，正在准备首次源码推送。npm 尚未发布，首次 Linux CI 结果待确认。以下仍为审稿内容，其他链接仅在真实目标建立后填写。

## Short introduction / 短介绍

### English

**Tablaze — Small snapshots. Warm sessions. Clear outcomes.**

Give your MCP coding agent a browser loop you can inspect. Tablaze keeps browser sessions running, returns compact page snapshots with element references, and executes an ordered batch of actions in one tool call. Then `tab_verify` checks the actual URL and page state.

Try a complete local task: fill a destination, choose three nights, select free cancellation, and submit the form. See which steps completed, inspect the result, and verify the filters. When a reference is stale, refresh the snapshot before continuing.

Built with Playwright. Eight stdio MCP tools, temporary isolated sessions by default, and explicit CDP attachment when you need an existing browser profile. Tablaze itself requires no model API key. Start from the source quickstart and reproduce the included benchmark.

### 中文

**Tablaze / 闪页 — 快照更精简，会话持续就绪，结果可以验证。**

让 MCP 编程助手拥有一个可以检查每一步的浏览器工作流。Tablaze 持续运行浏览器会话，返回带元素引用的精简页面快照，并在一次工具调用中顺序执行多步操作。随后用 `tab_verify` 检查真实 URL 和页面状态。

从一个完整的本地任务开始：填写目的地、选择三晚、勾选免费取消、提交表单。你能看到哪些步骤已经完成，读取结果，并核验筛选条件。引用过期时，重新观察页面再继续。

Tablaze 基于 Playwright，提供八个 stdio MCP 工具，默认使用临时隔离会话；需要现有浏览器 profile 时可显式连接 CDP。Tablaze 本身无需模型 API Key。按源码快速开始安装，再运行仓库中的基准复现结果。

## GitHub descriptions / GitHub 简介

Each single-line description below is within GitHub's 350-character limit. Use one language per repository description; keep the other in its corresponding README.

每条单行简介均不超过 350 字符。仓库简介选择一种语言，另一种放在对应 README 中。

**English**

```text
Compact browser MCP for coding agents. Warm sessions, guarded element refs, ordered action batches, and explicit outcome checks. Built with Playwright; isolated by default, with optional CDP attachment. Includes a reproducible local benchmark.
```

**中文**

```text
Tablaze / 闪页：为编程 Agent 提供精简的浏览器 MCP。持续会话、元素引用检查、顺序动作批次与明确结果验收。基于 Playwright，默认隔离，可显式连接 CDP；附可复现的本地基准。
```

## Evidence caption / 可选证据说明

Use this beside the raw report, not as a universal speed headline. These are observed measurements from the 2026-09-22 local run, not a timing promise for the demonstration below.

这段说明适合放在原始报告旁。数值来自 2026-09-22 本机运行，不是通用速度标题，也不是下方演示的耗时承诺。

> Local fixture, real Chrome: 5/5 runs passed independent URL/DOM checks. Median process-cold open: 415.013 ms; warm snapshot: 6.326 ms across 15 observations; four-action batch: 240.455 ms; outcome verification: 10.805 ms. Warm snapshots serialized to 1,401 UTF-8 JSON bytes. Apple M3 Max, macOS arm64, Node 26.8.1, Playwright 1.63.0, Chrome 153.0.8010.53. Engine calls only; MCP transport, model inference, installation and internet latency are excluded. Bytes are not tokens.

> 本地 fixture、真实 Chrome：5/5 次运行通过独立 URL/DOM 验收。中位数：新进程冷启动 415.013 ms；15 次会话内快照 6.326 ms；四步动作批次 240.455 ms；结果验收 10.805 ms。快照序列化为 1,401 UTF-8 JSON 字节。环境为 Apple M3 Max、macOS arm64、Node 26.8.1、Playwright 1.63.0、Chrome 153.0.8010.53。计时仅包含直接引擎调用，不含 MCP 传输、模型推理、安装和外网延迟；字节数不是 token 数。

Source: [raw report](../bench/results/latest.json), [measurement method](../bench/README.md), [validation record](VALIDATION.md). Before publication, pin the report to the release commit and check its `source_sha256` values against the candidate artifacts. Do not silently reuse these numbers after changing the measured build.

依据：[原始报告](../bench/results/latest.json)、[测量方法](../bench/README.md)、[验证记录](VALIDATION.md)。发布时将报告固定到对应提交，并核对候选产物的 `source_sha256`；测量版本变化后重新取数。

## 90-second recording script / 90 秒实拍脚本与字幕

This is a shot plan, not an existing recording or proof that Codex selected these calls autonomously. Record actual stdio MCP requests and responses next to the visible browser. Use a client that permits explicit tool calls for the deliberate stale-revision scene. A later recording driven by a Codex prompt should identify the real client/model and retain its actual tool choices.

这是分镜草稿，不是已录制视频，也不代表 Codex 已自主选择过这些调用。实拍时并排展示真实 stdio MCP 调用、响应和可见浏览器；故意使用旧版本的片段需要能明确指定工具参数的客户端。后续如改用 Codex 提示词驱动，应注明真实客户端、模型，并保留实际工具选择。

### Before recording / 录制前

1. Follow the [English](CODEX.md) or [Chinese](CODEX.zh-CN.md) setup guide. For a visible isolated browser, start the server with `--headed` and the selected browser mode. Build and install the browser before recording; label the opening frame “Setup completed before recording / 已提前完成安装”。
2. From the source root, start the fixture with the command below. Keep its terminal running, and copy the printed URL. In this script, `FIXTURE_URL` means that actual origin; it is not a fixed port or a public hotel service.
3. Show the server and client versions. Record at normal speed. If a tool call takes longer than its scene, extend the recording or mark the cut; do not accelerate it to imply lower latency.

先按接入指南完成构建和可见浏览器配置，再从源码根目录运行以下命令。保留终端，复制输出的本地地址；所有 `FIXTURE_URL` 都替换为这个真实地址。正常速度录制，超时则延长或标明剪辑。

```sh
node --input-type=module -e '
import { startFixture } from "./tests/fixture.mjs";
const fixture = await startFixture();
console.log(fixture.url);
const stop = async () => { await fixture.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
'
```

Stop this fixture with Ctrl+C after closing the demo sessions. All IDs and refs used below must come from actual tool responses; the script does not prescribe their generated values.

演示会话关闭后用 Ctrl+C 停止 fixture。下列所有 ID 和 ref 都取自实际响应，不预设生成值。

| Time / 时间 | Actual picture and calls / 实际画面与调用 | English subtitle | 中文字幕 |
| --- | --- | --- | --- |
| 00–08 | Show version and the configured local stdio command, then the fixture browser window. / 显示版本、本地 stdio 命令及 fixture 浏览器。 | Tablaze gives your MCP agent a browser loop: observe, act, verify. | Tablaze 为 MCP Agent 提供浏览器工作流：观察、操作、验收。 |
| 08–20 | `tab_open` at `FIXTURE_URL/`. Highlight `session_id`, `snapshot_id`, and the four control refs with names and roles. / 打开表单，标出会话、版本及四个控件引用。 | A compact snapshot gives each observed control a reference. | 精简快照为观察到的控件提供引用。 |
| 20–34 | One `tab_act`: fill Destination `Lisbon`; select Nights `["3"]`; check Free cancellation `true`; click Search stays. Show the four completed results and real navigation. / 一次批次完成四步，展示逐步结果和真实跳转。 | Four ordered actions in one tool call. Each step has a result. | 一次调用顺序执行四步，每一步都有结果。 |
| 34–47 | `tab_verify`: exact results URL, filter text, destination value and result count. Keep `passed: true` and the checks visible. / 检查精确 URL、筛选文字、字段值和结果数量。 | Verify the URL and page state before calling the task complete. | 验收真实 URL 和页面状态，再报告完成。 |
| 47–56 | `tab_extract` with `kind: "table"`; show the real Casa Flora, Lisbon, 3 row. / 读取表格并展示真实返回行。 | Extract the result as structured data. | 将结果读取为结构化数据。 |
| 56–71 | Open `FIXTURE_URL/lab?token=demo`, save snapshot A; call `tab_snapshot` to mint B; attempt Target action using A. Show `STALE_SNAPSHOT`, then verify Target count stays 0. / 新快照产生后故意用旧快照操作，显示拒绝与未变化计数。 | This revision is old. The action stops before the click. | 这个快照版本已过期，操作在点击前停止。 |
| 71–82 | Take a fresh full snapshot, click the currently observed Target action, verify `Target count: 1`. / 重新观察、使用当前引用点击，再检查计数。 | Observe again, then continue with the current reference. | 重新观察，再使用当前引用继续。 |
| 82–90 | `tab_close` both sessions, then `tab_list` shows no owned sessions. Display the verified repository and benchmark links after they exist. / 关闭两个会话，显示空列表及已确认的真实链接。 | Try the local workflow. Inspect the code. Reproduce the benchmark. | 运行本地流程，检查源码，复现基准。 |

The results URL assertion must be exactly `FIXTURE_URL/results?destination=Lisbon&nights=3&flexible=yes`. Other checks: text contains `3 nights · Free cancellation`; `#destination` has value `Lisbon`; `[data-hotel="casa-flora"]` has count `1`. Select the input by its observed role and name; a snapshot may also contain its label.

URL 断言必须包含完整 origin 和上述查询参数。其他断言检查筛选文字、目的地字段和唯一结果；输入框使用观察到的 role/name 选择，因为快照也可能包含同名 label。

The stale scene demonstrates revision validation. DOM replacement and changes during actionability waiting are separate cases in [browser tests](../tests/browser.test.mjs); do not label this scene as proof of every race condition.

旧快照片段展示版本校验；节点替换及等待期间的语义变化由独立[浏览器测试](../tests/browser.test.mjs)覆盖，字幕应准确描述当前画面。

## Three newcomer issue drafts / 三条新手 Issue 草稿

These are proposed issues, not already-open GitHub issues. Recheck scope against the release branch before creating them. Suggested labels: `good first issue`, `help wanted`; create labels only when the repository exists.

以下是待审草稿，不是已创建的 Issue。正式创建前对照发布分支确认仍有需要。每项均有明确入口和验收条件。

### 1. Add a one-command local demo fixture / 增加一条命令启动演示页面

**Problem / 问题：** The hotel demo exists in `tests/fixture.mjs`, but recording it currently needs the inline Node command above. A contributor should be able to open the same deterministic page without reading the test harness. / 演示页面已存在，但独立启动还需要内联 Node 命令；首次贡献者应能直接打开它。

**Scope / 范围：** Add `examples/demo-fixture.mjs` that imports `startFixture()`, prints the loopback URL, and closes the server on SIGINT/SIGTERM. Add an `npm run demo` script and a short English/Chinese instruction. Reuse the existing page; keep the ephemeral port and loopback binding. Do not add a second fixture or start a browser automatically. / 增加薄启动入口、脚本和双语说明，复用现有页面及临时端口。

**Done when / 验收：** From a built checkout, the command prints a usable URL; the hotel form and `/lab` load; Ctrl+C stops the process and releases the listener. An ordinary `npm test` run still passes. Submit the commands and observed outcomes. / 地址可访问，两个页面可用，退出释放端口，现有测试通过；提交实际检查记录。

**Starting points / 入口：** `tests/fixture.mjs`, `package.json`, this recording script. Intended as a small developer-experience change. / 适合首次参与的开发体验改动。

### 2. Cover multi-part accessible labels in an open shadow root / 补充开放 Shadow DOM 多段标签回归

**Problem / 问题：** Snapshot naming reads `aria-labelledby` from the element's root, but the current shadow fixture only covers a button's text content. The combination of two referenced labels and a duplicate ID outside the shadow root lacks a focused regression. / 当前实现会在元素所在 root 读取 `aria-labelledby`，现有 Shadow DOM 测试只覆盖按钮文本；多段标签及 root 外同 ID 的组合缺少专门回归。

**Scope / 范围：** Add a small local fixture with a button inside an open shadow root, two local label IDs, and a conflicting ID in the light DOM. Exercise it through `BrowserEngine`; select the observed button by role/name and click its ref. / 增加最小本地页面，经真实引擎按观察名称定位并点击。

**Done when / 验收：** The snapshot name contains the two intended label texts in order, excludes the outside text, and a real click updates a visible counter. The new test does not inspect private engine state or assert an entire snapshot string. Run it with managed Chromium or the documented isolated Chrome configuration. / 名称顺序正确、不混入外部文字，点击改变真实计数；不依赖内部状态或整段快照字符串。

**Starting points / 入口：** `src/snapshot.ts`, `tests/fixture.mjs`, `tests/browser.test.mjs`. This is a missing regression, not a confirmed current defect. If it reveals a defect, attach the failure before proposing a narrowly scoped fix. / 这是覆盖缺口；若暴露缺陷，先保留复现，再提出聚焦修复。

### 3. Render a benchmark report into a shareable Markdown summary / 将基准报告转成可分享的 Markdown

**Problem / 问题：** `bench/run.mjs` produces raw JSON and archives every run. Copying figures into release notes by hand can lose the attempt count or timing boundaries. / 基准已有完整 JSON，但手工抄到发布记录时容易遗漏总尝试数和测量范围。

**Scope / 范围：** Add a small Node script accepting a report path and printing Markdown to stdout. Include run date, environment, attempted/succeeded/failed counts, median/count pairs from the successful-sample summary, failed stages, and the report's measurement boundaries. Do not rerun a browser, modify the input report, estimate tokens or compare competitors. / 小脚本读取指定报告，输出环境、全部尝试计数、成功样本分布、失败阶段与计时边界。

**Done when / 验收：** A completed report produces the same numbers as its JSON; a failed or interrupted report remains visibly labelled; absent summaries and malformed JSON have useful handling with a nonzero exit for invalid input. Add small fixture-based tests for these cases and a command in `bench/README.md`. / 正确保留成功和失败信息，缺项有明确处理，非法输入非零退出，附小型数据测试与用法。

**Starting points / 入口：** `bench/run.mjs`, `bench/README.md`, `bench/results/latest.json`. No browser or model key is needed for the formatter tests. / 摘要工具测试无需浏览器或模型 Key。

## FAQ / 常见问题

**What can I use today? / 现在能用什么？**

Build the source from [GitHub](https://github.com/SweetDianDian/tablaze) with Node.js 20+, then use the [Codex integration guide](CODEX.md) or the eight standard stdio MCP tools from another compatible client. A local package has been exercised through a real MCP SDK client; one real Codex CLI model-selected local task also passed, as recorded in the [validation evidence](VALIDATION.md). The first hosted Linux CI result is pending. / 可从 GitHub 获取源码并按[中文 Codex 指南](CODEX.zh-CN.md)接入。已有真实 MCP SDK 验证和一次 Codex CLI 模型自主调用的本地任务验证，范围见[验证记录](VALIDATION.md)；首次托管 Linux CI 结果仍待确认。

**Is this Jev? Does it need a Jev key? / 这是 Jev 吗？需要 Jev Key 吗？**

Tablaze is a Playwright-based browser MCP. Your MCP client supplies the reasoning. Jev is not integrated, and no Jev/model key is required by this server. The Jev tutorial and task-level MCP example in the parent learning directory are separate work. / Tablaze 基于 Playwright，由 MCP 客户端负责推理，目前未接入 Jev；上级学习目录的 Jev 教程和任务级 MCP 示例是另一实现。

**Will it use my signed-in Chrome? / 会使用我已登录的 Chrome 吗？**

Default sessions are temporary and isolated. `--channel chrome` chooses the installed executable and launches separate browser resources. `--cdp-url` explicitly attaches to an existing Chromium endpoint; owned pages then share that profile's storage and login state. `tab_list` lists only Tablaze-owned sessions. / 默认会话临时隔离，指定 Chrome 渠道只选择程序。显式 CDP 模式会共享目标 profile 的存储和登录状态；列表只显示 Tablaze 自己的会话。

**What happens when the third step fails? / 第三步失败后会怎样？**

Steps one and two may already have changed the page. The batch stops, marks the failed step, and skips the remainder; it does not roll back. Batches allow 1–20 actions, with a 30-second total budget by default and 60 seconds maximum. Active cancellation or budget expiry closes the owned session to interrupt work, while completed side effects remain. / 前两步可能已生效。批次报告完成、失败和跳过状态，没有回滚；取消或总预算耗尽会关闭正在工作的自有会话，但不撤销已产生的副作用。

**What do refs and verification guarantee? / 引用检查和验收能保证什么？**

Refs bind observations to a session, snapshot revision and DOM target. Stale revisions and changed targets require another observation. Checks reduce incorrect input but are not atomic with a page's JavaScript. `tab_verify` reports only the assertions you chose; checking a heading does not prove that a remote business operation committed. / 引用绑定会话、快照版本和 DOM 目标，过期后需重新观察；检查与页面脚本并非原子执行。验收只证明所选断言，标题出现不等于远端业务操作已提交。

**Does a small snapshot mean lower token costs? / 快照小就等于 token 费用更低吗？**

Element/text budgets and diffs make payload size controllable. The current benchmark reports UTF-8 JSON bytes, not model tokens or invoices. A tokenizer-specific measurement and an end-to-end client run would be needed for a token-cost claim. A diff needs its named baseline; ask for a full snapshot when that baseline is unavailable. / 预算和差量可控制输出体积；当前测量的是 JSON 字节，token 或费用结论仍需指定模型分词器与真实客户端运行。没有对应基线时应取完整快照。

**Which pages are supported? / 支持哪些页面？**

Current browser support is Chromium. The fixture suite covers ordinary DOM controls, open shadow roots and explicitly selected frames. The snapshot is a compact DOM view, not a complete accessibility tree. File upload/download workflows, closed shadow roots, native dialogs and popup/new-tab workflows are not supported; screenshots can show canvas content, but there is no coordinate-click tool. / 当前支持 Chromium，覆盖普通 DOM、开放 Shadow DOM 和显式选中的 frame；不支持上传下载流程、关闭的 Shadow DOM、原生对话框与弹窗新标签流程。可截图观察 canvas，但没有坐标点击工具。

**Are snapshots safe to send to any model? / 快照能随意发给任何模型吗？**

Password and hidden input values are omitted from snapshots, and sensitive value checks are rejected. Normal page text, URLs, other field values and screenshots can still include private content. Choose pages and a client/model according to the data you intend to share. / 快照省略密码和隐藏输入值，拒绝敏感值检查；普通文字、URL、其他字段和截图仍可能包含私人内容，应按数据用途选择页面及客户端。

**Can I install from npm right now? / 现在能直接从 npm 安装吗？**

This preview has no public npm release. Use the source or the locally supplied tarball and its exact path. Add a registry installation command only after the package owner, version and public artifact have been verified. / 当前使用源码或本地提供的安装包；公开包、归属和版本核验后再写 registry 安装命令。

## Real URLs to fill before publication / 公开发布前待填链接

The repository and contribution routes are now known. Other unset fields are not live destinations; no placeholder should become a public button or installation instruction. Source-file links can be finalized after the first push, and evidence links should be pinned to their corresponding commit/tag.

仓库与贡献入口已确认，其余未填写字段不是可用链接，不生成公开按钮或安装指令。源码文件链接在首次推送后确认，证据优先固定到对应提交或版本。

| Field / 字段 | Current value / 当前值 | Verify before using / 使用前核验 |
| --- | --- | --- |
| `REPOSITORY_URL` | [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze) | Public repository created; initial source push in preparation. / 公开仓库已创建，首次源码推送准备中。 |
| `RELEASE_URL` | Unset / 待填 | Real tag/version, downloadable artifact and release notes. / 真实标签、可下载产物与发布说明。 |
| `NPM_PACKAGE_URL` | Unset / 待填 | Published package owner, exact version and installed contents. Omit until published. / 包归属、版本和安装内容；未发布则不展示。 |
| `WEBSITE_URL` | Unset / 待填 | Public HTTPS page, working EN/中文 links and actual installation commands. / 可访问页面、语言切换与真实安装命令。 |
| `DEMO_VIDEO_URL` | Unset / 待填 | Actual recording, visible version, normal-speed/cut labels and accurate captions. / 真实视频、版本及准确字幕。 |
| `BENCHMARK_REPORT_URL` | Unset / 待填 | Raw JSON pinned to its measured commit, alongside methodology. / 与测量提交一致的原始报告及方法。 |
| `VALIDATION_URL` | Unset / 待填 | Published validation record with remaining gaps intact. / 保留待验证事项的验证记录。 |
| `CI_RUN_URL` | Unset / 待填 | A real hosted run for the release candidate, not the workflow file alone. / 发布候选的真实托管运行。 |
| `CONTRIBUTING_URL`, `ISSUES_URL`, `PULL_REQUESTS_URL` | [Contribution guide](../CONTRIBUTING.md) · [Issues](https://github.com/SweetDianDian/tablaze/issues) · [Pull requests](https://github.com/SweetDianDian/tablaze/pulls) | The guide and templates become available with the first source push. / 指南和模板随首次源码推送提供。 |
| `SECURITY_REPORT_URL` | [Private vulnerability report](https://github.com/SweetDianDian/tablaze/security/advisories/new) | GitHub private reporting enabled and verified; aligned with `SECURITY.md`. / GitHub 私密报告已启用并验证，与安全说明一致。 |

Editorial references / 审稿依据：[product contract](PRODUCT_SPEC.md), [MCP tool schemas](../src/server.ts), [browser engine](../src/browser.ts), [snapshot implementation](../src/snapshot.ts), [fixtures](../tests/fixture.mjs), [launch plan](LAUNCH_PLAN.md).
