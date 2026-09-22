import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, stat, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Download, type ElementHandle, type Frame, type JSHandle, type Page } from 'playwright';
import { inspectDOM } from './snapshot.js';
import { assembleDOMExtraction, inspectDOMField, validateDOMFieldPlan, type DOMFieldPlan, type DOMFieldObservation, type ExtractionSchema } from './extraction.js';

export class BrowserError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BrowserError'; }
}
export type PopupPolicy = 'stay' | 'follow-single';
export interface BrowserBinding { readonly sessionId: string; readonly tabId: string; readonly documentEpoch: number; readonly origin: string }
export interface BrowserBindingGuard { readonly binding: BrowserBinding; readonly contextKey: string; assertCurrent(): Promise<void>; close(): Promise<void> }
export interface BrowserOptions { headless?: boolean; channel?: string; executablePath?: string; cdpUrl?: string; timeoutMs?: number; popupPolicy?: PopupPolicy }
export interface SnapshotOptions { mode?: 'full' | 'diff'; maxElements?: number; textLimit?: number; frameId?: string; selector?: string; viewportOnly?: boolean }
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface BrowserWorkspace {
  version: 1;
  popupPolicy?: PopupPolicy;
  sessions: { sessionId: string; activeTabId: string; storage: StorageState; tabs: { tabId: string; url: string }[] }[];
}
export type BrowserAction =
  | { type: 'click'; ref: string } | { type: 'fill'; ref: string; value: string }
  | { type: 'press'; ref: string; key: string } | { type: 'select'; ref: string; values: string[] }
  | { type: 'check'; ref: string; checked: boolean } | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; pixels?: number; ref?: string }
  | { type: 'wait'; text: string; timeoutMs?: number }
  | { type: 'hover' | 'double_click'; ref: string }
  | { type: 'upload'; ref: string; files: string[] }
  | { type: 'drag'; ref: string; targetRef: string }
  | { type: 'upload_chooser'; ref: string; files: string[] }
  | { type: 'click_xy'; x: number; y: number };
export type BrowserCheck = { kind: 'url'; value: string } | { kind: 'title'; contains: string }
  | { kind: 'text'; contains: string } | { kind: 'visible'; selector: string }
  | { kind: 'value'; selector: string; ref?: never; value: string }
  | { kind: 'value'; ref: string; selector?: never; value: string }
  | { kind: 'count'; selector: string; value: number };
