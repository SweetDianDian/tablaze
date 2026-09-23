# Introduction page / 介绍页源码

This directory contains the Git-tracked, portable static source of the bilingual Tablaze website. It has no build step and no GitHub-to-Sites deployment hook.

此目录是由 Git 跟踪的双语官网静态源码，无构建步骤，也没有 GitHub 推送后自动部署到 Sites 的流程。

```sh
python3 -m http.server 4173 --directory site --bind 127.0.0.1
```

Open http://127.0.0.1:4173. The language switch, illustrative replay, copy controls and benchmark display run without a build tool or external asset CDN. This page does not connect to a browser MCP; the replay is explicitly illustrative.

此目录是中英文介绍页的便携源码。运行上面的命令后访问本机地址，无需构建或外部素材 CDN。页面演示是示意回放，并没有在网页中连接 MCP。

The [public website](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site) additionally includes downloadable release artifacts. Before enabling those links on another host, copy the exact validated tarball and source zip alongside the page, then update `release.json`:

```json
{
  "package": "tablaze-0.1.0.tgz",
  "source": "tablaze-0.1.0-source.zip",
  "guides": true
}
```

The portable source defaults to guide downloads only. The real recording is optional generated media: run `demo/record.mjs`, copy `tablaze-demo.webm`, `demo-report.json`, `poster.png`, `wayfar-itinerary.csv` and the five captured JPEGs from `demo/output/` into `site/demo/`, and set `demo: true` in `release.json` to enable its section. Never enable a download before its exact artifact is present. Keep release downloads and recordings tied to their actual validated source version; newer guides do not upgrade an older package.

独立源码默认只展示文档下载。部署时将已验证的安装包和源码压缩包放入同目录，再启用对应入口。安装包和录制必须对应其实际验收版本；更新文档不代表旧安装包已经升级。

The expanded recording appears directly after the hero and compatibility strip. Its seven chapter buttons use the actual `chapters` timestamps from the generated report; the player retains native controls when that report is unavailable. Playback starts only after user interaction. The [recording guide](DEMO.md) explains the complete local travel workflow, its real MCP evidence and its scripted scope.

完整演示位于首屏和兼容性栏之后。七个章节使用实际报告中的时间戳；报告不可用时仍可使用原生视频控件，不自动播放。[录制说明](DEMO.md)包含差旅流程、真实 MCP 证据及本地脚本演示的范围。

## Public measurements / 公开量化记录

The page separately presents the [five-task third run](CODEX_COMPARISON_RESULTS_V3.md), [independent order follow-up](CODEX_TERMINAL_FOLLOWUP.md), [virtual-list development task](CODEX_VIRTUAL_LIST_SMOKE.md), [cross-origin authorization-return task](CODEX_AUTH_RETURN_SMOKE.md), [initial native Codex/MCP smoke](CODEX_NATIVE_MCP_SMOKE.md), and [expanded MCP variants](CODEX_MCP_VARIANTS_V2.md). Their public JSON records are copied byte-for-byte from `docs/evidence/`. The follow-ups do not replace the original Tablaze 4/5 / Browser Use 5/5 completion result. These small visible samples do not establish overall superiority.

页面分别展示[第三轮五任务记录](CODEX_COMPARISON_RESULTS_V3.md)、[独立订单复测](CODEX_TERMINAL_FOLLOWUP.md)、[虚拟列表开发任务](CODEX_VIRTUAL_LIST_SMOKE.md)、[跨来源授权返回任务](CODEX_AUTH_RETURN_SMOKE.md)、[初始原生 Codex/MCP 实测](CODEX_NATIVE_MCP_SMOKE.md)和[扩展的 MCP 入口对比](CODEX_MCP_VARIANTS_V2.md)。公开 JSON 记录从 `docs/evidence/` 原样复制。后续任务不替换原来的 Tablaze 4/5、Browser Use 5/5；少量可见样本不能证明整体优越性。

`benchmark.json` remains the historical 0.1.0 direct-engine fixture recorded on Apple M3 Max at 2026-09-22 04:40 UTC. The page labels it as historical; it excludes MCP and model inference. A new benchmark must retain its own complete report, source hashes, sample count, and timing definition. Do not silently relabel old measurements as current-code performance.

`benchmark.json` 保留 2026-09-22 04:40 UTC 在 Apple M3 Max 上测得的历史 0.1.0 直接引擎场景。页面明确标为历史数据，不含 MCP 和模型推理。新基准必须保留完整报告、源码哈希、样本量和计时定义，不能把旧数据重新标为当前代码性能。

## Synchronize and publish / 同步与发布

After the repository's public guides and reports are finalized, run:

```sh
node site/sync-docs.mjs
python3 -m http.server 4173 --directory site --bind 127.0.0.1
```

The sync script copies only a fixed list of public guides, reports, and evidence. It rewrites links to repository-only guides to their GitHub locations. Review English and Chinese pages, report links, download settings, and source hashes before publishing.

文档定稿后运行同步脚本，再本地预览。脚本仅复制固定清单的公开文档、报告和证据，并将仅存于仓库的文档链接改为 GitHub 地址。发布前核对中英文页面、报告链接、下载设置和源码哈希。

For the existing OpenAI Sites website, reuse the exact project returned for `tablaze-browser-mcp`; do not create a replacement site or use another project's hosting configuration. The portable checkout contains no Tablaze `.openai/hosting.json`. An existing deployment checkout may contain it; otherwise obtain the correct source repository through the existing project's Sites write-credential operation. Keep credentials and deployment metadata outside this public source directory.

Push the reviewed static source state to that project's source repository, save a version with that exact pushed commit SHA, then deploy the saved version and check deployment status. Preserve the current public audience. A GitHub source push and a saved Sites version alone do not update the live website. Every Sites deployment is production; publishing is a separate maintainer action from running this sync script.

更新现有 OpenAI Sites 官网时，复用 `tablaze-browser-mcp` 对应项目的准确 ID，不创建替代站点，不套用其他项目配置。可分发源码不含 Tablaze 的 `.openai/hosting.json`；若独立部署目录存在该文件则读取复用，否则通过现有项目的 Sites 写凭据操作取得正确源仓库。凭据和部署配置保留在公开源码之外。

将审核后的静态源码推到该项目源仓库，用准确的已推送 commit SHA 保存版本，再部署该保存版本并检查部署状态，保持当前公开访问范围。仅推 GitHub 或仅保存 Sites 版本不会更新线上官网。Sites 部署即生产发布；同步脚本不会执行推送或部署。
