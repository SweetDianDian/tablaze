# Contributing / 参与贡献

Tablaze is a developer preview in [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze). Use [Issues](https://github.com/SweetDianDian/tablaze/issues) for reproducible bugs or scoped proposals. Fork the repository, make a focused change, and open a [pull request](https://github.com/SweetDianDian/tablaze/pulls) with the commands and results you actually checked. For vulnerability reports, follow [SECURITY.md](SECURITY.md).

Tablaze 是 [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze) 下的开发者预览项目。通过 [Issues](https://github.com/SweetDianDian/tablaze/issues) 提交可复现问题或范围明确的建议；Fork 后提交聚焦改动，并在 [Pull Request](https://github.com/SweetDianDian/tablaze/pulls) 中附实际检查命令和结果。漏洞报告按 [SECURITY.md](SECURITY.md) 处理。

## Development / 开发

Use Node.js 20+. Clone the source (or your fork), install the locked dependencies, build, and select either managed Chromium or independently launched installed Chrome:

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
npm test
```

Installed Chrome on macOS/Linux / macOS、Linux 已安装 Chrome：

```sh
TABLAZE_BROWSER_CHANNEL=chrome npm test
```

These browser tests must use local fixtures and temporary contexts. Do not depend on a contributor's signed-in browser, real credentials, live purchases, or a third-party site staying unchanged. CDP tests must launch their own disposable browser and verify that unrelated fixture pages survive disconnect.

浏览器测试应使用本地 fixture 和临时上下文，不依赖贡献者的登录会话、真实凭据、实际购买或外站状态。CDP 测试必须自建一次性浏览器，并验证断开连接后无关 fixture 页面仍然保留。

## What a useful change includes / 有效改动包含什么

- Describe the actual trigger, previous behavior, and resulting behavior. / 写清触发条件、原行为和修改后的行为。
- Add focused regression coverage for browser correctness, lifecycle, protocol, or data exposure changes. Documentation-only edits do not need mirrored tests. / 针对正确性、生命周期、协议或数据暴露的改动补回归；纯文档修改无需复述实现的测试。
- Preserve sequential batches, honest partial results, revision checks, cancellation behavior, and owned-resource cleanup. / 保留串行批次、真实部分结果、版本检查、取消和自有资源清理契约。
- Keep English and Chinese user docs aligned. Mark missing support explicitly. / 同步中英文文档，明确尚未支持的功能。
- Supply commands and outcomes you actually ran. Do not replace failed samples with successful reruns. / 记录实际执行的检查和结果，不用重跑成功的样本替换失败样本。

The public tool contract lives in `src/server.ts`; engine behavior is in `src/browser.ts` and `src/snapshot.ts`. The product acceptance contract is in `docs/PRODUCT_SPEC.md`. A contract change must update examples and tests in the same patch.

工具契约以 `src/server.ts` 为准，引擎行为在 `src/browser.ts` 和 `src/snapshot.ts`，验收要求在 `docs/PRODUCT_SPEC.md`。改变契约时应同时更新例子与测试。

## Performance / 性能

Run `npm run bench`, or `TABLAZE_BROWSER_CHANNEL=chrome npm run bench`, from source. Read `bench/README.md` for measurement boundaries. Include environment, raw records, success checks, cold/warm distinctions, and every failed attempt. Do not claim a cross-product improvement without a matched comparison.

在源码中运行上述基准，按 `bench/README.md` 的范围提交环境、原始记录、成功验收、冷热边界与所有失败样本。没有匹配条件的对照实验，不宣称跨产品性能优势。

## Packaging / 打包

```sh
npm pack --dry-run
```

Inspect package contents for generated runtime files and documentation, and for accidental credentials, user profiles, screenshots, or private paths. Building a local tarball does not publish it to npm. The GitHub source repository is established; npm ownership, the reporting channel and the exact registry artifact must be verified before a package release.

检查包中运行文件和文档，同时排除误打包的凭据、用户 profile、截图和私人路径。GitHub 源码仓库已建立；生成本地 tarball 不等于发布到 npm，包发布前仍需确认 npm 归属、报告渠道和确切产物。

Contributions to project-owned source are under the [MIT license](LICENSE). Preserve third-party attribution; report vulnerabilities using [SECURITY.md](SECURITY.md).

项目自有源码贡献采用 [MIT](LICENSE)，保留第三方署名；漏洞报告方式见 [SECURITY.md](SECURITY.md)。
