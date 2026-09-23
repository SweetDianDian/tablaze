# Opt-in page scripts

`--page-script` adds `tab_script` to the MCP catalog. It is absent by default. SDK callers can set `allowPageScript: true` when creating a server or `BrowserEngine`. This extends the browser's programmable surface; it does not turn Tablaze into a host Python/JavaScript REPL or expose raw CDP.

```sh
node dist/cli.js --channel chrome --page-script
```

The tool accepts the active session's current **main-frame** `snapshot_id`, a JavaScript async-function body in `source`, optional JSON `input`, and optional `timeout_ms`. It runs in the active page origin. For example:

```json
{
  "session_id": "<session from tab_open>",
  "snapshot_id": "<current main-frame snapshot>",
  "source": "return [...document.querySelectorAll('table tbody tr')].map(row => row.innerText);"
}
```

The returned JSON includes `result` and a fresh `snapshot`. A script has **full page-origin authority**: it can read DOM, cookies available to page JavaScript, localStorage and account data, send network requests, edit the page, submit forms or open windows. The server treats every call as a write even if its source looks read-only. Enable it only for workflows and pages whose authority you intend to give the model. A persistent profile can contain signed-in account state and is available to page scripts when explicitly combined with this mode.

`--page-script` cannot be combined with configured secrets, an external CDP attachment or a document navigation policy. The navigation policy governs document requests, not arbitrary script-created network traffic. The script has no Tablaze host API or persistent JavaScript variables between calls. It runs in one owned tab's main document; it does not address child frames. Code is limited to 16 KiB UTF-8, input to 32 KiB JSON and returned JSON to 64 KiB. These are response budgets, not a security sandbox or a guarantee that malicious page code cannot consume resources.

Running a script invalidates previous element references and trusted browser bindings. A syntax error is reported without claiming a write. Runtime/output failures, cancellation and timeout report `outcome_unknown: true`, since effects may have happened before the failure. Timeout and transport interruption close that session. Observe the external business state and reconcile before retrying; never automatically repeat a submission. The refreshed snapshot in a completed response is a browser observation, not proof that a server accepted an action.

The real-Chrome regression posts once to an independent local HTTP endpoint and then throws. It verifies one accepted write, `outcome_unknown: true`, a fresh snapshot, stale-reference rejection, output limits and timeout cleanup. This is a mechanism test, not a matched real-model Browser Use comparison.
