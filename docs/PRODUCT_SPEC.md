# Tablaze / 闪页 — product contract

Status: implementation in progress. Target: a publishable, bilingual open-source browser MCP; strong adoption is an aspiration, not a verified outcome.

## Intended experience

Run a local stdio MCP server. Keep a browser process warm. Open isolated sessions by default, observe compact references, execute ordered actions, return useful evidence. No mandatory model provider or paid API key. A future optional Jev planner must use the same browser/verification boundary, not become required for basic use.

## Acceptance requirements

1. Typed stdio MCP compatible with an actual SDK client, with structured error reporting.
2. Real Chromium tests, not only mocks. Test navigation, forms, stale references, batch partial failure, extraction, verification, screenshot, isolation, concurrency, and shutdown.
3. Snapshot references tied to a snapshot revision and real DOM identity; reject outdated/replaced/changed targets before input. Normal Playwright actionability checks remain enabled.
4. Sequential batches stop at the first failed action and report every completed step. Batches are not transactions and do not roll back prior actions.
5. Full and incremental snapshots have explicit output budgets. Truncation is reported; hidden/password values are not dumped.
6. Explicit outcome assertions return pass/fail evidence, independently of whether an action command returned.
7. CLI help, diagnostics, install instructions, package build, package-content audit, license, attribution, contribution instructions, CI, bilingual documentation.
8. A responsive bilingual introduction page with a working language switch, copyable launch config and truthful demonstration. No invented public repository URL, downloads, stars, testimonials, speedups, or registry release.
9. Reproducible local performance benchmark separating cold launch, warm operations, payload size and successful checks. No cross-product superiority claim without matched experiments.
10. Publication plan and reviewable release artifacts. Actual GitHub/npm publication requires owner/account information and review of the concrete artifacts.

## Core engine interface (src/browser.ts)

Export BrowserEngine, BrowserError, BrowserOptions, SnapshotOptions, BrowserAction and BrowserCheck.

BrowserOptions: headless?: boolean; channel?: string; executablePath?: string; cdpUrl?: string; timeoutMs?: number.

- open(url: string): Promise<Record<string, unknown>> — return full snapshot including session_id.
- snapshot(sessionId: string, options?: SnapshotOptions): Promise<Record<string, unknown>>.
- act(sessionId: string, snapshotId: string, actions: BrowserAction[], options?: { snapshot?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>.
- extract(sessionId: string, options: { kind: 'text'|'links'|'table'; selector?: string; maxItems?: number }): Promise<Record<string, unknown>>.
- verify(sessionId: string, checks: BrowserCheck[], timeoutMs?: number): Promise<Record<string, unknown>>.
- screenshot(sessionId: string, fullPage?: boolean): Promise<{ buffer: Buffer; mimeType: string; url: string }>.
- list(): Record<string, unknown>[].
- close(sessionId: string): Promise<Record<string, unknown>>.
- dispose(): Promise<void>.

SnapshotOptions: mode?: 'full'|'diff'; maxElements?: number; textLimit?: number; frameId?: string.

BrowserAction discriminant `type`: click {ref}; fill {ref,value}; press {ref,key}; select {ref,values:string[]}; check {ref,checked:boolean}; scroll {direction:'up'|'down',pixels?:number}; wait {text:string,timeoutMs?:number}.

BrowserCheck discriminant `kind`: url {value}; title {contains}; text {contains}; visible {selector}; value {selector,value}; count {selector,value:number}.

Use session_id, snapshot_id, frames, elements, text, truncated, elapsed_ms in snapshots. Element entries carry ref, role, name and safe value metadata. In diff mode report added/changed/removed and still return the current snapshot_id. No output may imply a truncated page is complete.

## Tool surface (src/server.ts)

Eight tools: tab_open, tab_snapshot, tab_act, tab_extract, tab_verify, tab_capture, tab_list, tab_close.

MCP input fields are snake_case; map to engine options. `tab_act` takes session_id, snapshot_id, actions, include_snapshot, timeout_ms. Its total budget defaults to 30 seconds and is capped at 60 seconds. Active cancellation or expiry closes the owned session to interrupt work and prevents later actions; completed side effects remain. It is intentionally a write tool with open-world annotations. Every handler returns JSON text and structuredContent, and sets isError on failure. Screenshot tool returns an image block plus metadata. No generic JavaScript eval tool.

CLI defaults to stdio. Support --headless (default), --headed, --channel, --executable-path, --cdp-url (explicitly opt-in), --timeout-ms, --help, --version; `doctor` for readable diagnostics and `setup` for installing managed Chromium. Logs go to stderr during MCP operation. Normal shutdown closes owned sessions and browsers; CDP shutdown must not terminate external Chrome.

## Boundaries

The browser can produce external side effects; references and URL validation are correctness mechanisms, not a sandbox for hostile web pages. The tool acts inside the user's explicitly requested scope. Attached Chrome shares that profile's identity. Broad public claims wait for evidence. Closed shadow roots, unexpected new-tab flows, downloads and uploads must either be supported and tested or explicitly documented as limitations.
