/**
 * Settings + audio-host window (M21: the chat panel is GONE — no transcript,
 * no composer, no helper-buddy view; the whisper and the overlay carry those).
 * This ~380x520 frameless window survives for exactly two jobs:
 *
 * 1. HIDDEN AUDIO HOST — `start()` pre-creates the window at app-ready and
 *    keeps it alive so its renderer can capture microphone audio the moment
 *    the push-to-talk hotkey goes down, and play the model's voice.
 *    `backgroundThrottling: false` keeps AudioWorklets running while hidden.
 * 2. SETTINGS SURFACE — shown from the tray's Settings item (plus the
 *    first-run and actionable-error showOnce budgets); hides on blur.
 *
 * The dev/QA env flags (CLICKY_SHOW_PANEL, CLICKY_KEEP_PANEL_OPEN,
 * CLICKY_TEST_CAPTURE, CLICKY_TEST_MIC) are read by the composition root
 * (index.ts via env.ts) and arrive here as PanelManagerOptions.
 */

import { app, screen } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PANEL_HEIGHT, PANEL_WIDTH } from '../../shared/constants';
import type { MainToPanelChannel, MainToPanelEvents } from '../../shared/ipc';
import type {
  ActionableErrorKind,
  ActionableErrorIdentity,
  ActionableErrorNotice,
  ActionableErrorState,
} from '../../shared/types';
import {
  createHardenedWindow,
  hardenedWebPreferences,
  loadRendererPage,
  TASKBAR_SAFE_TOPMOST_LEVEL,
} from './common';
import {
  CRASH_LOOP_MAX_RECREATES,
  CRASH_LOOP_WINDOW_MS,
  CrashLoopGuard,
  recoverOnRenderProcessGone,
} from './harden';
import { wireCaptureTest } from './panel-capture-test';
import type { PanelCaptureTestOptions } from './panel-capture-test';
import { positionBuddyPanel } from './buddy-panel-position';

const MARGIN = 12;

/** Delay before the first-run auto-show (lets the tray/overlays settle). */
const FIRST_RUN_SHOW_DELAY_MS = 1500;

export interface PanelManagerOptions {
  /** CLICKY_SHOW_PANEL=1: show the panel on launch (it still hides on blur). */
  showOnLaunch?: boolean;
  /** CLICKY_KEEP_PANEL_OPEN=1: don't hide on blur (visual QA only). */
  keepOpenOnBlur?: boolean;
  /** CLICKY_TEST_CAPTURE=1: hidden-window mic capture QA (panel-capture-test.ts). */
  captureTest?: PanelCaptureTestOptions | null;
}

/**
 * Module-level handle so sibling main modules (e.g. conversation-side "show
 * the panel when a turn fails with no API key") can surface the panel once
 * without bootstrap wiring changes.
 */
let activePanel: PanelManager | null = null;

/**
 * Show the panel at most once per app run PER REASON (an error-catalog kind,
 * or 'first-run'). Delegates to the live PanelManager (which owns the M11
 * per-reason budget).
 */
export type PanelShowReason = 'first-run' | ActionableErrorKind;

export function showPanelOnce(reason: PanelShowReason = 'first-run'): void {
  activePanel?.showOnce(reason);
}

/** Retain and push the newest user-repairable failure into Settings. */
export function presentPanelActionableError(notice: ActionableErrorNotice): void {
  activePanel?.presentActionableError(notice);
}

/** Snapshot one exact current notice before starting asynchronous repair work. */
export function currentPanelActionableError(
  kinds: readonly ActionableErrorKind[],
): ActionableErrorIdentity | null {
  return activePanel?.currentActionableError(kinds) ?? null;
}

/** Clear one exact notice after the corresponding repair succeeds. */
export function resolvePanelActionableError(expected: ActionableErrorIdentity | null): void {
  if (expected !== null) activePanel?.resolveActionableError(expected);
}

/**
 * M16: toggle the control panel from a sibling main module (the overlay's
 * buddy-click). Routes to the live PanelManager singleton — same show/hide +
 * tray positioning + topmost re-assert the tray click uses. Replaces the M15
 * findPanelWindow-by-URL workaround now that panel.ts is integration-owned.
 */