interface Reference { handle: ElementHandle<Element>; fingerprint: string; entry: Record<string, unknown> }
interface SnapshotState { id: string; frame: Frame; generation: number; refs: Map<string, Reference>; actionable: boolean; entries: Record<string, unknown>[]; scope: { selector?: string; viewportOnly: boolean } }
interface DownloadRecord { id: string; filename: string; url: string; status: 'pending' | 'completed' | 'failed'; path?: string; bytes?: number; error?: string; download: Download; done: Promise<void> }
interface Session {
  id: string; context: BrowserContext; ownsContext: boolean; page: Page; tail: Promise<void>;
  closed: boolean; revision: number; nextRef: number; nextFrame: number; activationEpoch: number;
  frames: Map<Frame, string>; generations: Map<Frame, number>; snapshot?: SnapshotState;
  tabs: Map<string, Page>; activeTabId: string; nextTab: number;
  downloads: Map<string, DownloadRecord>;
  dialogPolicy?: { action: 'accept' | 'dismiss'; promptText?: string };
  dialogs: { type: string; message: string; action: string }[];
  unexpected: string[]; cleanup?: Promise<void>;
}
const errorInfo = (error: unknown, fallback = 'BROWSER_ERROR') => ({ code: error instanceof BrowserError ? error.code : fallback, message: (error instanceof Error ? error.message : String(error)).split('\nCall log:')[0].slice(0, 2000) });
const integer = (value: number | undefined, fallback: number, min: number, max: number, name: string) => { const result = value ?? fallback; if (!Number.isInteger(result) || result < min || result > max) throw new BrowserError('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}.`); return result; };
const validUrl = (url: string) => { let parsed: URL; try { parsed = new URL(url); } catch { throw new BrowserError('INVALID_URL', 'Use an absolute http:// or https:// URL.'); } if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new BrowserError('INVALID_URL', 'Only HTTP(S) URLs without embedded credentials are supported.'); return parsed.href; };

export class BrowserEngine {
  private browserPromise?: Promise<Browser>;
  private sessions = new Map<string, Session>();
  private openingSessions = new Set<Session>();
  private opening = new Set<Promise<unknown>>();
  private resourceCleanup = new Set<Promise<void>>();
  private cancelOpening = new Set<() => void>();
  private bindings = new Set<{ sessionId: string; invalidate: (code: string) => void }>();
  private bindingJobs = new Set<Promise<unknown>>();
  private cleanupFailed = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private disposalWork?: Promise<void>;
  private ownedBrowserClosing?: Promise<void>;
  private timeout: number;
  private popupPolicy: PopupPolicy;
  private artifactDirectory?: Promise<string>;
  constructor(private options: BrowserOptions = {}) {
    this.timeout = integer(options.timeoutMs, 10000, 100, 60000, 'timeoutMs');
    if (options.popupPolicy !== undefined && !['stay', 'follow-single'].includes(options.popupPolicy)) throw new BrowserError('INVALID_ARGUMENT', 'popupPolicy must be stay or follow-single.');
    this.popupPolicy = options.popupPolicy ?? 'stay';
  }

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
  /** A main-document lease for trusted application code, never a model-supplied token. */
  acquireBinding(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<BrowserBindingGuard> {
    let documentHandle: JSHandle<Document> | undefined;
    let closing: Promise<void> | undefined;
    let interruption: BrowserError | undefined;
    let rejectInterrupted: (error: BrowserError) => void = () => {};
    const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
    void interrupted.catch(() => {});
    const release = (): Promise<void> => {
      if (!documentHandle) return Promise.resolve();
      if (!closing) {
        // A destroyed execution context already released its remote handles.
        closing = documentHandle.dispose().catch(() => {});
        this.resourceCleanup.add(closing);
        void closing.then(() => this.resourceCleanup.delete(closing!));
      }
      return closing;
    };
    const lease = { sessionId, invalidate: (code: string) => {
      if (!interruption) {
        interruption = new BrowserError(code, code === 'CANCELLED' ? 'Browser binding was cancelled.' : code === 'BINDING_CLOSED' ? 'Browser binding is closed.' : 'The bound browser context is no longer current.');
        rejectInterrupted(interruption);
        this.bindings.delete(lease);
        options.signal?.removeEventListener('abort', onAbort);
      }
      void release();
    } };
    const onAbort = () => lease.invalidate('CANCELLED');
    const checkOpen = () => {
      if (this.disposed) lease.invalidate('ENGINE_CLOSED');
      if (options.signal?.aborted) lease.invalidate('CANCELLED');
      if (interruption) throw interruption;
    };
    this.bindings.add(lease);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const capturing = this.exclusive(sessionId, async session => {
      checkOpen();
      const page = session.page, frame = page.mainFrame(), tabId = session.activeTabId;
      const generation = session.generations.get(frame) ?? 0, activation = session.activationEpoch;
      const unchanged = () => {
        checkOpen();
        if (session.closed || page.isClosed() || frame.isDetached() || this.sessions.get(sessionId) !== session || session.page !== page || session.activeTabId !== tabId || session.activationEpoch !== activation || (session.generations.get(frame) ?? 0) !== generation) throw new BrowserError('BINDING_STALE', 'The bound tab or document changed. Acquire a fresh browser binding.');
      };
      documentHandle = await frame.evaluateHandle(() => document);
      try {
        unchanged();
        const location = await documentHandle.evaluate(bound => bound === document ? { origin: window.location.origin, protocol: window.location.protocol, href: window.location.href } : null);
        unchanged();
        if (!location || !['http:', 'https:'].includes(location.protocol) || location.origin === 'null') throw new BrowserError('BINDING_ORIGIN_UNSUPPORTED', 'Browser bindings require an HTTP(S) main document with a non-opaque origin.');
        const binding: BrowserBinding = Object.freeze({ sessionId, tabId, documentEpoch: generation, origin: location.origin });
        // Stable across leases of the same context, including their lifetime
        // between planning decisions. This key contains no page-controlled nonce.
        const contextKey = createHash('sha256').update(JSON.stringify([sessionId, tabId, generation, activation, location.href])).digest('hex');
        const assertCurrent = (): Promise<void> => {
          try { checkOpen(); } catch (error) { return Promise.reject(error); }
          const assertion = this.exclusive(sessionId, async () => {
            unchanged();
            const matches = await documentHandle!.evaluate((bound, expected) => bound === document && window.location.origin === expected.origin && window.location.href === expected.href, { origin: binding.origin, href: location.href });
            unchanged();
            if (!matches) throw new BrowserError('BINDING_STALE', 'The bound document changed. Acquire a fresh browser binding.');
          }).catch(error => {
            lease.invalidate(interruption?.code ?? 'BINDING_STALE');
            throw interruption ?? error;
          });
          return Promise.race([assertion, interrupted]);
        };
        // No application callback holds the session queue. Callers may await any
        // other engine method, then assert again before accepting delayed work.
        return Object.freeze({ binding, contextKey, assertCurrent, close: () => { lease.invalidate('BINDING_CLOSED'); return release(); } });
      } catch (error) {
        await release();
        throw error;
      }
    }).catch(error => {
      const code = interruption?.code ?? (error instanceof BrowserError ? error.code : 'BINDING_STALE');
      lease.invalidate(code);
      throw interruption!;
    });
    this.bindingJobs.add(capturing);
    void capturing.then(() => this.bindingJobs.delete(capturing), () => this.bindingJobs.delete(capturing));
    return Promise.race([capturing, interrupted]);
  }
  open(url: string, options: { storageState?: string | StorageState; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.'));
    let checked: string; try { checked = validUrl(url); } catch (error) { return Promise.reject(error); }
    const operation = this.openInternal(checked, options);
    this.opening.add(operation); operation.then(() => this.opening.delete(operation), () => this.opening.delete(operation));
    return operation;
  }
  private async openInternal(url: string, options: { storageState?: string | StorageState; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const ownsContext = !this.options.cdpUrl;
    let context: BrowserContext | undefined, page: Page | undefined, session: Session | undefined;
    let attemptCleanup: Promise<void> | undefined;
    let interruption: BrowserError | undefined, rejectCancellation: (error: BrowserError) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    void cancelled.catch(() => {});
    const check = () => {
      if (options.signal?.aborted) interruption ??= new BrowserError('CANCELLED', 'Opening this browser session was cancelled.');
      if (this.disposed) interruption ??= new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.');
      if (interruption) throw interruption;
    };
    const cleanupAttempt = (): Promise<void> => {
      if (!session && !(context && ownsContext) && !page) return Promise.resolve();
      if (!attemptCleanup) {
        attemptCleanup = (async () => {
          if (this.disposed && ownsContext) await this.ownedBrowserClosing;
          if (session) {
            session.closed = true; this.sessions.delete(session.id); this.openingSessions.delete(session);
            await this.cleanup(session);
          } else if (context && ownsContext) await context.close();
          else if (page) await page.close();
        })();
        this.opening.add(attemptCleanup);
        this.resourceCleanup.add(attemptCleanup);
        void attemptCleanup.then(() => { this.opening.delete(attemptCleanup!); this.resourceCleanup.delete(attemptCleanup!); }, () => { this.cleanupFailed = true; this.opening.delete(attemptCleanup!); this.resourceCleanup.delete(attemptCleanup!); });
      }
      return attemptCleanup;
    };
    const onAbort = () => {
      interruption ??= new BrowserError('CANCELLED', 'Opening this browser session was cancelled.');
      rejectCancellation(interruption);
      void cleanupAttempt().catch(() => {});
    };
    const onDispose = () => {
      interruption ??= new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.');
      rejectCancellation(interruption);
      void cleanupAttempt().catch(() => {});
    };
    // Track late resource acquisition independently of the caller-facing race.
    // Cancelling one open never closes the shared browser or an external context.
    const phase = <T>(pending: Promise<T>, receive?: (value: T) => void, disposeLate?: (value: T) => Promise<unknown>): Promise<T> => {
      const tracked = pending.then(async value => {
        receive?.(value);
        try { check(); }
        catch (error) {
          if (this.disposed && ownsContext) await this.ownedBrowserClosing;
          await disposeLate?.(value).catch(() => { this.cleanupFailed = true; });
          throw error;
        }
        return value;
      });
      this.opening.add(tracked);
      void tracked.then(() => this.opening.delete(tracked), () => this.opening.delete(tracked));
      return Promise.race([tracked, cancelled]);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    this.cancelOpening.add(onDispose);
    try {
      check();
      if (options.storageState && this.options.cdpUrl) throw new BrowserError('INVALID_ARGUMENT', 'Storage state import requires an isolated context.');
      if (typeof options.storageState === 'string' && (await phase(stat(options.storageState))).size > 10 * 1024 * 1024) throw new BrowserError('STATE_TOO_LARGE', 'Storage state exceeds 10 MiB.');
      const browser = await phase(this.browser());
      check();
      context = ownsContext
        ? await phase(browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, storageState: options.storageState }), value => { context = value; }, value => value.close())
        : browser.contexts()[0];
      if (!context) throw new BrowserError('CDP_CONTEXT_MISSING', 'The attached browser has no default context.');
      check();
      page = await phase(context.newPage(), value => { page = value; }, value => value.close());
      check();
      session = {
        id: randomUUID(), context, ownsContext, page, tail: Promise.resolve(), closed: false,
        revision: 0, nextRef: 1, nextFrame: 1, activationEpoch: 0, frames: new Map([[page.mainFrame(), 'f0']]), generations: new Map(),
        tabs: new Map(), activeTabId: '', nextTab: 1, downloads: new Map(), dialogs: [], unexpected: [],
      };
      this.openingSessions.add(session);
      session.activeTabId = this.registerPage(session, page);
      await phase(page.goto(url, { waitUntil: 'domcontentloaded' }));
      const snapshot = await phase(this.snapshotInternal(session, {}));
      check();
      this.sessions.set(session.id, session);
      this.openingSessions.delete(session);
      return { ...snapshot, session_mode: ownsContext ? 'isolated' : 'attached_profile' };
    } catch (error) {
      // Cancellation returns promptly even when a close RPC is stuck. Disposal
      // tracks that cleanup and reports incomplete cleanup instead of losing it.
      if (interruption) void cleanupAttempt().catch(() => {});
      else await cleanupAttempt();
      throw interruption ?? (error instanceof BrowserError ? error : new BrowserError('NAVIGATION_FAILED', errorInfo(error).message));
    } finally { options.signal?.removeEventListener('abort', onAbort); this.cancelOpening.delete(onDispose); }
  }
  private registerPage(session: Session, page: Page): string {
    const existing = [...session.tabs].find(([, owned]) => owned === page);
    if (existing) return existing[0];
    const id = `t${session.nextTab++}`;
    session.tabs.set(id, page);
    page.setDefaultTimeout(this.timeout);
    page.setDefaultNavigationTimeout(this.timeout);
    page.once('close', () => {
      session.tabs.delete(id);
      if (session.closed) return;
      if (session.page === page) {
        const next = session.tabs.entries().next().value;
        if (next) this.activatePage(session, next[0], next[1]);
        else { session.closed = true; this.sessions.delete(session.id); void this.cleanup(session).catch(() => {}); }
      }
    });
    page.on('framenavigated', frame => session.generations.set(frame, (session.generations.get(frame) ?? 0) + 1));
    page.on('popup', popup => {
      if (session.closed) { void popup.close().catch(() => {}); return; }
      this.registerPage(session, popup);
    });
    page.on('download', download => { this.trackDownload(session, download); });
    page.on('dialog', dialog => {
      const policy = session.dialogPolicy;
      session.dialogPolicy = undefined;
      session.dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 2000), action: policy?.action ?? 'dismiss' });
      if (session.dialogs.length > 20) session.dialogs.shift();
      if (!policy) session.unexpected.push(`A ${dialog.type()} dialog was dismissed. Arm tab_dialog before repeating an action that opens a dialog.`);
      const operation = policy?.action === 'accept' ? dialog.accept(policy.promptText) : dialog.dismiss();
      void operation.catch(() => {});
    });
    return id;
  }
  private activatePage(session: Session, id: string, page: Page): void {
    if (session.page !== page) session.activationEpoch++;
    void this.releaseRefs(session.snapshot);
    session.snapshot = undefined;
    session.activeTabId = id;
    session.page = page;
    // f0 always identifies the active tab's main frame. Revisions remain session-wide.
    session.frames = new Map([[page.mainFrame(), 'f0']]);
  }
  private artifacts(): Promise<string> {
    return this.artifactDirectory ??= mkdtemp(join(tmpdir(), 'tablaze-artifacts-'));
  }
  private trackDownload(session: Session, download: Download): void {
    if (session.closed || session.downloads.size >= 100) { void download.cancel().catch(() => {}); return; }
    const id = randomUUID();
    const record: DownloadRecord = { id, filename: basename(download.suggestedFilename()).slice(0, 200), url: download.url().slice(0, 4000), status: 'pending', download, done: Promise.resolve() };
    session.downloads.set(id, record);
    record.done = (async () => {
      try {
        const destination = join(await this.artifacts(), `${id}.download`);
        await download.saveAs(destination);
        await chmod(destination, 0o600);
        record.path = destination;
        record.bytes = (await stat(destination)).size;
        record.status = 'completed';
      } catch { record.status = 'failed'; record.error = 'The download failed or its session closed before completion.'; }
    })();
  }
  private tabList(session: Session) {
    return [...session.tabs].filter(([, page]) => !page.isClosed()).map(([id, page]) => ({ tab_id: id, url: page.url().slice(0, 4000), active: page === session.page }));
  }
  tabs(sessionId: string, options: { action: 'list' | 'new' | 'switch' | 'close'; tabId?: string; url?: string }): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (options.action === 'list') return { ok: true, session_id: session.id, tabs: this.tabList(session) };
      if (options.action === 'new') {
        const url = options.url ? validUrl(options.url) : 'about:blank';
        const page = await session.context.newPage();
        if (this.disposed || session.closed) {
          await page.close().catch(() => {});
          throw new BrowserError('SESSION_CLOSED', 'The session closed while creating this tab.');
        }
        const id = this.registerPage(session, page);
        try { if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }); }
        catch (error) { await page.close().catch(() => {}); throw new BrowserError('NAVIGATION_FAILED', errorInfo(error).message); }
        if (this.disposed || session.closed || page.isClosed()) throw new BrowserError('SESSION_CLOSED', 'The session closed while opening this tab.');
        this.activatePage(session, id, page);
      } else {
        const id = options.tabId;
        const page = id ? session.tabs.get(id) : undefined;
        if (!id || !page || page.isClosed()) throw new BrowserError('TAB_NOT_FOUND', 'Select a live tab owned by this session.');
        if (options.action === 'switch') this.activatePage(session, id, page);
        else if (options.action === 'close') {
          await page.close();
          if (session.closed) return { ok: true, session_id: session.id, closed: true, tabs: [] };
        } else throw new BrowserError('INVALID_ARGUMENT', 'Unsupported tab operation.');
      }
      return this.snapshotInternal(session, {});
    });
  }
  navigate(sessionId: string, options: { action: 'goto' | 'back' | 'forward' | 'reload'; url?: string }): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (session.snapshot) session.snapshot.actionable = false;
      const wait = { waitUntil: 'domcontentloaded' as const };
      if (options.action === 'goto') await session.page.goto(validUrl(options.url ?? ''), wait);
      else if (options.action === 'back') await session.page.goBack(wait);
      else if (options.action === 'forward') await session.page.goForward(wait);
      else if (options.action === 'reload') await session.page.reload(wait);
      else throw new BrowserError('INVALID_ARGUMENT', 'Unsupported navigation operation.');
      return this.snapshotInternal(session, {});
    });
  }
  dialog(sessionId: string, policy: { action: 'accept' | 'dismiss'; promptText?: string }): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (!['accept', 'dismiss'].includes(policy.action)) throw new BrowserError('INVALID_ARGUMENT', 'Choose accept or dismiss.');
      if (policy.promptText && policy.promptText.length > 10000) throw new BrowserError('INVALID_ARGUMENT', 'Prompt response exceeds 10000 characters.');
      session.dialogPolicy = { ...policy };
      return { ok: true, session_id: session.id, armed: true, action: policy.action };
    });
  }
  downloads(sessionId: string, downloadId?: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (downloadId) {
        const item = session.downloads.get(downloadId);
        if (!item) throw new BrowserError('DOWNLOAD_NOT_FOUND', 'No owned download with that ID.');
        const timeout = integer(timeoutMs, this.timeout, 100, 60000, 'timeoutMs');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([item.done, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      const records = [...session.downloads.values()].filter(item => !downloadId || item.id === downloadId).map(({ done, download, ...item }) => item);
      return { ok: records.every(item => item.status !== 'failed'), session_id: session.id, downloads: records };
    });
  }
  saveState(sessionId: string): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      const state = await session.context.storageState({ indexedDB: true });
      const path = join(await this.artifacts(), `${randomUUID()}.state.json`);
      await writeFile(path, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      return { ok: true, session_id: session.id, storage_state: path, cookies: state.cookies.length, origins: state.origins.length, includes: ['cookies', 'localStorage', 'indexedDB'] };
    });
  }
  /** Capture durable auth and owned URLs. This is not a serialization of live DOM or sessionStorage. */
  async exportWorkspace(): Promise<BrowserWorkspace> {
    const sessions: BrowserWorkspace['sessions'] = [];
    for (const id of [...this.sessions.keys()]) {
      const state = await this.exclusive(id, async session => {
        const storage = await session.context.storageState({ indexedDB: true });
        if (session.closed || session.page.isClosed() || !session.tabs.has(session.activeTabId)) throw new BrowserError('SESSION_CLOSED', 'The session closed during state export.');
        return { sessionId: id, activeTabId: session.activeTabId, storage,
          tabs: [...session.tabs].filter(([, page]) => !page.isClosed()).map(([tabId, page]) => ({ tabId, url: page.url() })),
        };
      });
      sessions.push(state);
    }
    return { version: 1, popupPolicy: this.popupPolicy, sessions };
  }
  async restoreWorkspace(input: unknown): Promise<{ sessionMap: Record<string, string>; snapshots: Record<string, unknown>[] }> {
    if (this.options.cdpUrl) throw new BrowserError('INVALID_ARGUMENT', 'Workspace restoration requires isolated contexts.');
    if (this.disposed || this.sessions.size || this.opening.size) throw new BrowserError('INVALID_ARGUMENT', 'Restore into a new, empty browser engine.');
    const workspace = input as BrowserWorkspace;
    if (!workspace || workspace.version !== 1 || !Array.isArray(workspace.sessions) || workspace.sessions.length > 20 || Buffer.byteLength(JSON.stringify(workspace)) > 10 * 1024 * 1024) throw new BrowserError('INVALID_ARGUMENT', 'Invalid or oversized browser workspace.');
    if (workspace.popupPolicy !== undefined && !['stay', 'follow-single'].includes(workspace.popupPolicy)) throw new BrowserError('INVALID_ARGUMENT', 'Invalid workspace popup policy.');
    const ids = new Set<string>();
    for (const saved of workspace.sessions) {
      if (!saved || typeof saved.sessionId !== 'string' || !saved.sessionId || ids.has(saved.sessionId) || !Array.isArray(saved.tabs) || !saved.tabs.length || saved.tabs.length > 50 || !saved.storage || !Array.isArray(saved.storage.cookies) || !Array.isArray(saved.storage.origins)) throw new BrowserError('INVALID_ARGUMENT', 'Invalid workspace session.');
      ids.add(saved.sessionId);
      const tabs = new Set<string>();
      for (const tab of saved.tabs) {
        if (!tab || typeof tab.tabId !== 'string' || !tab.tabId || tabs.has(tab.tabId) || typeof tab.url !== 'string' || tab.url.length > 8192) throw new BrowserError('INVALID_ARGUMENT', 'Invalid workspace tab.');
        tabs.add(tab.tabId);
        if (tab.url !== 'about:blank') validUrl(tab.url);
      }
      if (!tabs.has(saved.activeTabId)) throw new BrowserError('INVALID_ARGUMENT', 'Workspace active tab is missing.');
    }
    const restored: string[] = [];
    const sessionMap: Record<string, string> = Object.create(null);
    const snapshots: Record<string, unknown>[] = [];
    const previousPopupPolicy = this.popupPolicy;
    this.popupPolicy = workspace.popupPolicy ?? 'stay';
    try {
      for (const saved of workspace.sessions) {
        const first = saved.tabs[0];
        // openInternal permits about:blank only for a validated workspace record.
        const operation = this.openInternal(first.url, { storageState: saved.storage });
        this.opening.add(operation);
        let opened: Record<string, unknown>;
        try { opened = await operation; } finally { this.opening.delete(operation); }
        const id = opened.session_id as string;
        restored.push(id); sessionMap[saved.sessionId] = id;
        const tabMap = new Map([[first.tabId, opened.tab_id as string]]);
        for (const tab of saved.tabs.slice(1)) {
          const snapshot = await this.tabs(id, { action: 'new', ...(tab.url !== 'about:blank' ? { url: tab.url } : {}) });
          tabMap.set(tab.tabId, snapshot.tab_id as string);
        }
        snapshots.push(await this.tabs(id, { action: 'switch', tabId: tabMap.get(saved.activeTabId) }));
      }
      return { sessionMap, snapshots };
    } catch (error) {
      await Promise.allSettled(restored.map(id => this.close(id)));
      this.popupPolicy = previousPopupPolicy;
      throw error;
    }
  }
  pdf(sessionId: string, options: { format?: 'A4' | 'Letter'; landscape?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      const page = session.page;
      const tabId = session.activeTabId, url = page.url();
      const generation = session.generations.get(page.mainFrame()) ?? 0;
      if (options.format && !['A4', 'Letter'].includes(options.format)) throw new BrowserError('INVALID_ARGUMENT', 'PDF format must be A4 or Letter.');
      let expired = false;
      const timer = setTimeout(() => { expired = true; void page.close().catch(() => {}); }, this.timeout);
      let buffer: Buffer;
      try { buffer = await page.pdf({ format: options.format ?? 'A4', landscape: options.landscape ?? false, printBackground: true }); }
      catch (error) { throw expired ? new BrowserError('PDF_TIMEOUT', 'PDF export exceeded its time budget; the owned tab was closed.') : error; }
      finally { clearTimeout(timer); }
      if (page !== session.page || page.isClosed() || generation !== (session.generations.get(page.mainFrame()) ?? 0)) throw new BrowserError('CAPTURE_CHANGED', 'The page changed during PDF export.');
      if (buffer.length > 50 * 1024 * 1024) throw new BrowserError('CAPTURE_TOO_LARGE', 'PDF exceeds 50 MiB.');
      const path = join(await this.artifacts(), `${randomUUID()}.pdf`);
      await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
      if (page !== session.page || page.isClosed() || generation !== (session.generations.get(page.mainFrame()) ?? 0)) {
        await rm(path, { force: true });
        throw new BrowserError('CAPTURE_CHANGED', 'The page changed while persisting its PDF.');
      }
      return { ok: true, session_id: session.id, tab_id: tabId, url, path, bytes: buffer.length, mime_type: 'application/pdf', sha256: createHash('sha256').update(buffer).digest('hex') };
    });
  }
  private async uploadPaths(files: string[]): Promise<string[]> {
    if (!Array.isArray(files) || files.length > 20) throw new BrowserError('INVALID_ARGUMENT', 'Supply at most 20 upload paths. An empty list clears the selection.');
    return Promise.all(files.map(async file => {
      const path = await realpath(file);
      const info = await stat(path);
      if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new BrowserError('INVALID_ARGUMENT', 'Each upload must be a regular file no larger than 50 MiB.');
      return path;
    }));
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
    if (options.selector !== undefined && (typeof options.selector !== 'string' || !options.selector.trim() || options.selector.length > 1000)) throw new BrowserError('INVALID_ARGUMENT', 'Snapshot selector must contain 1–1000 characters.');
    if (options.viewportOnly !== undefined && typeof options.viewportOnly !== 'boolean') throw new BrowserError('INVALID_ARGUMENT', 'viewportOnly must be a boolean.');
    const scope = { selector: options.selector, viewportOnly: options.viewportOnly ?? false };
    const compatible = previous?.frame === frame && previous.generation === generation && JSON.stringify(previous.scope) === JSON.stringify(scope);
    const old = compatible ? [...previous.refs].map(([ref, item]) => ({ ref, node: item.handle })) : [];
    let root: ElementHandle | null = null;
    if (options.selector) {
      const roots = frame.locator(options.selector);
      if (await roots.count() !== 1) throw new BrowserError('SELECTOR_COUNT', 'Snapshot selector must match exactly one root element.');
      root = await roots.elementHandle();
      if (!root) throw new BrowserError('SNAPSHOT_CHANGED', 'The selected root disappeared. Take a fresh snapshot.');
    }
    const result = await frame.evaluateHandle(inspectDOM, { op: 'snapshot', root, viewportOnly: scope.viewportOnly, maxElements, textLimit, nextRef: session.nextRef, previous: old }).finally(() => root?.dispose());
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
    session.snapshot = { id, frame, generation, refs, actionable: true, entries, scope };
    const metadataTruncated = allFrames.length > 100 || allFrames.some(frame => frame.url.length > 4000 || frame.name.length > 200) || title.length > 1000 || session.page.url().length > 4000;
    const output: Record<string, unknown> = { ok: true, session_id: session.id, snapshot_id: id, tab_id: session.activeTabId, tabs: this.tabList(session), scope: { selector: scope.selector ?? null, viewport_only: scope.viewportOnly }, mode: options.mode ?? 'full', frame_id: frameId, url: session.page.url().slice(0, 4000), title: title.slice(0, 1000), frames, frame_count: allFrames.length, elements: entries, text: data.text, truncated: data.truncated || metadataTruncated, truncation: { ...data.truncation, metadata: metadataTruncated }, budgets: { max_elements: maxElements, text_limit: textLimit, max_frames: 100 }, elapsed_ms: Math.round(performance.now() - start) };
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
      const earlyFailure = (code: string, message: string) => { const error = { code, message }; return { ok: false, batch_complete: false, session_id: session.id, snapshot_id: snapshotId, partial: false, completed: 0, failed: { index: 0, action: actions[0].type, error }, results: actions.map((action, index) => ({ index, type: action.type, status: index === 0 ? 'failed' : 'skipped', ...(index === 0 ? { error } : {}) })), elapsed_ms: Math.round(performance.now() - start) }; };
      if (options.signal?.aborted) return earlyFailure('CANCELLED', 'The action batch was cancelled before it started.');
      const state = session.snapshot;
      if (!state || state.id !== snapshotId || !state.actionable) {
        return earlyFailure('STALE_SNAPSHOT', 'The snapshot was replaced or already used by an action batch. Take a fresh snapshot.');
      }
      const observedPage = state.frame.page();
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
        void interruptedCleanup.catch(() => {});
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
        if (observedPage.isClosed() || session.page !== observedPage) throw new BrowserError('STALE_REFERENCE', 'The observed tab closed or changed. Observe the active tab before further input.');
      };
      const remaining = (limit: number) => { checkInterruption(); return Math.max(1, Math.min(limit, deadline - performance.now())); };
      const results: Record<string, unknown>[] = [];
      let failed: Record<string, unknown> | null = null;
      let completed = 0;
      let failedActionMayHaveSideEffects = false;
      let popupFollowed: { from_tab_id: string; tab_id: string; action_index: number; window_ms: number } | undefined;
      const popupWindowMs = 250;
      try {
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        if (failed || popupFollowed) { results.push({ index, type: action.type, status: 'skipped', ...(popupFollowed ? { reason: 'replan_required' } : {}) }); continue; }
        let actionStarted = false;
        let popupWindow: { until: number; candidates: Set<Page>; listener: (popup: Page) => void } | undefined;
        const armPopupWindow = () => {
          if (this.popupPolicy !== 'follow-single' || !['click', 'double_click', 'press', 'click_xy', 'upload_chooser'].includes(action.type)) return;
          const candidates = new Set<Page>(), until = Math.min(deadline, performance.now() + popupWindowMs);
          const listener = (popup: Page) => {
            // This is a bounded opener/window association, not proof that the
            // input uniquely caused a popup. Other owned openers are excluded.
            if (!session.closed && session.page === observedPage && performance.now() <= until) candidates.add(popup);
          };
          observedPage.on('popup', listener);
          return { until, candidates, listener };
        };
        try {
          checkInterruption();
          if (session.unexpected.length) throw new BrowserError('UNSUPPORTED_FLOW', session.unexpected.shift()!);
          if (state.frame.isDetached() || state.generation !== (session.generations.get(state.frame) ?? 0)) throw new BrowserError('STALE_REFERENCE', 'The observed document navigated. Take a fresh snapshot.');
          if (action.type === 'click_xy') {
            if (state.frame !== observedPage.mainFrame()) throw new BrowserError('INVALID_ARGUMENT', 'Coordinate clicks use the main tab viewport; observe the main frame first.');
            const viewport = await observedPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
            if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0 || action.x >= viewport.width || action.y >= viewport.height) throw new BrowserError('INVALID_ARGUMENT', 'Coordinates must be inside the current viewport in CSS pixels.');
            checkInterruption();
            actionStarted = true;
            popupWindow = armPopupWindow();
            await observedPage.mouse.click(action.x, action.y);
          }
          else if (action.type === 'scroll') {
            const pixels = integer(action.pixels, 600, 1, 10000, 'pixels');
            if (!['up', 'down', 'left', 'right'].includes(action.direction)) throw new BrowserError('INVALID_ARGUMENT', 'Invalid scroll direction.');
            const delta = { x: action.direction === 'left' ? -pixels : action.direction === 'right' ? pixels : 0, y: action.direction === 'up' ? -pixels : action.direction === 'down' ? pixels : 0 };
            if (action.ref) {
              const target = await this.reference(session, state, action.ref);
              checkInterruption(); actionStarted = true;
              await target.evaluate((element, { x, y }) => element.scrollBy(x, y), delta);
            } else { actionStarted = true; await state.frame.evaluate(({ x, y }) => window.scrollBy(x, y), delta); }
          }
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
              case 'click': popupWindow = armPopupWindow(); await target.click({ timeout }); break;
              case 'double_click': popupWindow = armPopupWindow(); await target.dblclick({ timeout }); break;
              case 'hover': await target.hover({ timeout }); break;
              case 'upload':
              case 'upload_chooser': {
                const paths = await this.uploadPaths(action.files);
                checkInterruption();
                await this.reference(session, state, action.ref);
                if (action.type === 'upload') await target.setInputFiles(paths, { timeout: remaining(timeout) });
                else {
                  popupWindow = armPopupWindow();
                  const [chooser] = await Promise.all([
                    observedPage.waitForEvent('filechooser', { timeout: remaining(timeout) }),
                    target.click({ timeout: remaining(timeout) }),
                  ]);
                  checkInterruption();
                  await chooser.setFiles(paths, { timeout: remaining(timeout) });
                }
                break;
              }
              case 'drag': {
                const destination = await this.reference(session, state, action.targetRef);
                // Mouse coordinates are relative to the main viewport, even for iframe refs.
                // Inspect each ancestor frame before converting into the target document.
                const ensureHit = async (element: ElementHandle<Element>, point: { x: number; y: number }, sourceCover?: ElementHandle<Element>) => {
                  const hit = (expected: Element, { point, cover, frame }: { point: { x: number; y: number }; cover?: Element; frame: boolean }) => {
                    if (!expected.isConnected) return { ok: false, reason: 'The observed target was detached.' };
                    const inside = (root: Element, node: Element): boolean => {
                      let current: Element | null = node;
                      while (current) { if (current === root) return true; const owner = current.getRootNode(); current = current.parentElement ?? (owner instanceof ShadowRoot ? owner.host : null); }
                      return false;
                    };
                    const candidates: Element[] = []; const seen = new Set<Element>(); const roots = new Set<Document | ShadowRoot>();
                    const inspect = (root: Document | ShadowRoot) => {
                      if (roots.has(root)) return; roots.add(root);
                      for (const candidate of root.elementsFromPoint(point.x, point.y)) {
                        if (candidate.shadowRoot) inspect(candidate.shadowRoot);
                        if (!seen.has(candidate)) { seen.add(candidate); candidates.push(candidate); }
                      }
                    };
                    inspect(expected.ownerDocument);
                    const top = candidates.find(candidate => !cover || !inside(cover, candidate));
                    if (!top || !inside(expected, top)) return { ok: false, reason: 'Another element intercepts the observed drag point.' };
                    if (!frame) return { ok: true, point };
                    // Axis-aligned scale/zoom is supported; rotated or perspective frames
                    // cannot safely be mapped with an axis-aligned bounding rectangle.
                    let ancestor: Element | null = expected;
                    while (ancestor) {
                      const style = getComputedStyle(ancestor);
                      if (style.perspective !== 'none') return { ok: false, reason: 'Perspective-transformed frames require another interaction method.' };
                      if (style.transform !== 'none') {
                        const matrix = new DOMMatrixReadOnly(style.transform);
                        if (!matrix.is2D || Math.abs(matrix.b) > 0.000001 || Math.abs(matrix.c) > 0.000001 || matrix.a <= 0 || matrix.d <= 0) return { ok: false, reason: 'Rotated or reflected frames require another interaction method.' };
                      }
                      const owner = ancestor.getRootNode(); ancestor = ancestor.parentElement ?? (owner instanceof ShadowRoot ? owner.host : null);
                    }
                    const box = expected.getBoundingClientRect(); const iframe = expected as HTMLElement;
                    if (box.width <= 0 || box.height <= 0 || iframe.offsetWidth <= 0 || iframe.offsetHeight <= 0) return { ok: false, reason: 'The observed frame has no visible geometry.' };
                    return { ok: true, point: { x: (point.x - box.left) * iframe.offsetWidth / box.width - iframe.clientLeft, y: (point.y - box.top) * iframe.offsetHeight / box.height - iframe.clientTop } };
                  };
                  const frames: Frame[] = [];
                  for (let frame: Frame | null = state.frame; frame?.parentFrame(); frame = frame.parentFrame()) frames.unshift(frame);
                  let local = point;
                  for (const frame of frames) {
                    const owner = await frame.frameElement();
                    try {
                      const checked = await owner.evaluate(hit, { point: local, frame: true });
                      if (!checked.ok || !checked.point) throw new BrowserError('DRAG_TARGET_OBSCURED', checked.reason ?? 'The frame does not receive the drag input.');
                      local = checked.point;
                    } finally { await owner.dispose(); }
                  }
                  const checked = await element.evaluate(hit, { point: local, frame: false, cover: sourceCover });
                  if (!checked.ok) throw new BrowserError('DRAG_TARGET_OBSCURED', checked.reason ?? 'The target does not receive the drag input.');
                };
                await destination.click({ trial: true, timeout: remaining(timeout) });
                await target.scrollIntoViewIfNeeded({ timeout: remaining(timeout) });
                await this.reference(session, state, action.ref);
                await this.reference(session, state, action.targetRef);
                const [sourceBox, destinationBox, viewport] = await Promise.all([target.boundingBox(), destination.boundingBox(), observedPage.evaluate(() => ({ width: innerWidth, height: innerHeight }))]);
                if (!sourceBox || !destinationBox) throw new BrowserError('NOT_VISIBLE', 'Both drag targets must be visible.');
                const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
                const destinationPoint = { x: destinationBox.x + destinationBox.width / 2, y: destinationBox.y + destinationBox.height / 2 };
                if ([source, destinationPoint].some(point => point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height)) throw new BrowserError('NOT_VISIBLE', 'Both drag target centers must fit in the viewport; adjust scrolling first.');
                await this.reference(session, state, action.ref);
                await this.reference(session, state, action.targetRef);
                await ensureHit(destination, destinationPoint);
                await ensureHit(target, source);
                checkInterruption();
                await observedPage.mouse.move(source.x, source.y);
                await this.reference(session, state, action.ref);
                await this.reference(session, state, action.targetRef);
                await ensureHit(destination, destinationPoint);
                await ensureHit(target, source);
                checkInterruption();
                let buttonMayBeDown = false;
                try {
                  // Mark before awaiting: an RPC can apply input and then reject.
                  buttonMayBeDown = true;
                  await observedPage.mouse.down();
                  checkInterruption();
                  await observedPage.mouse.move(destinationPoint.x, destinationPoint.y, { steps: 12 });
                  await observedPage.mouse.move(destinationPoint.x, destinationPoint.y);
                  await this.reference(session, state, action.targetRef);
                  await ensureHit(destination, destinationPoint, target);
                  checkInterruption();
                  await observedPage.mouse.up();
                  buttonMayBeDown = false;
                } catch (error) {
                  if (buttonMayBeDown) {
                    try {
                      // Escape cancels a native HTML drag before cleanup releases at a
                      // neutral point. Cleanup must not drop onto an intercepting overlay.
                      await observedPage.keyboard.press('Escape');
                      await observedPage.mouse.move(-1, -1);
                      await observedPage.mouse.up();
                      buttonMayBeDown = false;
                    } catch {
                      interrupt('INPUT_CLEANUP_FAILED', 'Drag input could not be released reliably. This owned session was closed; prior effects may remain.');
                    }
                  }
                  throw error;
                }
                break;
              }
              case 'fill': if (action.value.length > 10000) throw new BrowserError('INVALID_ARGUMENT', 'Fill value exceeds 10000 characters.'); await target.fill(action.value, { timeout }); break;
              case 'press': { await target.focus(); checkInterruption(); const focused = await target.evaluate(element => { let active = document.activeElement; while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement; return active === element; }); if (!focused) throw new BrowserError('NOT_FOCUSABLE', 'The referenced element cannot receive keyboard input.'); popupWindow = armPopupWindow(); await target.press(action.key, { timeout: remaining(timeout) }); break; }
              case 'select': await target.selectOption(action.values, { timeout }); break;
              case 'check': await target.setChecked(action.checked, { timeout }); break;
              default: throw new BrowserError('INVALID_ARGUMENT', 'Unsupported action type.');
            }
          }
          checkInterruption();
          if (session.unexpected.length) throw new BrowserError('UNSUPPORTED_FLOW', session.unexpected.shift()!);
          if (popupWindow) {
            const window = popupWindow;
            const wait = window.until - performance.now();
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
            checkInterruption();
            observedPage.off('popup', window.listener);
            const candidates = [...window.candidates];
            if (candidates.length === 1 && !candidates[0].isClosed()) {
              const tab = [...session.tabs].find(([, page]) => page === candidates[0]);
              if (tab) {
                popupFollowed = { from_tab_id: session.activeTabId, tab_id: tab[0], action_index: index, window_ms: popupWindowMs };
                this.activatePage(session, tab[0], tab[1]);
              }
            }
          }
          completed++; results.push({ index, type: action.type, status: 'completed' });
        } catch (error) { if (!interruption && performance.now() >= deadline) interrupt('BATCH_TIMEOUT', 'The action batch exceeded its total time budget. This session was closed; completed actions were not rolled back.'); const info = errorInfo(interruption ?? error, 'ACTION_FAILED'); if (action.type === 'fill' && action.value) info.message = info.message.split(action.value).join('[redacted]'); failedActionMayHaveSideEffects = actionStarted; failed = { index, action: action.type, error: info }; results.push({ index, type: action.type, status: 'failed', error: info }); }
        finally { if (popupWindow) observedPage.off('popup', popupWindow.listener); }
      }
      const output: Record<string, unknown> = { ok: !failed && !interruption, batch_complete: !failed && !interruption && completed === actions.length, session_id: session.id, snapshot_id: snapshotId, partial: !!(failed || interruption) && (completed > 0 || failedActionMayHaveSideEffects) || !!popupFollowed && completed < actions.length, completed, failed, failed_action_may_have_side_effects: failedActionMayHaveSideEffects, results, ...(popupFollowed ? { replan_required: true, popup_followed: popupFollowed } : {}), elapsed_ms: Math.round(performance.now() - start) };
      if (session.dialogs.length) output.dialogs = session.dialogs.splice(0);
      if ((options.snapshot !== false || popupFollowed) && !interruption) { try { output.snapshot = await this.snapshotInternal(session, popupFollowed ? {} : { ...(state.generation === (session.generations.get(state.frame) ?? 0) ? state.scope : {}), frameId: state.frame.isDetached() ? 'f0' : session.frames.get(state.frame) }); } catch (error) { output.snapshot_error = errorInfo(interruption ?? error, 'SNAPSHOT_FAILED'); } }
      if (interruption) { output.ok = false; output.batch_complete = false; output.session_closed = true; output.error = errorInfo(interruption); output.partial = completed > 0 || failedActionMayHaveSideEffects; }
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
      const root = await roots.elementHandle();
      if (!root) throw new BrowserError('SELECTOR_COUNT', 'Extraction root disappeared.');
      const result = await frame.evaluate(inspectDOM, { op: 'extract', root, kind: options.kind, maxItems }).finally(() => root.dispose());
      return { ok: true, session_id: session.id, kind: options.kind, limits: { max_items: maxItems, max_characters: 20000 }, ...result };
    });
  }
  extractStructured(sessionId: string, options: { schema: ExtractionSchema; fields: DOMFieldPlan[] }): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      const fields = validateDOMFieldPlan(options.fields);
      const frame = session.snapshot?.frame ?? session.page.mainFrame();
      const page = session.page;
      const generation = session.generations.get(frame) ?? 0;
      const observations: Record<string, DOMFieldObservation[]> = Object.create(null);
      let total = 0;
      for (const field of fields) {
        const locator = frame.locator(field.selector);
        const count = await locator.count();
        if (count > 20 || (total += count) > 100) throw new BrowserError('EXTRACTION_LIMIT', 'Structured extraction allows at most 20 matches per field and 100 total. Narrow the selectors.');
        if (!field.multiple && count > 1) throw new BrowserError('SELECTOR_COUNT', `Field ${field.name} requires a single match.`);
        observations[field.name] = [];
        for (let index = 0; index < count; index++) {
          const node = await locator.nth(index).elementHandle();
          if (!node) throw new BrowserError('SNAPSHOT_CHANGED', 'An extraction target disappeared. Observe again.');
          try {
            const text = field.mode === 'text' ? await frame.evaluate(inspectDOM, { op: 'text', root: node, textLimit: 20000 }) : undefined;
            observations[field.name].push(await frame.evaluate(inspectDOMField, { node, selector: field.selector, mode: field.mode, attribute: field.attribute, matchIndex: index, text }));
          } finally { await node.dispose(); }
        }
      }
      if (frame.isDetached() || session.page !== page || generation !== (session.generations.get(frame) ?? 0)) throw new BrowserError('SNAPSHOT_CHANGED', 'The document changed during structured extraction.');
      return { ok: true, session_id: session.id, tab_id: session.activeTabId, url: frame.url(), ...assembleDOMExtraction({ schema: options.schema, fields, observations }) };
    });
  }
  verify(sessionId: string, checks: BrowserCheck[], timeoutMs?: number, snapshotId?: string): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (!Array.isArray(checks) || checks.length < 1 || checks.length > 20) throw new BrowserError('INVALID_ARGUMENT', 'Supply between 1 and 20 checks.');
      for (const check of checks) if (check.kind === 'value') {
        const hasRef = check.ref !== undefined, hasSelector = check.selector !== undefined;
        if (hasRef === hasSelector) throw new BrowserError('INVALID_ARGUMENT', 'Value checks require exactly one selector or ref.');
        const target = hasRef ? check.ref : check.selector;
        if (typeof target !== 'string' || !target.trim() || target.length > (hasRef ? 160 : 1000) || typeof check.value !== 'string' || check.value.length > 10000) throw new BrowserError('INVALID_ARGUMENT', 'Supply a bounded value and a nonempty selector or ref.');
      }
      const usesRefs = checks.some(check => check.kind === 'value' && check.ref !== undefined);
      if (snapshotId !== undefined && (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 160) || usesRefs && snapshotId === undefined) throw new BrowserError('INVALID_ARGUMENT', 'Ref value checks require snapshot_id from the current observation.');
      const state = session.snapshot;
      // Actions consume permission to act again, not permission to inspect the
      // same nodes. A newer observation still supersedes this revision.
      if (usesRefs && (!state || state.id !== snapshotId)) throw new BrowserError('STALE_SNAPSHOT', 'The supplied snapshot is no longer current. Use the latest observation.');
      const start = performance.now(); const timeout = integer(timeoutMs, this.timeout, 100, 60000, 'timeoutMs');
      const frame = state?.frame ?? session.page.mainFrame();
      const referenceContextUnchanged = () => state && !session.closed && !session.page.isClosed() && !this.disposed && session.snapshot === state && state.frame.page() === session.page && !state.frame.isDetached() && state.generation === (session.generations.get(state.frame) ?? 0);
      const guardedReference = async (ref: string) => {
        if (!referenceContextUnchanged()) throw new BrowserError('STALE_REFERENCE', 'The observed tab or document changed. Take a fresh snapshot.');
        const node = await this.reference(session, state!, ref);
        if (!referenceContextUnchanged()) throw new BrowserError('STALE_REFERENCE', 'The observed tab or document changed during verification. Take a fresh snapshot.');
        return node;
      };
      // Compare in the page so even a very large value returns bounded evidence.
      // Checking the sensitive type and reading the value share one evaluation.
      const readValue = (element: Element, expected: string) => {
        if (element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)) return { sensitive: true };
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return { unsupported: true };
        const value = element.value;
        return { value: value.slice(0, 2000), pass: value === expected };
      };
      const results = await Promise.all(checks.map(async (check, index) => {
        const deadline = start + timeout; let actual: unknown; let pass = false; let error: ReturnType<typeof errorInfo> | undefined;
        do {
          if (session.closed || session.page.isClosed() || this.disposed) { error = { code: 'SESSION_CLOSED', message: 'The session closed before the check passed.' }; break; }
          try {
            switch (check.kind) {
              case 'url': actual = session.page.url(); pass = actual === check.value; break;
              case 'title': actual = await session.page.title(); pass = (actual as string).includes(check.contains); break;
              case 'text': { const observed = await frame.evaluate(inspectDOM, { op: 'text', contains: check.contains, textLimit: 2000 }); actual = observed.text; pass = observed.matches; if (observed.scan_truncated && !pass) throw new BrowserError('OBSERVATION_TRUNCATED', 'The DOM scan budget was exhausted before this text was found. Narrow the task or inspect a specific region.'); break; }
              case 'visible': actual = await frame.locator(check.selector).isVisible(); pass = actual === true; break;
              case 'value': {
                actual = undefined;
                const observed = check.ref !== undefined
                  ? await (await guardedReference(check.ref)).evaluate(readValue, check.value)
                  : await frame.locator(check.selector!).evaluate(readValue, check.value, { timeout: Math.max(1, deadline - performance.now()) });
                if (observed.sensitive) throw new BrowserError('SENSITIVE_VALUE', 'Password and hidden field values are not returned or verified.');
                if (observed.unsupported) throw new BrowserError('NOT_FORM_CONTROL', 'Value checks require an input, textarea, or select.');
                if (check.ref !== undefined) await guardedReference(check.ref);
                actual = observed.value; pass = observed.pass === true; break;
              }
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
      // A parallel status check may outlive a value read. Do not return its ref
      // evidence if that node or document changed while other checks waited.
      await Promise.all(results.map(async result => {
        const check = checks[result.index];
        if (check.kind !== 'value' || check.ref === undefined || result.error) return;
        try {
          const observed = await (await guardedReference(check.ref)).evaluate(readValue, check.value);
          if (observed.sensitive) throw new BrowserError('SENSITIVE_VALUE', 'Password and hidden field values are not returned or verified.');
          if (observed.unsupported) throw new BrowserError('NOT_FORM_CONTROL', 'Value checks require an input, textarea, or select.');
          await guardedReference(check.ref);
          result.actual = observed.value;
          // This final read can revoke earlier evidence, never turn a timed-out
          // assertion into a success outside its polling budget.
          result.pass &&= observed.pass === true;
        }
        catch (caught) { result.pass = false; result.actual = undefined; result.error = errorInfo(caught, 'CHECK_FAILED'); }
      }));
      if (usesRefs && !referenceContextUnchanged()) for (const result of results) {
        const check = checks[result.index];
        if (check.kind === 'value' && check.ref !== undefined) {
          result.pass = false; result.actual = undefined;
          result.error ??= { code: 'STALE_REFERENCE', message: 'The observed tab or document changed during verification. Take a fresh snapshot.' };
        }
      }
      const passed = results.every(result => result.pass);
      return { ok: passed, session_id: session.id, ...(usesRefs ? { snapshot_id: snapshotId } : {}), passed, checks: results, elapsed_ms: Math.round(performance.now() - start) };
    });
  }
  screenshot(sessionId: string, fullPage = false): Promise<{ buffer: Buffer; mimeType: string; url: string; tabId: string; viewport: { width: number; height: number; scrollX: number; scrollY: number }; coordinateSpace: string }> {
    return this.exclusive(sessionId, async session => {
      const page = session.page;
      const tabId = session.activeTabId;
      const generation = session.generations.get(page.mainFrame()) ?? 0;
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY }));
      if (fullPage) {
        const pixels = await page.evaluate(() => document.documentElement.scrollWidth * document.documentElement.scrollHeight);
        if (pixels > 32000000) throw new BrowserError('CAPTURE_TOO_LARGE', 'Full-page capture exceeds 32 million pixels; use a viewport screenshot.');
      }
      const buffer = await page.screenshot({ type: 'jpeg', quality: 70, fullPage, scale: 'css', timeout: this.timeout });
      if (session.page !== page || page.isClosed() || generation !== (session.generations.get(page.mainFrame()) ?? 0)) throw new BrowserError('CAPTURE_CHANGED', 'The observed tab changed during capture. Capture the active tab again.');
      if (buffer.length > 4 * 1024 * 1024) throw new BrowserError('CAPTURE_TOO_LARGE', 'Screenshot exceeds 4 MiB; use a viewport screenshot.');
      return { buffer, mimeType: 'image/jpeg', url: page.url(), tabId, viewport, coordinateSpace: fullPage ? 'document-css' : 'viewport-css' };
    });
  }
  list(): Record<string, unknown>[] { return [...this.sessions.values()].filter(session => !session.closed && !session.page.isClosed()).map(session => ({ session_id: session.id, url: session.page.url(), snapshot_id: session.snapshot?.id ?? null, tab_id: session.activeTabId, tab_count: session.tabs.size, session_mode: session.ownsContext ? 'isolated' : 'attached_profile' })); }
  private cleanup(session: Session): Promise<void> {
    for (const lease of this.bindings) if (lease.sessionId === session.id) lease.invalidate(this.disposed ? 'ENGINE_CLOSED' : 'BINDING_STALE');
    if (!session.cleanup) {
      session.cleanup = (async () => {
        // External Chrome continues a download after its tab closes. Cancel only downloads
        // initiated by our pages before disconnecting, otherwise saveAs may never finish.
        const pending = [...session.downloads.values()].filter(item => item.status === 'pending');
        await Promise.all(pending.map(item => item.download.cancel().catch(() => {})));
        if (this.disposed && session.ownsContext) await this.ownedBrowserClosing;
        if (session.ownsContext) await session.context.close();
        else await Promise.all([...session.tabs.values()].map(page => page.close()));
        await Promise.all([...session.downloads.values()].map(item => item.done));
        await this.releaseRefs(session.snapshot);
      })().catch(error => { this.cleanupFailed = true; throw error; });
      this.resourceCleanup.add(session.cleanup);
      void session.cleanup.then(() => this.resourceCleanup.delete(session.cleanup!), () => this.resourceCleanup.delete(session.cleanup!));
    }
    return session.cleanup;
  }
  close(sessionId: string): Promise<Record<string, unknown>> { return this.exclusive(sessionId, async session => { session.closed = true; this.sessions.delete(sessionId); await this.cleanup(session); return { ok: true, session_id: sessionId, closed: true }; }); }
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      for (const lease of this.bindings) lease.invalidate('ENGINE_CLOSED');
      const sessions = [...new Set([...this.sessions.values(), ...this.openingSessions])];
      for (const session of sessions) session.closed = true;
      this.sessions.clear();
      const browserPromise = this.browserPromise;
      const alreadyClosing = [...this.resourceCleanup];
      if (!this.options.cdpUrl) this.ownedBrowserClosing = (async () => {
        // Let close RPCs started by an earlier cancellation settle briefly.
        // Chrome can stall when context.close and browser.close run together.
        // Acquisition promises never gate this grace; it counts in the 2s cap.
        if (alreadyClosing.length) await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 250);
          void Promise.allSettled(alreadyClosing).then(() => { clearTimeout(timer); resolve(); });
        });
        const browser = await browserPromise?.catch(() => undefined);
        if (browser) await browser.close().catch(() => { this.cleanupFailed = true; });
      })();
      for (const cancel of this.cancelOpening) cancel();
      this.disposalWork = (async () => {
        // Closing our isolated browser first interrupts otherwise pending RPCs.
        // A CDP connection must stay usable until late owned pages are identified
        // and closed; disconnecting first can strand a page in external Chrome.
        await this.ownedBrowserClosing;
        if ((await Promise.allSettled(sessions.map(session => this.cleanup(session)))).some(result => result.status === 'rejected')) this.cleanupFailed = true;
        await Promise.allSettled([...this.opening, ...this.bindingJobs, ...this.resourceCleanup, ...sessions.map(session => session.tail)]);
        const browser = await browserPromise?.catch(() => undefined);
        if (browser && this.options.cdpUrl) await browser.close().catch(() => { this.cleanupFailed = true; });
        if (this.cleanupFailed) throw new BrowserError('CLEANUP_INCOMPLETE', 'Some owned browser resources could not be confirmed closed.');
      })();
      this.disposal = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new BrowserError('CLEANUP_INCOMPLETE', 'Browser cleanup exceeded 2000 ms. Pending cleanup remains tracked; an attached browser connection stays open until late owned pages can be closed.')), 2000);
        void this.disposalWork!.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    }
    return this.disposal;
  }
}
