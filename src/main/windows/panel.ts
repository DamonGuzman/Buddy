/**
 * Panel window: ~380x520 frameless control panel toggled from the tray.
 * Hides on blur. Positioned near the tray (bottom-right work area).
 *
 * M5: the window is created at app start and kept alive hidden, so the panel
 * renderer exists to capture microphone audio the moment the push-to-talk
 * hotkey goes down — even if the user never opened the panel.
 * `backgroundThrottling: false` keeps AudioWorklets running while hidden.
 *
 * Env flags (dev/testing):
 * - CLICKY_SHOW_PANEL=1  → show the panel on launch (it still hides on blur).
 * - CLICKY_SHOW_SETTINGS=1 → show the panel directly on Settings (visual QA).
 * - CLICKY_KEEP_PANEL_OPEN=1 → don't hide on blur (visual QA only).
 * - CLICKY_TEST_CAPTURE=1 → after load, send a capture start/stop cycle to the
 *                          hidden renderer and mirror its console to stdout
 *                          (proves hidden-window mic capture end-to-end).
 * - CLICKY_USER_DATA=dir  → use a separate userData dir (settings + the
 *                          single-instance lock), so parallel dev instances
 *                          don't fight over the lock. Applied in index.ts
 *                          bootstrap, before the single-instance lock (M6).
 */

import { app, BrowserWindow, screen } from 'electron';
import type { Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PANEL_HEIGHT, PANEL_WIDTH } from '../../shared/constants';
import type { MainToPanelChannel, MainToPanelEvents } from '../../shared/ipc';
import { CrashLoopGuard, lockdownNavigation, recoverOnRenderProcessGone } from './harden';

const MARGIN = 12;

const SHOW_ON_LAUNCH = process.env['CLICKY_SHOW_PANEL'] === '1';
const SHOW_SETTINGS_ON_LAUNCH = process.env['CLICKY_SHOW_SETTINGS'] === '1';
const KEEP_PANEL_OPEN = process.env['CLICKY_KEEP_PANEL_OPEN'] === '1';
const TEST_CAPTURE = process.env['CLICKY_TEST_CAPTURE'] === '1';

/** Delay before the first-run auto-show (lets the tray/overlays settle). */
const FIRST_RUN_SHOW_DELAY_MS = 1500;

/**
 * Module-level handle so sibling main modules (e.g. conversation-side "show
 * the panel when a turn fails with no API key") can surface the panel once
 * without bootstrap wiring changes.
 */
let activePanel: PanelManager | null = null;
/**
 * M11: one auto-show budget PER REASON (error kind or 'first-run') instead of
 * a single boolean — the first-run discoverability show no longer consumes
 * the error budget, and each error kind can surface the panel once per run.
 */
const shownForReason = new Set<string>();

/**
 * Show the panel at most once per app run PER REASON (an error-catalog kind,
 * or 'first-run'). First-run discoverability + hidden-failure surfacing: the
 * panel otherwise only ever opens via a tray click.
 * Uses the focus-less show — this fires while the user may be mid-typing
 * elsewhere, and Windows' focus-steal prevention would otherwise demote the
 * window (drop topmost + bury it at the bottom of the z-order).
 */
