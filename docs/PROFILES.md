# Owned persistent Chrome profiles / 自有持久浏览器资料

Tablaze has an **opt-in owned profile** mode for local Chromium/Chrome. It keeps browser-managed durable cookies, localStorage and IndexedDB across a browser process restart. The default remains an isolated temporary context per session. This mode is separate from attaching to an existing Chrome through `--cdp-url`.

## Use / 用法

Start a new dedicated directory (its parent must already exist):

```sh
tablaze --channel chrome --profile-dir /absolute/private/tablaze-profile
```

The first `tab_open` returns `session_mode: "persistent_profile"` and a random `profile_id`. Retain that ID as trusted operator configuration. On a later process launch, pass it back:

```sh
tablaze --channel chrome --profile-dir /absolute/private/tablaze-profile --profile-id PROFILE_ID
```

首次 `tab_open` 会返回 `profile_id`；再次启动同一目录时必须提供 `--profile-id`。SDK 对应选项为 `profileDir` 和 `expectedProfileId`。Tablaze 在目录内保存权限受限的 `.tablaze-profile.json` 标记，并用 `.tablaze-owner-lock` 拒绝同时占用。既有非空目录若没有标记，一律不作为 Tablaze profile 接管。使用前应先确认目录属于当前用户且只有该用户可访问。该目录包含登录凭据，须像密码库一样保护；正常关闭不会删除它。

The first run creates a private marker and an exclusive lock. Existing nonempty Chrome directories without that marker are refused. A second engine/process cannot concurrently open the same profile. If Chrome launch fails after initialization, read the ID from `.tablaze-profile.json` and supply `--profile-id` on retry; the normal failure path releases its lock. A stale lock after a crash must be removed **only after confirming the former Chrome/Tablaze process is gone**. The profile ID prevents an accidental path swap; it does **not** prove which account is currently signed into a site. An operator or application must still verify the active account/tenant before a sensitive write, especially after a same-origin account switch.

Persistent profiles cannot be combined with external CDP, `tab_open.storage_state`, workspace import or CLI `--checkpoint`/`--resume`. A document navigation policy is also unavailable in this mode because Chrome may restore pages before the guard is installed. A profile is a durable browser directory, not a durable Agent checkpoint: open a new Tablaze session, re-observe the page and reconcile uncertain writes after restart. Session IDs, refs, pending operations and in-memory tab ownership are not restored. Browser-managed session cookies and sessionStorage are not promised across a cold restart. The directory is not encrypted by Tablaze.

本模式不能与外部 CDP、状态导入、工作区恢复、CLI 检查点/恢复或文档导航策略组合。重启后需重新打开会话、观察页面，并核对可能已经发生的写入；持久 profile 不等于任务可无损续跑。`profile_id` 只核对目录身份，不证明当前网站所登录的账户或租户。

The focused [real-Chrome test](../tests/owned-profile.test.mjs) covers cold restart persistence for a durable cookie, localStorage and IndexedDB, concurrent-owner rejection, profile-ID mismatch before a write URL is visited, a second profile having no first-user state at the same origin, refusal to adopt an unrelated browser directory, and lock/path handling after a failed Chrome launch. The [447/447 full regression log](evidence/development-tests-profile.txt) and [source/build manifest](evidence/owned-profile-validation.json) include those four profile tests. This is a mechanism test, not a model-driven Browser Use comparison or evidence of production OAuth parity.
