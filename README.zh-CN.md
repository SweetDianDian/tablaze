# Tablaze / 闪页

**快照更精简，会话持续就绪，结果可以验证。**

Tablaze 是供 AI Agent 使用的本地浏览器 MCP。它让 Chromium 持续运行，用精简快照描述网页，再对刚观察到的元素执行有界的操作批次，最后检查实际结果。

[English](README.md) · [接入 Codex](docs/CODEX.zh-CN.md) · [基准测试方法](bench/README.md) · [参与贡献](CONTRIBUTING.md)

**当前为开发者预览版 0.1.0。** 公开源码仓库为 [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze)。npm 尚未发布，请使用源码或本地生成的安装包；Linux CI 等待首次推送后的运行结果。没有声称已有使用量或跨产品速度优势。

## 能解决什么

- **浏览器持续就绪。** 服务运行期间保留页面和会话；默认每个会话使用独立的临时浏览器上下文。
- **观察量可以控制。** 全量与增量快照包含元素引用、可见文字、frame 信息，并明确说明截断。
- **操作有上下文。** 批次必须携带会话 ID 和快照版本；输入前检查节点是否被替换、目标含义是否改变。
- **减少逐步往返。** 一次提交最多 20 个顺序操作，读取完成、失败、跳过的步骤，再单独验收结果。
- **无需额外模型账户。** Tablaze 不调用模型，也不需要 API Key；推理由 MCP 客户端完成。

```text
Codex / 其他 MCP 客户端
           │ stdio
           ▼
        Tablaze
  观察 → 校验后操作 → 验收
           │ Playwright
           ▼
      持续运行的浏览器
       独立会话上下文
```

**本版没有接入 Jev。** 对 `browser-use/jev-ultrafast` 的探索启发了精简浏览器操作循环的设计，但 Tablaze 不依赖 Jev、TypeSafe 或文本生成服务。

## 从源码启动

