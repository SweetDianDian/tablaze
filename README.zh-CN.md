<p align="center">
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh">
    <img src="docs/assets/tablaze-banner.svg" alt="Tablaze 闪页 — 精简的浏览器 MCP。观察、操作、验收。" width="100%">
  </a>
</p>

<p align="center">
  <strong><a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh">访问官网 ↗</a></strong> &nbsp; · &nbsp;
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh#demo">观看真实演示</a> &nbsp; · &nbsp;
  <a href="docs/CODEX.zh-CN.md">Codex 接入指南</a> &nbsp; · &nbsp;
  <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml"><img src="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b7db9a?style=flat-square" alt="MIT 许可证"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A520-80b7ff?style=flat-square" alt="Node.js 20 及以上"></a>
</p>

**让 Agent 真正操作浏览器。** Tablaze / 闪页通过八个专注的 MCP 工具，让 Codex 等客户端连接 Chromium：观察页面、填写表单、提取结果，再检查任务是否完成。

基于 Playwright，浏览器会话在调用之间持续运行，推理由你的 MCP 客户端完成，无需额外模型 API Key。

## 看它完成一次任务

**[观看 56 秒真实演示 →](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh#demo)**

真实 MCP SDK 客户端搜索里斯本的住宿，完成五项验收，再展示按钮被替换后的拒绝与重新观察后的恢复。视频呈现实际工具响应和浏览器截图。

[![真实 MCP 演示：里斯本酒店结果通过五项检查](docs/assets/demo-poster.png)](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site?lang=zh#demo)

`观察表单` → `填写 · 选择 · 勾选 · 搜索` → `验收结果`

[本地复现录制](demo/README.md) · [查看完整调用记录](docs/evidence/demo-run.json)

## 开始使用

需要 **Node.js 20+**、npm 和 Git。当前为开发者预览版，npm 尚未发布，请从源码安装：

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
```

<details>
<summary>已安装 Chrome，或者正在使用 Linux？</summary>

已有 Chrome 时可以跳过 `setup`，运行 `node dist/cli.js doctor --channel chrome`，并在下方 Codex 命令末尾追加 `--channel chrome`。这会启动独立浏览器会话。

Linux 使用 `npx playwright install --with-deps chromium` 替代 `setup`，一起安装浏览器和系统依赖。

[浏览器模式与诊断](docs/CODEX.zh-CN.md#1-构建与选择浏览器)

</details>

### 接入 Codex

在克隆后的目录中，注册构建完成的服务：

```sh
codex mcp add tablaze -- "$(node -p 'process.execPath')" "$PWD/dist/cli.js"
codex mcp get tablaze
```

然后告诉 Codex：

> 使用 Tablaze 打开 https://example.com，读取标题和链接，验证页面标题包含“Example Domain”，然后关闭会话。报告这些检查的结果。

[完整接入指南](docs/CODEX.zh-CN.md)包含桌面配置、浏览器选择和排错。其他 MCP 客户端也可以通过 stdio 启动同一个 `node /绝对路径/tablaze/dist/cli.js` 命令。

## 简单的工作流，明确的控制

| 能力 | 给 Agent 带来什么 |
| --- | --- |
| **持续会话** | 调用之间保留页面状态。默认使用临时隔离上下文，也可显式通过 CDP 连接已有 profile。 |
| **精简观察** | 全量或增量快照，包含元素引用、文字预算与截断标记。 |
| **引用检查** | 输入前检查快照版本和 DOM 目标；目标变化后重新观察。 |
| **顺序批次** | 一次最多提交 20 个操作，分别报告完成、失败和跳过状态。遇错停止，先前操作仍然生效。 |
| **明确验收** | 核对实际 URL、标题、文字、字段值、可见性与元素数量。 |

### 八个工具

| 工具 | 用途 |
| --- | --- |
| `tab_open` | 打开页面并返回首次快照。 |
| `tab_snapshot` | 观察页面、变化或指定 frame。 |
| `tab_act` | 点击、填写、按键、选择、勾选、滚动或等待。 |
| `tab_verify` | 对当前页面执行明确断言。 |
| `tab_extract` | 读取文字、链接或表格。 |
| `tab_capture` | 获取 JPEG 截图。 |
| `tab_list` | 查看自有会话。 |
| `tab_close` | 关闭会话并释放资源。 |

## 深入了解

| 文档 | 内容 |
| --- | --- |
| [Codex 接入](docs/CODEX.zh-CN.md) | 可复制的配置、工具参数与排错。 |
| [运行机制](docs/RUNTIME.md#简体中文) | 引用生命周期、批次语义、浏览器模式与当前限制。 |
| [基准测试](bench/README.md) | 复现本地场景，检查每个原始样本。 |
| [验证记录](docs/VALIDATION.md) | 真实浏览器、SDK 与 Codex 的结果和验证范围。 |
| [安全边界](SECURITY.md) | 数据处理、资源归属与私密漏洞报告。 |
| [发布打包](docs/RELEASE.md) | 生成 npm 安装包和源码归档。 |

[Ubuntu 的 Node 20/22 CI](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) 已通过构建、浏览器/MCP 测试和包内容检查。源码目录中运行 `npm test` 可执行测试；`npm run bench` 单独运行本地基准。

## 参与贡献

带来一个可复现的浏览器案例，改进一份指南，或提交一项聚焦修复。[提交 Issue](https://github.com/SweetDianDian/tablaze/issues) · [提交 Pull Request](https://github.com/SweetDianDian/tablaze/pulls) · [贡献指南](CONTRIBUTING.md)

[MIT 许可证](LICENSE) · [依赖署名与项目来源](NOTICE)
