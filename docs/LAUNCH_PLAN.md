# Tablaze launch and adoption plan / 闪页发布与采用计划

Status: preparation plan. This document does not mean a repository, npm package, website, external announcement or user study has been published. Proposed numbers below are working goals for a small launch cohort, not achieved results or forecasts.

状态：发布准备计划。本文件不代表已发布 GitHub 仓库、npm 包、网站、对外公告或用户研究。下述数量是小范围首发的工作目标，不是已有成绩或增长预测。

The ambition is a useful open-source project that can earn tens of thousands of GitHub stars. The controllable work is a short path to a verified browser task, honest evidence, reliable maintenance and a welcoming contribution path. Stars are an outcome to observe, not a release guarantee.

愿景是做出有机会赢得数万 GitHub Star 的开源项目。可以落实的工作是让用户迅速完成可验收的浏览器任务、公开证据、持续维护，并让贡献者容易参与。Star 是需要观察的结果，不是发布承诺。

## Positioning / 定位

**English:** A compact browser MCP with persistent sessions, guarded element references and verifiable action batches.

**中文：** 精简的浏览器 MCP，提供持续会话、受检查的元素引用，以及可核验的动作批次。

Lead with one complete workflow: observe a local hotel form, submit four actions, verify the applied filters and result. Demonstrate a stale reference stopping before input. An action batch is sequential and stops on error; already completed actions remain applied.

首屏展示一个完整流程：观察酒店表单、提交四步动作、检查筛选条件与结果，再展示过期引用如何在输入前停止。批次按顺序执行，遇错即停；已完成的动作仍然生效。

Tablaze uses Playwright and exposes browser tools to an MCP client. It does not currently integrate the Jev model or run an autonomous Jev planner. The local Jev tutorial and its task-level MCP adapter are separate projects.

Tablaze 基于 Playwright，向 MCP 客户端提供浏览器工具；目前没有接入 Jev 模型或自主 Jev planner。同目录的 Jev 教程与任务级 MCP 适配器是另一实现。

## Release gates / 首发门槛

Each gate needs current evidence for the exact candidate commit or package. Keep gates open until that evidence exists; do not copy a previous green result onto changed code. The release maintainer records the date, version, command and artifact.

每项门槛都要有候选提交或包的当前证据；没有证据就保留待完成状态，代码变化后不能沿用旧的通过记录。发布维护者记录日期、版本、命令和产物。

| Gate / 门槛 | Evidence required / 所需证据 | Owner role / 责任角色 |
| --- | --- | --- |
| Fresh installation / 全新安装 | A clean checkout succeeds with `npm ci`, browser setup, build and a verified task; record any manual steps. / 从干净目录完成安装、浏览器准备、构建和验收，记录手动步骤。 | Release maintainer / 发布维护者 |
| Real engine + MCP / 真实引擎与协议 | Linux Node 20 and 22 CI runs `npm test` with managed Chromium; at least one target desktop client completes open → observe → act → verify → close. / 双版本 CI 使用管理的 Chromium；至少一个桌面客户端完成全流程。 | Core maintainer / 核心维护者 |
| Failure behavior / 失败语义 | Evidence for stale/replaced targets, occlusion, partial batches, sensitive-value handling, isolation and shutdown; unresolved defects are documented or fixed. / 对引用失效、遮挡、部分失败、敏感值、隔离及关闭留证，处理未解决缺陷。 | Core maintainer / 核心维护者 |
| Package contents / 包内容 | Inspect `npm pack --dry-run`; create and inspect the candidate tarball, install it outside the checkout and verify the executable and imports. / 检查文件清单和实际候选压缩包，在源码目录外安装并验证入口。 | Release maintainer / 发布维护者 |
| Truthful documentation / 真实文档 | English and Chinese quickstarts run as written; limits, session lifetime, browser modes and benchmark boundaries agree with code. / 中英文步骤可复现，限制、会话寿命、浏览器模式和计时边界与代码一致。 | Docs reviewer / 文档审阅者 |
| Reproducible measurements / 可复现测量 | Raw runs, failed attempts, environment, browser version and source hashes accompany every numeric claim. / 每个数值都有原始样本、失败记录、环境版本及源码哈希。 | Benchmark reviewer / 基准审阅者 |
| Public identity / 公开身份 | Confirm repository owner, package owner/name, license/attribution and final links before registering or publishing anything. / 发布前确认仓库及包归属、名称、许可证、归属说明和真实链接。 | Project owner / 项目负责人 |