export function togglePanel(): void {
  activePanel?.toggle();
}

/** Open Settings beside a right-clicked Buddy without toggle semantics. */
export function showPanelNearBuddy(anchor: Rectangle): void {
  activePanel?.showNearBuddy(anchor);
}

export class PanelManager {
  private win: BrowserWindow | null = null;
  private ignoreBlurUntil = 0;
  private panelLoaded = false;
  private pendingInactiveShow = false;
  private crashGuard = new CrashLoopGuard(CRASH_LOOP_MAX_RECREATES, CRASH_LOOP_WINDOW_MS, 'panel');
  /** M11: crash recovery gave up — index.ts surfaces it via the tray. */
  private fatalCb: (() => void) | null = null;
  /** M11: fired on every panel did-finish-load (transcript replay etc.). */
  private rendererReadyCb: (() => void) | null = null;
  /**
   * M11: one auto-show budget PER REASON (error kind or 'first-run') instead
   * of a single boolean — the first-run discoverability show no longer
   * consumes the error budget, and each error kind can surface the panel once
   * per run.
   */
  private readonly shownForReason = new Set<PanelShowReason>();
  /** Monotonic persistent repair state, replayed after panel renderer reloads. */
  private actionableErrorValue: ActionableErrorState = { revision: 0, notice: null };

  constructor(private readonly options: PanelManagerOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level singleton handle (see showPanelOnce/togglePanel)
    activePanel = this;
  }

  /**
   * Pre-create the (hidden) window as soon as the app is ready so the
   * renderer is alive for hotkey-driven mic capture and permission pre-warm.
   */
  start(): void {
    void app.whenReady().then(() => {
      // First run: no settings file yet (SettingsStore only writes on first
      // save). Deliberately a bare fs check — settings.ts internals stay
      // private. Auto-show the panel shortly after boot so a brand-new user
      // discovers the UI (it otherwise hides behind a tray icon).
      const firstRun = !existsSync(join(app.getPath('userData'), 'settings.json'));
      const win = this.ensureWindow();
      if (this.options.showOnLaunch) {
        win.webContents.once('did-finish-load', () => this.show());
      } else if (firstRun) {
        win.webContents.once('did-finish-load', () => {
          setTimeout(() => this.showOnce(), FIRST_RUN_SHOW_DELAY_MS);
        });
      }
    });
  }

  /**
   * M11: called when the panel renderer crashed repeatedly and recovery gave
   * up. The dead window has been destroyed; the next tray click recreates a
   * fresh one (bypassing the guard — a manual recreate is a user decision).
   */
  onFatal(cb: () => void): void {
    this.fatalCb = cb;
  }

  /** M11: called whenever the panel renderer finishes loading (incl. after a
   *  crash-recreate) — main replays the transcript ring + status snapshots. */
  onRendererReady(cb: () => void): void {
    this.rendererReadyCb = cb;
  }

  isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  toggle(anchor?: Rectangle): void {
    if (this.isVisible()) {
      this.hide();
    } else {
      this.show(anchor);
    }
  }

  show(anchor?: Rectangle): void {
    this.present(anchor, false);
  }

  /** Show Settings beside an explicit Buddy context-click. */
  showNearBuddy(anchor: Rectangle): void {
    this.present(anchor, true);
  }

  private present(anchor: Rectangle | undefined, besideBuddy: boolean): void {
    this.ignoreBlurUntil = 0;
    this.pendingInactiveShow = false;
    const win = this.ensureWindow();
    this.positionWindow(win, anchor, besideBuddy);
    win.show();
    this.positionWindow(win, anchor, besideBuddy);
    this.stabilizePosition(win, anchor, besideBuddy);
    win.focus();
    this.reassertTopmost(win);
  }

  /** Show without stealing focus (first-run auto-show, background surfacing). */
  showInactive(): void {
    const win = this.ensureWindow();
    if (!this.panelLoaded) {
      this.pendingInactiveShow = true;
      return;
    }
    this.presentInactive(win);
  }

