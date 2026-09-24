# Navigation policy / 导航策略

Navigation policy is trusted application configuration for an isolated Tablaze browser. It limits permitted HTTP(S) origins without asking the model to enforce a prompt rule. The default remains unchanged: omitting the policy disables this optional restriction. External CDP attachment cannot be combined with a policy because its browser context may contain personal pages and settings.

导航策略由应用或操作者配置，适用于 Tablaze 创建的独立浏览器。它按 HTTP(S) 精确来源限制导航，不依赖模型遵守提示词。省略策略时保持原有默认行为。策略不能与外部 CDP 连接同时使用，避免修改包含个人页面的共享浏览器上下文。

## Configuration / 配置

Create a UTF-8 JSON file, for example `navigation-policy.json`:

创建 UTF-8 JSON 文件，例如 `navigation-policy.json`：

```json
{
  "allowedOrigins": [
    "https://app.example.com",
    "https://login.example.com",
    "http://localhost:3000"
  ],
  "blockedOrigins": ["https://blocked.example.com"]
}
```

Only `allowedOrigins` and `blockedOrigins` are accepted. Both are optional arrays of strings. A URL's origin consists of its scheme, hostname and port; subdomains and different ports are separate origins. Scheme/hostname case, default ports and internationalized hostnames are normalized; an optional single trailing `/` is accepted. Duplicates are removed and ordering does not matter.

文件只接受 `allowedOrigins` 和 `blockedOrigins`，两者均为可选的字符串数组。来源由协议、主机和端口组成；子域名及不同端口分别匹配。协议和主机的大小写、默认端口及国际化域名会正规化；允许单个末尾 `/`。重复项会去重，数组顺序不影响策略。

| Configuration / 配置 | Meaning / 含义 |
| --- | --- |
| Policy omitted / 省略策略 | Existing browser behavior / 保持原有浏览器行为 |
| `{}` | Enable the policy and permit HTTP(S) origins / 启用策略，允许 HTTP(S) 来源 |
| `{"allowedOrigins": []}` | Permit no HTTP(S) origins / 不允许任何 HTTP(S) 来源 |
| `{"blockedOrigins": ["https://example.com"]}` | Permit other HTTP(S) origins / 允许其他 HTTP(S) 来源 |
| Both lists contain an origin / 同时出现在两个列表 | Block it; deny rules take precedence / 拒绝优先 |

Entries cannot contain wildcards, usernames/passwords, paths other than the optional trailing `/`, queries or fragments, backslashes or whitespace. Non-HTTP(S) origins are invalid. There may be at most 200 entries across both lists before deduplication, with at most 8192 characters per entry. A configured policy also rejects credential-bearing navigation targets; credentials belong in the application's authentication flow, not embedded in URLs.

配置项不能包含通配符、用户名或密码、路径（可选的末尾 `/` 除外）、查询参数、片段、反斜线或空白字符，也不能使用非 HTTP(S) 来源。两个列表在去重前合计最多 200 项，每项最多 8192 个字符。启用策略后，目标 URL 中嵌入用户名或密码也会被拒绝；认证信息应由应用的认证流程处理。

## CLI and SDK / 命令行与 SDK

`--navigation-policy <file>` accepts a regular UTF-8 JSON file of at most 64 KiB. Invalid configuration fails before starting a browser. Directories, FIFOs and malformed UTF-8/JSON are refused. The file is read once when the CLI starts; changes require a new process. Supply a trusted local file, not a path or configuration proposed by a webpage or model.

`--navigation-policy <file>` 接受不超过 64 KiB 的普通 UTF-8 JSON 文件。无效配置会在启动浏览器前被拒绝；不接受目录、FIFO、无效 UTF-8 或无效 JSON。CLI 启动时读取一次文件，修改后需要重启进程。路径及配置应由可信操作者提供，不应直接采用网页或模型给出的配置。

```sh
# Validate configuration and inspect browser availability; no browser is launched.
# 校验配置并检查浏览器是否可用；不会启动浏览器。
tablaze doctor --channel chrome --navigation-policy ./navigation-policy.json

# Start the stdio MCP server with the same policy.
# 使用同一策略启动 stdio MCP。
tablaze --channel chrome --navigation-policy ./navigation-policy.json

# Run an Agent with an explicitly selected model.
# 使用明确指定的模型运行 Agent。
tablaze run --provider codex --model YOUR_MODEL \
  --task "Inspect the application" --start-url https://app.example.com \
  --channel chrome --navigation-policy ./navigation-policy.json \
  --checkpoint ./private-run.json
```

The flag applies to MCP, `run` and `doctor`; it does not apply to `setup`. It cannot be combined with `--cdp-url`. `doctor` reports whether a policy is enabled and the canonical origin counts, without printing the configured origins or policy path. `allowed_origin_count: null` means no allowlist was supplied; check `enabled` to distinguish `{}` from no policy. Doctor validates configuration and executable availability, not live navigation enforcement.

该参数适用于 MCP、`run` 和 `doctor`，不适用于 `setup`，且不能与 `--cdp-url` 同用。`doctor` 只报告策略是否启用及正规化后的来源数量，不输出配置中的来源或策略文件路径。`allowed_origin_count: null` 表示没有配置允许列表；可通过 `enabled` 区分 `{}` 和未启用策略。Doctor 检查配置和浏览器程序是否存在，不执行真实导航验证。

SDK callers pass the same object to `BrowserEngine` or `createServer`; policy is not an MCP tool argument and cannot be changed by a model call:

SDK 调用方把同一对象传给 `BrowserEngine` 或 `createServer`；策略不是 MCP 工具参数，模型不能通过工具调用修改它：

