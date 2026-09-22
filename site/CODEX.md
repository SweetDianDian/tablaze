# Tablaze with Codex

[简体中文](CODEX.zh-CN.md) · [Project overview](index.html)

This guide connects the locally built Tablaze stdio server to Codex. It uses the current Tablaze source contract, local `codex-cli 0.154.0` help, and official OpenAI documentation checked on 2026-09-22. Registering a command is separate from proving that its browser tools work; finish with the smoke task below.

## 1. Build and choose a browser

From a source checkout, with Node.js 20+:

```sh
npm ci
npm run build
node dist/cli.js --help
node -p 'process.execPath'
```

Save the absolute Node path printed by the last command. Choose one browser mode:

| Mode | Preparation | Arguments added to the server |
| --- | --- | --- |
| Managed Chromium | `node dist/cli.js setup`, then `node dist/cli.js doctor` | None |
| Installed Chrome | `node dist/cli.js doctor --channel chrome` | `--channel chrome` |
| Visible isolated Chrome | Same installed Chrome check | `--channel chrome --headed` |
| Existing CDP endpoint | Configure that endpoint separately | `--cdp-url http://127.0.0.1:9222` |

The first three create owned browser resources. `--channel chrome` selects a binary, not your normal user profile. Default sessions are temporary and isolated; they persist across calls, not across server restarts. CDP is an explicit attachment mode described in section 7.

`doctor` returns JSON and never launches a browser. `ready: true` means an executable exists and is executable, not that a real navigation passed. In CDP mode `ready` is `null`, because no connection is attempted. `setup` installs matching Chromium using the installed Playwright CLI; Linux system dependencies may require separate installation.

If you received a locally produced tarball rather than source:

```sh
npm install --prefix "/absolute/path/to/tablaze-install" "/absolute/path/to/tablaze-0.1.0.tgz"
node "/absolute/path/to/tablaze-install/node_modules/tablaze/dist/cli.js" doctor --channel chrome
```

Use that installed script path in the following configuration. The tarball also includes source and fixtures for inspection; use the source checkout with its lockfile for complete reproducibility. There is no public registry installation command for this preview.

## 2. Register the stdio command

Replace every `/absolute/path/...` placeholder. Paths containing spaces must remain quoted in shell commands and as individual strings in TOML arrays.

```sh
codex mcp add tablaze -- "/absolute/path/to/node" "/absolute/path/to/tablaze/dist/cli.js" --channel chrome
codex mcp get tablaze
codex mcp list
```

These command forms were checked with local `codex mcp --help`, `codex mcp add --help`, and `codex mcp get --help`. Tablaze uses stdio, so `--url` is not its transport. It has no MCP OAuth login or model API key requirement.