  /**
   * Auto-surface the panel at most once per app run per `reason` (first-run
   * discoverability + hidden-failure surfacing: the panel otherwise only ever
   * opens via a tray click). Uses the focus-less show — this fires while the
   * user may be mid-typing elsewhere, and Windows' focus-steal prevention
   * would otherwise demote the window (drop topmost + bury it at the bottom
   * of the z-order).
   */
  showOnce(reason: PanelShowReason = 'first-run'): void {
    if (this.shownForReason.has(reason)) return;
    this.shownForReason.add(reason);
    this.showInactive();
  }

  actionableErrorState(): ActionableErrorState {
    return {
      revision: this.actionableErrorValue.revision,
      notice: this.actionableErrorValue.notice ? { ...this.actionableErrorValue.notice } : null,
    };
  }

  presentActionableError(notice: ActionableErrorNotice): void {
    this.actionableErrorValue = {
      revision: this.actionableErrorValue.revision + 1,
      notice: { ...notice },
    };
    this.send('panel:actionable-error', this.actionableErrorState());
  }

  currentActionableError(kinds: readonly ActionableErrorKind[]): ActionableErrorIdentity | null {
    const notice = this.actionableErrorValue.notice;
    if (notice === null || !kinds.includes(notice.kind)) return null;
    return { revision: this.actionableErrorValue.revision, kind: notice.kind };
  }

  resolveActionableError(expected: ActionableErrorIdentity): boolean {
    if (!this.matchesActionableError(expected)) return false;
    this.actionableErrorValue = {
      revision: this.actionableErrorValue.revision + 1,
      notice: null,
    };
    this.send('panel:actionable-error', this.actionableErrorState());
    return true;
  }

  /**
   * Main-owned recovery signals are synchronous with this state owner, so
   * they can safely snapshot and clear the current matching kind in one call.
   */
  resolveCurrentActionableError(kinds: readonly ActionableErrorKind[]): boolean {
    const expected = this.currentActionableError(kinds);
    return expected !== null && this.resolveActionableError(expected);
  }

  /** User acknowledgement is deliberately distinct from successful repair. */
  dismissActionableError(expected: ActionableErrorIdentity): boolean {
    return this.resolveActionableError(expected);
  }

  private matchesActionableError(expected: ActionableErrorIdentity): boolean {
    return (
      expected !== null &&
      typeof expected === 'object' &&
      Number.isSafeInteger(expected.revision) &&
      typeof expected.kind === 'string' &&
      this.actionableErrorValue.revision === expected.revision &&
      this.actionableErrorValue.notice?.kind === expected.kind
    );
  }

  hide(): void {
    this.pendingInactiveShow = false;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /**
   * Live-desktop approval is clicked inside this focusable window. Remove it
   * before the action gate's fresh receiver inspection, then give the OS one
   * compositor beat to restore the underlying application. A window that
   * remains visible fails closed instead of receiving Buddy's own input.
   */
  async prepareForLiveActionDispatch(): Promise<void> {
    this.hide();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      throw new Error('approval panel could not be hidden before desktop input');
    }
  }

