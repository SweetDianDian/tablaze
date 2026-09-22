# Introduction page / 介绍页源码

This directory contains the portable static source of the bilingual Tablaze introduction page.

```sh
python3 -m http.server 4173 --directory site --bind 127.0.0.1
```

Open http://127.0.0.1:4173. The language switch, illustrative replay, copy controls and benchmark display run without a build tool or external asset CDN. This page does not connect to a browser MCP; the replay is explicitly illustrative.

此目录是中英文介绍页的便携源码。运行上面的命令后访问本机地址，无需构建或外部素材 CDN。页面演示是示意回放，并没有在网页中连接 MCP。

The deployed private preview additionally includes downloadable release artifacts. Before enabling those links on another host, copy the exact validated tarball and source zip alongside the page, then update `release.json`:

```json
{
  "package": "tablaze-0.1.0.tgz",
  "source": "tablaze-0.1.0-source.zip",
  "guides": true
}
```

The portable source defaults to guide downloads only. The real recording is optional generated media: run demo/record.mjs, copy the WebM/report/poster into site/demo/, and set demo: true in release.json to enable its section. Never enable a download before its exact artifact is present. Replace `benchmark.json` with a fresh complete raw report after changing the browser implementation; update the sample count/method copy too. Host with any static server or the chosen hosting workflow. Existing Sites project metadata lives outside this distributable folder.

独立源码默认只展示文档下载。部署时将已验证的安装包和源码压缩包放入同目录，再启用对应入口。浏览器实现变化后需重跑基准、替换原始数据并更新样本量和计时边界；不能沿用不匹配的数字。现有 Sites 项目配置保留在独立部署目录，不在可分发源码中。