需要 **Node.js 20+**、npm、Git，以及能够运行 Chromium 的桌面或服务器环境。克隆源码后构建：

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
node dist/cli.js doctor
```

`setup` 调用当前依赖中的官方 Playwright CLI，下载匹配版本的 Chromium。Linux 可能还需要系统依赖，参见 [Playwright 浏览器安装说明](https://playwright.dev/docs/browsers)。MCP 初始化时不会自动下载浏览器。

如果已经安装 Chrome，可以跳过 `setup`：

```sh
node dist/cli.js doctor --channel chrome
```

`--channel chrome` 启动独立浏览器和临时上下文，不会接管现有已登录标签页。`doctor` 检查可执行文件并尽可能报告版本，不会启动或连接浏览器。

## 接入 Codex

将下方**两个绝对路径**替换成 Node 程序和构建产物的真实路径；用 `node -p 'process.execPath'` 查看 Node 路径。

```sh
codex mcp add tablaze -- "/absolute/path/to/node" "/absolute/path/to/tablaze/dist/cli.js" --channel chrome
codex mcp get tablaze
```

使用 `setup` 安装的 Chromium 时，去掉 `--channel chrome`。完整配置、工具例子、取消行为与排错见 [Codex 接入指南](docs/CODEX.zh-CN.md)。命令格式依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

可以这样开始：

> 使用 Tablaze 打开 https://example.com，读取标题和链接，验证页面标题，然后关闭会话。只报告浏览器证据能够确认的结果。

## 八个工具

| 工具 | 用途 |
| --- | --- |
| `tab_open` | 打开 HTTP(S) 页面并返回首次快照。 |
| `tab_snapshot` | 获取全量或增量快照，也可以指定 iframe。 |
| `tab_act` | 顺序点击、填写、按键、选择、勾选、滚动和等待。 |
| `tab_extract` | 提取有数量与长度限制的文字、链接或表格。 |
| `tab_verify` | 检查 URL、标题、文字、可见性、字段值和元素数量。 |
| `tab_capture` | 返回 JPEG 截图及元数据。 |
| `tab_list` | 列出本服务拥有的会话。 |
| `tab_close` | 关闭一个自有会话。 |

工具结果同时提供 JSON 文字和 `structuredContent`。失败操作设置 `isError`；批次还返回部分完成情况。SDK 的参数校验错误使用 SDK 自身格式。截图额外返回 MCP image block。服务不提供任意 JavaScript 执行工具。

## 执行规则

先观察，再操作。新快照会使旧 `snapshot_id` 失效；批次使用后也会消耗该版本。下一次操作应使用 `tab_act` 返回的新快照，或重新调用 `tab_snapshot`。其他会话、已导航或已替换文档的引用不能混用。增量快照依赖它标明的基线；没有基线时应请求全量快照。

每批 **1–20 步**，同一会话内串行执行，遇到第一个失败便停止。整批默认 **30 秒**，最多 **60 秒**。CLI 的 `--timeout-ms` 控制单步及导航等待，`tab_act.timeout_ms` 控制整个批次。运行中收到取消或整批超时后，会关闭自有会话以打断执行；开始前已取消的批次不会执行操作。取消或失败**不会回滚**已经发生的点击、提交或网络请求。

节点身份与语义检查能减少过期目标误操作，但网页仍可在重验与实际输入之间变化，**不构成原子保证或安全沙箱**。预检也可能滚动页面。业务结果应使用 `tab_verify` 验收；点击完成不等于提交成功。

## 浏览器模式与数据

默认会话相互隔离，只在上下文和服务运行期间保留状态，不是保存到磁盘的用户配置。显式传入 `--cdp-url` 才会连接已经配置好的 Chromium 端点，并在其既有 profile 中创建自有页面；这些页面共享该 profile 的登录身份和存储。关闭 Tablaze 会清理自有页面并断开连接，不会主动关闭无关标签页或终止外部 Chrome。

快照不返回 password 和 hidden input 的值，字段值验收也拒绝读取它们。其他字段值、页面文字、URL、提取内容和截图仍可能包含私人信息，并会返回 MCP 客户端；这不是全面的秘密识别系统。具体边界见 [SECURITY.md](SECURITY.md)。

当前限制：仅 Chromium；没有上传下载流程、任意脚本执行、封闭 Shadow DOM、原生对话框处理和受支持的新标签页流程。开放 Shadow DOM 和显式选择的 frame 有覆盖，但精简 DOM 表示不是完整的无障碍树。Canvas 界面可以截图观察，但没有坐标点击工具。CDP 使用 Playwright 能力保真度较低的连接方式。

## 构建本地安装包

```sh
npm pack
```

本版本生成 `tablaze-0.1.0.tgz`。将这个实际文件安装到你选择的目录：

```sh
npm install --prefix "/absolute/path/to/tablaze-install" "/absolute/path/to/tablaze-0.1.0.tgz"
node "/absolute/path/to/tablaze-install/node_modules/tablaze/dist/cli.js" doctor --channel chrome
```

随后将 Codex 指向已安装的 `dist/cli.js` 绝对路径。本预览版尚未发布到 npm，因此不能把 `npx tablaze@latest` 当作安装方式。

## 验证与贡献

通过 [Issues](https://github.com/SweetDianDian/tablaze/issues) 提交可复现问题，或通过 [Pull Requests](https://github.com/SweetDianDian/tablaze/pulls) 提交聚焦的改动。本地 fixture 流程和验证要求见[贡献指南](CONTRIBUTING.md)。

在带有 lockfile 并已安装开发依赖的源码目录运行：

```sh
npm test
npm run bench
```

macOS/Linux 使用已安装 Chrome 时，可在命令前加 `TABLAZE_BROWSER_CHANNEL=chrome`。测试使用本地 fixture 和独立浏览器。基准分别记录冷启动、热快照、批次操作、结果验收和 JSON 体积，不包含模型推理和 MCP 传输。参见[方法与原始输出格式](bench/README.md)，发布结果时应保留环境信息和失败样本。

采用 [MIT 许可证](LICENSE)。依赖署名与项目来源见 [NOTICE](NOTICE)。

可复现[真实 MCP 演示](demo/README.md)、查阅[验证记录](docs/VALIDATION.md)，并按[打包指南](docs/RELEASE.md)生成安装包和源码归档。