  /** Send a typed event to the panel (no-op if never opened). */
  send<C extends MainToPanelChannel>(channel: C, payload: MainToPanelEvents[C]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy(): void {
    if (activePanel === this) activePanel = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // -------------------------------------------------------------------------

  /**
   * Windows silently drops the real HWND topmost bit when a background
   * process shows a window (focus-steal prevention / fullscreen-app
   * protection), while Electron's cached always-on-top state still says true
   * — so a plain setAlwaysOnTop(true) no-ops. Toggle it off and re-assert in
   * the taskbar-safe topmost band, then verify once more a beat later.
   */
  private reassertTopmost(win: BrowserWindow): void {
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
    setTimeout(() => {
      if (!win.isDestroyed() && win.isVisible() && !win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
      }
    }, 300);
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.panelLoaded = false;

    // Dev/unpacked runs: give the window the buddy icon (packaged builds get
    // it from the exe resources via electron-builder's win.icon).
    const iconPath = join(
      app.getAppPath(),
      'build',
      process.platform === 'darwin' ? 'icon.icns' : 'icon.ico',
    );
    const win = createHardenedWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      ...(existsSync(iconPath) ? { icon: iconPath } : {}),
      // Keep the renderer (and its AudioWorklets) running at full speed
      // while the window is hidden — mic capture must work unseen.
      webPreferences: hardenedWebPreferences('panel.js'),
    });

    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    // Crash recovery: a dead panel renderer silently kills mic capture AND
    // model-voice playback (both live in this renderer). Recreate, preserving
    // visibility (bounded by crashGuard).
    recoverOnRenderProcessGone(
      win,
      this.crashGuard,
      'panel',
      () => {
        const wasVisible = !win.isDestroyed() && win.isVisible();
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        const fresh = this.ensureWindow();
        if (wasVisible) {
          fresh.webContents.once('did-finish-load', () => this.show());
        }
      },
      // M11 fix (renderer_dead): the guard gave up — WITHOUT this, a zombie
      // BrowserWindow with a gone renderer lingered forever (voice + playback
      // dead, tray click showed an empty shell). Destroy + null it so the
      // next tray click recreates from scratch, and let index.ts surface the
      // failure via the tray (balloon + tooltip).
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        this.fatalCb?.();
      },
    );

    // M11: notify main wiring on every renderer load (first boot AND
    // crash-recreates) so the transcript ring / status can be replayed —
    // entries pushed before the renderer existed are otherwise lost.
    win.webContents.on('did-finish-load', () => {
      if (this.win !== win) return;
      this.panelLoaded = true;
      this.send('panel:actionable-error', this.actionableErrorState());
      this.rendererReadyCb?.();
      if (this.pendingInactiveShow) {
        this.pendingInactiveShow = false;
        this.presentInactive(win);
      }
    });

    win.on('blur', () => {
      if (this.options.keepOpenOnBlur) return; // explicit visual QA mode: keep the panel up
      if (Date.now() < this.ignoreBlurUntil) return;
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isFocused()) win.hide();
      }, 100);
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.panelLoaded = false;
      }
    });

    if (this.options.captureTest) {
      wireCaptureTest(
        win,
        (payload) => this.send('audio:capture', payload),
        this.options.captureTest,
      );
    }

    loadRendererPage(win, 'panel');

    this.win = win;
    return win;
  }

  /** Bottom-right of the primary display's work area — near the Windows tray. */
  private presentInactive(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.positionNearTray(win);
    this.ignoreBlurUntil = Date.now() + 1_000;
    win.showInactive();
    this.positionNearTray(win);
    this.stabilizePosition(win);
    this.reassertTopmost(win);
  }

  private stabilizePosition(win: BrowserWindow, anchor?: Rectangle, besideBuddy = false): void {
    for (const delay of [100, 400, 1_000]) {
      setTimeout(() => {
        if (!win.isDestroyed() && win.isVisible()) this.positionWindow(win, anchor, besideBuddy);
      }, delay);
    }
  }

  private positionWindow(win: BrowserWindow, anchor?: Rectangle, besideBuddy = false): void {
    if (besideBuddy && anchor) {
      const display = screen.getDisplayMatching(anchor);
      const position = positionBuddyPanel(anchor, display.workArea, {
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT,
      });
      win.setPosition(position.x, position.y);
      return;
    }
    this.positionNearTray(win, anchor);
  }

  private positionNearTray(win: BrowserWindow, anchor?: Rectangle): void {
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    if (process.platform === 'darwin') {
      const { bounds, workArea } = display;
      const anchorCenter = anchor ? anchor.x + anchor.width / 2 : bounds.x + bounds.width;
      const x = Math.min(
        Math.max(Math.round(anchorCenter - PANEL_WIDTH / 2), bounds.x + MARGIN),
        bounds.x + bounds.width - PANEL_WIDTH - MARGIN,
      );
      win.setPosition(x, Math.round(Math.max(bounds.y, workArea.y) + MARGIN));
      return;
    }
    const { workArea } = display;
    win.setPosition(
      Math.round(workArea.x + workArea.width - PANEL_WIDTH - MARGIN),
      Math.round(workArea.y + workArea.height - PANEL_HEIGHT - MARGIN),
    );
  }
}
