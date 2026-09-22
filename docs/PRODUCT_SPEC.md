# Tablaze / 闪页 — product contract

Status: implementation in progress. The expanded objective is to exceed Browser Use capabilities with verified outcomes; see BROWSER_USE_COMPARISON.md for pinned baselines, full scope and outstanding evidence. Target: a publishable, bilingual open-source browser MCP; strong adoption is an aspiration, not a verified outcome.

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

Export BrowserEngine, BrowserError, BrowserOptions, PopupPolicy, BrowserWorkspace, SnapshotOptions, BrowserAction, BrowserCheck, BrowserBinding and BrowserBindingGuard.

BrowserOptions: headless?: boolean; channel?: string; executablePath?: string; cdpUrl?: string; timeoutMs?: number; popupPolicy?: 'stay'|'follow-single'.

- open(url: string, options?: { storageState?: string | StorageState; signal?: AbortSignal }): Promise<Record<string, unknown>> — return full snapshot including session_id. Cancellation cleans up this attempt, including resources acquired after cancellation, while preserving other sessions and external CDP pages.
- snapshot(sessionId: string, options?: SnapshotOptions): Promise<Record<string, unknown>>.
- act(sessionId: string, snapshotId: string, actions: BrowserAction[], options?: { snapshot?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>>.
- extract(sessionId: string, options: { kind: 'text'|'links'|'table'; selector?: string; maxItems?: number }): Promise<Record<string, unknown>>.
- verify(sessionId: string, checks: BrowserCheck[], timeoutMs?: number, snapshotId?: string): Promise<Record<string, unknown>>. Ref-based checks require the current snapshot ID; selector-only calls remain compatible.
- screenshot(sessionId: string, fullPage?: boolean): Promise<{ buffer: Buffer; mimeType: string; url: string }>.
- list(): Record<string, unknown>[].
- close(sessionId: string): Promise<Record<string, unknown>>.
- acquireBinding(sessionId: string, options?: { signal?: AbortSignal }): Promise<BrowserBindingGuard> — capture an owned active main-document binding, with `assertCurrent`, `close` and an executor-only `contextKey` covering navigation and tab-activation history. This does not grant authority over cross-origin child frames or freeze the DOM.
- dispose(): Promise<void>.

SnapshotOptions: mode?: 'full'|'diff'; maxElements?: number; textLimit?: number; frameId?: string; selector?: string; viewportOnly?: boolean.

BrowserAction discriminant `type`: click {ref}; fill {ref,value}; press {ref,key}; select {ref,values:string[]}; check {ref,checked:boolean}; scroll {direction:'up'|'down'|'left'|'right',pixels?:number,ref?:string}; wait {text:string,timeoutMs?:number}; hover/double_click {ref}; upload/upload_chooser {ref,files:string[]}; drag {ref,targetRef}; click_xy {x,y}.

Popup policy defaults to `stay`. Explicit `follow-single` associates one new popup from the acted-on owned page with a 250 ms input window; multiple candidates or other openers do not trigger a switch. This association is not proof of causality. A switch returns a fresh snapshot and `replan_required: true`; remaining actions and same-decision Agent calls are skipped. `batch_complete` distinguishes a fully executed batch from successful input followed by skipped actions. Workspace restoration retains the saved policy and rolls it back if restoration fails.

BrowserCheck discriminant `kind`: url {value}; title {contains}; text {contains}; visible {selector}; value {selector,value} or {ref,value}, exclusively; count {selector,value:number}. Text excludes raw input/textarea/select values. Ref value checks bind to the observed node and document, and remain read-only even when that current snapshot was consumed by an action without a replacement snapshot.

Use session_id, snapshot_id, frames, elements, text, truncated, elapsed_ms in snapshots. Element entries carry ref, role, name and safe value metadata. In diff mode report added/changed/removed and still return the current snapshot_id. No output may imply a truncated page is complete.

## Tool surface (src/server.ts)

Original eight tools (extended by tab_navigate, tab_tabs, tab_downloads, tab_dialog, tab_state, tab_pdf and tab_extract_structured): tab_open, tab_snapshot, tab_act, tab_extract, tab_verify, tab_capture, tab_list, tab_close.

MCP input fields are snake_case; map to engine options. `tab_act` takes session_id, snapshot_id, actions, include_snapshot, timeout_ms. Its total budget defaults to 30 seconds and is capped at 60 seconds. Active cancellation or expiry closes the owned session to interrupt work and prevents later actions; completed side effects remain. It is intentionally a write tool with open-world annotations. Every handler returns JSON text and structuredContent, and sets isError on failure. Screenshot tool returns an image block plus metadata. No generic JavaScript eval tool.

CLI defaults to stdio. Support --headless (default), --headed, --channel, --executable-path, --cdp-url (explicitly opt-in), --timeout-ms, --popup-policy, --help, --version; `doctor` for readable diagnostics and `setup` for installing managed Chromium. Logs go to stderr during MCP operation. Normal shutdown closes owned sessions and browsers; CDP shutdown must not terminate external Chrome.

The optional Agent `run` command and `runAgent` API use the same MCP execution boundary. Caller-supplied `startUrl` / `--start-url` performs one budgeted initialization before planning; it is never inferred from task text. Version 3 checkpoints retain initialization registration and do not replay it automatically on resume. Strictly valid version 1/2 checkpoints migrate as unbound records; version 1 has no initializer, while version 2 retains it. Full task-runner and recovery semantics are in [AGENT.md](AGENT.md).

## Typed custom-tool SDK (src/custom-tools.ts)

`defineTool` declares a unique name, explicit version, description, Zod object input/output schemas, trusted `read`/`write` effect and optional exact HTTP(S) origins. `createToolRegistry` composes those handlers with an existing Agent/MCP client, a trusted application-context resolver, and an optional browser/session binding. The SDK publishes input/output JSON Schema, validates actual inputs and outputs, and refreshes visible tools before each planning decision. It does not load executable handlers from CLI flags or checkpoint data. See [CUSTOM_TOOLS.md](CUSTOM_TOOLS.md).

The planner receives public tool contracts, not credentials, raw tenant identifiers, browser handles or dispatch metadata. A captured context is checked after planning and again before a handler starts; changing it skips stale queued calls. Private context keys also invalidate stale evidence between catalogs, including tab switches away and back. A verified session's confirmed `tab_close` may preserve its evidence across context-only changes; later mutations still invalidate it. These checks do not make browser scripts and external writes atomic.

Version-3 bound checkpoints record digests of the full tool contract, including hidden tools, versions, schemas, effects and origin policies, and the caller's principal/tenant/policy identity. Resume requires matching identities through the SDK before planning or dispatch; reconciliation cannot change that requirement. Old unbound runs cannot gain a registry on resume. Entered writes with failed or invalid output remain ambiguous until trusted reconciliation and are never automatically replayed. Custom-tool success cannot bypass `tab_verify` or `validateCompletion`.

The real Codex reports were measured before this SDK and its context/recovery bindings. Local mechanism tests do not extend those reports into a measured model success rate for custom tools. Broader site coverage, provider support, general network/file policies and repeated matched model evaluation remain outstanding.

## Boundaries

The browser can produce external side effects; references and URL validation are correctness mechanisms, not a sandbox for hostile web pages. The tool acts inside the user's explicitly requested scope. Attached Chrome shares that profile's identity. Broad public claims wait for evidence. Owned new tabs/popups, downloads and explicit uploads are supported in the development branch and require real-browser coverage. Closed shadow roots remain a documented DOM limitation; coordinate actions are a separate visual path. Model-driven Agent capability and matched Browser Use evaluation are additional acceptance requirements, not proven by deterministic local browser tests.
