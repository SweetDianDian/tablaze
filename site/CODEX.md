# Tablaze with Codex

[简体中文](CODEX.zh-CN.md) · [Project overview](https://github.com/SweetDianDian/tablaze/blob/main/README.md)

This guide connects the locally built Tablaze stdio server to Codex. It uses the current Tablaze source contract, local `codex-cli 0.154.0` help, and official OpenAI documentation checked on 2026-09-22. Registering a command is separate from proving that its browser tools work; finish with the smoke task below.

The current development branch exposes 16 MCP tools by default. A trusted operator can add `--capture-network` for bounded owned-tab responses, `--page-script` for full-authority page-origin JavaScript, or both; each adds one optional tool. See the [network journal](NETWORK.md) and [page-script](PAGE_SCRIPT.md) contracts. The recorded 0.1.0 release and Codex acceptance evidence describe an earlier build; they do not validate every capability now present in source. Use the checkout's tool catalog and commit when identifying a build.

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

The first three create owned browser resources. `--channel chrome` selects a binary, not your normal user profile. Default sessions are temporary and isolated; they persist across calls. A restart alone does not restore them: use explicit state export/import or the checkpoint workflow below. CDP is an explicit attachment mode described in section 7.

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

In this MCP integration, Codex decides the next tool call and Tablaze runs browser operations through Playwright. MCP startup makes no model call and needs no model API key. The separate optional `tablaze run` command has a configured model adapter; see the [Agent guide](https://github.com/SweetDianDian/tablaze/blob/main/docs/AGENT.md).

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

For an observed form control, use `{"kind":"value","ref":"r3","value":"Lisbon"}` and supply the containing `snapshot_id` beside `session_id`. Use the fresh snapshot returned by an action when available. A value check accepts exactly one of `ref` or a CSS `selector`; the existing `{"kind":"value","selector":"#destination","value":"Lisbon"}` form remains supported. Page-text checks exclude raw input, textarea and select values: combine value checks for controls with text checks for confirmation messages. Ref checks reject replaced nodes, changed identities and stale documents.

Supply 1–20 checks. A failed assertion returns `passed: false` and `isError: true`; inspect each check's `index`, `pass`, and `actual`. Password and hidden-input values are refused.

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
| `CLEANUP_INCOMPLETE` | Disposal could not confirm all owned resources closed within its bounded wait. Inspect the cleanup error separately from the business outcome; unresolved CDP acquisition retains late cleanup without closing unrelated pages. See [runtime boundaries](https://github.com/SweetDianDian/tablaze/blob/main/docs/RUNTIME.md). |
| `SELECTOR_COUNT` | Narrow extraction to one root, or use `multiple: true` for an intended structured-field array. |
| `FRAME_NOT_FOUND` | Refresh the frames list; do not reuse a detached frame ID. |
| `SENSITIVE_VALUE` | The selected input is password/hidden; verify an independent visible outcome instead. |
| `CAPTURE_TOO_LARGE` | Use a viewport screenshot or reduce the page being exported as PDF. |
| `PDF_TIMEOUT` | The export exceeded its timeout and closed the owned tab; check remaining tabs before continuing. |
| `SCHEMA_MISMATCH` / `TYPE_CONVERSION` | Inspect the field plan and schema; values are not silently coerced or invented. |
| `TRUNCATED_FIELD` / `EXTRACTION_LIMIT` | Narrow selectors or split the extraction. |
| `UNSUPPORTED_FLOW` | Inspect the reported flow; arm `tab_dialog` before a native dialog and inspect possible effects before retrying. Owned popups and downloads have dedicated tools. |
| CDP cannot connect | Confirm the endpoint independently. Tablaze intentionally omits endpoint details from connection errors. |

Current source supports explicit uploads and downloads, owned popups, armed native dialogs, viewport coordinate clicks and an opt-in [owned persistent Chrome profile](PROFILES.md). Closed shadow roots remain outside DOM observation and no generic eval tool is provided. Explicit workspace restoration rebuilds selected browser state and URLs, not live page memory. Snapshot role/name heuristics are compact DOM metadata, not a full accessibility implementation. Read [SECURITY.md](SECURITY.md) for the implemented redaction and isolation boundaries.

To remove this integration, `codex mcp remove tablaze` removes the configured server entry. It does not uninstall your source checkout or tarball installation.

## Non-interactive CLI approval behavior

An actual `codex exec` check connected to Tablaze and successfully called `tab_list`, but its default non-interactive approval policy rejected `tab_open` with `MCP tool call requires approval, but approval policy is never`. This is a client authorization decision, not a browser launch error. `tab_open` and `tab_act` remain correctly marked as write tools. Use an interactive client approval flow or a documented, explicitly selected reviewed approval mode for a controlled task. Do not relabel write tools as read-only or disable approvals to make a smoke test appear green.

Inspect tool events and the final task result: in this check the CLI exited zero while the browser task reported failure. A process exit code alone does not prove the workflow completed.

A subsequent actual model-driven acceptance run passed `tab_list → tab_open → tab_act → tab_verify → tab_close → tab_list`: four form actions, five independent checks and zero remaining sessions. It retained `--sandbox read-only` with invocation-only `-c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"'`, supported by the installed CLI. No global configuration was changed and approval was not disabled. These settings describe a verified, explicitly authorized local fixture task; confirm support and scope in your client before use. [Official Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review)

[Actual tool evidence](evidence/codex-e2e.json) includes arguments, results and limitations. Model connection retries and fallback are included in the 233.936-second duration, so it is not a speed benchmark. This proves one deterministic local flow only; the JSONL stream does not expose individual approval rationales or establish behavior across every client version and external website.

## Development branch: extended workflows

These additions are not covered by the historical 0.1.0 release evidence. The server now exposes 16 tools: `tab_open`, `tab_snapshot`, `tab_find`, `tab_act`, `tab_extract`, `tab_verify`, `tab_capture`, `tab_list`, `tab_close`, `tab_navigate`, `tab_tabs`, `tab_downloads`, `tab_dialog`, `tab_state`, `tab_pdf`, and `tab_extract_structured`.

For truncated pages, scope `tab_snapshot` to exactly one CSS root, or scroll and observe only the viewport. Changing scope resets the diff baseline. A new snapshot invalidates earlier revisions.

For a virtual list, call `tab_find` with visible target text and an observed vertical `container_ref` plus its current `snapshot_id`. It searches one selected frame, scrolls at most 40 times by default (100 maximum), and returns a fresh viewport snapshot when found. Use its new refs for actions. `found:false` with `limit_reached:true` means the configured range ended, not that the application lacks the item. Finding changes scroll position and never clicks or submits.

```json
{"session_id":"<session_id>","selector":"#results","viewport_only":true,"max_elements":150}
```

Snapshots include the active `tab_id` and owned `tabs`. By default popups stay open without an automatic switch. The optional global `--popup-policy follow-single` follows a unique popup associated with the active owned opener within an activating action's bounded window; multiple, background or late candidates require explicit inspection. Following returns `replan_required` and a fresh snapshot, and skips remaining old-context actions. Check `batch_complete` as well as `ok`. See [the exact policy and cancellation boundaries](https://github.com/SweetDianDian/tablaze/blob/main/docs/RUNTIME.md). `tab_tabs` accepts `list`, `new` (optional HTTP(S) url), `switch` (tab_id), or `close` (tab_id). Closing the final tab ends the session. CDP mode manages only pages created by this service and their popups. `tab_navigate` accepts `goto` (url required), `back`, `forward`, and `reload`, preserving session storage.

```json
{"session_id":"<session_id>","action":"switch","tab_id":"<tab_id_from_tabs>"}
```

New `tab_act` steps:

```json
[
  {"type":"hover","ref":"<current_ref>"},
  {"type":"double_click","ref":"<current_ref>"},
  {"type":"upload","ref":"<visible_file_input_ref>","files":["/absolute/path/report.csv"]},
  {"type":"upload_chooser","ref":"<visible_choose_file_button_ref>","files":["/absolute/path/report.csv"]},
  {"type":"drag","ref":"<source_ref>","target_ref":"<destination_ref>"},
  {"type":"scroll","direction":"right","pixels":500,"ref":"<scroll_container_ref>"}
]
```

Uploads accept up to 20 explicit regular local files, each at most 50 MiB; an empty list clears selection. Use `upload` for an observed visible file input, or `upload_chooser` for the observed visible button that opens a file chooser backed by a hidden input. The latter waits for the page's file-chooser event and supplies the selected files. Uploading exposes file bytes to the page, so the paths must be within the user's requested scope.

`drag` moves the mouse between two currently observed refs. Both target centers must fit in the viewport after scrolling; re-observe and adjust the viewport if `NOT_VISIBLE` is returned. It does not guarantee compatibility with every custom drag widget. `scroll` accepts `up`, `down`, `left`, and `right`; omit `ref` to scroll the observed frame's window, or supply a current container ref to scroll that element. Pixels range from 1 to 10,000. Check the resulting page state rather than assuming a requested scroll moved content.

After visual inspection, `{"type":"click_xy","x":120,"y":160}` clicks inside the main tab viewport in CSS pixels using the current snapshot_id. Coordinates do not provide element identity guards; re-observe after page changes. Observe the main frame before coordinate actions.

Use `tab_downloads` with session_id to list records, then download_id and optional timeout_ms to await a specific download. Only status `completed` supplies a usable path; pending is not success. Completed artifacts survive closing; pending owned downloads are cancelled during cleanup.

Before an action opens a native dialog, call `tab_dialog` with action `accept` or `dismiss` and optional `prompt_text`. This one-shot policy is consumed by the next dialog. Unarmed dialogs are dismissed and reported as a failed action with possible effects.

`tab_state` (session_id) saves a private `storage_state` file. Pass its path to `tab_open.storage_state` to restore cookies, localStorage and IndexedDB in an isolated context. Files contain credentials; sessionStorage, extensions and existing tabs are not saved. CDP imports are rejected.

`tab_pdf` prints the active tab to a local PDF artifact; it does not export only a selected child frame. It accepts `format: "A4" | "Letter"` and `landscape`, and returns a path, byte count, SHA-256, MIME type, source URL, and tab ID. PDFs above 50 MiB are rejected. The ordinary action timeout applies; an export timeout closes the owned tab. Print styles can differ from screen rendering, so inspect the artifact when layout matters.

```json
{"session_id":"<session_id>","format":"A4","landscape":false}
```

`tab_extract_structured` reads a named field plan and validates its output against JSON Schema draft-07. It returns a source URL, selector, match index, and raw quote for every extracted value. Plans support text, attributes, current non-sensitive form values, typed scalars, and arrays; limits are 30 fields, 20 matches per field, and 100 matches total. Missing required fields, unsafe values, type failures, and truncated evidence produce errors. See the [schema extraction examples and provenance limits](https://github.com/SweetDianDian/tablaze/blob/main/docs/EXTRACTION.md); a quotation's presence is not proof of a claim's truth.

## Choose a planner for `run`

`run` is the optional standalone Agent loop. Every provider requires an explicit `--model`; Tablaze does not select or silently replace it. The provider defaults to `openai-compatible` for existing commands.

| `--provider` | Endpoint and authentication | Provider options |
| --- | --- | --- |
| `openai-compatible` (default) | Required full `--endpoint` ending at the provider's chat-completions route; optional key from `TABLAZE_API_KEY` or `--api-key-env`. | The endpoint must support function tools. |
| `codex` | Uses the installed Codex CLI and its existing login; no Tablaze endpoint or API key flag. | `--codex-command` selects an executable, default `codex`; optional `--reasoning-effort`. |
| `anthropic` | Defaults to `https://api.anthropic.com/v1/messages`; `--endpoint` can select a compatible proxy. Read the required service credential from `TABLAZE_API_KEY`, or choose its environment variable with `--api-key-env`. | `--max-output-tokens` maps to `max_tokens`, default 4096. |
| `ollama` | Defaults to `http://localhost:11434/api/chat`; `--endpoint` can select another server. A configured key is sent as a Bearer token. | Optional `--max-output-tokens` maps to `options.num_predict`; omitted by default. |

For Codex, complete `codex login` if needed and use `codex login status` to inspect the current authentication method. Tablaze reuses that CLI authentication; it does not copy login files or configure an API endpoint. Account access, limits, and any billing follow the selected Codex authentication. [Official authentication guide](https://learn.chatgpt.com/docs/auth)

```sh
node dist/cli.js run --provider codex --model "<your-codex-model>" --task "<authorized task>" --start-url "https://<your-site>/" --channel chrome
node dist/cli.js run --provider anthropic --model "<your-anthropic-model>" --api-key-env ANTHROPIC_API_KEY --max-output-tokens 4096 --task "<authorized task>" --channel chrome
node dist/cli.js run --provider ollama --model "<your-installed-model>" --task "<authorized task>" --channel chrome
```

Codex reasoning values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; support depends on the explicitly chosen model and CLI. Omitting the flag leaves its setting to Codex. `--codex-command` and `--reasoning-effort` are rejected for other providers; Codex rejects `--endpoint`, `--api-key-env`, and `--max-output-tokens`. Output-token flags apply only to Anthropic and Ollama, with a local range of 1–1,000,000; the service can enforce a smaller model-specific maximum. A response byte cap is not a token budget. Tool and image support also depend on the chosen model.

Planner usage is reported in `model_usage` only from actual provider counters. Missing counters remain absent; no monetary cost is inferred. Codex also reports fixed `provider_diagnostics` fields for process exit, terminal event, error-notification count and latency; raw stderr and provider error text are omitted. The CLI waits for Codex child cleanup before printing, so usage flushed during cancellation can still be recorded. The same run limits, cancellation, verification requirements, and cleanup apply to each provider. Codex planning invokes the local executable; it does not make arbitrary CLI capabilities available as Tablaze browser tools.

## Saved tasks and browser restoration

The optional autonomous loop is configured separately from MCP in the [Agent guide](https://github.com/SweetDianDian/tablaze/blob/main/docs/AGENT.md). On a new run, `run --start-url <HTTP(S) URL>` can open an explicitly supplied starting page before the first model decision. The normal tool dispatcher accounts for this navigation in tool and time budgets. Current checkpoints retain this initialization state and migrate valid earlier formats; resume does not automatically replay an attempted initializer or let an existing run add or change its URL. Workspaces also retain popup policy, defaulting to `stay` for older files; an explicitly conflicting policy is rejected on resume.

To create and resume a private run checkpoint with the default compatible provider, choose your model endpoint and supply credentials through the configured environment variable. For another provider, pass the same explicit provider/model options described above on each invocation:

```sh
node dist/cli.js run --task "<authorized task>" --model "<model-id>" --endpoint "https://<provider>/v1/chat/completions" --channel chrome --checkpoint "/absolute/path/private-run.json"
node dist/cli.js run --resume "/absolute/path/private-run.json" --model "<model-id>" --endpoint "https://<provider>/v1/chat/completions" --channel chrome
```

The CLI writes a 0600 temporary file and atomically renames it to the checkpoint path. The file contains full task history and browser cookies, localStorage, and IndexedDB; keep it private. Source-library `exportWorkspace()`/`restoreWorkspace()` and CLI resume recreate isolated contexts, owned tab URLs, and the active tab, with new session identifiers. They do not restore live DOM, unsaved form drafts, sessionStorage, page JavaScript memory, scroll position, extensions, pending downloads, or in-flight transactions. Restoring URLs loads pages again. Old refs and completion evidence are invalid; observe and verify the restored state. Workspace import requires a new empty engine and does not target a CDP-attached profile.

Unknown-outcome mutations stop resume with `needs_input` before browser or model startup. Check the real business outcome first, then explicitly supply `--reconciled "<what you checked and observed>"`. This operator acknowledgment neither proves completion nor instructs the runner to replay the submission. Library callers use `reconciliation`; checkpoints requiring an application `validateCompletion` function must be resumed through the library with that function.

Step, tool-call, planner-call, and elapsed-time counters carry forward. Limits default to the saved limits; process downtime is excluded. The returned library checkpoint includes the final persistence wait. The CLI's saved elapsed time includes browser-state export performed before saving, but not the duration of the last atomic file write itself. This is a timing boundary, not an exact measurement of that final I/O. See [runtime details](https://github.com/SweetDianDian/tablaze/blob/main/docs/RUNTIME.md) and [checkpoint security](SECURITY.md).
