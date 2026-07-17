import { lookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import type {
  AuthenticationResponseDetails,
  AuthInfo,
  BrowserWindowConstructorOptions,
  DownloadItem,
  Event,
  Session,
  WebContents,
} from 'electron';
import { isPrivateAddress } from './network-address';
import { BuddyBrowserProxy } from './browser-proxy';
import type { BrowserProxyResolver } from './browser-proxy';

export const BUDDY_BROWSER_PARTITION = 'persist:buddy';
const NAVIGATION_TOKEN_MS = 10_000;
const ORIGIN_LEDGER_FILE = 'buddy-visited-origins.json';

const BROWSER_WEB_PREFERENCES = {
  backgroundThrottling: false,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  // Buddy browser pages never own native UI. This remains disabled during visible takeover;
  // takeover is for login/consent on the same page, not renderer-controlled modal prompts.
  disableDialogs: true,
} as const;

export type BrowserDestinationGuard = (url: URL) => Promise<void>;

export interface BuddyBrowserProfileOptions {
  partition?: string;
  /** Narrow seam for an Electron test fixture. Production always uses the public-network guard. */
  destinationGuard?: BrowserDestinationGuard;
  logger?: { warn(message: string): void };
  proxyResolver?: BrowserProxyResolver;
  /** Narrow test seam for proving Session proxy-install ordering and failure behavior. */
  sessionFactory?: (partition: string) => Session;
}

export interface BuddyBrowserWindowOptions {
  show: boolean;
  width?: number;
  height?: number;
  title?: string;
  /** True only for a visible window the user is directly operating. */
  userOperated?: boolean;
}

interface WindowPolicy {
  currentOrigin: string | null;
  userOperated: boolean;
  token: { expiresAt: number; expectedUrl: string } | null;
  blockedListeners: Set<(url: string) => void>;
  internalStartUrl: string | null;
}

/** Persistent, least-privilege profile shared by buddy browser surfaces. */
export class BuddyBrowserProfile {
  readonly partition: string;

  private sessionInstance: Session | null = null;
  private readonly destinationGuard: BrowserDestinationGuard;
  private readonly useChromiumDestinationGuard: boolean;
  private readonly logger: { warn(message: string): void };
  private readonly proxy: BuddyBrowserProxy;
  private readonly sessionFactory: (partition: string) => Session;
  private proxyReady: Promise<void> | null = null;
  private readonly windows = new Set<BrowserWindow>();
  private readonly policies = new Map<number, WindowPolicy>();
  private readonly visitedOrigins = new Set<string>();
  private ledgerLoad: Promise<void> | null = null;
  private ledgerWrite: Promise<void> = Promise.resolve();
  private disposed = false;
  private suspended = false;

  private readonly onWillDownload = (_event: Event, item: DownloadItem): void => {
    // Cancel outside the synthetic mouse event call stack. Cancelling synchronously makes Chromium
    // wedge both CDP and sendInputEvent mouse-up dispatch on attachment navigations.
    setImmediate(() => item.cancel());
  };

  private readonly onAppLogin = (
    event: Event,
    contents: WebContents,
    _details: AuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void => {
    // Proxy authentication can be emitted only at app scope for an initially hidden renderer.
    // Scope credentials to this exact Electron Session and loopback endpoint.
    if (!contents || contents.session !== this.sessionInstance) return;
    event.preventDefault();
    if (!authInfo.isProxy || !this.proxy.isOwnEndpoint(authInfo.host, authInfo.port)) {
      callback();
      return;
    }
    const credentials = this.proxy.getCredentials();
    callback(credentials.username, credentials.password);
  };

  constructor(options: BuddyBrowserProfileOptions = {}) {
    this.partition = options.partition ?? BUDDY_BROWSER_PARTITION;
    if (!this.partition.startsWith('persist:')) {
      throw new Error('buddy browser profile must use a persistent Electron partition');
    }
    this.destinationGuard = options.destinationGuard ?? assertPublicBrowserDestination;
    this.useChromiumDestinationGuard = options.destinationGuard === undefined;
    this.logger = options.logger ?? { warn: (message) => console.warn(message) };
    this.sessionFactory =
      options.sessionFactory ?? ((partition) => session.fromPartition(partition));
    this.proxy = new BuddyBrowserProxy({
      destinationGuard: options.destinationGuard ?? assertBrowserDestinationSyntax,
      allowPrivateDestinations: options.destinationGuard !== undefined,
      ...(options.proxyResolver === undefined ? {} : { resolver: options.proxyResolver }),
      logger: this.logger,
    });
  }

  /** Lazy by design: service construction occurs before Electron's app-ready boundary. */
  get session(): Session {
    this.assertAlive();
    if (this.sessionInstance === null) this.installSessionSecurity();
    const instance = this.sessionInstance;
    if (instance === null) throw new Error('buddy browser session initialization failed');
    return instance;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  async ensureReady(): Promise<void> {
    this.assertAvailable();
    void this.session;
    await this.proxyReady;
  }

  /** Lock/suspend closes every enrolled surface, invalidating all active driver operations. */
  setSuspended(suspended: boolean): void {
    this.assertAlive();
    this.suspended = suspended;
    if (!suspended) return;
    for (const win of [...this.windows]) {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  createWindow(options: BuddyBrowserWindowOptions): BrowserWindow {
    this.assertAvailable();
    // Initialize the Session and its request handlers before the first renderer can issue traffic.
    void this.session;
    const windowOptions: BrowserWindowConstructorOptions = {
      show: options.show,
      width: options.width ?? 1024,
      height: options.height ?? 768,
      useContentSize: true,
      skipTaskbar: !options.show,
      ...(options.title === undefined ? {} : { title: options.title }),
      webPreferences: { ...BROWSER_WEB_PREFERENCES, partition: this.partition },
    };
    const win = new BrowserWindow(windowOptions);
    // Agent-generated clicks count as renderer user activation, so autoplay policy alone is not
    // enough. Keep page audio muted for both hidden operation and visible login takeover.
    win.webContents.setAudioMuted(true);
    win.webContents.on('will-prevent-unload', (event) => {
      // Electron's preventDefault here means "ignore the page's request to block unloading".
      event.preventDefault();
    });
    const policy: WindowPolicy = {
      currentOrigin: originOrNull(win.webContents.getURL()),
      userOperated: options.userOperated ?? false,
      token: null,
      blockedListeners: new Set(),
      internalStartUrl: null,
    };
    this.windows.add(win);
    const webContentsId = win.webContents.id;
    this.policies.set(webContentsId, policy);
    win.once('closed', () => {
      this.windows.delete(win);
      this.policies.delete(webContentsId);
    });
    win.webContents.on('did-navigate', (_event, url) => {
      policy.currentOrigin = originOrNull(url);
      policy.token = null;
      this.noteVisitedOrigin(url);
      if (policy.userOperated) setTrustedBrowserTitle(win, url);
    });
    win.webContents.on('did-redirect-navigation', (details) => {
      if (policy.userOperated && details.isMainFrame) setTrustedBrowserTitle(win, details.url);
    });
    win.on('page-title-updated', (event) => {
      if (!policy.userOperated) return;
      event.preventDefault();
    });
    win.webContents.on('did-frame-navigate', (_event, url) => this.noteVisitedOrigin(url));
    hardenBrowserContents(
      win.webContents,
      () => policy.userOperated,
      (url) => {
        void this.validateDestination(url)
          .then(async (destination) => {
            this.authorizeNavigation(win.webContents, destination);
            await loadBrowserWindow(win, destination);
          })
          .catch((error: unknown) => {
            this.logger.warn(`[browser-profile] blocked popup destination: ${errorMessage(error)}`);
          });
      },
      (url) => this.isTopNavigationAllowed(policy, url),
      (url) => {
        policy.token = null;
        for (const listener of policy.blockedListeners) listener(url);
      },
    );
    return win;
  }

  async createEnrollmentWindow(initialUrl = 'about:blank'): Promise<BrowserWindow> {
    await this.ensureReady();
    let url = normalizeBrowserUrl(initialUrl, true);
    if (url !== 'about:blank') url = await this.validateDestination(url);
    const win = this.createWindow({ show: true, title: "Buddy's browser", userOperated: true });
    win.on('close', (event) => {
      if (win.isDestroyed()) return;
      event.preventDefault();
      win.destroy();
    });
    await loadBrowserWindow(win, url);
    win.show();
    win.focus();
    return win;
  }

  /** Load Buddy's fixed inert start page; arbitrary callers cannot authorize other data URLs. */
  async loadInternalStartPage(win: BrowserWindow): Promise<void> {
    this.assertAvailable();
    await this.ensureReady();
    const policy = this.policies.get(win.webContents.id);
    if (!policy) throw new Error('browser window is not registered with the buddy profile');
    const url = buddyStartPageUrl();
    policy.internalStartUrl = url;
    try {
      await loadBrowserWindow(win, url);
    } finally {
      policy.internalStartUrl = null;
    }
  }

  /** Authorize exactly one bounded top-level navigation chain after the gate approves an action. */
  authorizeNavigation(contents: WebContents, destinationUrl: string): void {
    this.assertAvailable();
    const policy = this.policies.get(contents.id);
    if (!policy) throw new Error('browser window is not registered with the buddy profile');
    policy.token = {
      expiresAt: Date.now() + NAVIGATION_TOKEN_MS,
      expectedUrl: new URL(destinationUrl).href,
    };
  }

  revokeNavigation(contents: WebContents): void {
    const policy = this.policies.get(contents.id);
    if (policy) policy.token = null;
  }

  setUserOperated(contents: WebContents, userOperated: boolean): void {
    this.assertAvailable();
    const policy = this.policies.get(contents.id);
    if (!policy) throw new Error('browser window is not registered with the buddy profile');
    policy.userOperated = userOperated;
    policy.token = null;
    if (userOperated) {
      const win = BrowserWindow.fromWebContents(contents);
      if (win) setTrustedBrowserTitle(win, contents.getURL());
    }
  }

  onNavigationBlocked(contents: WebContents, listener: (url: string) => void): () => void {
    const policy = this.policies.get(contents.id);
    if (!policy) throw new Error('browser window is not registered with the buddy profile');
    policy.blockedListeners.add(listener);
    return () => policy.blockedListeners.delete(listener);
  }

  async validateDestination(url: string): Promise<string> {
    await this.ensureReady();
    const normalized = normalizeBrowserUrl(url);
    const destination = new URL(normalized);
    await this.destinationGuard(destination);
    await this.assertChromiumDestination(destination);
    return normalized;
  }

  async listEnrolledSites(): Promise<string[]> {
    this.assertAvailable();
    await this.ensureReady();
    await this.ensureLedgerLoaded();
    const cookies = await this.session.cookies.get({});
    const domains = new Set(cookies.map((cookie) => normalizeCookieDomain(cookie.domain ?? '')));
    return [...domains].filter((domain) => domain.length > 0).sort();
  }

  async clearEnrolledSite(domain: string): Promise<void> {
    this.assertAvailable();
    const normalized = normalizeCookieDomain(domain);
    if (!isHostname(normalized)) throw new Error(`invalid enrolled-site domain: ${domain}`);
    await this.ensureReady();
    await this.ensureLedgerLoaded();

    // Fail closed against in-flight actions: affected renderers are gone before storage mutation.
    for (const win of [...this.windows]) {
      const host = hostnameOrNull(win.webContents.getURL());
      if (host && domainMatches(host, normalized) && !win.isDestroyed()) win.destroy();
    }

    const cookies = await this.session.cookies.get({});
    const matching = cookies.filter((cookie) =>
      domainMatches(normalizeCookieDomain(cookie.domain ?? ''), normalized),
    );
    await this.session.closeAllConnections();
    await Promise.all(
      matching.map((cookie) => {
        const host = normalizeCookieDomain(cookie.domain ?? '');
        const scheme = cookie.secure ? 'https' : 'http';
        const cookiePath = cookie.path ?? '/';
        const path = cookiePath.startsWith('/') ? cookiePath : `/${cookiePath}`;
        return this.session.cookies.remove(`${scheme}://${host}${path}`, cookie.name);
      }),
    );

    const origins = [...this.visitedOrigins].filter((origin) => {
      const host = hostnameOrNull(origin);
      return host !== null && domainMatches(host, normalized);
    });
    const hosts = new Set([
      normalized,
      ...matching.map((cookie) => normalizeCookieDomain(cookie.domain ?? '')),
    ]);
    for (const host of hosts) {
      origins.push(`https://${host}`, `http://${host}`);
    }
    await Promise.all(
      [...new Set(origins)].map((origin) => this.session.clearStorageData({ origin })),
    );
    for (const origin of origins) this.visitedOrigins.delete(origin);
    this.session.flushStorageData();
    await this.persistOriginLedger();
  }

  async clearAllData(): Promise<void> {
    this.assertAvailable();
    await this.ensureReady();
    for (const win of [...this.windows]) {
      if (!win.isDestroyed()) win.destroy();
    }
    await this.session.closeAllConnections();
    await Promise.all([
      this.session.clearStorageData(),
      this.session.clearCache(),
      this.session.clearAuthCache(),
    ]);
    this.session.flushStorageData();
    this.visitedOrigins.clear();
    await this.persistOriginLedger();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const win of [...this.windows]) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
    this.policies.clear();
    let readinessError: unknown = null;
    try {
      await this.proxyReady;
    } catch (error) {
      readinessError = error;
    }
    if (this.sessionInstance) {
      await this.sessionInstance.closeAllConnections();
      this.sessionInstance.off('will-download', this.onWillDownload);
      this.sessionInstance.setPermissionCheckHandler(null);
      this.sessionInstance.setPermissionRequestHandler(null);
      this.sessionInstance.webRequest.onBeforeRequest(null);
    }
    app.off('login', this.onAppLogin);
    await this.proxy.dispose();
    await this.ledgerWrite;
    if (readinessError) throw readinessError;
  }

  private installSessionSecurity(): void {
    const instance = this.sessionFactory(this.partition);
    this.sessionInstance = instance;
    app.on('login', this.onAppLogin);
    this.proxyReady = this.proxy.start().then((port) =>
      instance.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
        // Chromium otherwise bypasses proxies for loopback. Production rejects private targets;
        // the subtraction is required only so explicitly-authorized local E2E fixtures are pinned.
        proxyBypassRules: '<-loopback>',
      }),
    );
    instance.setPermissionCheckHandler(() => false);
    instance.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    instance.on('will-download', this.onWillDownload);
    instance.webRequest.onBeforeRequest((details, callback) => {
      void this.assessRequest(details.webContentsId, details.resourceType, details.url)
        .then((allowed) => callback({ cancel: !allowed }))
        .catch((error: unknown) => {
          this.logger.warn(`[browser-profile] blocked request: ${errorMessage(error)}`);
          callback({ cancel: true });
        });
    });
    void this.ensureLedgerLoaded().catch((error: unknown) => {
      this.logger.warn(`[browser-profile] origin ledger load failed: ${errorMessage(error)}`);
    });
  }

  private async assessRequest(
    webContentsId: number | undefined,
    resourceType: string,
    rawUrl: string,
  ): Promise<boolean> {
    if (this.disposed || this.suspended) return false;
    // onBeforeRequest is installed synchronously, but setProxy is asynchronous. Holding every
    // network request here makes startup fail closed: no renderer request can escape directly.
    await this.proxyReady;
    if (this.disposed || this.suspended) return false;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol === 'about:' && url.href === 'about:blank')
      return resourceType === 'mainFrame';
    if (url.protocol === 'data:') {
      const policy = webContentsId === undefined ? undefined : this.policies.get(webContentsId);
      return resourceType === 'mainFrame' && policy?.internalStartUrl === rawUrl;
    }
    if (url.protocol === 'blob:') return resourceType !== 'mainFrame';
    const isWebSocket = url.protocol === 'wss:';
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && !isWebSocket) return false;
    if (isWebSocket && resourceType !== 'webSocket') return false;
    await this.destinationGuard(url);
    await this.assertChromiumDestination(url);
    await this.ensureLedgerLoaded();
    this.noteVisitedOrigin(url.href);

    if (resourceType !== 'mainFrame') return true;
    const policy = webContentsId === undefined ? undefined : this.policies.get(webContentsId);
    if (!policy) return false;
    const destinationOrigin = url.origin;
    if (policy.userOperated || destinationOrigin === policy.currentOrigin) {
      return true;
    }
    const token = policy.token;
    if (!token || token.expiresAt < Date.now() || token.expectedUrl !== url.href) {
      return false;
    }
    policy.token = null;
    return true;
  }

  private isTopNavigationAllowed(policy: WindowPolicy, rawUrl: string): boolean {
    if (policy.internalStartUrl === rawUrl) return true;
    let url: URL;
    try {
      url = new URL(normalizeBrowserUrl(rawUrl, true));
    } catch {
      return false;
    }
    if (url.href === 'about:blank') return policy.currentOrigin === null;
    if (policy.userOperated || url.origin === policy.currentOrigin) return true;
    return Boolean(
      policy.token && policy.token.expiresAt >= Date.now() && policy.token.expectedUrl === url.href,
    );
  }

  private noteVisitedOrigin(rawUrl: string): void {
    const origin = originOrNull(rawUrl);
    if (origin === null || this.visitedOrigins.has(origin)) return;
    this.visitedOrigins.add(origin);
    void this.persistOriginLedger().catch((error: unknown) => {
      this.logger.warn(`[browser-profile] origin ledger write failed: ${errorMessage(error)}`);
    });
  }

  private async assertChromiumDestination(url: URL): Promise<void> {
    if (!this.useChromiumDestinationGuard) return;
    const resolved = await this.session.resolveHost(url.hostname, { cacheUsage: 'disallowed' });
    if (
      resolved.endpoints.length === 0 ||
      resolved.endpoints.some((endpoint) => isPrivateAddress(endpoint.address))
    ) {
      throw new Error('Chromium resolved the destination to a private address');
    }
  }

  private async ensureLedgerLoaded(): Promise<void> {
    if (this.ledgerLoad) return this.ledgerLoad;
    this.ledgerLoad = this.loadOriginLedger();
    return this.ledgerLoad;
  }

  private async loadOriginLedger(): Promise<void> {
    const path = this.originLedgerPath();
    if (path === null) return;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error('origin ledger must be an array of strings');
      }
      for (const item of parsed) {
        const origin = originOrNull(item);
        if (origin) this.visitedOrigins.add(origin);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private persistOriginLedger(): Promise<void> {
    const path = this.originLedgerPath();
    if (path === null) return Promise.resolve();
    const payload = `${JSON.stringify([...this.visitedOrigins].sort())}\n`;
    this.ledgerWrite = this.ledgerWrite.then(async () => {
      await fs.mkdir(join(path, '..'), { recursive: true });
      const temporary = `${path}.tmp`;
      await fs.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, path);
    });
    return this.ledgerWrite;
  }

  private originLedgerPath(): string | null {
    const storagePath = this.sessionInstance?.storagePath;
    return storagePath ? join(storagePath, ORIGIN_LEDGER_FILE) : null;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('buddy browser profile is disposed');
  }

  private assertAvailable(): void {
    this.assertAlive();
    if (this.suspended) throw new Error('buddy browser profile is suspended');
  }
}