export function showPanelOnce(reason = 'first-run'): void {
  if (shownForReason.has(reason) || !activePanel) return;
  shownForReason.add(reason);
  activePanel.showInactive();
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

/** Open the control panel without turning an already-visible panel into a close action. */
export function openPanel(): void {
  activePanel?.show();
}

export class PanelManager {
  private win: BrowserWindow | null = null;
  private requestedView: 'chat' | 'settings' = SHOW_SETTINGS_ON_LAUNCH ? 'settings' : 'chat';
  private ignoreBlurUntil = 0;
  private panelLoaded = false;
  private pendingInactiveShow = false;
  private crashGuard = new CrashLoopGuard(3, 5 * 60_000, 'panel');
  /** M11: crash recovery gave up — index.ts surfaces it via the tray. */
  private fatalCb: (() => void) | null = null;
  /** M11: fired on every panel did-finish-load (transcript replay etc.). */
  private rendererReadyCb: (() => void) | null = null;

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

  constructor() {
    activePanel = this;
    // Pre-create the (hidden) window as soon as the app is ready so the
    // renderer is alive for hotkey-driven mic capture and permission pre-warm.
    void app.whenReady().then(() => {
      // First run: no settings file yet (SettingsStore only writes on first
      // save). Deliberately a bare fs check — settings.ts internals stay
      // private. Auto-show the panel shortly after boot so a brand-new user
      // discovers the UI (it otherwise hides behind a tray icon).
      const firstRun = !existsSync(join(app.getPath('userData'), 'settings.json'));
      const win = this.ensureWindow();
      if (SHOW_SETTINGS_ON_LAUNCH) {
        win.webContents.once('did-finish-load', () => this.showSettings());
      } else if (SHOW_ON_LAUNCH) {
        win.webContents.once('did-finish-load', () => this.show());
      } else if (firstRun) {
        win.webContents.once('did-finish-load', () => {
          setTimeout(() => showPanelOnce(), FIRST_RUN_SHOW_DELAY_MS);
        });
      }
    });
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
    this.ignoreBlurUntil = 0;
    this.pendingInactiveShow = false;
    const win = this.ensureWindow();
    this.positionNearTray(win, anchor);
    win.show();
    // An all-Spaces NSWindow can be parked just beyond a fullscreen Space
    // while hidden. Re-apply bounds after show, when macOS accepts the target
    // display coordinates.
    this.positionNearTray(win, anchor);
    this.stabilizePosition(win, anchor);
    win.focus();
    this.reassertTopmost(win);
  }

  /** Open the persistent permission repair UI, including during first load. */
  showSettings(anchor?: Rectangle): void {
    this.requestedView = 'settings';
    const win = this.ensureWindow();
    this.show(anchor);
    const send = (): void => {
      if (!win.isDestroyed()) win.webContents.send('panel:show-settings', null);
    };
    if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send);
    else send();
  }

  requestedPanelView(): 'chat' | 'settings' {
    return this.requestedView;
  }

  /** Show without stealing focus (first-run auto-show, background surfacing). */
  showInactive(): void {
    const win = this.ensureWindow();
    // Permission diagnosis can finish before the hidden renderer's first
    // navigation. Electron's isLoading* values briefly read false during that
    // cold-launch gap, so use our did-finish-load latch instead of guessing.
    if (!this.panelLoaded) {
      this.pendingInactiveShow = true;
      return;
    }
    this.presentInactive(win);
  }

  /**
   * Windows silently drops the real HWND topmost bit when a background
   * process shows a window (focus-steal prevention / fullscreen-app
   * protection), while Electron's cached always-on-top state still says true
   * — so a plain setAlwaysOnTop(true) no-ops. Toggle it off and re-assert at
   * the same elevated z-band the overlay uses (which observably survives
   * those demotions), then verify once more a beat later.
   */
  private reassertTopmost(win: BrowserWindow): void {
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    setTimeout(() => {
      if (!win.isDestroyed() && win.isVisible() && !win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, 'screen-saver');
      }
    }, 300);
  }

  hide(): void {
    this.pendingInactiveShow = false;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
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
    const win = new BrowserWindow({
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
      webPreferences: {
        preload: join(__dirname, '../preload/panel.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep the renderer (and its AudioWorklets) running at full speed
        // while the window is hidden — mic capture must work unseen.
        backgroundThrottling: false,
      },
    });

    // Permission failures must remain actionable while the user is in a
    // fullscreen app (a common Buddy use case). Without this macOS silently
    // shows the panel on the ordinary desktop Space, making tray/Fix clicks
    // look broken even though the window did open.
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    lockdownNavigation(win);
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
      this.rendererReadyCb?.();
      if (this.pendingInactiveShow) {
        this.pendingInactiveShow = false;
        this.presentInactive(win);
      }
    });

    win.on('blur', () => {
      if (KEEP_PANEL_OPEN) return; // explicit visual QA mode: keep the panel up
      if (Date.now() < this.ignoreBlurUntil) return;
      // Promoting a showInactive/all-Spaces window can emit blur immediately
      // before focus. Defer dismissal long enough for the click target to
      // become key; genuine outside clicks remain unfocused and still close.
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

    if (TEST_CAPTURE) this.wireCaptureTest(win);

    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/panel/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/panel/index.html'));
    }

    this.win = win;
    return win;
  }

  private presentInactive(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.positionNearTray(win);
    // macOS emits a synthetic blur as a focus-less window is shown. Without
    // a short guard the generic hide-on-blur behavior closes an actionable
    // permission/error panel in the same tick, so it appears never to open.
    this.ignoreBlurUntil = Date.now() + 1_000;
    win.showInactive();
    this.positionNearTray(win);
    this.stabilizePosition(win);
    this.reassertTopmost(win);
  }

  /** macOS fullscreen Spaces may relocate an inactive window after show. */
  private stabilizePosition(win: BrowserWindow, anchor?: Rectangle): void {
    for (const delay of [100, 400, 1_000]) {
      setTimeout(() => {
        if (!win.isDestroyed() && win.isVisible()) this.positionNearTray(win, anchor);
      }, delay);
    }
  }

  /**
   * CLICKY_TEST_CAPTURE=1: mirror renderer console lines to stdout and run a
   * start→(6s)→stop capture cycle against the hidden window, so hidden-window
   * mic capture can be verified from a terminal without the hotkey wiring.
   */
  private wireCaptureTest(win: BrowserWindow): void {
    win.webContents.on('console-message', (details) => {
      console.log(`[panel-console] ${details.message}`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          // CLICKY_TEST_MIC=<label substring> → select that device first via
          // the real renderer-side flow (enumerateDevices + clicky.selectMic).
          const micMatch = process.env['CLICKY_TEST_MIC'];
          if (micMatch) {
            const picked: unknown = await win.webContents.executeJavaScript(
              `(async () => {
                 const devs = await navigator.mediaDevices.enumerateDevices();
                 const m = devs.find(
                   (d) =>
                     d.kind === 'audioinput' &&
                     d.label.toLowerCase().includes(${JSON.stringify(micMatch.toLowerCase())}),
                 );
                 if (m) await window.clicky.selectMic(m.deviceId);
                 return m
                   ? m.label
                   : 'no match in: ' +
                       devs
                         .filter((d) => d.kind === 'audioinput')
                         .map((d) => d.label || d.deviceId)
                         .join(' | ');
               })()`,
            );
            console.log('[capture-test] selected mic:', picked ?? '(no match, using default)');
          }
          console.log(
            '[capture-test] sending audio:capture start (window hidden:',
            !win.isVisible(),
            ')',
          );
          this.send('audio:capture', { command: 'start' });
          setTimeout(() => {
            console.log('[capture-test] sending audio:capture stop');
            this.send('audio:capture', { command: 'stop' });
            // Phase 2: synthetic tone through the same worklet pipeline
            // (nonzero-signal proof independent of mic hardware).
            setTimeout(() => {
              console.log('[capture-test] starting dev tone capture');
              void win.webContents.executeJavaScript(
                `window.__clickyDev && window.__clickyDev.captureTone()`,
              );
              setTimeout(() => {
                console.log('[capture-test] stopping dev tone capture');
                void win.webContents.executeJavaScript(
                  `window.__clickyDev && window.__clickyDev.stopCapture()`,
                );
                // Phase 3: playback QA (gapless + flush + stale-item drop).
                void win.webContents
                  .executeJavaScript(
                    `window.__clickyDev ? window.__clickyDev.playbackQa() : 'dev hooks unavailable'`,
                  )
                  .then((marks) => console.log('[capture-test] playback drain marks (ms):', marks));
              }, 3000);
            }, 1000);
          }, 6000);
        })();
      }, 2500);
    });
  }

  /** Position by the menu-bar icon on macOS or the Windows notification area. */
  private positionNearTray(win: BrowserWindow, anchor?: Rectangle): void {
    if (process.platform === 'darwin') {
      const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
      const { bounds, workArea } = display;
      // Fullscreen/remote-desktop Spaces can report a transient workArea
      // wider than the actual display. Horizontal placement must use bounds
      // or the panel is clamped just beyond the visible right edge.
      const anchorCenter = anchor ? anchor.x + anchor.width / 2 : bounds.x + bounds.width;
      const x = Math.min(
        Math.max(Math.round(anchorCenter - PANEL_WIDTH / 2), bounds.x + MARGIN),
        bounds.x + bounds.width - PANEL_WIDTH - MARGIN,
      );
      win.setPosition(x, Math.round(Math.max(bounds.y, workArea.y) + MARGIN));
      return;
    }
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    const { workArea } = display;
    win.setPosition(
      Math.round(workArea.x + workArea.width - PANEL_WIDTH - MARGIN),
      Math.round(workArea.y + workArea.height - PANEL_HEIGHT - MARGIN),
    );
  }
}