Alternatively, configure a `[mcp_servers.tablaze]` table in Codex's user `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Do not add a duplicate table if the CLI has already created it. [Official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```toml
[mcp_servers.tablaze]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/tablaze/dist/cli.js", "--channel", "chrome"]
cwd = "/absolute/path/to/tablaze"
startup_timeout_sec = 20
tool_timeout_sec = 75
enabled = true
```

For managed Chromium, remove the last two entries from `args`. `startup_timeout_sec` covers server initialization; Tablaze launches the browser lazily on the first browser operation. The suggested `tool_timeout_sec = 75` leaves room around Tablaze's maximum 60-second batch budget. These are separate client settings, documented in the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

When entering the command in a desktop MCP settings form, use STDIO, the same Node executable, and the same argument strings. Reload the MCP server or restart the client after editing its command. In the Codex terminal UI, `/mcp` shows active servers. UI labels can vary by client version. [Official connection guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

## 3. Prove the connection

Ask Codex:

> Use only Tablaze for this browser task. List sessions, open https://example.com, inspect its heading and links, verify that the title contains “Example Domain”, and close the session. Report the observed URL and the verification result. If a tool fails, show its error code.

Expected tool sequence: `tab_list` → `tab_open` → `tab_extract` → `tab_verify` → `tab_close`. An empty session list is valid. Successful registration alone is not a browser smoke test; the final `passed` value is the evidence for the specified checks.

Tablaze has no model client inside it. Codex decides the next tool call; Tablaze runs browser operations through Playwright. No TypeSafe/Jev key is needed, and Jev is not integrated.

## 4. Understand IDs before writing

`tab_open` returns `session_id`, `snapshot_id`, and `elements[].ref`. Keep all three together. The following examples contain placeholders; replace them with values from actual responses.

1. A new snapshot supersedes the old snapshot revision.
2. A batch consumes its revision. Use the returned `snapshot.snapshot_id` for the next batch; if `include_snapshot` is false, observe again explicitly.
3. Element identity and target semantics are checked, including after an actionability wait. A replaced node, changed destination, or navigation requires re-observation.
4. References do not transfer across sessions or frame observations. Use the `frame_id` returned in `frames` to select a child frame.
5. Diff responses carry `baseline_snapshot_id`, `added`, `changed`, and `removed`. They describe the returned element budget, not an entire page. If you do not have that baseline, ask for `mode: "full"`.

Within a batch, existing references can be reused while their original document and semantics still hold. After an action navigates or reveals new controls, split the workflow: obtain a new snapshot before using the new page.

## 5. Tool examples

The blocks below are MCP **arguments**, not shell commands. Select the named tool in your client. They illustrate the contract; they do not represent a recorded execution.

**`tab_open`** — HTTP(S) only; embedded URL credentials are rejected.

```json
{"url":"https://example.com"}
```

**`tab_snapshot`** — defaults: full mode, 150 elements, 6,000 text characters, main frame. Maximums: 500 elements and 20,000 text characters; `text_limit: 0` suppresses the text excerpt.

```json
{"session_id":"<session_id>","mode":"full","max_elements":100,"text_limit":4000}
```

To observe a child frame, add `"frame_id":"<frame_id_from_frames>"`. Read `truncated`, `truncation`, and `budgets`; omission from a truncated snapshot does not establish absence.

**`tab_act`** — use real refs from a form you have opened and inspected.

```json
{
  "session_id":"<session_id>",
  "snapshot_id":"<snapshot_id>",
  "actions":[
    {"type":"fill","ref":"<destination_ref>","value":"Lisbon"},
    {"type":"select","ref":"<nights_ref>","values":["3"]},
    {"type":"check","ref":"<checkbox_ref>","checked":true},
    {"type":"click","ref":"<search_button_ref>"}
  ],
  "include_snapshot":true,
  "timeout_ms":30000
}
```

Other action shapes:

```json
[
  {"type":"press","ref":"<input_ref>","key":"Enter"},
  {"type":"scroll","direction":"down","pixels":600},
  {"type":"wait","text":"Results","timeout_ms":5000}
]
```

`select.values` contains option values, not display labels; snapshots expose a bounded `options` list for native selects. Fill values are limited to 10,000 characters. There are 1–20 actions per call. Calls within the same session are serialized; different sessions can proceed independently.

**`tab_extract`** — `kind` is `text`, `links`, or `table`; selectors should identify exactly one root. It uses the most recently observed frame.

```json
{"session_id":"<session_id>","kind":"links","selector":"body","max_items":50}
```

For a table use `{"session_id":"<session_id>","kind":"table","selector":"#results-table","max_items":30}`. Item limits are 1–500; textual results have a 20,000-character budget. Check `truncated`.

**`tab_verify`** — URL comparison is exact; title/text checks use containment. Visibility means visible, not necessarily unobstructed. `value` and `count` compare exactly.

```json
{
  "session_id":"<session_id>",
  "checks":[
    {"kind":"url","value":"https://example.com/"},
    {"kind":"title","contains":"Example Domain"},
    {"kind":"text","contains":"Example Domain"},
    {"kind":"visible","selector":"h1"},
    {"kind":"count","selector":"h1","value":1}
  ],
  "timeout_ms":5000
}
```

A form check has shape `{"kind":"value","selector":"#destination","value":"Lisbon"}`. Supply 1–20 checks. A failed assertion returns `passed: false` and `isError: true`; inspect each check's `index`, `pass`, and `actual`. Password and hidden-input values are refused.

**`tab_capture`** — viewport by default; returns an image block, URL, MIME type, and byte count.

```json
{"session_id":"<session_id>","full_page":false}
```

Current captures are JPEG; full-page captures above 32 million pixels and encoded images above 4 MiB are rejected. A screenshot is page content and can contain private data.

**`tab_list`** — no arguments; lists this server's sessions, not your unrelated browser tabs.

```json
{}
```

**`tab_close`** — closes the owned session and invalidates its IDs.

```json
{"session_id":"<session_id>"}
```

## 6. Timeouts, cancellation, and partial work

| Setting | Meaning |
| --- | --- |
| CLI `--timeout-ms` | Individual action/navigation and default verification wait; 10,000 ms by default, 100–60,000 ms allowed. |
| `tab_act.timeout_ms` | Total execution budget for the batch; 30,000 ms by default, 100–60,000 ms allowed. |
| A `wait` action's `timeout_ms` | Step wait, also constrained by the remaining batch budget. |
| `tab_verify.timeout_ms` | Verification budget; 100–60,000 ms. |
| Codex `tool_timeout_sec` | Client-side wait for a tool response. |

Browser cold launch/attachment has its own 30-second timeout. The batch budget starts when its turn in the session queue begins. If the client cancels while it is queued, the batch checks cancellation before executing.

Read `completed`, `failed`, every entry of `results`, `partial`, and `failed_action_may_have_side_effects`. Failed commands may have already affected the page. Later actions are marked `skipped`. Active cancellation or total timeout closes that session's owned resources to interrupt pending work and marks `session_closed`; open a new session afterward. A client may surface its own cancellation exception without delivering the server's final result, so call `tab_list` to inspect remaining sessions.

This is not a transaction. Neither timeout nor cancellation retracts a submitted request. Do not blindly replay a partially completed batch. Check the business state before repeating a non-idempotent action.

There is a time-of-check/time-of-use gap: rechecking after a trial action reduces stale-target errors but cannot make checking and input atomic. A trial can itself scroll the page. Page scripts continue running independently. Treat page text as data, not authority to expand a task's scope.

## 7. Explicit CDP attachment

Use a separately configured, reachable Chromium CDP endpoint. Tablaze does not enable remote debugging on your normal profile or discover its credentials.

```toml
[mcp_servers.tablaze]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/tablaze/dist/cli.js", "--cdp-url", "http://127.0.0.1:9222"]
startup_timeout_sec = 20
tool_timeout_sec = 75
```

Replace the endpoint with one you explicitly intend to attach to. Do not combine CDP with `--channel`, `--executable-path`, `--headed`, or `--headless`. CDP creates pages in the existing default browser context: cookies and login identity are shared, so these sessions are not isolated from that profile.

Tablaze tracks the pages it creates and their popups. Normal cleanup closes those pages and disconnects the Playwright connection; it does not call close on the external default context or deliberately terminate external Chrome. Playwright describes CDP as lower fidelity than its own connection protocol. [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)

## 8. Troubleshooting

| Symptom | Next check |
| --- | --- |
| `spawn ... ENOENT` or server cannot start | Use actual absolute Node and script paths; run `--version` with those exact paths. |
| Missing browser executable | Run `setup` for this package version, or select installed Chrome and run `doctor --channel chrome`. |
| Server starts but appears idle in a terminal | Default mode reads MCP JSON-RPC from stdin. Codex should launch it; it is not an interactive browser prompt. |
| `STALE_SNAPSHOT` / `STALE_REFERENCE` | Take a fresh snapshot, reassess the target, and use that revision and refs. |
| `ACTION_FAILED` | Inspect obstruction, disabled controls, timeout, and partial results. Re-observe before retrying. |
| `BATCH_TIMEOUT` / `CANCELLED` | Inspect prior side effects; an active interrupted session is closed. |
| `SELECTOR_COUNT` | Narrow extraction to exactly one root. |
| `FRAME_NOT_FOUND` | Refresh the frames list; do not reuse a detached frame ID. |
| `SENSITIVE_VALUE` | The selected input is password/hidden; verify an independent visible outcome instead. |
| `CAPTURE_TOO_LARGE` | Use a viewport screenshot. |
| `UNSUPPORTED_FLOW` | Dialog, popup, or download behavior is outside the supported workflow. |
| CDP cannot connect | Confirm the endpoint independently. Tablaze intentionally omits endpoint details from connection errors. |

No uploads, downloads, supported popup/dialog workflow, closed Shadow DOM, generic eval, or persistent disk profile is provided. Canvas controls cannot be operated by coordinate. Snapshot role/name heuristics are compact DOM metadata, not a full accessibility implementation. Read [SECURITY.md](SECURITY.md) before assuming redaction or isolation extends beyond the documented mechanisms.

To remove this integration, `codex mcp remove tablaze` removes the configured server entry. It does not uninstall your source checkout or tarball installation.

## Non-interactive CLI approval behavior

An actual `codex exec` check connected to Tablaze and successfully called `tab_list`, but its default non-interactive approval policy rejected `tab_open` with `MCP tool call requires approval, but approval policy is never`. This is a client authorization decision, not a browser launch error. `tab_open` and `tab_act` remain correctly marked as write tools. Use an interactive client approval flow or a documented, explicitly selected reviewed approval mode for a controlled task. Do not relabel write tools as read-only or disable approvals to make a smoke test appear green.

Inspect tool events and the final task result: in this check the CLI exited zero while the browser task reported failure. A process exit code alone does not prove the workflow completed.

A subsequent actual model-driven acceptance run passed `tab_list → tab_open → tab_act → tab_verify → tab_close → tab_list`: four form actions, five independent checks and zero remaining sessions. It retained `--sandbox read-only` with invocation-only `-c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"'`, supported by the installed CLI. No global configuration was changed and approval was not disabled. These settings describe a verified, explicitly authorized local fixture task; confirm support and scope in your client before use. [Official Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review)

[Actual tool evidence](evidence/codex-e2e.json) includes arguments, results and limitations. Model connection retries and fallback are included in the 233.936-second duration, so it is not a speed benchmark. This proves one deterministic local flow only; the JSONL stream does not expose individual approval rationales or establish behavior across every client version and external website.