```ts
import { BrowserEngine, type NavigationPolicy } from 'tablaze';

const navigationPolicy: NavigationPolicy = {
  allowedOrigins: ['https://app.example.com', 'https://login.example.com'],
};
const engine = new BrowserEngine({ channel: 'chrome', navigationPolicy });
try {
  const snapshot = await engine.open('https://app.example.com');
  inspectSnapshot(snapshot);
} finally {
  await engine.dispose();
}
```

## Checkpoints / 恢复点

An exported browser workspace stores a `navigationPolicyHash` when a policy is configured, including when no session has opened yet. Restoration requires the currently configured policy hash to match exactly. Canonically equivalent lists, including reordered or duplicate origins, match. Adding, removing or changing a policy does not. A legacy workspace without a policy hash can only be restored with no policy configured. The checkpoint stores the identity hash, not a policy file that the CLI silently trusts or reconstructs.

配置策略后，浏览器工作区导出会保存 `navigationPolicyHash`，即使尚未打开任何会话。恢复时要求当前策略的 hash 完全一致；顺序变化、重复项等正规化后相同的配置可以恢复。新增、移除或修改策略都会被拒绝。旧工作区没有策略 hash 时，只能在未配置策略的情况下恢复。恢复点保存的是策略身份 hash，CLI 不会根据恢复点静默加载或重建策略文件。

```sh
tablaze run --resume ./private-run.json --provider codex --model YOUR_MODEL \
  --channel chrome --navigation-policy ./navigation-policy.json
```

Policy identity is an equality check, not a signature or permission to trust an edited checkpoint. Checkpoints may contain cookies, page history and other sensitive state; keep them private. Existing limits, fresh-reference requirements and reconciliation of uncertain writes still apply. See [Agent recovery](AGENT.md) and [security boundaries](SECURITY.md).

策略 hash 用于一致性检查，不是签名，也不代表修改后的恢复点可信。恢复点可能包含 Cookie、页面历史及其他敏感状态，应妥善保管。原有预算、重新观察引用和核对未决写操作的要求仍然有效。参见 [Agent 恢复](AGENT.md)和[安全边界](SECURITY.md)。

## Boundaries / 边界

The runtime checks HTTP(S) **document requests**, including main-page and iframe navigation, popup documents and each HTTP redirect hop. The policy applies across the isolated contexts owned by the engine. Policy-enabled contexts block service workers. Internal `about:blank` pages and inline `srcdoc` documents are not external HTTP requests and can still exist; they do not add a new allowed HTTP(S) origin.

运行时检查 HTTP(S) **文档请求**，包括主页面和 iframe 导航、弹窗文档，以及 HTTP 重定向的每一跳。策略覆盖引擎创建的独立上下文；启用策略的上下文会阻止 Service Worker。内部 `about:blank` 页面和内联 `srcdoc` 文档不是外部 HTTP 请求，仍可存在，但不会因此新增允许的 HTTP(S) 来源。

Non-document traffic, including `fetch`/XHR, images, scripts and WebSockets, is outside this navigation policy. An allowed page can still make such requests to other origins. The policy does not provide per-origin secret storage or credential injection. Use an independent network boundary when the application requires broader traffic restrictions.

`fetch`/XHR、图片、脚本、WebSocket 等非文档流量不受此导航策略限制；已允许的页面仍可能向其他来源发送这些请求。策略不提供按来源隔离的密钥存储或凭证注入。应用需要更广泛的流量限制时，应使用独立的网络控制。

A transport-loss probe disconnected the guard's raw CDP WebSocket while a Document request was paused. Chromium continued the request: the receiving server's request count rose from 0 to 2; the retained result does not identify both request paths. The production guard detects transport loss, enters a failed state (`NAVIGATION_POLICY_FAILED`) and attempts to close the owned browser. That cleanup is best effort; it cannot guarantee that no request escapes before shutdown. This is an observed limit on atomic fail-closed behavior, not a network firewall.

已观测到的传输中断实验中，Document 请求暂停时断开守卫的原始 CDP WebSocket，Chromium 仍继续发送请求，接收服务器的请求数从 0 增至 2；保留的结果没有分别记录两次请求的路径。生产守卫会检测连接丢失，进入失败状态（`NAVIGATION_POLICY_FAILED`），并尽力关闭自有浏览器；但不能保证关闭前没有请求发出。这是已证实的非原子封锁边界，不能作为网络防火墙。

An origin policy is not an operating-system network firewall or a validation of everything an allowed site can do. It does not authorize purchases, messages or other business actions, establish that an allowed site is trustworthy, or prevent prompt injection. It does not govern the model provider's HTTP endpoint, a local Codex process or application-defined tool handlers. Those have their own trusted configuration and authorization. See [providers](PROVIDERS.md) and [custom tools](https://github.com/SweetDianDian/tablaze/blob/main/docs/CUSTOM_TOOLS.md).

来源策略不是操作系统网络防火墙，也不验证已允许站点中的所有行为。它不授予购买、发消息等业务操作权限，不证明站点可信，也不能防止提示注入。模型服务的 HTTP 端点、本地 Codex 进程和应用自定义工具处理器不受此浏览器策略管理；这些入口各自需要可信配置与授权。参见[模型适配器](PROVIDERS.md)和[自定义工具](https://github.com/SweetDianDian/tablaze/blob/main/docs/CUSTOM_TOOLS.md)。

See [measured probe evidence and provenance limits](NAVIGATION_POLICY_VALIDATION.md) and [current full regression results](https://github.com/SweetDianDian/tablaze/blob/main/docs/DEVELOPMENT_STATUS.md).

参见[探针实测及证据边界](NAVIGATION_POLICY_VALIDATION.md)与[当前全量回归](https://github.com/SweetDianDian/tablaze/blob/main/docs/DEVELOPMENT_STATUS.md)。
