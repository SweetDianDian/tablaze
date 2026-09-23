import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, realpath, stat, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Download, type ElementHandle, type Frame, type JSHandle, type Page, type Video } from 'playwright';
import { inspectDOM } from './snapshot.js';
import { assembleDOMExtraction, inspectDOMField, validateDOMFieldPlan, type DOMFieldPlan, type DOMFieldObservation, type ExtractionSchema } from './extraction.js';
import { compileNavigationPolicy, NavigationPolicyError, type NavigationPolicy, type CompiledNavigationPolicy } from './navigation-policy.js';
import { startNavigationGuard, type NavigationGuard } from './navigation-guard.js';
import { compileSecretStore, SecretError, type BrowserSecretOptions, type CompiledSecretStore } from './secret-store.js';
import { installSecretBridge, type SecretInputBridge } from './secret-input.js';
import { projectSecretSnapshot, projectSecretExtraction, projectSecretText, redactSecretMetadata } from './secret-projection.js';
import { NetworkJournal, NetworkJournalError } from './network-journal.js';
import { acquireOwnedProfile, type OwnedProfileLease } from './owned-profile.js';
import { executePageScript } from './page-script.js';

export class BrowserError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'BrowserError'; }
}
export type PopupPolicy = 'stay' | 'follow-single';
export interface BrowserBinding { readonly sessionId: string; readonly tabId: string; readonly documentEpoch: number; readonly origin: string }
export interface BrowserBindingGuard { readonly binding: BrowserBinding; readonly contextKey: string; assertCurrent(): Promise<void>; close(): Promise<void> }
export interface BrowserOptions { headless?: boolean; channel?: string; executablePath?: string; cdpUrl?: string; profileDir?: string; expectedProfileId?: string; viewport?: { width: number; height: number }; deviceScaleFactor?: number; permissions?: string[]; proxy?: { server: string; bypass?: string; username?: string; password?: string }; timeoutMs?: number; popupPolicy?: PopupPolicy; navigationPolicy?: NavigationPolicy; secrets?: BrowserSecretOptions; captureNetwork?: boolean; recordVideo?: boolean; allowPageScript?: boolean }
export interface BrowserRecording { session_id: string; tab_id: string; path: string; bytes: number; mime_type: 'video/webm'; sha256: string }
export interface SnapshotOptions { mode?: 'full' | 'diff'; maxElements?: number; textLimit?: number; frameId?: string; selector?: string; viewportOnly?: boolean }
export interface FindTextOptions { text: string; frameId?: string; containerRef?: string; snapshotId?: string; maxScrolls?: number; timeoutMs?: number; signal?: AbortSignal }
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface BrowserWorkspace {
  version: 1;
  popupPolicy?: PopupPolicy;
  /** Bind restoration to the same trusted navigation policy; never infer it from saved URLs. */
  navigationPolicyHash?: string;
  secretPolicyHash?: string;
  sessions: { sessionId: string; activeTabId: string; storage: StorageState; requiresReauthentication?: boolean; tabs: { tabId: string; url: string }[] }[];
}
export type BrowserAction =
  | { type: 'fill_secret'; ref: string; secret: string }
  | { type: 'click'; ref: string } | { type: 'fill'; ref: string; value: string }
  | { type: 'click_named'; name: string; timeoutMs?: number }
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
  closed: boolean; revision: number; nextRef: number; nextFrame: number; activationEpoch: number; scriptEpoch: number;
  frames: Map<Frame, string>; generations: Map<Frame, number>; snapshot?: SnapshotState;
  tabs: Map<string, Page>; activeTabId: string; nextTab: number;
  downloads: Map<string, DownloadRecord>;
  dialogPolicy?: { action: 'accept' | 'dismiss'; promptText?: string };
  dialogs: { type: string; message: string; action: string }[];
  unexpected: string[]; cleanup?: Promise<void>;
  navigationGuard?: NavigationGuard; navigationContextId?: string;
  secretTainted?: boolean;
  network?: NetworkJournal;
  videos: Map<string, Video>; recordings: BrowserRecording[];
}
const errorInfo = (error: unknown, fallback = 'BROWSER_ERROR') => ({ code: error instanceof BrowserError || error instanceof SecretError || error instanceof NetworkJournalError ? error.code : fallback, message: (error instanceof Error ? error.message : String(error)).split('\nCall log:')[0].slice(0, 2000) });
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
  private ownedBrowserLaunch?: Promise<Browser>;
  private profileContext?: BrowserContext;
  private profileLease?: OwnedProfileLease;
  private timeout: number;
  private popupPolicy: PopupPolicy;
  private readonly navigationPolicy?: CompiledNavigationPolicy;
  private navigationGuards = new Map<Browser, NavigationGuard>();
  private readonly secretStore?: CompiledSecretStore;
  private readonly secretBridgeKey = `__tablaze_${randomUUID().replaceAll('-', '')}`;
  private readonly secretOperations = new Set<AbortController>();
  private artifactDirectory?: Promise<string>;
  private readonly completedRecordings: BrowserRecording[] = [];
  constructor(private options: BrowserOptions = {}) {
    this.timeout = integer(options.timeoutMs, 10000, 100, 60000, 'timeoutMs');
    if (options.viewport && (typeof options.viewport !== 'object' || options.viewport === null || Array.isArray(options.viewport) || !Number.isInteger(options.viewport.width) || !Number.isInteger(options.viewport.height) || options.viewport.width < 320 || options.viewport.width > 3840 || options.viewport.height < 240 || options.viewport.height > 2160)) throw new BrowserError('INVALID_ARGUMENT', 'viewport width must be 320–3840 and height 240–2160.');
    if (options.deviceScaleFactor !== undefined && (typeof options.deviceScaleFactor !== 'number' || !Number.isFinite(options.deviceScaleFactor) || options.deviceScaleFactor < 0.5 || options.deviceScaleFactor > 4)) throw new BrowserError('INVALID_ARGUMENT', 'deviceScaleFactor must be a finite number from 0.5 to 4.');
    const allowedPermissions = new Set(['geolocation', 'notifications', 'clipboard-read', 'clipboard-write', 'camera', 'microphone', 'midi', 'midi-sysex', 'background-sync', 'ambient-light-sensor', 'accelerometer', 'gyroscope', 'magnetometer', 'accessibility-events', 'payment-handler']);
    if (options.permissions !== undefined && (!Array.isArray(options.permissions) || options.permissions.length > 15 || options.permissions.some(permission => typeof permission !== 'string' || !allowedPermissions.has(permission)) || new Set(options.permissions).size !== options.permissions.length)) throw new BrowserError('INVALID_ARGUMENT', 'permissions must be a unique list of supported browser permission names.');
    if (options.cdpUrl && (options.viewport || options.deviceScaleFactor !== undefined || options.permissions !== undefined)) throw new BrowserError('BROWSER_CONFIG_CDP_UNSUPPORTED', 'Viewport, device scale and permissions require a browser context owned by this engine.');
    if (options.proxy !== undefined) {
      if (typeof options.proxy !== 'object' || options.proxy === null || Array.isArray(options.proxy) || typeof options.proxy.server !== 'string' || options.proxy.server.length > 2048 || typeof options.proxy.bypass === 'string' && options.proxy.bypass.length > 1024 || options.proxy.bypass !== undefined && typeof options.proxy.bypass !== 'string' || options.proxy.username !== undefined && (typeof options.proxy.username !== 'string' || options.proxy.username.length > 512) || options.proxy.password !== undefined && (typeof options.proxy.password !== 'string' || options.proxy.password.length > 512)) throw new BrowserError('PROXY_CONFIG_INVALID', 'Invalid proxy configuration.');
      let server: URL;
      try { server = new URL(options.proxy.server); } catch { throw new BrowserError('PROXY_CONFIG_INVALID', 'Invalid proxy server URL.'); }
      if (!['http:', 'https:', 'socks5:'].includes(server.protocol) || !server.hostname || server.username || server.password || !['', '/'].includes(server.pathname) || server.search || server.hash) throw new BrowserError('PROXY_CONFIG_INVALID', 'Proxy server must be an HTTP(S) or SOCKS5 URL without embedded credentials or a path.');
      if (options.cdpUrl) throw new BrowserError('PROXY_CDP_UNSUPPORTED', 'An external CDP browser cannot be reconfigured with a proxy.');
    }
    if (options.recordVideo !== undefined && typeof options.recordVideo !== 'boolean') throw new BrowserError('INVALID_ARGUMENT', 'recordVideo must be a boolean.');
    if (options.profileDir !== undefined && (typeof options.profileDir !== 'string' || !isAbsolute(options.profileDir) || options.profileDir === '/')) throw new BrowserError('PROFILE_PATH_INVALID', 'profileDir must be a dedicated absolute directory.');
    if (options.expectedProfileId !== undefined && (typeof options.expectedProfileId !== 'string' || !options.expectedProfileId)) throw new BrowserError('PROFILE_ID_MISMATCH', 'expectedProfileId must be a nonempty profile identifier.');
    if (options.popupPolicy !== undefined && !['stay', 'follow-single'].includes(options.popupPolicy)) throw new BrowserError('INVALID_ARGUMENT', 'popupPolicy must be stay or follow-single.');
    this.popupPolicy = options.popupPolicy ?? 'stay';
    if (options.profileDir && options.cdpUrl) throw new BrowserError('PROFILE_CDP_UNSUPPORTED', 'An owned persistent profile cannot attach to an external CDP browser.');
    if (options.expectedProfileId && !options.profileDir) throw new BrowserError('PROFILE_PATH_INVALID', 'expectedProfileId requires profileDir.');
    try { this.navigationPolicy = compileNavigationPolicy(options.navigationPolicy); }
    catch { throw new BrowserError('NAVIGATION_POLICY_INVALID', 'Invalid navigation policy configuration.'); }
    if (this.navigationPolicy && options.cdpUrl) throw new BrowserError('NAVIGATION_POLICY_CDP_UNSUPPORTED', 'Navigation policy requires an isolated browser owned by this engine.');
    if (this.navigationPolicy && options.profileDir) throw new BrowserError('PROFILE_NAVIGATION_POLICY_UNSUPPORTED', 'A persistent profile may restore documents before the navigation guard starts. Use fresh isolated contexts for a navigation policy.');
    try { this.secretStore = compileSecretStore(options.secrets); }
    catch { throw new BrowserError('SECRET_CONFIG_INVALID', 'Invalid browser secret configuration.'); }
    if (this.secretStore && options.cdpUrl) throw new BrowserError('SECRET_CDP_UNSUPPORTED', 'Browser secrets require an isolated browser owned by this engine.');
    if (options.recordVideo && (options.cdpUrl || options.profileDir)) throw new BrowserError('RECORDING_CONTEXT_UNSUPPORTED', 'Video recording requires isolated browser contexts owned by this engine.');
    if (options.recordVideo && this.secretStore && !this.secretStore.allowSensitiveArtifacts) throw new BrowserError('SECRET_ARTIFACT_BLOCKED', 'Video recording with configured secrets requires allowSensitiveArtifacts in the trusted secret configuration.');
    if (options.allowPageScript && (this.secretStore || options.cdpUrl || this.navigationPolicy)) throw new BrowserError('PAGE_SCRIPT_CONFLICT', 'Page scripts cannot be combined with configured secrets, external CDP, or a navigation policy.');
  }

  private secretText(value: string, limit: number): string { return this.secretStore ? projectSecretText(value, limit, this.secretStore) : value.slice(0, limit); }
  private protectMetadata<T>(value: T): T { return this.secretStore ? redactSecretMetadata(value, this.secretStore) : value; }
  private errorInfo(error: unknown, fallback = 'BROWSER_ERROR') {
    return { ...errorInfo(error, fallback), message: this.secretText((error instanceof Error ? error.message : String(error)).split('\nCall log:')[0], 2000) };
  }
  private assertArtifactAllowed(session: Session): void {
    if (session.secretTainted && !this.secretStore?.allowSensitiveArtifacts) throw new BrowserError('SECRET_ARTIFACT_BLOCKED', 'This session received a secret. Binary and authentication-state exports require trusted operator configuration.');
  }
  private async secretContext(frame: Frame) {
    try {
      const context = await frame.evaluate(key => ((globalThis as any)[key] as SecretInputBridge | undefined)?.context(), this.secretBridgeKey);
      if (!context?.ok || !/^https?:\/\//i.test(frame.url())) throw new BrowserError('SECRET_ORIGIN_UNSUPPORTED', 'Secrets require a supported HTTP(S) document origin.');
      return context;
    } catch (error) { if (error instanceof BrowserError) throw error; throw new BrowserError('SECRET_CONTEXT_CHANGED', 'The secret target document is no longer available.'); }
  }

  private assertNavigationAllowed(url: string, internalBlank = false): void {
    if (internalBlank && url === 'about:blank') return;
    try { this.navigationPolicy?.assertAllowed(url); }
    catch (error) { throw new BrowserError(error instanceof NavigationPolicyError ? error.code : 'NAVIGATION_BLOCKED', 'Navigation is blocked by the configured policy.'); }
  }
  private assertNavigationGuard(guard?: NavigationGuard): void {
    const failure = this.navigationGuardFailure(guard);
    if (failure) throw failure;
  }
  private navigationGuardFailure(guard?: NavigationGuard): BrowserError | undefined {
    try { guard?.assertHealthy(); }
    catch { return new BrowserError('NAVIGATION_POLICY_FAILED', 'The navigation policy could not remain active. The owned browser is being closed.'); }
  }
  private blockedNavigations(session: Session): number { return session.navigationContextId ? session.navigationGuard?.blockedRequests(session.navigationContextId) ?? 0 : 0; }

  private browser(): Promise<Browser> {
    if (this.disposed) return Promise.reject(new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.'));
    if (!this.browserPromise) {
      const launch = this.options.cdpUrl
        ? chromium.connectOverCDP(this.options.cdpUrl, { timeout: 30000 })
        : this.options.profileDir
          ? acquireOwnedProfile(this.options.profileDir, this.options.expectedProfileId).then(async lease => {
            this.profileLease = lease;
            try {
              const context = await chromium.launchPersistentContext(lease.directory, { headless: this.options.headless ?? true, channel: this.options.channel, executablePath: this.options.executablePath, timeout: 30000, viewport: this.options.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: this.options.deviceScaleFactor, permissions: this.options.permissions, proxy: this.options.proxy, acceptDownloads: true });
              this.profileContext = context;
              const browser = context.browser();
              if (!browser) { await context.close(); throw new BrowserError('BROWSER_LAUNCH_FAILED', 'The persistent Chrome context has no browser connection.'); }
              return browser;
            } catch (error) {
              await lease.release();
              if (this.profileLease === lease) this.profileLease = undefined;
              throw error;
            }
          })
        : chromium.launch({ headless: this.options.headless ?? true, channel: this.options.channel, executablePath: this.options.executablePath, timeout: 30000, ...(this.navigationPolicy ? { args: ['--remote-debugging-port=0', '--enable-automation'] } : {}) });
      if (!this.options.cdpUrl) {
        this.ownedBrowserLaunch = launch;
        void launch.then(browser => browser.once('disconnected', () => { if (this.ownedBrowserLaunch === launch) this.ownedBrowserLaunch = undefined; }), () => { if (this.ownedBrowserLaunch === launch) this.ownedBrowserLaunch = undefined; });
      }
      const pending = launch.then(async browser => {
        if (this.navigationPolicy) {
          try { this.navigationGuards.set(browser, await startNavigationGuard(browser, this.navigationPolicy)); }
          catch { await browser.close().catch(() => {}); throw new BrowserError('NAVIGATION_POLICY_FAILED', 'The isolated browser navigation policy could not be initialized.'); }
        }
        browser.once('disconnected', () => {
          if (this.browserPromise === pending) this.browserPromise = undefined;
          if (this.options.profileDir) {
            this.profileContext = undefined;
          }
          const guard = this.navigationGuards.get(browser);
          if (guard) void guard.close().finally(() => this.navigationGuards.delete(browser)).catch(() => { this.cleanupFailed = true; });
        });
        return browser;
      }).catch(error => { if (this.browserPromise === pending) this.browserPromise = undefined; if (error instanceof BrowserError) throw error; throw new BrowserError('BROWSER_LAUNCH_FAILED', this.options.cdpUrl ? 'Could not connect to the configured CDP endpoint. Check reachability and Chrome remote debugging; endpoint details are omitted.' : this.options.profileDir ? 'Could not launch the dedicated Chrome profile. Check the browser executable and profile ownership; directory details are omitted.' : errorInfo(error).message); });
      this.browserPromise = pending;
    }
    return this.browserPromise;
  }
  private session(id: string): Session { const session = this.sessions.get(id); if (!session || session.closed) throw new BrowserError('SESSION_NOT_FOUND', `No open session ${id}.`); return session; }
  private exclusive<T>(id: string, work: (session: Session) => Promise<T>, allowUnhealthy = false): Promise<T> {
    if (this.disposed) return Promise.reject(new BrowserError('ENGINE_CLOSED', 'The browser engine has been disposed.'));
    let session: Session; try { session = this.session(id); } catch (error) { return Promise.reject(error); }
    const result = session.tail.then(async () => {
      if (!allowUnhealthy) this.assertNavigationGuard(session.navigationGuard);
      if (session.closed || session.page.isClosed()) throw new BrowserError('SESSION_CLOSED', 'This session is closed.');
      try {
        return await work(session);
      } catch (error) {
        if (!allowUnhealthy && !this.disposed && !(error instanceof BrowserError && ['CANCELLED', 'BATCH_TIMEOUT', 'ENGINE_CLOSED'].includes(error.code))) this.assertNavigationGuard(session.navigationGuard);
        if (this.secretStore) { const safe = this.errorInfo(error); throw new BrowserError(safe.code, safe.message); }
        throw error;
      }
    });
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
      const generation = session.generations.get(frame) ?? 0, activation = session.activationEpoch, scriptEpoch = session.scriptEpoch;
      const unchanged = () => {
        checkOpen();
        if (session.closed || page.isClosed() || frame.isDetached() || this.sessions.get(sessionId) !== session || session.page !== page || session.activeTabId !== tabId || session.activationEpoch !== activation || session.scriptEpoch !== scriptEpoch || (session.generations.get(frame) ?? 0) !== generation) throw new BrowserError('BINDING_STALE', 'The bound tab or document changed. Acquire a fresh browser binding.');
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
        const contextKey = createHash('sha256').update(JSON.stringify([sessionId, tabId, generation, activation, scriptEpoch, location.href])).digest('hex');
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
    let checked: string; try { checked = validUrl(url); this.assertNavigationAllowed(checked); } catch (error) { return Promise.reject(error); }
    const operation = this.openInternal(checked, options);
    this.opening.add(operation); operation.then(() => this.opening.delete(operation), () => this.opening.delete(operation));
    return operation;
  }
  private async openInternal(url: string, options: { storageState?: string | StorageState; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const ownsContext = !this.options.cdpUrl && !this.options.profileDir;
    let context: BrowserContext | undefined, page: Page | undefined, session: Session | undefined;
    let navigationGuard: NavigationGuard | undefined;
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
      this.assertNavigationAllowed(url, true);
      if (options.storageState && (this.options.cdpUrl || this.options.profileDir)) throw new BrowserError('INVALID_ARGUMENT', 'Storage state import requires a fresh isolated context, not an attached or persistent profile.');
      if (typeof options.storageState === 'string' && (await phase(stat(options.storageState))).size > 10 * 1024 * 1024) throw new BrowserError('STATE_TOO_LARGE', 'Storage state exceeds 10 MiB.');
      const browser = await phase(this.browser());
      navigationGuard = this.navigationGuards.get(browser);
      this.assertNavigationGuard(navigationGuard);
      check();
      context = this.options.profileDir
        ? this.profileContext
        : ownsContext
        ? await phase(browser.newContext({ viewport: this.options.viewport ?? { width: 1280, height: 800 }, deviceScaleFactor: this.options.deviceScaleFactor, permissions: this.options.permissions, proxy: this.options.proxy, acceptDownloads: true, storageState: options.storageState, ...(this.navigationPolicy ? { serviceWorkers: 'block' as const } : {}), ...(this.options.recordVideo ? { recordVideo: { dir: await this.artifacts(), size: this.options.viewport ?? { width: 1280, height: 800 } } } : {}) }), value => { context = value; }, value => value.close())
        : browser.contexts()[0];
      if (!context) throw new BrowserError('CDP_CONTEXT_MISSING', 'The attached browser has no default context.');
      check();
      if (this.secretStore) await phase(context.addInitScript(installSecretBridge, { key: this.secretBridgeKey }));
      page = await phase(context.newPage(), value => { page = value; }, value => value.close());
      check();
      const navigationContextId = navigationGuard ? await phase(navigationGuard.contextIdFor(page)) : undefined;
      session = {
        id: randomUUID(), context, ownsContext, page, tail: Promise.resolve(), closed: false,
        revision: 0, nextRef: 1, nextFrame: 1, activationEpoch: 0, scriptEpoch: 0, frames: new Map([[page.mainFrame(), 'f0']]), generations: new Map(),
        tabs: new Map(), activeTabId: '', nextTab: 1, downloads: new Map(), videos: new Map(), recordings: [], dialogs: [], unexpected: [],
        navigationGuard, navigationContextId,
        ...(this.options.captureNetwork ? { network: new NetworkJournal((text, limit) => this.secretText(text, limit)) } : {}),
      };
      this.openingSessions.add(session);
      session.activeTabId = this.registerPage(session, page);
      await phase(page.goto(url, { waitUntil: 'domcontentloaded' }));
      const openedPage = page;
      if (!openedPage) throw new BrowserError('BROWSER_ERROR', 'The opened page disappeared before initial observation.');
      // Main-document DOMContentLoaded can precede a newly attached iframe's
      // navigation. A short, bounded wait makes its first observation useful
      // without making every page wait for network-idle or third-party frames.
      const pendingFrames = openedPage.frames().filter(frame => frame !== openedPage.mainFrame() && (!frame.url() || frame.url() === 'about:blank')).slice(0, 5);
      if (pendingFrames.length) await phase(Promise.allSettled(pendingFrames.map(frame => frame.waitForURL(target => !!target.toString() && target.toString() !== 'about:blank', { timeout: 800 }).catch(() => {}))));
      const snapshot = await phase(this.snapshotInternal(session, {}));
      check();
      this.assertNavigationGuard(navigationGuard);
      this.sessions.set(session.id, session);
      this.openingSessions.delete(session);
      return { ...snapshot, session_mode: this.options.profileDir ? 'persistent_profile' : ownsContext ? 'isolated' : 'attached_profile', ...(this.profileLease ? { profile_id: this.profileLease.id } : {}) };
    } catch (error) {
      const failure = interruption ?? this.navigationGuardFailure(navigationGuard) ?? (error instanceof BrowserError ? error : session && this.blockedNavigations(session) > 0 ? new BrowserError('NAVIGATION_BLOCKED', 'Navigation was blocked by the configured policy.') : new BrowserError('NAVIGATION_FAILED', errorInfo(error).message));
      // Cancellation returns promptly even when a close RPC is stuck. Disposal
      // tracks that cleanup and reports incomplete cleanup instead of losing it.
      if (interruption) void cleanupAttempt().catch(() => {});
      else await cleanupAttempt();
      throw failure;
    } finally { options.signal?.removeEventListener('abort', onAbort); this.cancelOpening.delete(onDispose); }
  }
  private registerPage(session: Session, page: Page): string {
    const existing = [...session.tabs].find(([, owned]) => owned === page);
    if (existing) return existing[0];
    const id = `t${session.nextTab++}`;
    session.tabs.set(id, page);
    if (this.options.recordVideo) {
      const video = page.video();
      if (video) session.videos.set(id, video);
    }
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
    if (session.network) page.on('response', response => { try { session.network?.record(response, id); } catch { /* A malformed network event must not stop browser interaction. */ } });
    page.on('dialog', dialog => {
      const policy = session.dialogPolicy;
      session.dialogPolicy = undefined;
      session.dialogs.push({ type: dialog.type(), message: this.secretText(dialog.message(), 2000), action: policy?.action ?? 'dismiss' });
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
    const record: DownloadRecord = { id, filename: this.secretText(basename(download.suggestedFilename()), 200), url: this.secretText(download.url(), 4000), status: 'pending', download, done: Promise.resolve() };
    session.downloads.set(id, record);
    record.done = (async () => {
      let destination: string | undefined;
      try {
        this.assertArtifactAllowed(session);
        destination = join(await this.artifacts(), `${id}.download`);
        this.assertArtifactAllowed(session);
        await download.saveAs(destination);
        this.assertArtifactAllowed(session);
        await chmod(destination, 0o600);
        record.path = destination;
        record.bytes = (await stat(destination)).size;
        record.status = 'completed';
      } catch { await download.cancel().catch(() => {}); if (destination) await rm(destination, { force: true }).catch(() => {}); record.status = 'failed'; record.error = 'The download failed, was blocked by secret artifact policy, or its session closed before completion.'; }
    })();
  }
  private tabList(session: Session) {
    return [...session.tabs].filter(([, page]) => !page.isClosed()).map(([id, page]) => ({ tab_id: id, url: this.secretText(page.url(), 4000), active: page === session.page }));
  }
  network(sessionId: string, options: { afterId?: number; maxItems?: number; responseId?: number } = {}): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (!session.network) throw new BrowserError('NETWORK_CAPTURE_DISABLED', 'Start the server with network capture enabled to inspect owned tab responses.');
      if (options.responseId !== undefined) {
        this.assertArtifactAllowed(session);
        return { ok: true, session_id: session.id, response: await session.network.body(options.responseId) };
      }
      return { ok: true, session_id: session.id, ...session.network.list(options.afterId, integer(options.maxItems, 50, 1, 100, 'maxItems')) };
    });
  }
  tabs(sessionId: string, options: { action: 'list' | 'new' | 'switch' | 'close'; tabId?: string; url?: string }): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (options.action === 'list') return { ok: true, session_id: session.id, tabs: this.tabList(session) };
      if (options.action === 'new') {
        const url = options.url ? validUrl(options.url) : 'about:blank';
        this.assertNavigationAllowed(url, true);
        const page = await session.context.newPage();
        if (this.disposed || session.closed) {
          await page.close().catch(() => {});
          throw new BrowserError('SESSION_CLOSED', 'The session closed while creating this tab.');
        }
        const id = this.registerPage(session, page);
        const blockedBefore = this.blockedNavigations(session);
        try { if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' }); }
        catch (error) { await page.close().catch(() => {}); throw this.blockedNavigations(session) > blockedBefore ? new BrowserError('NAVIGATION_BLOCKED', 'Navigation was blocked by the configured policy.') : new BrowserError('NAVIGATION_FAILED', errorInfo(error).message); }
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
      const blockedBefore = this.blockedNavigations(session);
      try {
        if (options.action === 'goto') { const url = validUrl(options.url ?? ''); this.assertNavigationAllowed(url); await session.page.goto(url, wait); }
        else if (options.action === 'back') await session.page.goBack(wait);
        else if (options.action === 'forward') await session.page.goForward(wait);
        else if (options.action === 'reload') await session.page.reload(wait);
        else throw new BrowserError('INVALID_ARGUMENT', 'Unsupported navigation operation.');
      } catch (error) { if (this.blockedNavigations(session) > blockedBefore) throw new BrowserError('NAVIGATION_BLOCKED', 'Navigation was blocked by the configured policy.'); throw error; }
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
      this.assertArtifactAllowed(session);
      if (downloadId) {
        const item = session.downloads.get(downloadId);
        if (!item) throw new BrowserError('DOWNLOAD_NOT_FOUND', 'No owned download with that ID.');
        const timeout = integer(timeoutMs, this.timeout, 100, 60000, 'timeoutMs');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([item.done, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
      const records = [...session.downloads.values()].filter(item => !downloadId || item.id === downloadId).map(({ done, download, ...item }) => item);
      return { ok: records.every(item => item.status !== 'failed'), session_id: session.id, downloads: this.protectMetadata(records) };
    });
  }
  saveState(sessionId: string): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      this.assertArtifactAllowed(session);
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
        if (session.secretTainted && !this.secretStore?.allowSensitiveArtifacts) return {
          sessionId: id, activeTabId: session.activeTabId, storage: { cookies: [], origins: [] }, requiresReauthentication: true,
          tabs: [...session.tabs].filter(([, page]) => !page.isClosed()).map(([tabId]) => ({ tabId, url: 'about:blank' })),
        };
        const storage = await session.context.storageState({ indexedDB: true });
        if (session.closed || session.page.isClosed() || !session.tabs.has(session.activeTabId)) throw new BrowserError('SESSION_CLOSED', 'The session closed during state export.');
        return { sessionId: id, activeTabId: session.activeTabId, storage,
          tabs: [...session.tabs].filter(([, page]) => !page.isClosed()).map(([tabId, page]) => ({ tabId, url: page.url() })),
        };
      });
      sessions.push(state);
    }
    return { version: 1, popupPolicy: this.popupPolicy, ...(this.navigationPolicy ? { navigationPolicyHash: this.navigationPolicy.hash } : {}), ...(this.secretStore ? { secretPolicyHash: this.secretStore.hash } : {}), sessions };
  }
  async restoreWorkspace(input: unknown): Promise<{ sessionMap: Record<string, string>; snapshots: Record<string, unknown>[] }> {
    if (this.options.cdpUrl || this.options.profileDir) throw new BrowserError('INVALID_ARGUMENT', 'Workspace restoration requires fresh isolated contexts.');
    if (this.disposed || this.sessions.size || this.opening.size) throw new BrowserError('INVALID_ARGUMENT', 'Restore into a new, empty browser engine.');
    const workspace = input as BrowserWorkspace;
    if (!workspace || workspace.version !== 1 || !Array.isArray(workspace.sessions) || workspace.sessions.length > 20 || Buffer.byteLength(JSON.stringify(workspace)) > 10 * 1024 * 1024) throw new BrowserError('INVALID_ARGUMENT', 'Invalid or oversized browser workspace.');
    if (workspace.navigationPolicyHash !== this.navigationPolicy?.hash) throw new BrowserError('NAVIGATION_POLICY_MISMATCH', 'Restore requires the same navigation policy as the saved workspace.');
    if (workspace.secretPolicyHash !== this.secretStore?.hash) throw new BrowserError('SECRET_POLICY_MISMATCH', 'Restore requires the same secret context, versions and policy as the saved workspace.');
    if (this.secretStore) await this.secretStore.assertContext(AbortSignal.timeout(this.timeout));
    if (workspace.popupPolicy !== undefined && !['stay', 'follow-single'].includes(workspace.popupPolicy)) throw new BrowserError('INVALID_ARGUMENT', 'Invalid workspace popup policy.');
    const ids = new Set<string>();
    for (const saved of workspace.sessions) {
      if (!saved || typeof saved.sessionId !== 'string' || !saved.sessionId || ids.has(saved.sessionId) || !Array.isArray(saved.tabs) || !saved.tabs.length || saved.tabs.length > 50 || !saved.storage || !Array.isArray(saved.storage.cookies) || !Array.isArray(saved.storage.origins)) throw new BrowserError('INVALID_ARGUMENT', 'Invalid workspace session.');
      ids.add(saved.sessionId);
      if (saved.requiresReauthentication !== undefined && typeof saved.requiresReauthentication !== 'boolean' || saved.requiresReauthentication && (saved.storage.cookies.length || saved.storage.origins.length || saved.tabs.some(tab => tab.url !== 'about:blank'))) throw new BrowserError('INVALID_ARGUMENT', 'Reauthentication checkpoints must omit storage and document URLs.');
      const tabs = new Set<string>();
      for (const tab of saved.tabs) {
        if (!tab || typeof tab.tabId !== 'string' || !tab.tabId || tabs.has(tab.tabId) || typeof tab.url !== 'string' || tab.url.length > 8192) throw new BrowserError('INVALID_ARGUMENT', 'Invalid workspace tab.');
        tabs.add(tab.tabId);
        if (tab.url !== 'about:blank') validUrl(tab.url);
        this.assertNavigationAllowed(tab.url, true);
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
        const snapshot = await this.tabs(id, { action: 'switch', tabId: tabMap.get(saved.activeTabId) });
        if (saved.requiresReauthentication) snapshot.requires_reauthentication = true;
        snapshots.push(snapshot);
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
      this.assertArtifactAllowed(session);
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
      return { ok: true, session_id: session.id, tab_id: tabId, url: this.secretText(url, 4000), path, bytes: buffer.length, mime_type: 'application/pdf', sha256: createHash('sha256').update(buffer).digest('hex') };
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
  /** Opt-in page-origin JavaScript. It has the page's authority, so all execution is treated as a write. */
  script(sessionId: string, snapshotId: string, source: string, input?: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      if (!this.options.allowPageScript) throw new BrowserError('PAGE_SCRIPT_DISABLED', 'Page scripts require an explicit operator opt-in.');
      if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > 16 * 1024) throw new BrowserError('INVALID_ARGUMENT', 'source must be nonempty and at most 16 KiB.');
      const timeoutMs = integer(options.timeoutMs, this.timeout, 100, 60_000, 'timeoutMs');
      let serialized: string;
      try { serialized = JSON.stringify(input === undefined ? null : input); }
      catch { throw new BrowserError('INVALID_ARGUMENT', 'input must be a JSON value.'); }
      if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 32 * 1024) throw new BrowserError('INVALID_ARGUMENT', 'input must be JSON of at most 32 KiB.');
      const state = session.snapshot;
      const page = session.page;
      if (!state || state.id !== snapshotId || !state.actionable || state.frame !== page.mainFrame() || state.frame.isDetached() || state.generation !== (session.generations.get(state.frame) ?? 0)) throw new BrowserError('STALE_SNAPSHOT', 'Supply a current main-frame snapshot_id before running a page script.');
      if (options.signal?.aborted) throw new BrowserError('CANCELLED', 'Page script was cancelled before execution.');
      // A script can mutate any DOM node, navigate, or open a popup. Old refs and
      // trusted application bindings must never survive its first instruction.
      session.scriptEpoch++;
      for (const lease of this.bindings) if (lease.sessionId === session.id) lease.invalidate('BINDING_STALE');
      session.snapshot = undefined;
      await this.releaseRefs(state);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectInterrupted: (error: BrowserError) => void = () => {};
      const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
      void interrupted.catch(() => {});
      const onAbort = () => rejectInterrupted(new BrowserError('CANCELLED', 'Page script was cancelled after execution may have started.'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timed = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrowserError('SCRIPT_TIMEOUT', 'Page script exceeded its time budget.')), timeoutMs); });
      const pending = executePageScript(page, source, JSON.parse(serialized));
      void pending.catch(() => {});
      let outcome: Awaited<typeof pending>;
      try { outcome = await Promise.race([pending, interrupted, timed]); }
      catch (error) {
        session.closed = true;
        this.sessions.delete(session.id);
        void this.cleanup(session).catch(() => {});
        const code = error instanceof BrowserError ? error.code : 'SCRIPT_INTERRUPTED';
        return { ok: false, session_id: session.id, outcome_unknown: true, session_closed: true, error: { code, message: 'Page script may have changed the browser or server state. The session was closed; inspect the external outcome before retrying.' } };
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
      let snapshot: Record<string, unknown>;
      try { snapshot = await this.snapshotInternal(session, {}); }
      catch {
        session.closed = true;
        this.sessions.delete(session.id);
        void this.cleanup(session).catch(() => {});
        return { ok: false, session_id: session.id, outcome_unknown: outcome.kind !== 'syntax', session_closed: true, error: { code: 'SCRIPT_OBSERVATION_FAILED', message: 'The page could not be observed after the script; the session was closed.' } };
      }
      if (outcome.kind === 'ok') {
        if (Buffer.byteLength(outcome.json, 'utf8') > 64 * 1024) return { ok: false, session_id: session.id, outcome_unknown: true, snapshot, error: { code: 'SCRIPT_OUTPUT_TOO_LARGE', message: 'Page script output exceeded 64 KiB.' } };
        return { ok: true, session_id: session.id, result: JSON.parse(outcome.json), result_bytes: outcome.bytes, snapshot };
      }
      const errors = {
        syntax: ['SCRIPT_SYNTAX', 'Page script could not be compiled.'],
        runtime: ['SCRIPT_RUNTIME', 'Page script threw after execution began; inspect the page before retrying.'],
        output_too_large: ['SCRIPT_OUTPUT_TOO_LARGE', 'Page script output exceeded 64 KiB; page effects may have occurred.'],
        output_unsupported: ['SCRIPT_OUTPUT_UNSUPPORTED', 'Page script output was not serializable JSON; page effects may have occurred.'],
      } as const;
      const [code, message] = errors[outcome.kind];
      return { ok: false, session_id: session.id, outcome_unknown: outcome.kind !== 'syntax', snapshot, error: { code, message } };
    });
  }
  /** Bounded, read-and-scroll search. Every returned ref comes from a fresh snapshot. */
  findText(sessionId: string, options: FindTextOptions): Promise<Record<string, unknown>> {
    return this.exclusive(sessionId, async session => {
      const text = options.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new BrowserError('INVALID_ARGUMENT', 'Find text must contain 1–200 characters.');
      const maxScrolls = integer(options.maxScrolls, 40, 0, 100, 'maxScrolls');
      const budget = integer(options.timeoutMs, 30000, 100, 60000, 'find timeoutMs');
      const deadline = performance.now() + budget;
      this.frameList(session);
      const frameId = options.frameId ?? 'f0';
      const frame = [...session.frames].find(([item, id]) => id === frameId && !item.isDetached())?.[0];
      if (!frame) throw new BrowserError('FRAME_NOT_FOUND', 'Find requires a live frame from the current frames list.');
      const page = session.page, generation = session.generations.get(frame) ?? 0;
      let container: ElementHandle<Element> | undefined;
      if (options.containerRef !== undefined) {
        const current = session.snapshot;
        if (!options.snapshotId || !current || current.id !== options.snapshotId || current.frame !== frame) throw new BrowserError('STALE_SNAPSHOT', 'A scroll container requires the current snapshot_id and frame.');
        container = await this.reference(session, current, options.containerRef);
        const scrollable = await container.evaluate(node => {
          const style = getComputedStyle(node);
          return /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
        });
        if (!scrollable) throw new BrowserError('INVALID_ARGUMENT', 'The observed container is not vertically scrollable.');
      }
      const check = () => {
        if (options.signal?.aborted) throw new BrowserError('CANCELLED', 'Text finding was cancelled.');
        if (performance.now() >= deadline) throw new BrowserError('FIND_TIMEOUT', 'Text finding exceeded its time budget. The page may have been scrolled.');
        if (session.closed || page.isClosed() || session.page !== page || frame.isDetached() || generation !== (session.generations.get(frame) ?? 0)) throw new BrowserError('FIND_CONTEXT_CHANGED', 'The page or frame changed during text finding. Observe again.');
      };
      let scrolls = 0, reachedEnd = false, found = false;
      for (;;) {
        check();
        const matches = frame.getByText(text, { exact: false });
        const count = Math.min(await matches.count(), 100);
        for (let index = 0; index < count; index++) {
          check();
          const target = await matches.nth(index).elementHandle();
          if (!target) continue;
          try {
            if (!await target.isVisible()) continue;
            if (container && !await target.evaluate((node, root) => {
              for (let current: Node | null = node; current; current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null)) if (current === root) return true;
              return false;
            }, container)) continue;
            if (container) {
              // A virtual list may render rows just outside its clipped viewport.
              // Calling scrollIntoViewIfNeeded here can synchronously return before
              // its scroll handler replaces the row, producing an immediately stale ref.
              const inViewport = await target.evaluate((node, root) => {
                const item = node.getBoundingClientRect(), list = root.getBoundingClientRect();
                return item.width > 0 && item.height > 0 && item.top >= list.top + 4 && item.bottom <= list.bottom - 4
                  && (item.left + item.right) / 2 > list.left && (item.left + item.right) / 2 < list.right
                  && item.top >= 0 && item.bottom <= innerHeight && item.left >= 0 && item.right <= innerWidth;
              }, container);
              if (!inViewport) continue;
            } else {
              await target.scrollIntoViewIfNeeded({ timeout: Math.max(100, Math.min(this.timeout, deadline - performance.now())) });
              await new Promise(resolve => setTimeout(resolve, 80));
            }
            check();
            if (await target.isVisible()) { found = true; break; }
          } finally { await target.dispose(); }
        }
        if (found || scrolls >= maxScrolls) break;
        const position = container ? await container.evaluate(node => {
          const before = node.scrollTop, maximum = node.scrollHeight - node.clientHeight;
          node.scrollTop = Math.min(maximum, before + Math.max(1, Math.floor(node.clientHeight * 0.6)));
          return { before, after: node.scrollTop, maximum };
        }) : await frame.evaluate(() => {
          const node = document.scrollingElement;
          if (!node) return { before: 0, after: 0, maximum: 0 };
          const before = node.scrollTop, maximum = node.scrollHeight - node.clientHeight;
          node.scrollTop = Math.min(maximum, before + Math.max(1, Math.floor(innerHeight * 0.8)));
          return { before, after: node.scrollTop, maximum };
        });
        check();
        if (position.after <= position.before && position.after >= position.maximum) { reachedEnd = true; break; }
        scrolls++;
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      check();
      const snapshot = await this.snapshotInternal(session, { frameId, viewportOnly: true, maxElements: 500 });
      return { ok: true, found, scrolls, reached_end: !found && reachedEnd, limit_reached: !found && !reachedEnd && scrolls >= maxScrolls, session_id: session.id, frame_id: frameId, snapshot };
    });
  }
  private frameList(session: Session) { return session.page.frames().map(frame => { if (!session.frames.has(frame)) session.frames.set(frame, `f${session.nextFrame++}`); return { frame_id: session.frames.get(frame)!, url: frame.url(), name: frame.name(), is_main: frame === session.page.mainFrame() }; }); }
  private async releaseRefs(state?: SnapshotState) { if (state) await Promise.all([...state.refs.values()].map(ref => ref.handle.dispose().catch(() => {}))); }
  private async snapshotInternal(session: Session, options: SnapshotOptions): Promise<Record<string, unknown>> {
    const start = performance.now();
    const maxElements = integer(options.maxElements, 150, 1, 500, 'maxElements');
    const textLimit = integer(options.textLimit, 6000, 0, 20000, 'textLimit');
    if (options.mode !== undefined && !['full', 'diff'].includes(options.mode)) throw new BrowserError('INVALID_ARGUMENT', 'Snapshot mode must be full or diff.');
    const allFrames = this.frameList(session);
    const frames = allFrames.slice(0, 100).map(frame => ({ ...frame, url: this.secretText(frame.url, 4000), name: this.secretText(frame.name, 200) }));
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
    const result = await frame.evaluateHandle(inspectDOM, { op: 'snapshot', root, viewportOnly: scope.viewportOnly, maxElements, textLimit, outputPadding: this.secretStore?.padding, nextRef: session.nextRef, previous: old }).finally(() => root?.dispose());
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
    const output: Record<string, unknown> = { ok: true, session_id: session.id, snapshot_id: id, tab_id: session.activeTabId, tabs: this.tabList(session), scope: { selector: scope.selector ?? null, viewport_only: scope.viewportOnly }, mode: options.mode ?? 'full', frame_id: frameId, url: this.secretText(session.page.url(), 4000), title: this.secretText(title, 1000), frames, frame_count: allFrames.length, elements: entries, text: data.text, truncated: data.truncated || metadataTruncated, truncation: { ...data.truncation, metadata: metadataTruncated }, budgets: { max_elements: maxElements, text_limit: textLimit, max_frames: 100 }, elapsed_ms: Math.round(performance.now() - start) };
    this.assertNavigationGuard(session.navigationGuard);
    if (session.navigationGuard) output.navigation_policy = { enabled: true, blocked_requests: this.blockedNavigations(session) };
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
    if (this.secretStore) {
      output.available_secrets = [];
      // about:blank and opaque frames remain usable, but cannot receive secrets.
      try {
        const target = await this.secretContext(frame), top = await this.secretContext(session.page.mainFrame());
        await this.secretStore.assertContext(AbortSignal.timeout(this.timeout));
        output.available_secrets = this.secretStore.aliases(target.origin, top.origin);
      } catch (error) { output.secret_input_error = this.errorInfo(error); }
      return projectSecretSnapshot(output, textLimit, this.secretStore);
    }
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
      const blockedBefore = this.blockedNavigations(session);
      state.actionable = false;
      const deadline = start + budget;
      const secretController = new AbortController();
      this.secretOperations.add(secretController);
      let interruption: BrowserError | undefined;
      let interruptedCleanup: Promise<void> | undefined;
      const interrupt = (code: string, message: string) => {
        if (interruption) return;
        interruption = new BrowserError(code, message);
        secretController.abort();
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
        if (options.signal?.aborted) onAbort();
        if (performance.now() >= deadline) interrupt('BATCH_TIMEOUT', 'The action batch exceeded its total time budget. This session was closed; completed actions were not rolled back.');
        if (interruption) throw interruption;
        this.assertNavigationGuard(session.navigationGuard);
        if (session.closed) { interrupt('SESSION_CLOSED', 'The browser tab closed while the batch was running.'); throw interruption; }
        if (this.blockedNavigations(session) > blockedBefore) throw new BrowserError('NAVIGATION_BLOCKED', 'A document request was blocked by the configured navigation policy. Re-observe before continuing.');
        if (observedPage.isClosed() || session.page !== observedPage) throw new BrowserError('STALE_REFERENCE', 'The observed tab closed or changed. Observe the active tab before further input.');
      };
      const remaining = (limit: number) => { checkInterruption(); return Math.max(1, Math.min(limit, deadline - performance.now())); };
      const results: Record<string, unknown>[] = [];
      let failed: Record<string, unknown> | null = null;
      let completed = 0;
      let failedActionMayHaveSideEffects = false;
      let outcomeUnknown = false;
      let popupFollowed: { from_tab_id: string; tab_id: string; action_index: number; window_ms: number } | undefined;
      let activatedInBatch = false;
      const popupWindowMs = 250;
      try {
      for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        if (failed || popupFollowed) { results.push({ index, type: action.type, status: 'skipped', ...(popupFollowed ? { reason: 'replan_required' } : {}) }); continue; }
        let actionStarted = false;
        let popupWindow: { until: number; candidates: Set<Page>; listener: (popup: Page) => void } | undefined;
        const armPopupWindow = () => {
          if (this.popupPolicy !== 'follow-single' || !['click', 'click_named', 'double_click', 'press', 'click_xy', 'upload_chooser'].includes(action.type)) return;
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
          if (action.type === 'click_named') {
            if (!activatedInBatch) throw new BrowserError('INVALID_ARGUMENT', 'click_named requires an earlier completed activating action in this batch. Observe existing targets and use their refs.');
            if (!action.name?.trim() || action.name.length > 200) throw new BrowserError('INVALID_ARGUMENT', 'Supply an exact nonempty accessible name of at most 200 characters.');
            const waitUntil = performance.now() + integer(action.timeoutMs, 5000, 100, 60000, 'click_named timeoutMs');
            const named = state.frame.getByRole('button', { name: action.name, exact: true })
              .or(state.frame.getByRole('menuitem', { name: action.name, exact: true })).filter({ visible: true });
            let target: ElementHandle<Element> | null = null;
            while (!target) {
              checkInterruption();
              if (state.frame.isDetached() || state.generation !== (session.generations.get(state.frame) ?? 0)) throw new BrowserError('STALE_REFERENCE', 'The observed document changed while waiting for the named target.');
              const count = await named.count();
              if (count > 1) throw new BrowserError('AMBIGUOUS_TARGET', 'More than one visible target has that role and exact accessible name. Observe the page and use a ref.');
              if (count === 1) target = await named.elementHandle({ timeout: remaining(Math.max(1, waitUntil - performance.now())) });
              else if (performance.now() >= waitUntil) throw new BrowserError('TARGET_NOT_FOUND', 'The named target did not become visible before the wait limit. Observe the page before further input.');
              else await new Promise(resolve => setTimeout(resolve, Math.min(75, waitUntil - performance.now())));
            }
            try {
              const actionDeadline = performance.now() + this.timeout;
              actionStarted = true; // Trial may scroll; a later RPC failure has uncertain effects.
              await target.click({ trial: true, timeout: remaining(Math.max(1, actionDeadline - performance.now())) });
              checkInterruption();
              if (state.frame.isDetached() || state.generation !== (session.generations.get(state.frame) ?? 0)) throw new BrowserError('STALE_REFERENCE', 'The observed document changed before input.');
              if (await named.count() !== 1) throw new BrowserError('AMBIGUOUS_TARGET', 'The named target changed before input. Observe the page and use a ref.');
              const current = await named.elementHandle({ timeout: remaining(Math.max(1, actionDeadline - performance.now())) });
              try { if (!current || !await current.evaluate((node, expected) => node === expected, target)) throw new BrowserError('STALE_REFERENCE', 'The named target was replaced before input. Observe the page and use a ref.'); }
              finally { await current?.dispose(); }
              checkInterruption();
              popupWindow = armPopupWindow();
              await target.click({ timeout: remaining(Math.max(1, actionDeadline - performance.now())) });
            } finally { await target.dispose(); }
          }
          else if (action.type === 'click_xy') {
            if (state.frame !== observedPage.mainFrame()) throw new BrowserError('INVALID_ARGUMENT', 'Coordinate clicks use the main tab viewport; observe the main frame first.');
            const viewport = await observedPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
            if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.y < 0 || action.x >= viewport.width || action.y >= viewport.height) throw new BrowserError('INVALID_ARGUMENT', 'Coordinates must be inside the current viewport in CSS pixels.');
            checkInterruption();
            actionStarted = true;
            popupWindow = armPopupWindow();
            await observedPage.mouse.click(action.x, action.y);
          }
          else if (action.type === 'fill_secret') {
            if (!this.secretStore) throw new BrowserError('SECRET_NOT_CONFIGURED', 'Secret input requires trusted operator configuration.');
            const target = await this.reference(session, state, action.ref);
            const topFrame = observedPage.mainFrame();
            const top = await this.secretContext(topFrame);
            const probe = await target.evaluate((node, key) => ((globalThis as any)[key] as SecretInputBridge | undefined)?.probe(node), this.secretBridgeKey);
            if (!probe?.ok) throw new BrowserError(probe?.code ?? 'SECRET_TARGET_INVALID', 'The observed secret target is not a writable control in a supported document.');
            const targetContext = await this.secretContext(state.frame);
            if (targetContext.documentId !== probe.documentId || targetContext.origin !== probe.origin) throw new BrowserError('SECRET_CONTEXT_CHANGED', 'The secret target document changed.');
            const value = await this.secretStore.resolve(action.secret, probe.origin, top.origin, secretController.signal);
            checkInterruption();
            await this.reference(session, state, action.ref);
            const currentTop = await this.secretContext(topFrame);
            if (currentTop.documentId !== top.documentId || currentTop.origin !== top.origin) throw new BrowserError('SECRET_CONTEXT_CHANGED', 'The top document changed while resolving the secret.');
            await this.secretStore.assertContext(secretController.signal);
            checkInterruption();
            await this.reference(session, state, action.ref);
            // No focus, keyboard events, or selector re-resolution with plaintext.
            // An RPC failure after dispatch cannot prove that the setter did not run.
            session.secretTainted = true;
            actionStarted = true;
            let filled: Awaited<ReturnType<SecretInputBridge['fill']>> | undefined;
            try { filled = await target.evaluate((node, input) => ((globalThis as any)[input.key] as SecretInputBridge | undefined)?.fill(node, input), { key: this.secretBridgeKey, documentId: probe.documentId, origin: probe.origin, value }); }
            catch { throw new BrowserError('SECRET_INPUT_FAILED', 'Secret input returned no reliable outcome. Inspect actual effects before retrying.'); }
            if (!filled?.ok) {
              if (filled && filled.wrote === false) actionStarted = false;
              throw new BrowserError(filled?.code ?? 'SECRET_INPUT_FAILED', 'Secret input could not be confirmed. Observe the page and reconcile any possible effects.');
            }
          }
          else if (action.type === 'scroll') {
            const pixels = integer(action.pixels, 600, 1, 10000, 'pixels');
            if (!['up', 'down', 'left', 'right'].includes(action.direction)) throw new BrowserError('INVALID_ARGUMENT', 'Invalid scroll direction.');
            const delta = { x: action.direction === 'left' ? -pixels : action.direction === 'right' ? pixels : 0, y: action.direction === 'up' ? -pixels : action.direction === 'down' ? pixels : 0 };
            if (action.ref) {
              const ref = action.ref;
              const target = await this.reference(session, state, ref);
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
          if (['click', 'click_named', 'double_click', 'press', 'hover', 'click_xy', 'upload_chooser'].includes(action.type)) activatedInBatch = true;
        } catch (error) { if (!interruption && performance.now() >= deadline) interrupt('BATCH_TIMEOUT', 'The action batch exceeded its total time budget. This session was closed; completed actions were not rolled back.'); const policyError = this.blockedNavigations(session) > blockedBefore ? new BrowserError('NAVIGATION_BLOCKED', 'A document request was blocked by the configured navigation policy.') : undefined; const info = this.errorInfo(interruption ?? this.navigationGuardFailure(session.navigationGuard) ?? policyError ?? error, 'ACTION_FAILED'); if (action.type === 'fill' && action.value) info.message = info.message.split(action.value).join('[redacted]'); failedActionMayHaveSideEffects = actionStarted; outcomeUnknown = action.type === 'fill_secret' && actionStarted; failed = { index, action: action.type, error: info }; results.push({ index, type: action.type, status: 'failed', error: info }); }
        finally { if (popupWindow) observedPage.off('popup', popupWindow.listener); }
      }
      const output: Record<string, unknown> = { ok: !failed && !interruption, batch_complete: !failed && !interruption && completed === actions.length, session_id: session.id, snapshot_id: snapshotId, partial: !!(failed || interruption) && (completed > 0 || failedActionMayHaveSideEffects) || !!popupFollowed && completed < actions.length, completed, failed, failed_action_may_have_side_effects: failedActionMayHaveSideEffects, results, ...(popupFollowed ? { replan_required: true, popup_followed: popupFollowed } : {}), elapsed_ms: Math.round(performance.now() - start) };
      if (outcomeUnknown) output.outcome_unknown = true;
      if (session.dialogs.length) output.dialogs = this.protectMetadata(session.dialogs.splice(0));
      if ((options.snapshot !== false || popupFollowed) && !interruption) { try { output.snapshot = await this.snapshotInternal(session, popupFollowed ? {} : { ...(state.generation === (session.generations.get(state.frame) ?? 0) ? state.scope : {}), frameId: state.frame.isDetached() ? 'f0' : session.frames.get(state.frame) }); } catch (error) { output.snapshot_error = this.errorInfo(interruption ?? error, 'SNAPSHOT_FAILED'); } }
      if (interruption) { output.ok = false; output.batch_complete = false; output.session_closed = true; output.error = errorInfo(interruption); output.partial = completed > 0 || failedActionMayHaveSideEffects; }
      output.elapsed_ms = Math.round(performance.now() - start);
      return output;
      } finally { clearTimeout(timer); secretController.abort(); this.secretOperations.delete(secretController); options.signal?.removeEventListener('abort', onAbort); if (interruptedCleanup) await interruptedCleanup; }
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
      const result = await frame.evaluate(inspectDOM, { op: 'extract', root, kind: options.kind, maxItems, outputPadding: this.secretStore?.padding }).finally(() => root.dispose());
      return { ok: true, session_id: session.id, kind: options.kind, limits: { max_items: maxItems, max_characters: 20000 }, ...(this.secretStore ? projectSecretExtraction(result, options.kind, this.secretStore) : result) };
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
      const extracted = assembleDOMExtraction({ schema: options.schema, fields, observations });
      // A schema-valid fact containing a credential cannot be silently changed
      // into a different fact by redaction. Ask for a narrower, safe selector.
      if (this.secretStore?.contains(JSON.stringify({ url: frame.url(), ...extracted }))) throw new BrowserError('SECRET_EVIDENCE_BLOCKED', 'Structured extraction includes a configured secret. Narrow the fields or selector.');
      return { ok: true, session_id: session.id, tab_id: session.activeTabId, url: frame.url(), ...extracted };
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
      const readValue = (element: Element, input: { expected: string; outputLimit: number }) => {
        if (element instanceof HTMLInputElement && ['password', 'hidden'].includes(element.type)) return { sensitive: true };
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return { unsupported: true };
        const value = element.value;
        return { value: value.slice(0, input.outputLimit), pass: value === input.expected };
      };
      const results = await Promise.all(checks.map(async (check, index) => {
        const deadline = start + timeout; let actual: unknown; let pass = false; let error: ReturnType<typeof errorInfo> | undefined;
        do {
          if (session.closed || session.page.isClosed() || this.disposed) { error = { code: 'SESSION_CLOSED', message: 'The session closed before the check passed.' }; break; }
          try {
            switch (check.kind) {
              case 'url': actual = session.page.url(); pass = actual === check.value; break;
              case 'title': actual = await session.page.title(); pass = (actual as string).includes(check.contains); break;
              case 'text': { const observed = await frame.evaluate(inspectDOM, { op: 'text', contains: check.contains, textLimit: 2000, outputPadding: this.secretStore?.padding }); actual = this.secretText(observed.text, 2000); pass = observed.matches; if (observed.scan_truncated && !pass) throw new BrowserError('OBSERVATION_TRUNCATED', 'The DOM scan budget was exhausted before this text was found. Narrow the task or inspect a specific region.'); break; }
              case 'visible': actual = await frame.locator(check.selector).isVisible(); pass = actual === true; break;
              case 'value': {
                actual = undefined;
                const observed = check.ref !== undefined
                  ? await (await guardedReference(check.ref)).evaluate(readValue, { expected: check.value, outputLimit: 2000 + (this.secretStore?.padding ?? 0) })
                  : await frame.locator(check.selector!).evaluate(readValue, { expected: check.value, outputLimit: 2000 + (this.secretStore?.padding ?? 0) }, { timeout: Math.max(1, deadline - performance.now()) });
                if (observed.sensitive) throw new BrowserError('SENSITIVE_VALUE', 'Password and hidden field values are not returned or verified.');
                if (observed.unsupported) throw new BrowserError('NOT_FORM_CONTROL', 'Value checks require an input, textarea, or select.');
                if (check.ref !== undefined) await guardedReference(check.ref);
                actual = typeof observed.value === 'string' ? this.secretText(observed.value, 2000) : undefined; pass = observed.pass === true; break;
              }
              case 'count': actual = await frame.locator(check.selector).count(); pass = actual === check.value; break;
              default: throw new BrowserError('INVALID_ARGUMENT', 'Unsupported check kind.');
            }
            error = undefined;
          } catch (caught) { error = this.errorInfo(caught, 'CHECK_FAILED'); if (caught instanceof BrowserError || session.closed || session.page.isClosed() || this.disposed) break; }
          if (!pass && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(75, deadline - performance.now())));
        } while (!pass && performance.now() < deadline);
        if (typeof actual === 'string') actual = this.secretText(actual, 2000);
        return { index, kind: check.kind, pass, actual, ...(error ? { error } : {}) };
      }));
      // A parallel status check may outlive a value read. Do not return its ref
      // evidence if that node or document changed while other checks waited.
      await Promise.all(results.map(async result => {
        const check = checks[result.index];
        if (check.kind !== 'value' || check.ref === undefined || result.error) return;
        try {
          const observed = await (await guardedReference(check.ref)).evaluate(readValue, { expected: check.value, outputLimit: 2000 + (this.secretStore?.padding ?? 0) });
          if (observed.sensitive) throw new BrowserError('SENSITIVE_VALUE', 'Password and hidden field values are not returned or verified.');
          if (observed.unsupported) throw new BrowserError('NOT_FORM_CONTROL', 'Value checks require an input, textarea, or select.');
          await guardedReference(check.ref);
          result.actual = typeof observed.value === 'string' ? this.secretText(observed.value, 2000) : undefined;
          // This final read can revoke earlier evidence, never turn a timed-out
          // assertion into a success outside its polling budget.
          result.pass &&= observed.pass === true;
        }
        catch (caught) { result.pass = false; result.actual = undefined; result.error = this.errorInfo(caught, 'CHECK_FAILED'); }
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
      this.assertArtifactAllowed(session);
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
      return { buffer, mimeType: 'image/jpeg', url: this.secretText(page.url(), 4000), tabId, viewport, coordinateSpace: fullPage ? 'document-css' : 'viewport-css' };
    });
  }
  list(): Record<string, unknown>[] { return [...this.sessions.values()].filter(session => !session.closed && !session.page.isClosed()).map(session => ({ session_id: session.id, url: this.secretText(session.page.url(), 4000), snapshot_id: session.snapshot?.id ?? null, tab_id: session.activeTabId, tab_count: session.tabs.size, session_mode: this.options.profileDir ? 'persistent_profile' : session.ownsContext ? 'isolated' : 'attached_profile', ...(this.profileLease ? { profile_id: this.profileLease.id } : {}) })); }
  recordings(): BrowserRecording[] { return this.completedRecordings.map(recording => ({ ...recording })); }
  private async collectRecordings(session: Session): Promise<void> {
    if (!this.options.recordVideo) return;
    const directory = await realpath(await this.artifacts());
    for (const [tabId, video] of session.videos) {
      let path: string;
      try { path = await realpath(await video.path()); }
      catch { throw new BrowserError('RECORDING_FAILED', 'A browser video could not be finalized.'); }
      if (!path.startsWith(`${directory}/`)) throw new BrowserError('RECORDING_FAILED', 'A browser video escaped its private artifact directory.');
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size === 0) throw new BrowserError('RECORDING_FAILED', 'A browser video is missing or empty.');
      await chmod(path, 0o600);
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      const recording: BrowserRecording = { session_id: session.id, tab_id: tabId, path, bytes: metadata.size, mime_type: 'video/webm', sha256: digest.digest('hex') };
      session.recordings.push(recording);
      this.completedRecordings.push(recording);
    }
  }
  private cleanup(session: Session): Promise<void> {
    for (const lease of this.bindings) if (lease.sessionId === session.id) lease.invalidate(this.disposed ? 'ENGINE_CLOSED' : 'BINDING_STALE');
    if (!session.cleanup) {
      session.cleanup = (async () => {
        // External Chrome continues a download after its tab closes. Cancel only downloads
        // initiated by our pages before disconnecting, otherwise saveAs may never finish.
        const pending = [...session.downloads.values()].filter(item => item.status === 'pending');
        await Promise.all(pending.map(item => item.download.cancel().catch(() => {})));
        if (this.disposed && session.ownsContext && !this.options.recordVideo) await this.ownedBrowserClosing;
        if (session.ownsContext) await session.context.close();
        else await Promise.all([...session.tabs.values()].map(page => page.close()));
        await Promise.all([...session.downloads.values()].map(item => item.done));
        await this.collectRecordings(session);
        await this.releaseRefs(session.snapshot);
      })().catch(error => { this.cleanupFailed = true; throw error; });
      this.resourceCleanup.add(session.cleanup);
      void session.cleanup.then(() => this.resourceCleanup.delete(session.cleanup!), () => this.resourceCleanup.delete(session.cleanup!));
    }
    return session.cleanup;
  }
  close(sessionId: string): Promise<Record<string, unknown>> { return this.exclusive(sessionId, async session => { session.closed = true; this.sessions.delete(sessionId); await this.cleanup(session); return { ok: true, session_id: sessionId, closed: true, ...(this.options.recordVideo ? { recordings: session.recordings.map(recording => ({ ...recording })) } : {}) }; }, true); }
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      for (const lease of this.bindings) lease.invalidate('ENGINE_CLOSED');
      const sessions = [...new Set([...this.sessions.values(), ...this.openingSessions])];
      for (const session of sessions) session.closed = true;
      this.sessions.clear();
      const browserPromise = this.browserPromise;
      const ownedBrowserLaunch = this.ownedBrowserLaunch;
      const alreadyClosing = [...this.resourceCleanup];
      if (!this.options.cdpUrl) this.ownedBrowserClosing = (async () => {
        // Playwright finalizes video only when its owned context closes. Preserve
        // that ordering for explicit recording before closing the shared browser.
        if (this.options.recordVideo && (await Promise.allSettled(sessions.map(session => this.cleanup(session)))).some(result => result.status === 'rejected')) this.cleanupFailed = true;
        // Let close RPCs started by an earlier cancellation settle briefly.
        // Chrome can stall when context.close and browser.close run together.
        // Acquisition promises never gate this grace; it counts in the 2s cap.
        if (alreadyClosing.length) await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 250);
          void Promise.allSettled(alreadyClosing).then(() => { clearTimeout(timer); resolve(); });
        });
        const browser = await (ownedBrowserLaunch ?? browserPromise)?.catch(() => undefined);
        let closed = !browser;
        if (browser) {
          try { await browser.close(); closed = true; }
          catch { this.cleanupFailed = true; }
        }
        if (this.profileLease) {
          if (closed) await this.profileLease.release().catch(() => { this.cleanupFailed = true; });
          else this.cleanupFailed = true;
        }
      })();
      for (const cancel of this.cancelOpening) cancel();
      this.disposalWork = (async () => {
        // Closing our isolated browser first interrupts otherwise pending RPCs.
        // A CDP connection must stay usable until late owned pages are identified
        // and closed; disconnecting first can strand a page in external Chrome.
        await this.ownedBrowserClosing;
        if ((await Promise.allSettled([...this.navigationGuards.values()].map(guard => guard.close()))).some(result => result.status === 'rejected')) this.cleanupFailed = true;
        this.navigationGuards.clear();
        if ((await Promise.allSettled(sessions.map(session => this.cleanup(session)))).some(result => result.status === 'rejected')) this.cleanupFailed = true;
        await Promise.allSettled([...this.opening, ...this.bindingJobs, ...this.resourceCleanup, ...sessions.map(session => session.tail)]);
        const browser = await browserPromise?.catch(() => undefined);
        if (browser && this.options.cdpUrl) await browser.close().catch(() => { this.cleanupFailed = true; });
        if (this.cleanupFailed) throw new BrowserError('CLEANUP_INCOMPLETE', 'Some owned browser resources could not be confirmed closed.');
      })();
      this.disposal = new Promise<void>((resolve, reject) => {
        const graceMs = this.options.recordVideo ? 15000 : 2000;
        const timer = setTimeout(() => reject(new BrowserError('CLEANUP_INCOMPLETE', `Browser cleanup exceeded ${graceMs} ms. Pending cleanup remains tracked; an attached browser connection stays open until late owned pages can be closed.`)), graceMs);
        void this.disposalWork!.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    }
    return this.disposal;
  }
}
