# Owned browser emulation, permissions and proxy

Tablaze can set the browser viewport, device pixel ratio and granted page permissions at launch. These are **trusted operator settings**, not model-selected actions. They apply to new isolated contexts and to an owned persistent profile when it launches; they cannot reconfigure an external CDP browser.

```sh
tablaze --channel chrome --viewport 900x620 --device-scale-factor 2 --permissions geolocation,notifications
```

The same flags work with `tablaze run` and `tablaze doctor`. The SDK accepts `new BrowserEngine({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2, permissions: ['geolocation'] })` or the equivalent `createServer` options. `doctor` reports the parsed settings but does not open a browser; a real-Chrome test checks `innerWidth`, `innerHeight`, `devicePixelRatio` and the granted geolocation permission. Video recording, when separately enabled, uses the configured viewport as its frame size.

For responsive or localized pages, configure screen size, user agent, locale, time zone, mobile viewport behavior and touch independently:

```sh
tablaze --channel chrome --viewport 390x844 --screen 390x844 \
  --device-scale-factor 3 --mobile --touch \
  --locale fr-FR --timezone Europe/Paris \
  --user-agent "$BROWSER_USER_AGENT"
```

The SDK options are `screen`, `userAgent`, `locale`, `timezoneId`, `isMobile` and `hasTouch`. `doctor` reports screen/region/mobile/touch settings and only whether a custom user agent is present. A real-Chrome page check confirms `navigator.userAgent`, `navigator.language`, `Intl` time zone, `screen`, pixel ratio and touch capability. Mobile mode and touch are separate so callers can match a specific target device. A custom user agent can change site behavior but does not guarantee that the whole browser looks like that device.

For common Chromium mobile checks, use one trusted preset instead of six manual flags:

```sh
tablaze --channel chrome --device-preset pixel-7
```

The SDK accepts `new BrowserEngine({ devicePreset: 'pixel-7' })`; `pixel-7-pro` is also available. Each preset takes its viewport, screen, scale, user agent, mobile behavior and touch setting from the pinned Playwright device descriptor. `doctor` shows the effective values without printing the user agent. The preset cannot be combined with manual viewport/screen/scale/UA/mobile/touch settings or applied to an external CDP browser. Locale, time zone and permissions remain independent operator choices. Real-Chrome SDK and CLI MCP tests read the resulting page properties, including a meta-viewport page width. The [full Node 24 + Chrome log](evidence/development-tests-device-presets-node24.txt) records **501/501 passed** (SHA-256 `870e7fbce9f0959118c57ee953798f0a0cb0416dbcda17af39937defe3148e73`). A preset emulates selected browser properties; it does not change the host OS, browser engine, complete fingerprint or window geometry. Descriptor UA versions can differ from an installed Chrome channel.

An owned context can also use an HTTP(S) or SOCKS5 proxy:

```sh
export TABLAZE_PROXY_PASSWORD='your-proxy-password'
tablaze --channel chrome --proxy-server http://127.0.0.1:8080 \
  --proxy-bypass localhost,127.0.0.1 --proxy-username operator \
  --proxy-password-env TABLAZE_PROXY_PASSWORD
```

The SDK option is `proxy: { server, bypass?, username?, password? }`. The CLI requires an environment-variable name for a password and rejects credentials embedded in `--proxy-server`; `doctor` reports only whether a proxy and credentials were configured, plus its protocol. External CDP mode rejects proxy settings because that browser is not owned by Tablaze. Real-Chrome tests verify four routes with independent local servers: ordinary HTTP proxying; a 407 Basic-auth challenge followed by an accepted request without the secret appearing in page output; a non-loopback local destination going through the proxy without `bypass` and directly to its server with `bypass`; and an HTTP page returned through a SOCKS5 server that sees the requested hostname. The bypass test skips on machines without a non-loopback IPv4 address. The [route validation log](evidence/development-tests-proxy-routes-node24.txt) records **498/498 passed** (SHA-256 `61016985a2b0931ee580d68235ff63a178ed44b65cabddd3d76cac42b7cfd79f`). A separate real-Chrome MCP test starts the CLI with `--proxy-server`, `--proxy-username` and `--proxy-password-env`, receives a 407 challenge, and loads the target through the authenticated proxy without disclosing the test credential in MCP output or stderr. The [full CLI-stage log](evidence/development-tests-proxy-cli-node24.txt) records **499/499 passed** (SHA-256 `431b2ad8e632c4987060798721d91a3603934a7828ba09a8cc564430ed55ea43`). HTTPS CONNECT, authenticated HTTPS proxies, SOCKS5 authentication and external proxy services still need separate end-to-end evidence.

Default viewport is 1280×800 with device scale 1 and no explicit permission grants. Width is limited to 320–3840 CSS pixels, height to 240–2160, and scale to 0.5–4. Permission names must be unique and belong to the allowlist: `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, `camera`, `microphone`, `midi`, `midi-sysex`, `background-sync`, `ambient-light-sensor`, `accelerometer`, `gyroscope`, `magnetometer`, `accessibility-events`, `payment-handler`. Chromium/platform support varies; a requested permission can still fail at browser creation, so callers should use only permissions their workflow needs.

These options do not emulate full browser/device identity or browser window geometry. Optional [HAR and browser trace files](DIAGNOSTICS.md) are separate debugging artifacts with their own privacy and lifecycle limits. Granting camera, microphone, clipboard or location changes what a page may access. A proxy can see destination metadata and, for plain HTTP, page content; use one you trust. Keep credentials in a trusted environment and dedicated profiles.

中文：`--viewport 宽x高`、`--device-scale-factor` 和 `--permissions` 用来配置新建的自有浏览器上下文，也可用于自有持久 profile；不修改外部 CDP 浏览器。默认视口 1280×800、像素比 1、不主动授予权限。权限由操作者配置，页面获得这些权限后可能读取位置、剪贴板或设备，请只开启任务需要的项目。

移动端与地区测试可另设 `--screen`、`--user-agent`、`--locale`、`--timezone`、`--mobile`、`--touch`。这些参数彼此独立，不是预设的完整手机设备身份；真实 Chrome 回归已验证页面可见的语言、时区、屏幕、像素比和触控状态。

常见移动页面可用 `--device-preset pixel-7` 或 `pixel-7-pro` 一次设置视口、屏幕、像素比、UA、移动端行为和触控。SDK 使用 `devicePreset`；与手动设备参数冲突时直接报错。预设只模拟部分浏览器属性，不会改变宿主系统或提供完整设备指纹。

代理可用 `--proxy-server`、`--proxy-bypass`、`--proxy-username` 与 `--proxy-password-env` 配置；密码只从环境变量读取，不要放进 URL。真实 Chrome 与独立本地服务器已分别验收 HTTP 代理、407 Basic 认证、非回环目标的绕过规则，以及 SOCKS5 传递目标域名并加载 HTTP 页面。另有 CLI stdio MCP 测试证实环境变量密码经过 407 挑战后成功请求页面，输出未泄露凭据。HTTPS CONNECT 与外部代理服务仍需另测。
