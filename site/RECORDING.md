# Optional real browser video

`--record-video` records the pixels of every owned tab in an isolated Tablaze session. It is disabled by default. Playwright writes one WebM file per tab; the file is finalized when the session closes. This is a continuous browser recording for debugging, not the narrated presentation video on the website. It contains no added cursor or audio track.

```sh
node dist/cli.js --record-video --channel chrome
```

When an MCP client calls `tab_close`, its response includes `recordings` with each tab's `session_id`, `tab_id`, private absolute `path`, `bytes`, `mime_type` and SHA-256. The video bytes are never inlined into the MCP response. `tablaze run --record-video ...` includes the same records in the final JSON report after browser cleanup, even if the Agent did not call `tab_close`. SDK users can pass `recordVideo: true` to `BrowserEngine` or `createServer`, and read `engine.recordings()` after `close()` or `dispose()`.

The artifact directory is private and each finalized file is mode `0600`. A recording can contain private page content, including credentials typed outside Tablaze's secret aliases; retain and share it accordingly. With configured secret aliases, recording is refused unless the trusted configuration explicitly sets `allowSensitiveArtifacts: true`. Recording is unavailable for external CDP attachments and persistent-profile mode because Tablaze does not own a new isolated context in those modes. The option does not change ordinary browser actions, and a failed recording finalization is reported as an error rather than silently claiming an artifact exists.

The recording starts with the session, so it cannot be enabled halfway through an existing session. Files remain on disk after session closure and have no automatic retention policy. The WebM is a debugging artifact; it does not prove the business task succeeded. Continue to use `tab_verify` and independent application checks for that conclusion.

中文：通过 `--record-video` 可选录制真实浏览器标签页。每个标签页生成独立 WebM；关闭会话后，`tab_close` 返回私有文件路径、大小和 SHA-256。独立 `run` 命令会在清理后把录像清单写入最终 JSON。默认关闭，不添加假鼠标，也不录声音；录像可能包含私人页面信息。外部 CDP、持久 profile 不支持此模式；配置了密钥别名时，须由可信配置显式允许敏感文件。
