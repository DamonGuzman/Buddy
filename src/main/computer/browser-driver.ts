import type { BrowserWindow, Event as ElectronEvent, NativeImage, WebFrameMain } from 'electron';
import { CAPTURE_JPEG_QUALITY } from '../../shared/constants';
import type { ElementFacts } from '../agents/gate/trigger';
import type { GateDriverInspection } from '../agents/gate/action-gate';
import type { CaptureResult } from '../capture';
import { planResize } from '../capture-math';
import type { ComputerDriver, DriverPayloadField, DriverPoint, MouseButton } from './driver';
import { getBuddyBrowserProfile, normalizeBrowserUrl } from './browser-profile';
import type { BuddyBrowserProfile } from './browser-profile';

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 768;
const MAX_FACT_TEXT = 500;
const MAX_FACT_ATTRIBUTE = 1_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 12_000;
const POST_CLICK_NAVIGATION_OBSERVE_MS = 100;
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export interface BrowserDriverLogger {
  warn(message: string): void;
}

export interface OffscreenBrowserDriverOptions {
  profile?: BuddyBrowserProfile;
  initialUrl?: string;
  logger?: BrowserDriverLogger;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
}

interface BrowserObservation {
  capture: CaptureResult;
  contentWidth: number;
  contentHeight: number;
}

interface CssPoint {
  x: number;
  y: number;
}

interface FrameSnapshot {
  facts: Omit<ElementFacts, 'frame'>;
  payloadFields: DriverPayloadField[];
  fingerprint: string;
  pageRevision: string | number;
  resolvedInChild: boolean;
  childFrameIndex: number | null;
  childFrameUrl: string | null;
  childFrameName: string | null;
  childX: number | null;
  childY: number | null;
}

interface KeyDefinition {
  key: string;
  code: string;
  virtualKeyCode: number;
  modifier?: keyof typeof MODIFIER_BITS;
}

const consoleLogger: BrowserDriverLogger = {
  warn: (message) => console.warn(message),
};

/**
 * A fully hidden, focus-independent browser surface driven through Chromium's DevTools protocol.
 * It never sends OS input and never touches the user's live desktop.
 */
export class OffscreenBrowserDriver implements ComputerDriver {
  readonly profile: BuddyBrowserProfile;

  private readonly win: BrowserWindow;
  private readonly logger: BrowserDriverLogger;
  private readonly signal: AbortSignal | null;
  private readonly operationTimeoutMs: number;
  private readonly ready: Promise<void>;
  private observation: BrowserObservation | null = null;
  private attachInFlight: Promise<void> | null = null;
  private disposed = false;
  private takeoverVisible = false;
  private takeoverDone: (() => void) | null = null;
  private navigationError: Error | null = null;
  private readonly removeBlockedNavigationListener: () => void;