The workflow in `.github/workflows/ci.yml` is prepared for the Tablaze directory to be the repository root. It runs on ordinary `pull_request` events with read-only repository permissions; no release or account credentials are needed. It does not publish packages. A configured workflow is not evidence that hosted CI has passed.

`.github/workflows/ci.yml` 以 Tablaze 目录作为未来仓库根目录，使用普通 `pull_request` 事件和仓库只读权限，无需发布凭证。工作流不会发布包；写好配置不等于已通过 GitHub 托管 CI。

## Claims and proof / 差异点与举证

| Claim to demonstrate / 要展示的能力 | Proof / 证据 | Scope to preserve / 需要保留的范围 |
| --- | --- | --- |
| Reuse a running session / 复用现有会话 | Compare process-cold open and repeated observations in one session. / 分开测量新进程启动与同会话重复观察。 | Runtime reuse does not mean session IDs survive server restart. / 进程内复用不代表重启后会话仍有效。 |
| Compact observations / 精简观察 | Store actual serialized JSON bytes under explicit element/text budgets; show truncation. / 记录预算下的真实 JSON 字节，并展示裁剪标记。 | Bytes are not tokens; token claims require a named tokenizer. / 字节不等于 token，token 声明需注明分词器。 |
| Guarded references / 引用检查 | A deterministic fixture replaces or renames a target after observation; the click is rejected and the page counter stays unchanged. / 观察后替换或改名，点击被拒且页面计数不变。 | This is an action correctness mechanism, not a security sandbox. / 这是动作正确性机制，不是安全沙箱。 |
| Fewer tool round trips / 减少工具往返 | Show four explicitly ordered actions in one `tab_act`, with per-step results. / 一个 `tab_act` 返回四步动作的逐项结果。 | Model latency and total task speed need separate end-to-end measurements. / 模型耗时与总任务速度要另测。 |
| Verifiable completion / 可核验完成 | Fresh URL, field, text and result-count checks fail when the expected outcome is absent. / URL、字段、文字和数量检查在目标缺失时确实失败。 | Checks prove only the chosen assertions. / 仅证明选择的断言。 |

Publish measurements from [`bench/run.mjs`](../bench/run.mjs) with the [methodology](../bench/README.md). Avoid universal “fastest”, cheapest or percentage-saving headlines. A comparison with another tool requires pinned versions, the same browser state and task, independent checks, all attempts and disclosed installation/transport/model boundaries. A localhost engine benchmark cannot establish an internet agent speed ranking.

发布 [`bench/run.mjs`](../bench/run.mjs) 的原始测量及[方法说明](../bench/README.md)。不使用无边界的“最快”“最便宜”或节省百分比标题。对照其他工具要固定版本、浏览器状态和任务，保留独立验收、全部尝试，并说明安装、传输与模型计时范围。本地引擎基准不能证明互联网 Agent 排名。

## First users and contribution paths / 首批用户与贡献路径

| Audience / 受众 | First useful task / 首个有用任务 | Contribution route / 贡献方式 |
| --- | --- | --- |
| Developers using MCP coding clients / 使用 MCP 编程客户端的开发者 | Test a local search or settings form and return outcome evidence. / 验证本地搜索或设置表单，并返回结果证据。 | Client setup report or a copyable quickstart correction. / 客户端接入报告或启动文档修正。 |
| Agent/tool authors / Agent 与工具作者 | Integrate typed snapshots, sequential actions and structured failures. / 接入快照、顺序动作与结构化失败。 | Small adapter example or protocol regression fixture. / 小型适配示例或协议回归用例。 |
| Frontend/QA contributors / 前端与测试贡献者 | Reproduce a real UI control that fails or changes during input. / 复现失败控件或输入时变化的页面。 | Minimal local HTML fixture plus expected outcome, followed by a focused fix. / 最小本地页面和预期结果，再提交聚焦修复。 |

