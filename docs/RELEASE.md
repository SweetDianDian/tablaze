# Release artifacts / 发布产物

## English

Run from a checkout with Node.js 20+, npm, Python 3, and installed dependencies:

```sh
npm ci
node scripts/package-release.mjs
```

The script locates the repository from its own file location. The default destination is `artifacts/release` in that repository. An explicit `--out` must be an absolute directory path; paths containing spaces are supported. For example, from another working directory:

```sh
node '/absolute/path with spaces/tablaze/scripts/package-release.mjs' \
  --out '/absolute/release output'
```

The output contains the following files, with the current package version in each archive name:

| File | Contents |
| --- | --- |
| `tablaze-0.1.0.tgz` | The result of `npm pack --json`, using the existing `package.json` files list and prepack build. |
| `tablaze-0.1.0-source.zip` | Source, tests, benchmark fixtures and results, documentation, site, demo source, scripts, GitHub configuration, and dependency lockfile. |
| `release-manifest.json` | UTC creation time, archive names, byte sizes, SHA-256 hashes, source file count, source tree digest, and per-file hashes for the compiled `dist` files inside the npm archive. |

The source archive excludes dependencies, Git metadata, build/release output, `.env` files, local npm settings, private hosting/deployment directories, `demo/output`, video recordings, and GIFs larger than 2 MiB. The exact exclusion rules are recorded in the manifest. Small site image assets and demo source such as `demo/record.mjs`, `demo/viewer.html`, and README files remain eligible. Source symlinks cause an explicit error instead of following files outside the checkout.

The ZIP uses sorted file entries and fixed archive timestamps. Its hash is stable for identical contents and executable bits. `created_at` records the actual packaging time separately. The source ZIP omits compiled `dist`; rebuild it with `npm ci` and `npm run build` after extracting. The npm archive includes compiled runtime files according to the existing package manifest.

The script verifies ZIP integrity, checks the actual npm archive for excluded files, and compares its compiled files with the current `dist` output. It stages work before replacing the archive files and writes the manifest last. Running it again updates the release artifacts for the current package version. It does not run browser tests, publish npm packages, upload GitHub assets, or create a public release.

Before distributing an artifact, run the project's validation separately and compare the artifact's SHA-256 with the manifest. For example, a cross-platform Node.js check from the output directory is:

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const manifest = JSON.parse(readFileSync("release-manifest.json", "utf8"));
for (const artifact of manifest.artifacts) {
  const bytes = readFileSync(artifact.filename);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256 || bytes.length !== artifact.size_bytes) {
    throw new Error(`Artifact mismatch: ${artifact.filename}`);
  }
  console.log(`Verified ${artifact.filename}`);
}
'
```

## 简体中文

环境需要 Node.js 20+、npm、Python 3，以及已安装的项目依赖。在项目目录运行：

```sh
npm ci
node scripts/package-release.mjs
```

脚本根据自身位置定位项目，默认写入项目内的 `artifacts/release`。可以用 `--out /绝对路径` 指定独立输出目录，路径支持空格，也可以从其他工作目录调用脚本的绝对路径。

产物包括当前版本的 npm 安装包、完整源码 ZIP，以及 `release-manifest.json`。Manifest 记录 UTC 打包时间、文件名、字节大小、SHA-256、源码文件数量、源码树摘要，以及 npm 包中实际 `dist` 文件的逐个哈希。

源码 ZIP 包含源码、测试、基准测试及结果、文档、介绍页、演示源码、脚本、GitHub 配置和依赖锁文件；排除 `node_modules`、`.git`、构建及发布产物、`.env`、本地 npm 配置、私有托管元数据、`demo/output`、录制视频和大于 2 MiB 的 GIF。小型页面图片和 `demo/record.mjs`、`demo/viewer.html`、README 等演示源码可以进入 ZIP。遇到源码符号链接时会明确失败，避免打包项目外部文件。

ZIP 按路径排序并使用固定归档时间，同样的内容与可执行权限会得到同样的 ZIP 哈希；真实打包时间单独写入 Manifest。源码 ZIP 不含生成的 `dist`，解压后运行 `npm ci` 和 `npm run build`。npm 安装包仍严格使用现有 `package.json` 的文件清单和 prepack 构建流程。

脚本会校验 ZIP 完整性、检查 npm 包排除项、比较编译文件哈希，完成暂存后再替换发布文件，最后写入 Manifest。重复运行会更新当前版本的产物。它不重复运行浏览器测试，也不上传、发布 npm 包或创建 GitHub Release；分发前应单独完成项目验证，并按上面的 Node.js 命令核对产物哈希。
