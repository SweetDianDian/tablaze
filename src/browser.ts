import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Frame, type Page } from 'playwright';
import { inspectDOM } from './snapshot.js';

export class BrowserError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BrowserError'; }
}
export interface BrowserOptions { headless?: boolean; channel?: string; executablePath?: string; cdpUrl?: string; timeoutMs?: number }
export interface SnapshotOptions { mode?: 'full' | 'diff'; maxElements?: number; textLimit?: number; frameId?: string }
export type BrowserAction =
  | { type: 'click'; ref: string } | { type: 'fill'; ref: string; value: string }
  | { type: 'press'; ref: string; key: string } | { type: 'select'; ref: string; values: string[] }
  | { type: 'check'; ref: string; checked: boolean } | { type: 'scroll'; direction: 'up' | 'down'; pixels?: number }
  | { type: 'wait'; text: string; timeoutMs?: number };
export type BrowserCheck = { kind: 'url'; value: string } | { kind: 'title'; contains: string }
  | { kind: 'text'; contains: string } | { kind: 'visible'; selector: string }
  | { kind: 'value'; selector: string; value: string } | { kind: 'count'; selector: string; value: number };
interface Reference { handle: ElementHandle<Element>; fingerprint: string; entry: Record<string, unknown> }
interface SnapshotState { id: string; frame: Frame; generation: number; refs: Map<string, Reference>; actionable: boolean; entries: Record<string, unknown>[] }
interface Session { id: string; context: BrowserContext; ownsContext: boolean; page: Page; tail: Promise<void>; closed: boolean; revision: number; nextRef: number; nextFrame: number; frames: Map<Frame, string>; generations: Map<Frame, number>; snapshot?: SnapshotState; popups: Set<Page>; unexpected: string[]; cleanup?: Promise<void> }
const errorInfo = (error: unknown, fallback = 'BROWSER_ERROR') => ({ code: error instanceof BrowserError ? error.code : fallback, message: (error instanceof Error ? error.message : String(error)).split('\nCall log:')[0].slice(0, 2000) });
const integer = (value: number | undefined, fallback: number, min: number, max: number, name: string) => { const result = value ?? fallback; if (!Number.isInteger(result) || result < min || result > max) throw new BrowserError('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`); return result; };
const validUrl = (url: string) => { let parsed: URL; try { parsed = new URL(url); } catch { throw new BrowserError('INVALID_URL', 'Use an absolute http:// or https:// URL.'); } if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new BrowserError('INVALID_URL', 'Only HTTP(S) URLs without embedded credentials are supported.'); return parsed.href; };

export class BrowserEngine {
  private browserPromise?: Promise<Browser>;
  private sessions = new Map<string, Session>();
  private openingSessions = new Set<Session>();
  private opening = new Set<Promise<Record<string, unknown>>>();
  private disposed = false;
  private disposal?: Promise<void>;
  private timeout: number;
  constructor(private options: BrowserOptions = {}) { this.timeout = integer(options.timeoutMs, 10000, 100, 60000, 'timeoutMs'); }

  private browser(): Promise<Browser> {
    if (this.disposed) return Promise.reject(new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.'));
    if (!this.browserPromise) {
      const launch = this.options.cdpUrl
        ? chromium.connectOverCDP(this.options.cdpUrl, { timeout: 30000 })
        : chromium.launch({ headless: this.options.headless ?? true, channel: this.options.channel, executablePath: this.options.executablePath, timeout: 30000 });
      const pending = launch.then(browser => { browser.once('disconnected', () => { if (this.browserPromise === pending) this.browserPromise = undefined; }); return browser; }).catch(error => { if (this.browserPromise === pending) this.browserPromise = undefined; throw new BrowserError('BROWSER_LAUNCH_FAILED', this.options.cdpUrl ? 'Could not connect to the configured CDP endpoint. Check reachability and Chrome remote debugging; endpoint details are omitted.' : errorInfo(error).message); });
      this.browserPromise = pending;
    }
    return this.browserPromise;
  }
  private session(id: string): Session { const session = this.sessions.get(id); if (!session || session.closed) throw new BrowserError('SESSION_NOT_FOUND', `No open session ${id}.`); return session; }
  private exclusive<T>(id: string, work: (session: Session) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.'));
    let session: Session; try { session = this.session(id); } catch (error) { return Promise.reject(error); }
    const result = session.tail.then(() => { if (session.closed || session.page.isClosed()) throw new BrowserError('SESSION_CLOSED', 'This session is closed.'); return work(session); });
    session.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  open(url: string): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.'));
    let checked: string; try { checked = validUrl(url); } catch (error) { return Promise.reject(error); }
    const operation = this.openInternal(checked);
    this.opening.add(operation); operation.then(() => this.opening.delete(operation), () => this.opening.delete(operation));
    return operation;
  }
  private async openInternal(url: string): Promise<Record<string, unknown>> {
    const browser = await this.browser();
    if (this.disposed) throw new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.');
    const ownsContext = !this.options.cdpUrl;
    const context = ownsContext ? await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: false }) : browser.contexts()[0];
    if (!context) throw new BrowserError('CDP_CONTEXT_MISSING', 'The attached browser has no default context.');
    let page: Page;
    try { page = await context.newPage(); } catch (error) { if (ownsContext) await context.close().catch(() => {}); throw error; }
    page.setDefaultTimeout(this.timeout); page.setDefaultNavigationTimeout(this.timeout);
    const session: Session = { id: randomUUID(), context, ownsContext, page, tail: Promise.resolve(), closed: false, revision: 0, nextRef: 1, nextFrame: 1, frames: new Map([[page.mainFrame(), 'f0']]), generations: new Map(), popups: new Set(), unexpected: [] };
    this.openingSessions.add(session);
    page.once('close', () => { session.closed = true; this.sessions.delete(session.id); void this.cleanup(session); });
    page.on('framenavigated', frame => session.generations.set(frame, (session.generations.get(frame) ?? 0) + 1));
    page.on('popup', popup => { session.popups.add(popup); session.unexpected.push('A new-tab flow was blocked; use a task that stays in the current tab.'); void popup.close().catch(() => {}); });
    page.on('download', download => { session.unexpected.push('Downloads are not supported.'); void download.cancel().catch(() => {}); });
    page.on('dialog', dialog => { session.unexpected.push(`A ${dialog.type()} dialog was dismissed; dialog workflows are not supported.`); void dialog.dismiss().catch(() => {}); });
    try {
      if (this.disposed) throw new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const snapshot = await this.snapshotInternal(session, {});
      if (this.disposed) throw new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.');
      this.sessions.set(session.id, session);
      this.openingSessions.delete(session);
      return { ...snapshot, session_mode: ownsContext ? 'isolated' : 'attached_profile' };
    } catch (error) { this.sessions.delete(session.id); this.openingSessions.delete(session); session.closed = true; await this.cleanup(session); throw error instanceof BrowserError ? error : new BrowserError('NAVIGATION_FAILED', errorInfo(error).message); }
  }
  snapshot(sessionId: string, options: SnapshotOptions = {}): Promise<Record<string, unknown>> { return this.exclusive(sessionId, session => this.snapshotInternal(session, options)); }
  private frameList(session: Session) { return session.page.frames().map(frame => { if (!session.frames.has(frame)) session.frames.set(frame, `f${session.nextFrame++}`); return { frame_id: session.frames.get(frame)!, url: frame.url(), name: frame.name(), is_main: frame === session.page.mainFrame() }; }); }
  private async releaseRefs(state?: SnapshotState) { if (state) await Promise.all([...state.refs.values()].map(ref => ref.handle.dispose().catch(() => {}))); }
  private async snapshotInternal(session: Session, options: SnapshotOptions): Promise<Record<string, unknown>> {
    const start = performance.now();
    const maxElements = integer(options.maxElements, 150, 1, 500, 'maxElements');
    const textLimit = integer(options.textLimit, 6000, 0, 20000, 'textLimit');
    if (options.mode !== undefined && !['full', 'diff'].includes(options.mode)) throw new BrowserError('INVALID_ARGUMENT', 'Snapshot mode must be full or diff.');
    const allFrames = this.frameList(session);
    const frames = allFrames.slice(0, 100).map(frame => ({ ...frame, url: frame.url.slice(0, 4000), name: frame.name.slice(0, 200) }));
    const frameId = options.frameId ?? 'f0';
    const frame = [...session.frames].find(([frame, id]) => id === frameId && !frame.isDetached())?.[0];
    if (!frame) throw new BrowserError('FRAME_NOT_FOUND', `No live frame ${frameId}. Read the frames list from a current snapshot.`);
    const previous = session.snapshot;
    const generation = session.generations.get(frame) ?? 0;
    const compatible = previous?.frame === frame && previous.generation === generation;
    const old = compatible ? [...previous.refs].map(([ref, item]) => ({ ref, node: item.handle })) : [];
    const result = await frame.evaluateHandle(inspectDOM, { op: 'snapshot', maxElements, textLimit, nextRef: session.nextRef, previous: old });
    const dataHandle = await result.getProperty('data');
    const data = await dataHandle.jsonValue() as any;
    const nodesHandle = await result.getProperty('nodes');
    const properties = await nodesHandle.getProperties();
    const refs = new Map<string, Reference>();
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < data.records.length; i++) {
      const { fingerprint, ...entry } = data.records[i];
      const handle = properties.get(String(i))?.asElement() as ElementHandle<Element> | null;
      if (handle) { refs.set(entry.ref, { handle, fingerprint, entry }); entries.push(entry); }
    }
    await Promise.all([result.dispose(), dataHandle.dispose(), nodesHandle.dispose()]);
    const title = await session.page.title();
    if (frame.isDetached() || generation !== (session.generations.get(frame) ?? 0)) { await Promise.all([...refs.values()].map(ref => ref.handle.dispose().catch(() => {}))); throw new BrowserError('SNAPSHOT_CHANGED', 'The document navigated while being observed. Take a fresh snapshot.'); }
    session.nextRef = data.next_ref;
    const id = `${session.id}:${++session.revision}`;
    session.snapshot = { id, frame, generation, refs, actionable: true, entries };
    const metadataTruncated = allFrames.length > 100 || allFrames.some(frame => frame.url.length > 4000 || frame.name.length > 200) || title.length > 1000 || session.page.url().length > 4000;
    const output: Record<string, unknown> = { ok: true, session_id: session.id, snapshot_id: id, mode: options.mode ?? 'full', frame_id: frameId, url: session.page.url().slice(0, 4000), title: title.slice(0, 1000), frames, frame_count: allFrames.length, elements: entries, text: data.text, truncated: data.truncated || metadataTruncated, truncation: { ...data.truncation, metadata: metadataTruncated }, budgets: { max_elements: maxElements, text_limit: textLimit, max_frames: 100 }, elapsed_ms: Math.round(performance.now() - start) };
    if (options.mode === 'diff') {
      const previousEntries = new Map((compatible ? previous.entries : []).map(entry => [entry.ref, entry]));
      const currentEntries = new Map(entries.map(entry => [entry.ref, entry]));
      output.added = entries.filter(entry => !previousEntries.has(entry.ref));
      output.changed = entries.filter(entry => previousEntries.has(entry.ref) && JSON.stringify(previousEntries.get(entry.ref)) !== JSON.stringify(entry));
      output.removed = [...previousEntries.keys()].filter(ref => !currentEntries.has(ref));
      output.baseline_snapshot_id = compatible ? previous.id : null;
      output.diff_scope = 'returned_elements';
      delete output.elements;
    }
    await this.releaseRefs(previous);
    return output;
  }
  private async reference(session: Session, state: SnapshotState, ref: string): Promise<ElementHandle<Element>> {
    const item = state.refs.get(ref);
    if (!item) throw new BrowserError('UNKNOWN_REFERENCE', `Reference ${ref} is not in the supplied snapshot. Take a fresh snapshot.`);
    if (state.frame.isDetached() || state.generation !== (session.generations.get(state.frame) ?? 0)) throw new BrowserError('STALE_REFERENCE', 'The target document has changed. Take a fresh snapshot.');
    try { const current = await state.frame.evaluate(inspectDOM, { op: 'inspect', node: item.handle }); if (!current.visible || current.fingerprint !== item.fingerprint) throw new BrowserError('STALE_REFERENCE', 'The element was detached, hidden, or its identity changed. Take a fresh snapshot.'); }
    catch (error) { throw error instanceof BrowserError ? error : new BrowserError('STALE_REFERENCE', 'The target element is no longer in the original document. Take a fresh snapshot.'); }
    return item.handle;
  }
  act(sessionId: string, snapshotId: string, actions: BrowserAction[], options: { snapshot?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      const start = performance.now();
      if (!Array.isArray(actions) || actions.length < 1 || actions.length > 20) throw new BrowserError('INVALID_ARGUMENT', 'Supply between 1 and 20 actions.');
      const budget = integer(options.timeoutMs, 30000, 100, 60000, 'batch timeoutMs');
      const earlyFailure = (code: string, message: string) => { const error = { code, message }; return { ok: false, session_id: session.id, snapshot_id: snapshotId, partial: false, completed: 0, failed: { index: 0, action: actions[0].type, error }, results: actions.map((action, index) => ({ index, type: action.type, status: index === 0 ? 'failed' : 'skipped', ...(index === 0 ? { error } : {}) })), elapsed_ms: Math.round(performance.now() - start) }; };
      if (options.signal?.aborted) return earlyFailure('CANCELLED', 'The action batch was cancelled before it started.');
      const state = session.snapshot;
      if (!state || state.id !== snapshotId || !state.actionable) {
        return earlyFailure('STALE_SNAPSHOT', 'The snapshot was replaced or already used by an action batch. Take a fresh snapshot.');
      }
      state.actionable = false;
      const deadline = start + budget;
      let interruption: BrowserError | undefined;
      let interruptedCleanup: Promise<void> | undefined;
      const interrupt = (code: string, message: string) => {
        if (interruption) return;
        interruption = new BrowserError(code, message);
        session.closed = true;
        this.sessions.delete(session.id);
        // Closing only the owned page/context interrupts in-flight Playwright RPCs.
        interruptedCleanup = this.cleanup(session);
      };
      const onAbort = () => interrupt('CANCELLED', 'The action batch was cancelled. This session was closed; completed actions were not rolled back.');
      const timer = setTimeout(() => interrupt('BATCH_TIMEOUT', 'The action batch exceeded its total time budget. This session was closed; completed actions were not rolled back.'), budget);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const checkInterruption = () => {
        if (this.disposed) interrupt('ENGINE_CLOSED', 'The browser engine is shutting down.');
        if (session.closed && !interruption) interrupt('SESSION_CLOSED', 'The browser tab closed while the batch was running.');
        if (options.signal?.aborted) onAbort();
        if (performance.now() >= deadline) interrupt('BATCH_TIMEOUT', 'The action batch exceeded its total time budget. This session was closed; completed actions were not rolled back.');
        if (interruption) throw interruption;
      };
      const remaining = (limit: number) => { checkInterruption(); return Math.max(1, Math.min(limit, deadline - performance.now())); };
      const results: Record<string, unknown>[] = [];
      let failed: Record<string, unknown> | null = null;
      let completed = 0;
      let failedActionMayHaveSideEffects = false;
      try {
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        if (failed) { results.push({ index, type: action.type, status: 'skipped' }); continue; }
        let actionStarted = false;
        try {
          checkInterruption();
          if (session.unexpected.length) throw new BrowserError('UNSUPPORTED_FLOW', session.unexpected.shift()!);
          if (action.type === 'scroll') { const pixels = integer(action.pixels, 600, 1, 10000, 'pixels'); if (!['up', 'down'].includes(action.direction)) throw new BrowserError('INVALID_ARGUMENT', 'Scroll direction must be up or down.'); actionStarted = true; await state.frame.evaluate(({ direction, pixels }) => window.scrollBy(0, direction === 'up' ? -pixels : pixels), { direction: action.direction, pixels }); }
          else if (action.type === 'wait') { if (!action.text) throw new BrowserError('INVALID_ARGUMENT', 'Wait text must be nonempty.'); await state.frame.getByText(action.text).first().waitFor({ state: 'visible', timeout: remaining(integer(action.timeoutMs, this.timeout, 100, 60000, 'timeoutMs')) }); }
          else {
            const target = await this.reference(session, state, action.ref);
            checkInterruption();
            const actionDeadline = performance.now() + this.timeout;
            // Trial checks cover interception for fill/select/press as well as click.
            // Recheck identity after any actionability wait before issuing input.
            // A trial may scroll into view, so even a failed trial can affect the page.
            actionStarted = true;
            await target.click({ trial: true, timeout: remaining(this.timeout) });
            checkInterruption();
            await this.reference(session, state, action.ref);
            const timeout = remaining(Math.max(1, actionDeadline - performance.now()));
            switch (action.type) {
              case 'click': await target.click({ timeout }); break;
              case 'fill': if (action.value.length > 10000) throw new BrowserError('INVALID_ARGUMENT', 'Fill value exceeds 10000 characters.'); await target.fill(action.value, { timeout }); break;
              case 'press': { await target.focus(); checkInterruption(); const focused = await target.evaluate(element => { let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return active === element; }); if (!focused) throw new BrowserError('NOT_FOCUSABLE', 'The referenced element cannot receive keyboard input.'); await target.press(action.key, { timeout: remaining(timeout) }); break; }
              case 'select': await target.selectOption(action.values, { timeout }); break;
              case 'check': await target.setChecked(action.checked, { timeout }); break;
              default: throw new BrowserError('INVALID_ARGUMENT', 'Unsupported action type.');
            }
          }
          checkInterruption();
          if (session.unexpected.length) throw new BrowserError('UNSUPPORTED_FLOW', session.unexpected.shift()!);
          completed++; results.push({ index, type: action.type, status: 'completed' });
        } catch (error) { if (!interruption && performance.now() >= deadline) interrupt('BATCH_TIMEOUT', 'The action batch exceeded its total time budget. This session was closed; completed actions were not rolled back.'); const info = errorInfo(interruption ?? error, 'ACTION_FAILED'); if (action.type === 'fill' && action.value) info.message = info.message.split(action.value).join('[redacted]'); failedActionMayHaveSideEffects = actionStarted; failed = { index, action: action.type, error: info }; results.push({ index, type: action.type, status: 'failed', error: info }); }
      }
      const output: Record<string, unknown> = { ok: !failed && !interruption, session_id: session.id, snapshot_id: snapshotId, partial: !!(failed || interruption) && (completed > 0 || failedActionMayHaveSideEffects), completed, failed, failed_action_may_have_side_effects: failedActionMayHaveSideEffects, results, elapsed_ms: Math.round(performance.now() - start) };
      if (options.snapshot !== false && !interruption) { try { output.snapshot = await this.snapshotInternal(session, { frameId: state.frame.isDetached() ? 'f0' : session.frames.get(state.frame) }); } catch (error) { output.snapshot_error = errorInfo(interruption ?? error, 'SNAPSHOT_FAILED'); } }
      if (interruption) { output.ok = false; output.session_closed = true; output.error = errorInfo(interruption); output.partial = completed > 0 || failedActionMayHaveSideEffects; }
      output.elapsed_ms = Math.round(performance.now() - start);
      return output;
      } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); if (interruptedCleanup) await interruptedCleanup; }
    });
  }
  extract(sessionId: string, options: { kind: 'text' | 'links' | 'table'; selector?: string; maxItems?: number }): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      const maxItems = integer(options.maxItems, 100, 1, 500, 'maxItems');
      const frame = session.snapshot?.frame ?? session.page.mainFrame();
      const selector = options.selector ?? (options.kind === 'table' ? 'table' : 'body');
      const roots = frame.locator(selector);
      if (await roots.count() !== 1) throw new BrowserError('SELECTOR_COUNT', 'Extraction selector must match exactly one root element.');
      const result = await roots.evaluate((root, { kind, maxItems }) => {
        const visible = (element: Element) => { if (!element.getClientRects().length) return false; for (let current: Element | null = element; current; current = current.parentElement) { const style = getComputedStyle(current); if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true') return false; } return true; };
        if (kind === 'text') { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let text = ''; let scanned = 0; let node: Node | null; while ((node = walker.nextNode()) && scanned++ < 30000 && text.length <= 20000) { const parent = node.parentElement; if (parent && visible(parent) && !parent.closest('script,style,noscript,textarea,input')) { const piece = node.textContent?.replace(/\s+/g, ' ').trim(); if (piece) text += (text ? ' ' : '') + piece.slice(0, 20001); } } return { text: text.slice(0, 20000), truncated: text.length > 20000 || scanned >= 30000 }; }
        if (kind === 'links') { const candidates = [...(root.matches('a[href]') ? [root] : []), ...root.querySelectorAll('a[href]')].filter(visible); let remaining = 20000; let clipped = candidates.length > maxItems; const items: { text: string; href: string }[] = []; for (const element of candidates.slice(0, maxItems)) { if (remaining <= 0) { clipped = true; break; } const rawText = (element as HTMLElement).innerText; const rawHref = (element as HTMLAnchorElement).href; const href = rawHref.slice(0, Math.min(2000, remaining)); remaining -= href.length; const text = rawText.slice(0, Math.min(1000, remaining)); remaining -= text.length; clipped ||= text.length < rawText.length || href.length < rawHref.length; items.push({ text, href }); } return { items, truncated: clipped }; }
        if (kind === 'table') { const candidates = [...root.querySelectorAll('tr')].filter(visible); let clipped = candidates.length > maxItems; let remaining = 20000; const items: string[][] = []; for (const row of candidates.slice(0, maxItems)) { if (remaining <= 0) { clipped = true; break; } const cells = [...row.querySelectorAll('th,td')].filter(visible); clipped ||= cells.length > 50; const values: string[] = []; for (const cell of cells.slice(0, 50)) { if (remaining <= 0) { clipped = true; break; } const raw = (cell as HTMLElement).innerText; const value = raw.slice(0, Math.min(1000, remaining)); clipped ||= value.length < raw.length; remaining -= value.length; values.push(value); } items.push(values); } return { items, truncated: clipped }; }
        throw new Error('Unsupported extraction kind.');
      }, { kind: options.kind, maxItems });
      return { ok: true, session_id: session.id, kind: options.kind, limits: { max_items: maxItems, max_characters: 20000 }, ...result };
    });
  }
  verify(sessionId: string, checks: BrowserCheck[], timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (!Array.isArray(checks) || checks.length < 1 || checks.length > 20) throw new BrowserError('INVALID_ARGUMENT', 'Supply between 1 and 20 checks.');
      const start = performance.now(); const timeout = integer(timeoutMs, this.timeout, 100, 60000, 'timeoutMs');
      const frame = session.snapshot?.frame ?? session.page.mainFrame();
      const results = await Promise.all(checks.map(async (check, index) => {
        const deadline = performance.now() + timeout; let actual: unknown; let pass = false; let error: ReturnType<typeof errorInfo> | undefined;
        do {
          if (session.closed || session.page.isClosed() || this.disposed) { error = { code: 'SESSION_CLOSED', message: 'The session closed before the check passed.' }; break; }
          try {
            switch (check.kind) {
              case 'url': actual = session.page.url(); pass = actual === check.value; break;
              case 'title': actual = await session.page.title(); pass = (actual as string).includes(check.contains); break;
              case 'text': actual = await frame.locator('body').innerText({ timeout: Math.max(1, deadline - performance.now()) }); pass = (actual as string).includes(check.contains); actual = (actual as string).slice(0, 2000); break;
              case 'visible': actual = await frame.locator(check.selector).isVisible(); pass = actual === true; break;
              case 'value': { const observed = await frame.locator(check.selector).evaluate(element => { if (element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)) return { sensitive: true }; if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return { sensitive: false, value: element.value }; return { unsupported: true }; }, undefined, { timeout: Math.max(1, deadline - performance.now()) }); if (observed.sensitive) throw new BrowserError('SENSITIVE_VALUE', 'Password and hidden field values are not returned or verified.'); if (observed.unsupported) throw new BrowserError('NOT_FORM_CONTROL', 'Value checks require an input, textarea, or select.'); actual = observed.value; pass = actual === check.value; break; }
              case 'count': actual = await frame.locator(check.selector).count(); pass = actual === check.value; break;
              default: throw new BrowserError('INVALID_ARGUMENT', 'Unsupported check kind.');
            }
            error = undefined;
          } catch (caught) { error = errorInfo(caught, 'CHECK_FAILED'); if (caught instanceof BrowserError || session.closed || session.page.isClosed() || this.disposed) break; }
          if (!pass && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(75, deadline - performance.now())));
        } while (!pass && performance.now() < deadline);
        if (typeof actual === 'string') actual = actual.slice(0, 2000);
        return { index, kind: check.kind, pass, actual, ...(error ? { error } : {}) };
      }));
      const passed = results.every(result => result.pass);
      return { ok: passed, session_id: session.id, passed, checks: results, elapsed_ms: Math.round(performance.now() - start) };
    });
  }
  screenshot(sessionId: string, fullPage = false): Promise<{ buffer: Buffer; mimeType: string; url: string }> {
    return this.exclusive(sessionId, async session => { if (fullPage) { const pixels = await session.page.evaluate(() => document.documentElement.scrollWidth * document.documentElement.scrollHeight); if (pixels > 32000000) throw new BrowserError('CAPTURE_TOO_LARGE', 'Full-page capture exceeds 32 million pixels; use a viewport screenshot.'); } const buffer = await session.page.screenshot({ type: 'jpeg', quality: 70, fullPage, timeout: this.timeout }); if (buffer.length > 4 * 1024 * 1024) throw new BrowserError('CAPTURE_TOO_LARGE', 'Screenshot exceeds 4 MiB; use a viewport screenshot.'); return { buffer, mimeType: 'image/jpeg', url: session.page.url() }; });
  }
  list(): Record<string, unknown>[] { return [...this.sessions.values()].filter(session => !session.closed && !session.page.isClosed()).map(session => ({ session_id: session.id, url: session.page.url(), snapshot_id: session.snapshot?.id ?? null, session_mode: session.ownsContext ? 'isolated' : 'attached_profile' })); }
  private cleanup(session: Session): Promise<void> { if (!session.cleanup) session.cleanup = (async () => { if (session.ownsContext) await session.context.close().catch(() => {}); else await session.page.close().catch(() => {}); await Promise.all([...session.popups].map(page => page.close().catch(() => {}))); await this.releaseRefs(session.snapshot); })(); return session.cleanup; }
  close(sessionId: string): Promise<Record<string, unknown>> { return this.exclusive(sessionId, async session => { session.closed = true; this.sessions.delete(sessionId); await this.cleanup(session); return { ok: true, session_id: sessionId, closed: true }; }); }
  dispose(): Promise<void> { if (!this.disposal) { this.disposed = true; this.disposal = (async () => { const sessions = [...new Set([...this.sessions.values(), ...this.openingSessions])]; for (const session of sessions) session.closed = true; this.sessions.clear(); await Promise.allSettled(sessions.map(session => this.cleanup(session))); await Promise.allSettled([...this.opening, ...sessions.map(session => session.tail)]); if (this.browserPromise) { const browser = await this.browserPromise.catch(() => undefined); /* For connectOverCDP, Playwright 1.63 closes its transport, not external Chrome. */ if (browser) await browser.close().catch(() => {}); } })(); } return this.disposal; }
}