Keep newcomer work specific: one accessible-name case, one installation platform report, one bilingual example or one failure-message improvement. A maintainer should attach a reproducible starting point and completion criterion before labelling an issue as a first contribution. Credit accepted contributions in release notes with the contributor's preferred public identity.

新手任务保持具体：一个可访问名称案例、一个平台安装报告、一份双语例子或一条错误提示改进。维护者应先写清复现入口与完成条件，再将其标成适合首次贡献的任务。发布记录按贡献者希望公开的身份致谢。

## Launch materials / 首发材料

Prepare these locally before any public announcement. The project owner reviews the final files and real destination links before publication.

对外介绍前先在本地准备以下材料，由项目负责人审阅文件及真实目标链接后再发布。

1. **A 45–90 second recording at normal speed.** Start with the actual command/config, perform the hotel workflow, show independent verification and close the session. Display cuts and omitted setup explicitly. / **45–90 秒正常速度录屏。** 展示真实启动方式、酒店流程、独立验收与关闭；剪辑和省略步骤明确标注。
2. **A short failure/recovery clip.** Replace a target, show the rejection, refresh the snapshot and continue. Keep completed partial actions visible. / **失败与恢复短片。** 替换目标、显示拒绝、刷新快照后继续；保留已执行步骤的实际状态。
3. **English and Chinese quickstarts.** Separate managed Chromium, installed Chrome and explicit CDP attachment; name the observed client/version. / **中英文快速开始。** 分清管理的 Chromium、本机 Chrome 与显式 CDP，并注明实测客户端版本。
4. **A release evidence bundle.** Candidate version/commit, test logs, package manifest, raw benchmark JSON, limitations and changelog. / **发布证据包。** 候选版本、测试日志、包清单、基准原始数据、限制及变更说明。
5. **One concise launch post per relevant community.** Explain the task solved, show the real recording, disclose current limits and invite reproducible feedback. / **为相关社区各准备一篇简短介绍。** 说明解决的任务，附真实演示与限制，邀请可复现反馈。

Do not invent users, downloads, testimonials, badges or star counts; buy stars; solicit coordinated voting; gate functionality behind starring; or present sponsored promotion as an independent review. Keep account creation, messages, repository/npm publication and community posting as explicit owner actions, not side effects of this plan.

不虚构用户、下载量、评价、徽章或 Star；不购买 Star、组织投票、以 Star 解锁功能，或把付费宣传包装成独立测评。创建账号、发送消息、发布仓库/npm 和社区发帖由负责人明确执行，不是本计划的自动副作用。

## Adoption funnel and measurement / 采用漏斗与度量

Use public aggregate data where available and an explicitly participating small cohort for usage questions. The current server does not provide a product-analytics system; do not claim active users or retention from npm downloads alone. Do not add identifiers or telemetry merely to make the table easier to fill.

公开数据用于总体趋势；使用情况通过明确愿意参与的小范围用户样本了解。当前服务没有产品分析系统，不能从 npm 下载量推导活跃用户或留存。不要为了填表额外收集标识或加入遥测。

| Stage / 阶段 | Measure / 指标 | Interpretation / 如何解释 |
| --- | --- | --- |
| Discovery / 发现 | Repository/page visits and source where aggregate data is available; weekly stars tracked separately. / 可用的页面访问来源，另记每周 Star。 | Interest, not installation. / 表示关注，不表示安装。 |
| Installation / 安装 | In a consenting cohort: attempts, first successful launch and reasons for failure. / 参与样本的安装尝试、首次启动成功及失败原因。 | Publish numerator/denominator and cohort size. / 同时列分子、分母和样本量。 |
| Activation / 首次价值 | Time from instructions opened to the first independently verified task; completion count. / 从打开说明到首个验收任务的时间与完成数量。 | Include setup time; list excluded delays. / 包含准备时间，列明排除项。 |
| Reuse / 再次使用 | Participating users reporting a second useful task within 14 days, divided by activated participants. / 已完成首个任务者中，14 天内报告再次完成有用任务的比例。 | A small self-report sample, not population retention. / 是小样本自述，不是全体留存。 |
| Reliability / 可靠性 | Public regression pass rate and reproducible user failures by browser/client/version. / 回归通过情况与按版本分类的可复现失败。 | Fixture reliability and real-world reliability remain separate. / fixture 与真实任务可靠性分开。 |
| Contribution / 贡献 | External reproducible reports, first PRs, merged contributions and time to first useful maintainer response. / 外部复现报告、首次 PR、合入贡献及首次有效维护回应时间。 | Count helpful outcomes, not comment volume. / 统计实际帮助，不统计灌水量。 |

