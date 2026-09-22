# Tablaze / 闪页

**Small snapshots. Warm sessions. Clear outcomes.**

Tablaze is a local browser MCP for agents that need to open pages, work through forms, and verify what actually happened. It keeps Chromium running, returns compact page observations, and executes bounded action batches against the elements the agent just observed.

[简体中文](README.zh-CN.md) · [Connect Codex](docs/CODEX.md) · [Benchmark method](bench/README.md) · [Contributing](CONTRIBUTING.md)

**Status: developer preview, version 0.1.0.** The public source repository is [SweetDianDian/tablaze](https://github.com/SweetDianDian/tablaze). npm publication is still pending; use the source or a locally built package. Linux CI awaits its first push-triggered result. There are no claimed adoption numbers or cross-product speedups.

## What makes it useful

- **A browser that stays ready.** Sessions retain their page and cookies while the server runs. Default sessions use separate, temporary browser contexts.
- **Observations with a budget.** Full or incremental snapshots expose element references, visible text, frames, and explicit truncation information.
- **References with context.** Each batch supplies both a session ID and a snapshot revision. Replaced nodes and changed target semantics are checked again before input.
- **Fewer separate tool calls.** Submit up to 20 ordered actions, inspect completed/failed/skipped steps, then verify explicit outcomes.
- **No extra model account.** Tablaze does not call a model or require an API key. Your MCP client supplies the reasoning.

```text
Codex / another MCP client
           │ stdio
           ▼
        Tablaze
 observe → guarded actions → verify
           │ Playwright
           ▼
   persistent browser process
     isolated session contexts
```

Jev is **not integrated** in this release. The exploration of `browser-use/jev-ultrafast` inspired the focus on a small browser control loop; Tablaze does not require Jev, TypeSafe, or a text-generation provider.

## Start from source

Requires **Node.js 20+**, npm, Git, and a supported desktop/server environment for Chromium. Clone the source, then build it:

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
node dist/cli.js doctor
```

`setup` invokes the installed Playwright CLI to download its matching Chromium. On Linux, additional system libraries may be required; see [Playwright's browser installation guide](https://playwright.dev/docs/browsers). Browser downloads never run automatically during MCP startup.

To use installed Chrome instead, skip `setup` and run:

```sh
node dist/cli.js doctor --channel chrome
```

`--channel chrome` launches a separate browser with a temporary context. It does not attach to your existing logged-in tabs. `doctor` checks the executable and reports versions when available; it does not launch or connect to a browser.

## Connect Codex

Replace **both absolute paths** below with your Node executable and built checkout. Find Node with `node -p 'process.execPath'`.

```sh
codex mcp add tablaze -- "/absolute/path/to/node" "/absolute/path/to/tablaze/dist/cli.js" --channel chrome
codex mcp get tablaze
```

Omit `--channel chrome` to use Chromium installed by `setup`. For configuration, all tool examples, cancellation semantics, and troubleshooting, read the [Codex guide](docs/CODEX.md). The command shape follows [OpenAI's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Try this prompt:

> Use Tablaze to open https://example.com, read its heading and links, verify the page title, and close the session. Report what the browser evidence confirms.

## Eight tools

| Tool | Purpose |
| --- | --- |
| `tab_open` | Open an HTTP(S) page and return its first snapshot. |
| `tab_snapshot` | Read a full snapshot or a diff; optionally select an iframe. |
| `tab_act` | Click, fill, press, select, check, scroll, or wait in an ordered batch. |
| `tab_extract` | Extract bounded text, links, or table rows. |
| `tab_verify` | Check URL, title, text, visibility, field value, or element count. |
| `tab_capture` | Return a JPEG screenshot with metadata. |
| `tab_list` | List this server's sessions. |
| `tab_close` | Close one owned session. |

Tool results include JSON text and `structuredContent`. Failed operations set `isError`; action results also describe partial progress. SDK input-validation errors use the SDK's error format. Screenshots include an MCP image block. There is no arbitrary JavaScript execution tool.

## Know the execution contract

Observe before acting. A newer snapshot invalidates the previous `snapshot_id`, and an action batch consumes its supplied revision. Use the fresh snapshot returned by `tab_act`, or call `tab_snapshot` again. References from another session or a navigated/replaced document are not interchangeable. A diff needs its named baseline; ask for a full snapshot if that baseline is unavailable.

Batches contain **1–20 steps**, run serially within a session, and stop at the first failure. The total budget defaults to **30 seconds**, with a **60-second maximum**. The CLI's `--timeout-ms` controls individual action/navigation waits; `tab_act.timeout_ms` controls the whole batch. A cancelled active batch or expired batch budget closes its owned session to interrupt work. A cancellation received before execution starts performs no actions. Cancellation and failure **do not roll back** clicks, submissions, or network requests that already happened.

Node identity and semantic checks reduce stale-target mistakes. The DOM can still change between a check and actual input: this is **not an atomic guarantee or a security sandbox**. Trial actionability checks can scroll the page. Use `tab_verify` for business outcomes; a completed click does not prove a successful submission.

## Browser modes and data

Default sessions are isolated and last only as long as their context/server. They are not saved user profiles. An explicit `--cdp-url` attaches to an already configured Chromium endpoint and creates owned pages in its existing profile. Those pages share that profile's login state and storage. Closing Tablaze cleans up its owned pages and disconnects; it does not intentionally close unrelated tabs or terminate the external Chrome process.

Password and hidden input values are omitted from snapshots and rejected by value checks. Other field values, page text, URLs, extracted content, and screenshots may contain private information and are returned to the MCP client. This is not comprehensive secret detection. Read the [security boundaries](SECURITY.md).

Current limits: Chromium only; no file upload/download workflow, arbitrary evaluation, closed-shadow-root access, native dialog handling, or supported new-tab workflow. Open shadow DOM and explicitly selected frames have coverage, but the compact DOM representation is not a complete accessibility tree. Canvas-only interfaces may need a screenshot; there is no coordinate-click tool. CDP uses Playwright's lower-fidelity attachment path.

## Build a local package

```sh
npm pack
```

For this version, the output is `tablaze-0.1.0.tgz`. Install that exact artifact into a directory you choose:

```sh
npm install --prefix "/absolute/path/to/tablaze-install" "/absolute/path/to/tablaze-0.1.0.tgz"
node "/absolute/path/to/tablaze-install/node_modules/tablaze/dist/cli.js" doctor --channel chrome
```

Point Codex at the installed `dist/cli.js` absolute path. A registry command such as `npx tablaze@latest` is intentionally not an installation path for this unpublished preview.

## Validate and contribute

Report a reproducible problem through [Issues](https://github.com/SweetDianDian/tablaze/issues), or send a focused [pull request](https://github.com/SweetDianDian/tablaze/pulls). Read the [contribution guide](CONTRIBUTING.md) for the local fixture workflow and validation expectations.

Run from the source checkout with its lockfile and development dependencies:

```sh
npm test
npm run bench
```

With installed Chrome on macOS/Linux, prefix either command with `TABLAZE_BROWSER_CHANNEL=chrome`. Tests use local fixtures and isolated browsers. The benchmark separates cold opening, warm observation, action batches, verification, and JSON payload size; its scope excludes model reasoning and MCP transport. See the [method and raw-output format](bench/README.md). Publish measurements with their environment and failed attempts, not an unsupported speed claim.

[MIT license](LICENSE). Dependency credits and project provenance are in [NOTICE](NOTICE).

Reproduce the [actual MCP demo](demo/README.md), inspect [validation evidence](docs/VALIDATION.md), or create release archives with the [packaging guide](docs/RELEASE.md).