let defaultProfile: BuddyBrowserProfile | null = null;

export function getBuddyBrowserProfile(): BuddyBrowserProfile {
  defaultProfile ??= new BuddyBrowserProfile();
  return defaultProfile;
}

export async function disposeBuddyBrowserProfile(): Promise<void> {
  await defaultProfile?.dispose();
  defaultProfile = null;
}

export function normalizeBrowserUrl(value: string, allowBlank = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid browser URL: ${value}`);
  }
  if (allowBlank && url.href === 'about:blank') return url.href;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`browser URL scheme is not allowed: ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('browser URLs must not contain credentials');
  }
  return url.href;
}

export async function assertPublicBrowserDestination(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'wss:') {
    throw new Error('only http(s) and secure websocket urls are allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('local addresses are blocked');
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('private addresses are blocked');
  }
}

async function assertBrowserDestinationSyntax(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'wss:') {
    throw new Error('only http(s) and secure websocket urls are allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('local addresses are blocked');
  }
}

function hardenBrowserContents(
  contents: WebContents,
  isUserOperated: () => boolean,
  openUserPopupInSameWindow: (url: string) => void,
  isTopNavigationAllowed: (url: string) => boolean,
  onBlockedNavigation: (url: string) => void,
): void {
  // Hidden popups are simply denied. A directly user-operated enrollment/takeover flow may reuse
  // its one visible surface, after the same destination guard runs asynchronously.
  contents.setWindowOpenHandler(({ url }) => {
    if (isUserOperated()) openUserPopupInSameWindow(url);
    return { action: 'deny' };
  });
  const preventUnsafeScheme = (event: Event, rawUrl: string): void => {
    try {
      normalizeBrowserUrl(rawUrl, true);
    } catch {
      event.preventDefault();
      onBlockedNavigation(rawUrl);
      return;
    }
    if (!isTopNavigationAllowed(rawUrl)) {
      event.preventDefault();
      onBlockedNavigation(rawUrl);
    }
  };
  contents.on('will-navigate', preventUnsafeScheme);
  contents.on('will-redirect', preventUnsafeScheme);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function originOrNull(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function hostnameOrNull(rawUrl: string): string | null {
  try {
    return normalizeCookieDomain(new URL(rawUrl).hostname);
  } catch {
    return null;
  }
}

function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function setTrustedBrowserTitle(win: BrowserWindow, rawUrl: string): void {
  const origin = originOrNull(rawUrl);
  win.setTitle(origin ? `Buddy's browser — ${origin}` : "Buddy's browser — blank page");
}

function loadBrowserWindow(win: BrowserWindow, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const contents = win.webContents;
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error(`browser navigation timed out: ${url}`)),
      12_000,
    );
    const cleanup = (): void => {
      clearTimeout(timeout);
      contents.off('did-finish-load', onReady);
      contents.off('did-fail-load', onFailed);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onReady = (): void => finish();
    const onFailed = (
      _event: Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && errorCode !== -3) {
        finish(
          new Error(
            `browser navigation failed (${errorCode}) for ${validatedURL}: ${errorDescription}`,
          ),
        );
      }
    };
    contents.once('did-finish-load', onReady);
    contents.on('did-fail-load', onFailed);
    void win.loadURL(url).then(
      () => finish(),
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function buddyStartPageUrl(): string {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Buddy browser</title><style>
html,body{margin:0;width:100%;height:100%;background:#f5f7fb;color:#344054;font:16px system-ui,sans-serif}
body{display:grid;place-items:center}.card{text-align:center}.mark{font-size:42px;color:#1570ef}.copy{margin-top:10px}
</style></head><body><main class="card"><div class="mark">◆</div><div class="copy">buddy browser ready</div></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253 || value.includes('..')) return false;
  return value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