Review these once a week. Start with targets such as “at least 8 of 10 participating testers complete the quickstart without live coaching” and “triage reproducible reports within three working days when maintainer capacity permits.” These are proposed operating targets, not service guarantees. If the sample is too small, report counts and examples instead of percentages. Fix the largest activation obstacle before expanding outreach.

每周复盘一次。初期可把“10 名参与测试者中至少 8 名无需实时指导完成快速开始”“维护能力允许时三个工作日内分类可复现报告”作为工作目标，不作为服务承诺。样本过少时报告数量和案例，不强调百分比。扩大传播之前先修复阻碍首次成功的最大问题。

## 30 / 60 / 90 days / 阶段计划

Day 0 is the first public release after the gates above pass. Dates can move with evidence and maintainer capacity. Do not force features or marketing activity to hit a star target.

第 0 天从通过门槛后的首次公开发布开始；后续日期随证据和维护能力调整，不为达到 Star 数硬推功能或宣传。

| Window / 时间 | Concrete work / 具体工作 | Evidence and decision / 证据与决策 |
| --- | --- | --- |
| Days 0–30 / 前 30 天 | Support a voluntary cohort of about 10 users across two MCP clients; fix the top three installation/control failures; publish one real demo and one measured baseline; maintain English/Chinese instructions. / 支持约 10 名自愿用户覆盖两个客户端，修复前三类接入或操作失败，发布真实演示和基线，维护双语说明。 | Record every failed onboarding attempt; repeat the quickstart after fixes. Broaden distribution only after most testers can complete it without coaching. / 保留失败尝试，修复后重测；多数用户能自行完成再扩散。 |
| Days 31–60 / 第 31–60 天 | Turn repeated failures into public fixtures; document a second client integration; welcome three well-scoped first-contributor issues; publish one versioned reliability report. / 将重复失败做成公开 fixture，完善第二客户端示例，准备三个明确的新手任务，发布版本化可靠性报告。 | Compare activation and repeat-use observations with the first cohort. Prioritize the most repeated unmet task, not the most-requested buzzword. / 对照首批激活和复用情况，优先处理重复出现的实际任务。 |
| Days 61–90 / 第 61–90 天 | Ship the highest-value supported workflow improvement; validate package upgrades; run one matched comparison only if a fair harness and maintainer time exist; invite maintainership from sustained contributors. / 交付最有价值的工作流改进，验证升级；有公平评测框架和维护时间才做对照，邀请持续贡献者参与维护。 | Publish what improved, what regressed and what remains unsupported. Continue, narrow or change direction from task success and community capacity. / 公布提升、回退与限制，根据任务成功和社区能力决定继续、收敛或调整。 |

A strong launch is repeatable: one useful task, a readable failure, a reproducible issue and a fix users can install. Track star growth as one public signal alongside those outcomes.

持续落实有用任务、可理解的失败、可复现的问题和用户能安装的修复，同时观察 Star 与实际使用结果。

## CI references / CI 依据

The workflow uses current official [`actions/checkout`](https://github.com/actions/checkout), [`actions/setup-node`](https://github.com/actions/setup-node) and [`actions/upload-artifact`](https://github.com/actions/upload-artifact) action lines, and follows Playwright's [browser/dependency installation guidance](https://playwright.dev/docs/ci). Before a release, verify any action-version update against its upstream documentation and a real hosted run.

工作流采用当前官方 Action 版本，并按 Playwright 文档安装浏览器与系统依赖。发布前，Action 版本变化仍需对照上游文档及真实托管运行核验。