  constructor(options: OffscreenBrowserDriverOptions = {}) {
    this.profile = options.profile ?? getBuddyBrowserProfile();
    this.logger = options.logger ?? consoleLogger;
    this.signal = options.signal ?? null;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (!(this.operationTimeoutMs > 0))
      throw new Error('browser operation timeout must be positive');
    this.win = this.profile.createWindow({
      show: false,
      width: options.width ?? DEFAULT_WIDTH,
      height: options.height ?? DEFAULT_HEIGHT,
    });
    this.win.webContents.debugger.on('detach', this.onDebuggerDetach);
    this.win.webContents.debugger.on('message', this.onDebuggerMessage);
    this.removeBlockedNavigationListener = this.profile.onNavigationBlocked(
      this.win.webContents,
      (url) => {
        this.navigationError = new Error(`browser navigation was blocked by policy: ${url}`);
      },
    );
    this.win.webContents.on('render-process-gone', () => {
      this.observation = null;
      if (!this.win.isDestroyed()) this.win.destroy();
    });
    this.win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.navigationError = new Error(
            `browser navigation failed (${errorCode}) for ${validatedURL}: ${errorDescription}`,
          );
        }
      },
    );
    this.win.on('close', (event) => {
      if (!this.disposed && this.takeoverVisible) {
        event.preventDefault();
        const done = this.takeoverDone;
        this.hideAfterTakeover();
        done?.();
      }
    });

    const initialUrl =
      options.initialUrl === undefined ? null : normalizeBrowserUrl(options.initialUrl, true);
    this.ready = this.initialize(initialUrl);
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  async capture(): Promise<CaptureResult[]> {
    await this.ensureReady();
    const [contentWidth, contentHeight] = this.win.getContentSize();
    if (
      !(contentWidth !== undefined && contentWidth > 0) ||
      !(contentHeight !== undefined && contentHeight > 0)
    ) {
      throw new Error(
        `buddy browser has invalid content size ${String(contentWidth)}x${String(contentHeight)}`,
      );
    }

    const raw = await this.capturePaintedPage();
    const rawSize = raw.getSize();
    const image = resizeCapture(raw);
    const imageSize = image.getSize();
    const scaleFactor = rawSize.width / contentWidth;
    if (!(scaleFactor > 0) || !Number.isFinite(scaleFactor)) {
      throw new Error('buddy browser returned an invalid capture scale');
    }

    const capture: CaptureResult = {
      meta: {
        screenIndex: 0,
        displayId: -1,
        imageW: imageSize.width,
        imageH: imageSize.height,
        displayBounds: { x: 0, y: 0, width: contentWidth, height: contentHeight },
        scaleFactor,
        isActive: true,
      },
      jpegBase64: image.toJPEG(CAPTURE_JPEG_QUALITY).toString('base64'),
    };
    this.observation = {
      capture,
      contentWidth,
      contentHeight,
    };
    return [capture];
  }

  async click(target: DriverPoint, button: MouseButton, count: 1 | 2): Promise<void> {
    if (button !== 'left') throw new Error('buddy browser supports left clicks only');
    const point = this.toCssPoint(target);
    this.observation = null;
    this.navigationError = null;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      // Electron's synchronous mouse input path works for hidden windows. It is intentionally used
      // for clicks because Chromium leaves Input.dispatchMouseEvent promises permanently pending
      // when a popup/download/navigation is denied by a browser-process policy. Keyboard input
      // remains CDP-only because sendInputEvent keyboard events require OS focus.
      this.win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      this.win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    }
    await this.runOperation(
      'click navigation observation',
      new Promise<void>((resolve) => setTimeout(resolve, POST_CLICK_NAVIGATION_OBSERVE_MS)),
    );
    if (this.navigationError) throw this.navigationError;
  }

  /** Arm the exact mechanically inspected href/form action for the next hidden navigation. */
  async authorizeNextNavigation(destination: string): Promise<void> {
    await this.ensureReady();
    const normalized = await this.profile.validateDestination(destination);
    this.profile.authorizeNavigation(this.win.webContents, normalized);
  }

  async typeText(text: string): Promise<void> {
    if (typeof text !== 'string') throw new Error('browser text must be a string');
    this.observation = null;
    await this.sendCommand('Input.insertText', { text });
  }

  async pressKeys(keys: string[]): Promise<void> {
    if (keys.length === 0 || keys.length > 8) {
      throw new Error('browser key chord must contain between 1 and 8 keys');
    }
    const definitions = normalizeKeyChord(keys);
    this.observation = null;
    let modifiers = 0;
    const pressed: KeyDefinition[] = [];
    try {
      for (const key of definitions) {
        if (key.modifier) modifiers |= MODIFIER_BITS[key.modifier];
        pressed.push(key);
        await this.sendKeyEvent('keyDown', key, modifiers);
      }
    } finally {
      for (const key of pressed.reverse()) {
        try {
          await this.sendKeyEvent('keyUp', key, modifiers);
        } catch (error) {
          this.logger.warn(`[browser-driver] key release failed: ${errorMessage(error)}`);
        } finally {
          if (key.modifier) modifiers &= ~MODIFIER_BITS[key.modifier];
        }
      }
    }
  }

  async navigate(url: string): Promise<void> {
    await this.ensureReady();
    this.observation = null;
    const destination = await this.profile.validateDestination(url);
    this.profile.authorizeNavigation(this.win.webContents, destination);
    try {
      await this.runOperation('navigation', this.loadPage(destination));
    } catch (error) {
      this.profile.revokeNavigation(this.win.webContents);
      throw error;
    }
  }

  async scroll(target: DriverPoint, dy: number): Promise<void> {
    if (!Number.isFinite(dy)) throw new Error('browser scroll delta must be finite');
    const point = this.toCssPoint(target);
    this.observation = null;
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: dy,
    });
  }

  async inspect(target: DriverPoint): Promise<ElementFacts | null> {
    return (await this.inspectDetailed(target)).facts;
  }

  /** Inspect the actual focused control, including nested open shadow roots and child frames. */
  async inspectFocused(): Promise<ElementFacts | null> {
    return (await this.inspectDetailed(null)).facts;
  }

  async readPendingPayload(target: DriverPoint | null): Promise<DriverPayloadField[]> {
    return (await this.inspectDetailed(target)).payloadFields;
  }

  async inspectDetailed(target: DriverPoint | null): Promise<GateDriverInspection> {
    await this.ensureReady();
    const inspectionTarget =
      target === null
        ? ({ kind: 'focused' } as const)
        : ({ kind: 'point', ...this.toCssPoint(target) } as const);
    const detailed = await this.inspectFrameDetailed(
      this.win.webContents.mainFrame,
      inspectionTarget,
      true,
    );
    return (
      detailed ?? {
        facts: null,
        payloadFields: [],
        fingerprint: 'unresolved-page',
        pageRevision: 0,
      }
    );
  }

  /** Explicitly user-triggered takeover: show this exact hidden surface so state is preserved. */
  async showForTakeover(onDone?: () => void): Promise<void> {
    await this.ensureReady();
    this.assertAlive();
    this.takeoverVisible = true;
    this.takeoverDone = onDone ?? null;
    this.profile.setUserOperated(this.win.webContents, true);
    this.win.setSkipTaskbar(false);
    this.win.show();
    this.win.focus();
  }

  hideAfterTakeover(): void {
    this.assertAlive();
    if (!this.takeoverVisible) return;
    this.takeoverVisible = false;
    this.profile.setUserOperated(this.win.webContents, false);
    this.win.hide();
    this.win.setSkipTaskbar(true);
    this.takeoverDone = null;
  }

  isTakeoverVisible(): boolean {
    return this.takeoverVisible && !this.win.isDestroyed() && this.win.isVisible();
  }

  getCurrentUrl(): string {
    this.assertAlive();
    return this.win.webContents.getURL();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.observation = null;
    this.win.webContents.debugger.off('detach', this.onDebuggerDetach);
    this.win.webContents.debugger.off('message', this.onDebuggerMessage);
    this.signal?.removeEventListener('abort', this.onAbort);
    this.removeBlockedNavigationListener();
    if (!this.win.webContents.isDestroyed() && this.win.webContents.debugger.isAttached()) {
      this.win.webContents.debugger.detach();
    }
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private readonly onDebuggerDetach = (): void => {
    if (this.disposed || this.win.webContents.isDestroyed()) return;
    // Reattach eagerly; every command also calls ensureDebugger so a transient failure is safe.
    void this.ensureDebugger()
      .then(() => this.installDebuggerSecurity())
      .catch((error: unknown) => {
        this.logger.warn(`[browser-driver] debugger reattach failed: ${errorMessage(error)}`);
      });
  };

  private readonly onDebuggerMessage = (
    _event: ElectronEvent,
    method: string,
    params: unknown,
  ): void => {
    if (method !== 'Page.fileChooserOpened' || this.disposed) return;
    const backendNodeId = objectNumber(params, 'backendNodeId');
    if (backendNodeId === null) {
      this.logger.warn('[browser-driver] intercepted file chooser had no backend node id');
      return;
    }
    // Interception prevents Chromium from creating native file-picker UI. Clearing the element
    // completes the page-side chooser request without exposing any filesystem path.
    void this.win.webContents.debugger
      .sendCommand('DOM.setFileInputFiles', { files: [], backendNodeId })
      .catch((error: unknown) => {
        this.logger.warn(`[browser-driver] failed to cancel file chooser: ${errorMessage(error)}`);
      });
  };

  private readonly onAbort = (): void => {
    void this.dispose();
  };

  private async initialize(initialUrl: string | null): Promise<void> {
    await this.profile.ensureReady();
    await this.ensureDebugger();
    // A freshly constructed hidden WebContents has no committed renderer document. Commit Buddy's
    // inert page before enabling Page-domain interception; Page.enable otherwise has no target and
    // can remain pending indefinitely.
    await this.profile.loadInternalStartPage(this.win);
    await this.installDebuggerSecurity();
    if (initialUrl === null) {
      return;
    }
    // The inert bootstrap document means an explicit about:blank request is now a real navigation.
    if (initialUrl === 'about:blank') {
      await this.runOperation('initial blank navigation', this.loadPage(initialUrl));
      return;
    }
    initialUrl = await this.profile.validateDestination(initialUrl);
    this.profile.authorizeNavigation(this.win.webContents, initialUrl);
    await this.runOperation('initial navigation', this.loadPage(initialUrl));
  }

  private async ensureReady(): Promise<void> {
    this.assertAlive();
    await this.ready;
    this.assertAlive();
  }

  private loadPage(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const contents = this.win.webContents;
      let settled = false;
      const cleanup = (): void => {
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
        _event: ElectronEvent,
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
      void this.win.loadURL(url).then(
        () => finish(),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private async capturePaintedPage(): Promise<NativeImage> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        this.win.webContents.invalidate();
        if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const image = await this.runOperation('capture', this.win.webContents.capturePage());
        if (image.isEmpty()) throw new Error('buddy browser returned an empty capture');
        return image;
      } catch (error) {
        lastError = error;
        // The next iteration requests a repaint and waits one compositor beat.
      }
    }
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
  }

  private assertAlive(): void {
    if (this.signal?.aborted) throw new Error('buddy browser operation was cancelled');
    if (this.profile.isSuspended()) throw new Error('buddy browser profile is suspended');
    if (this.disposed || this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
      throw new Error('buddy browser driver is disposed');
    }
  }

  private async ensureDebugger(): Promise<void> {
    this.assertAlive();
    const debug = this.win.webContents.debugger;
    if (debug.isAttached()) return;
    if (this.attachInFlight) return this.attachInFlight;
    this.attachInFlight = Promise.resolve().then(() => {
      if (!debug.isAttached()) debug.attach('1.3');
    });
    try {
      await this.attachInFlight;
    } finally {
      this.attachInFlight = null;
    }
  }

  private async installDebuggerSecurity(): Promise<void> {
    const debug = this.win.webContents.debugger;
    // This is installed on every attach because debugger detach resets protocol state.
    await this.runOperation('debugger Page enable', debug.sendCommand('Page.enable'));
    await this.runOperation(
      'file chooser interception setup',
      debug.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }),
    );
  }

  private async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureReady();
    await this.ensureDebugger();
    return this.runOperation(
      method,
      params === undefined
        ? this.win.webContents.debugger.sendCommand(method)
        : this.win.webContents.debugger.sendCommand(method, params),
    );
  }

  private async sendKeyEvent(
    type: 'keyDown' | 'keyUp',
    definition: KeyDefinition,
    modifiers: number,
  ): Promise<void> {
    await this.sendCommand('Input.dispatchKeyEvent', {
      type,
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
      nativeVirtualKeyCode: definition.virtualKeyCode,
      modifiers,
      ...(type === 'keyDown' && definition.key === 'Enter'
        ? { text: '\r', unmodifiedText: '\r' }
        : {}),
      ...(type === 'keyDown' &&
      definition.code === 'KeyA' &&
      (modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) !== 0
        ? { commands: ['SelectAll'] }
        : {}),
    });
  }

  private toCssPoint(target: DriverPoint): CssPoint {
    const observation = this.observation;
    if (observation === null) {
      throw new Error('capture the buddy browser before using screenshot coordinates');
    }
    return mapBrowserPoint(target, observation.capture, {
      width: observation.contentWidth,
      height: observation.contentHeight,
    });
  }

  private async inspectFrameDetailed(
    frame: WebFrameMain,
    target: { kind: 'point'; x: number; y: number } | { kind: 'focused' },
    isTop: boolean,
  ): Promise<GateDriverInspection | null> {
    if (frame.isDestroyed() || frame.detached) return null;
    const snapshot = parseFrameSnapshot(
      await this.runOperation(
        'DOM inspection',
        frame.executeJavaScript(buildInspectionScript(target)),
      ),
    );
    if (snapshot === null) return null;
    const facts: ElementFacts = {
      ...snapshot.facts,
      frame: isTop && !snapshot.resolvedInChild ? 'top' : 'same-origin',
    };
    const result: GateDriverInspection = {
      facts,
      payloadFields: snapshot.payloadFields,
      fingerprint: `${frame.frameTreeNodeId}:${snapshot.fingerprint}`,
      pageRevision: `${frame.frameTreeNodeId}:${snapshot.pageRevision}`,
    };
    if (snapshot.childFrameIndex === null) return result;
    const child = findChildFrame(frame, snapshot);
    if (child === null || child.isDestroyed() || child.detached) {
      return { ...result, facts: { ...facts, frame: 'cross-origin-unresolved' } };
    }
    const childTarget =
      target.kind === 'focused'
        ? ({ kind: 'focused' } as const)
        : snapshot.childX !== null && snapshot.childY !== null
          ? ({ kind: 'point', x: snapshot.childX, y: snapshot.childY } as const)
          : null;
    if (childTarget === null) {
      return { ...result, facts: { ...facts, frame: 'cross-origin-unresolved' } };
    }
    const resolved = await this.inspectFrameDetailed(child, childTarget, false);
    return resolved ?? { ...result, facts: { ...facts, frame: 'cross-origin-unresolved' } };
  }

  private async runOperation<T>(label: string, operation: Promise<T>): Promise<T> {
    this.assertAlive();
    let timeout: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out`)), this.operationTimeoutMs);
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (!this.signal) return;
      onAbort = () => reject(new Error(`${label} was cancelled`));
      if (this.signal.aborted) onAbort();
      else this.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, timeoutPromise, abortPromise]);
    } catch (error) {
      this.observation = null;
      this.logger.warn(`[browser-driver] ${label} failed: ${errorMessage(error)}`);
      if (error instanceof Error && error.message === `${label} timed out`) void this.dispose();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (onAbort) this.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function mapBrowserPoint(
  target: DriverPoint,
  capture: CaptureResult,
  contentSize: { width: number; height: number },
): CssPoint {
  if (target.screenIndex !== capture.meta.screenIndex) {
    throw new Error('that screenshot does not exist');
  }
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    throw new Error('browser coordinates must be finite');
  }
  if (!(contentSize.width > 0) || !(contentSize.height > 0)) {
    throw new Error('browser content size must be positive');
  }
  if (
    target.x < 0 ||
    target.y < 0 ||
    target.x >= capture.meta.imageW ||
    target.y >= capture.meta.imageH
  ) {
    throw new Error(
      `browser coordinates are outside screen${capture.meta.screenIndex} (${capture.meta.imageW}x${capture.meta.imageH})`,
    );
  }
  const x = target.x;
  const y = target.y;
  return {
    x: x * (contentSize.width / capture.meta.imageW),
    y: y * (contentSize.height / capture.meta.imageH),
  };
}

function resizeCapture(raw: NativeImage): NativeImage {
  const size = raw.getSize();
  if (!(size.width > 0) || !(size.height > 0)) throw new Error('invalid browser capture size');
  const plan = planResize(size.width, size.height);
  return plan.resized
    ? raw.resize({ width: plan.width, height: plan.height, quality: 'good' })
    : raw;
}

function findChildFrame(frame: WebFrameMain, snapshot: FrameSnapshot): WebFrameMain | null {
  // Never trust DOM/frame array ordering across renderer processes. A unique frame name is the
  // strongest identity available through both the iframe element and WebFrameMain. A unique URL
  // is also safe; duplicates deliberately remain unresolved rather than guessing by array index.
  const matches = frame.frames.filter((candidate) => {
    if (snapshot.childFrameName) {
      return (
        candidate.name === snapshot.childFrameName &&
        (!snapshot.childFrameUrl || candidate.url === snapshot.childFrameUrl)
      );
    }
    return Boolean(snapshot.childFrameUrl) && candidate.url === snapshot.childFrameUrl;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function buildInspectionScript(
  target: { kind: 'point'; x: number; y: number } | { kind: 'focused' } | { kind: 'page' },
): string {
  const targetJson = JSON.stringify(target);
  return `(() => {
    const target = ${targetJson};
    const stateKey = Symbol.for('buddy.browser.inspection');
    if (!globalThis[stateKey]) {
      const bytes = new Uint32Array(4);
      crypto.getRandomValues(bytes);
      globalThis[stateKey] = { documentGeneration: Array.from(bytes).join('-') };
    }
    const pageRevision = globalThis[stateKey].documentGeneration;
    const cap = (value, max) => String(value ?? '').trim().slice(0, max);
    const composedParent = (node) => {
      if (!node) return null;
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode?.();
      return root && root.host instanceof Element ? root.host : null;
    };
    const composedClosest = (start, predicate) => {
      for (let node = start; node; node = composedParent(node)) {
        if (node instanceof Element && predicate(node)) return node;
      }
      return null;
    };
    const actionable = (start) => composedClosest(start, (el) =>
      ['A','BUTTON','INPUT','SELECT','TEXTAREA'].includes(el.tagName) ||
      ['button','link','checkbox','radio','menuitem','option','switch','tab'].includes(el.getAttribute('role') || '') ||
      el.isContentEditable
    ) || start;
    const deepPoint = (root, x, y) => {
      let el = root.elementFromPoint?.(x, y) || null;
      while (el?.shadowRoot) {
        const deeper = el.shadowRoot.elementFromPoint?.(x, y) || null;
        if (!deeper || deeper === el) break;
        el = deeper;
      }
      return { element: el, resolvedInChild: false };
    };
    const deepFocused = () => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return { element: el, resolvedInChild: false };
    };
    const nodePath = (start) => {
      const parts = [];
      for (let node = start; node instanceof Element; node = composedParent(node)) {
        const parent = composedParent(node);
        const siblings = parent ? Array.from(parent.children || []).filter((candidate) => candidate.tagName === node.tagName) : [];
        const index = siblings.indexOf(node);
        parts.push(node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.getAttribute('name') ? '[name=' + node.getAttribute('name') + ']' : '') + ':' + index);
      }
      return parts.reverse().join('>');
    };
    const allFrames = [];
    const collectFrames = (root) => {
      for (const el of root.querySelectorAll?.('*') || []) {
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') allFrames.push(el);
        if (el.shadowRoot) collectFrames(el.shadowRoot);
      }
    };
    collectFrames(document);
    let raw;
    let resolvedInChild = false;
    if (target.kind === 'point') {
      const hit = deepPoint(document, target.x, target.y);
      raw = hit.element;
      resolvedInChild = hit.resolvedInChild;
    } else if (target.kind === 'focused') {
      const hit = deepFocused();
      raw = hit.element;
      resolvedInChild = hit.resolvedInChild;
    } else raw = document.documentElement;
    if (!(raw instanceof Element)) return null;
    const frameElement = (raw.tagName === 'IFRAME' || raw.tagName === 'FRAME') ? raw : null;
    const el = actionable(raw);
    const form = el.form || composedClosest(el, (candidate) => candidate.tagName === 'FORM');
    const anchor = composedClosest(el, (candidate) => candidate.tagName === 'A');
    const label = el.getAttribute('aria-label') || el.innerText ||
      ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || el.getAttribute('placeholder')) : '') ||
      el.getAttribute('title') || el.textContent || '';
    const rect = frameElement?.getBoundingClientRect();
    return {
      facts: {
        tag: cap(el.tagName.toLowerCase(), 50),
        ...(el.getAttribute('type') ? { inputType: cap(el.getAttribute('type').toLowerCase(), 100) } : {}),
        text: cap(label, ${MAX_FACT_TEXT}),
        inForm: Boolean(form),
        ...((el.formAction || form?.action) ? { formAction: cap(el.formAction || form.action, ${MAX_FACT_ATTRIBUTE}) } : {}),
        ...(anchor?.href ? { href: cap(anchor.href, ${MAX_FACT_ATTRIBUTE}) } : {}),
        url: cap(el.ownerDocument?.location?.href || location.href, ${MAX_FACT_ATTRIBUTE}),
        ...(el.getAttribute('name') ? { name: cap(el.getAttribute('name'), 200) } : {}),
        ...(el.id ? { id: cap(el.id, 200) } : {}),
        ...(el.getAttribute('aria-label') ? { ariaLabel: cap(el.getAttribute('aria-label'), 200) } : {}),
        ...(el.getAttribute('autocomplete') ? { autocomplete: cap(el.getAttribute('autocomplete'), 200) } : {}),
        ...(el.getAttribute('role') ? { role: cap(el.getAttribute('role'), 100) } : {}),
        ...(el.isContentEditable ? { contentEditable: true } : {})
      },
      payloadFields: form ? Array.from(form.elements).slice(0, 50).flatMap((field) => {
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return [];
        if ((field instanceof HTMLInputElement) && ['checkbox','radio'].includes(field.type) && !field.checked) return [];
        const name = cap(field.name || field.id || field.getAttribute('aria-label') || 'unnamed', 160);
        const type = cap(field.type || field.tagName.toLowerCase(), 100);
        const credential = type === 'password' || /password|passcode|otp|token|secret|api.?key/i.test(name + ' ' + (field.autocomplete || ''));
        return [{ name, value: credential ? '[redacted]' : cap(field.value, 2000), type }];
      }) : [],
      fingerprint: cap([el.ownerDocument?.location?.href || location.href, nodePath(el), nodePath(deepFocused().element), el.formAction || form?.action || ''].join('|'), 4000),
      pageRevision,
      resolvedInChild,
      childFrameIndex: frameElement ? allFrames.indexOf(frameElement) : null,
      childFrameUrl: frameElement ? cap(frameElement.src, ${MAX_FACT_ATTRIBUTE}) : null,
      childFrameName: frameElement ? cap(frameElement.name, 200) : null,
      childX: frameElement && rect && target.kind === 'point' ? target.x - rect.left : null,
      childY: frameElement && rect && target.kind === 'point' ? target.y - rect.top : null
    };
  })()`;
}

function parseFrameSnapshot(value: unknown): FrameSnapshot | null {
  if (!isRecord(value) || !isRecord(value['facts'])) return null;
  const facts = value['facts'];
  if (
    typeof facts['tag'] !== 'string' ||
    typeof facts['text'] !== 'string' ||
    typeof facts['inForm'] !== 'boolean' ||
    typeof facts['url'] !== 'string'
  ) {
    return null;
  }
  return {
    facts: {
      tag: facts['tag'].slice(0, 50),
      text: facts['text'].slice(0, MAX_FACT_TEXT),
      inForm: facts['inForm'],
      url: facts['url'].slice(0, MAX_FACT_ATTRIBUTE),
      ...optionalStringFacts(facts),
      ...(facts['contentEditable'] === true ? { contentEditable: true } : {}),
    },
    payloadFields: parsePayloadFields(value['payloadFields']),
    fingerprint:
      typeof value['fingerprint'] === 'string' && value['fingerprint'].length > 0
        ? value['fingerprint'].slice(0, 4_000)
        : 'unresolved-element',
    pageRevision:
      (typeof value['pageRevision'] === 'number' && Number.isFinite(value['pageRevision'])) ||
      (typeof value['pageRevision'] === 'string' && value['pageRevision'].length > 0)
        ? value['pageRevision']
        : 'unknown-document',
    resolvedInChild: value['resolvedInChild'] === true,
    childFrameIndex: integerOrNull(value['childFrameIndex']),
    childFrameUrl: stringOrNull(value['childFrameUrl']),
    childFrameName: stringOrNull(value['childFrameName']),
    childX: finiteOrNull(value['childX']),
    childY: finiteOrNull(value['childY']),
  };
}

function parsePayloadFields(value: unknown): DriverPayloadField[] {
  if (!Array.isArray(value)) return [];
  const fields: DriverPayloadField[] = [];
  for (const item of value.slice(0, 50)) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || typeof item['value'] !== 'string')
      continue;
    fields.push({
      name: item['name'].slice(0, 160),
      value: item['value'].slice(0, 2_000),
      ...(typeof item['type'] === 'string' ? { type: item['type'].slice(0, 100) } : {}),
    });
  }
  return fields;
}

function optionalStringFacts(value: Record<string, unknown>): Partial<ElementFacts> {
  const output: Partial<ElementFacts> = {};
  for (const key of [
    'inputType',
    'formAction',
    'href',
    'name',
    'id',
    'ariaLabel',
    'autocomplete',
    'role',
  ] as const) {
    if (typeof value[key] === 'string') output[key] = value[key].slice(0, MAX_FACT_ATTRIBUTE);
  }
  return output;
}

function parseKeyDefinition(raw: string): KeyDefinition {
  const name = raw.trim().toUpperCase();
  const special = SPECIAL_KEYS[name];
  if (special) return special;
  if (/^[A-Z]$/.test(name)) {
    return { key: name.toLowerCase(), code: `Key${name}`, virtualKeyCode: name.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, virtualKeyCode: name.charCodeAt(0) };
  }
  const functionMatch = /^F([1-9]|1[0-2])$/.exec(name);
  if (functionMatch) {
    const number = Number(functionMatch[1]);
    return { key: name, code: name, virtualKeyCode: 111 + number };
  }
  throw new Error(`unsupported browser key: ${raw}`);
}

function normalizeKeyChord(keys: string[]): KeyDefinition[] {
  const definitions = keys.map(parseKeyDefinition);
  const modifiers = new Map<keyof typeof MODIFIER_BITS, KeyDefinition>();
  const nonModifiers: KeyDefinition[] = [];
  for (const definition of definitions) {
    if (!definition.modifier) {
      nonModifiers.push(definition);
      continue;
    }
    if (modifiers.has(definition.modifier)) {
      throw new Error(`duplicate browser modifier: ${definition.key}`);
    }
    modifiers.set(definition.modifier, definition);
  }
  if (nonModifiers.length !== 1) {
    throw new Error('browser key chord must contain exactly one non-modifier key');
  }
  const nonModifier = nonModifiers[0];
  if (!nonModifier) throw new Error('browser key chord has no non-modifier key');
  return [
    ...(['ctrl', 'alt', 'shift', 'meta'] as const).flatMap((modifier) => {
      const definition = modifiers.get(modifier);
      return definition ? [definition] : [];
    }),
    nonModifier,
  ];
}

const SPECIAL_KEYS: Readonly<Record<string, KeyDefinition>> = {
  CTRL: { key: 'Control', code: 'ControlLeft', virtualKeyCode: 17, modifier: 'ctrl' },
  CONTROL: { key: 'Control', code: 'ControlLeft', virtualKeyCode: 17, modifier: 'ctrl' },
  ALT: { key: 'Alt', code: 'AltLeft', virtualKeyCode: 18, modifier: 'alt' },
  SHIFT: { key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16, modifier: 'shift' },
  META: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91, modifier: 'meta' },
  COMMAND: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91, modifier: 'meta' },
  ENTER: { key: 'Enter', code: 'Enter', virtualKeyCode: 13 },
  RETURN: { key: 'Enter', code: 'Enter', virtualKeyCode: 13 },
  TAB: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
  ESC: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  ESCAPE: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  SPACE: { key: ' ', code: 'Space', virtualKeyCode: 32 },
  BACKSPACE: { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 },
  DELETE: { key: 'Delete', code: 'Delete', virtualKeyCode: 46 },
  ARROWUP: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
  UP: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
  ARROWDOWN: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
  DOWN: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
  ARROWLEFT: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
  LEFT: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
  ARROWRIGHT: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
  RIGHT: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
  HOME: { key: 'Home', code: 'Home', virtualKeyCode: 36 },
  END: { key: 'End', code: 'End', virtualKeyCode: 35 },
  PAGEUP: { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 },
  PAGEDOWN: { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectNumber(value: unknown, key: string): number | null {
  return isRecord(value) ? finiteOrNull(value[key]) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
