# Owned browser viewport, scale and permissions

Tablaze can set the browser viewport, device pixel ratio and granted page permissions at launch. These are **trusted operator settings**, not model-selected actions. They apply to new isolated contexts and to an owned persistent profile when it launches; they cannot reconfigure an external CDP browser.

```sh
tablaze --channel chrome --viewport 900x620 --device-scale-factor 2 --permissions geolocation,notifications
```

The same flags work with `tablaze run` and `tablaze doctor`. The SDK accepts `new BrowserEngine({ viewport: { width: 900, height: 620 }, deviceScaleFactor: 2, permissions: ['geolocation'] })` or the equivalent `createServer` options. `doctor` reports the parsed settings but does not open a browser; a real-Chrome test checks `innerWidth`, `innerHeight`, `devicePixelRatio` and the granted geolocation permission. Video recording, when separately enabled, uses the configured viewport as its frame size.

Default viewport is 1280×800 with device scale 1 and no explicit permission grants. Width is limited to 320–3840 CSS pixels, height to 240–2160, and scale to 0.5–4. Permission names must be unique and belong to the allowlist: `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, `camera`, `microphone`, `midi`, `midi-sysex`, `background-sync`, `ambient-light-sensor`, `accelerometer`, `gyroscope`, `magnetometer`, `accessibility-events`, `payment-handler`. Chromium/platform support varies; a requested permission can still fail at browser creation, so callers should use only permissions their workflow needs.

These options do not emulate a full mobile device or change user agent, touch input, locale, timezone, screen size or browser window geometry. Proxy settings, HAR capture and full browser traces are separate unresolved gaps in the [Browser Use capability audit](BROWSER_USE_2026_AUDIT.md). Granting camera, microphone, clipboard or location changes what a page may access. Use dedicated profiles and trusted applications accordingly.

中文：`--viewport 宽x高`、`--device-scale-factor` 和 `--permissions` 用来配置新建的自有浏览器上下文，也可用于自有持久 profile；不修改外部 CDP 浏览器。默认视口 1280×800、像素比 1、不主动授予权限。权限由操作者配置，页面获得这些权限后可能读取位置、剪贴板或设备，请只开启任务需要的项目。
