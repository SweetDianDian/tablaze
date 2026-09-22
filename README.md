<p align="center">
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site">
    <img src="docs/assets/tablaze-banner.svg" alt="Tablaze — a compact browser MCP. Observe. Act. Verify." width="100%">
  </a>
</p>

<p align="center">
  <strong><a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site">Website ↗</a></strong> &nbsp; · &nbsp;
  <a href="https://tablaze-browser-mcp.isdiandian0825.chatgpt.site#demo">Watch the demo</a> &nbsp; · &nbsp;
  <a href="docs/CODEX.md">Codex guide</a> &nbsp; · &nbsp;
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml"><img src="https://github.com/SweetDianDian/tablaze/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b7db9a?style=flat-square" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A520-80b7ff?style=flat-square" alt="Node.js 20 or later"></a>
</p>

**Give your agent a browser it can work with.** Tablaze connects Codex and other MCP clients to Chromium through eight focused tools. Inspect a page, fill a form, extract a result, and check that the task actually succeeded.

Built with Playwright. Browser sessions stay running between calls; your MCP client supplies the reasoning. No additional model API key required.

## See it work

**[Watch the 56-second demo →](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site#demo)**

A real MCP SDK client searches for a stay in Lisbon, verifies five outcomes, then encounters a replaced button and recovers with a fresh observation. The recording shows actual tool responses and browser captures.

[![Real MCP demo: five checks passed against the Lisbon hotel results](docs/assets/demo-poster.png)](https://tablaze-browser-mcp.isdiandian0825.chatgpt.site#demo)

`Observe the form` → `Fill · select · check · search` → `Verify the result`

[Reproduce the recording](demo/README.md) · [Inspect the full trace](docs/evidence/demo-run.json)

## Get started

Requires **Node.js 20+**, npm and Git. This is a developer preview; npm publication is pending, so install from source:

```sh
git clone https://github.com/SweetDianDian/tablaze.git
cd tablaze
npm ci
npm run build
node dist/cli.js setup
```

<details>
<summary>Already have Chrome, or running on Linux?</summary>

For installed Chrome, skip `setup`, run `node dist/cli.js doctor --channel chrome`, and append `--channel chrome` to the Codex command below. This launches a separate browser session.

On Linux, use `npx playwright install --with-deps chromium` in place of `setup` to install the browser and system dependencies.

[Browser modes and diagnostics](docs/CODEX.md#1-build-and-choose-a-browser)

</details>

### Connect Codex

From the cloned directory, register the built server:

```sh
codex mcp add tablaze -- "$(node -p 'process.execPath')" "$PWD/dist/cli.js"
codex mcp get tablaze
```

Then ask Codex:

> Use Tablaze to open https://example.com, read the heading and links, verify that the title contains “Example Domain”, then close the session. Report the result of the checks.

[Complete Codex setup](docs/CODEX.md) covers desktop configuration, browser selection and troubleshooting. Other MCP clients can launch the same `node /absolute/path/to/tablaze/dist/cli.js` command over stdio.

## A small loop, with useful controls

| Capability | What it gives your agent |
| --- | --- |
| **Warm sessions** | Keep page state between calls. Temporary, isolated browser contexts by default; explicit CDP attachment for an existing profile. |
| **Compact observations** | Full or incremental snapshots with element refs, text budgets and visible truncation. |
| **Guarded actions** | Check snapshot revisions and DOM targets before input. Re-observe when a target changes. |
| **Ordered batches** | Send up to 20 actions in one call, with completed, failed and skipped steps. Stops on error; earlier effects remain. |
| **Explicit verification** | Check the resulting URL, title, text, field values, visibility and element counts. |

### Eight tools

| Tool | Use it to |
| --- | --- |
| `tab_open` | Open a page and receive its first snapshot. |
| `tab_snapshot` | Observe the page, changes or a selected frame. |
| `tab_act` | Click, fill, press, select, check, scroll or wait. |
| `tab_verify` | Test explicit assertions against the current page. |
| `tab_extract` | Read text, links or tables. |
| `tab_capture` | Capture a JPEG screenshot. |
| `tab_list` | Inspect owned sessions. |
| `tab_close` | Close a session and release its resources. |

## Explore the project

| Guide | Inside |
| --- | --- |
| [Codex integration](docs/CODEX.md) | Copyable configuration, tool arguments and troubleshooting. |
| [Runtime reference](docs/RUNTIME.md#english) | Reference lifetime, batch semantics, browser modes and current limits. |
| [Benchmark](bench/README.md) | Reproduce the local workload and inspect every raw sample. |
| [Validation evidence](docs/VALIDATION.md) | Real browser, SDK and Codex results, with their measured scope. |
| [Security](SECURITY.md) | Data handling, resource ownership and private reporting. |
| [Release packaging](docs/RELEASE.md) | Build the npm tarball and source archive. |

[Ubuntu CI on Node 20 and 22](https://github.com/SweetDianDian/tablaze/actions/runs/35696802909) passed the build, browser/MCP tests and package inspection. To check a source checkout yourself, run `npm test`; use `npm run bench` for the separate local benchmark.

## Contribute

Bring a reproducible browser case, improve a guide, or send a focused fix. [Open an issue](https://github.com/SweetDianDian/tablaze/issues) · [Submit a pull request](https://github.com/SweetDianDian/tablaze/pulls) · [Read the contribution guide](CONTRIBUTING.md)

[MIT licensed](LICENSE) · [Dependency credits and project provenance](NOTICE)
