/**
 * Overlay window management: one transparent, click-through, always-on-top
 * window per display, covering the full display bounds. Handles display
 * hotplug (add/remove/metrics change).
 *
 * Overlays are NEVER focusable and never intercept mouse input (hard rule).
 *
 * Buddy residency rule (M2): at rest the buddy lives on the PRIMARY display's
 * overlay only. A pointer 'animate' command shows/moves it on the addressed
 * display and hides it everywhere else; 'idle' returns it to the primary
 * rest corner; 'hide' fades it out everywhere. `routePointer` is the single
 * entry point that enforces this — production dispatch and the debug server
 * both go through it.
 */

import { BrowserWindow, screen } from 'electron';
import type { Display } from 'electron';
import { join } from 'node:path';
import type { MainToOverlayChannel, MainToOverlayEvents } from '../../shared/ipc';
import type { PointerCommand } from '../../shared/types';
import { CrashLoopGuard, lockdownNavigation, recoverOnRenderProcessGone } from './harden';

/**
 * Module-level handle to the started manager so sibling main modules (e.g.
 * the debug server) can reach the overlays without bootstrap wiring changes.
 */
let activeManager: OverlayManager | null = null;

export function getOverlayManager(): OverlayManager | null {
  return activeManager;
}

export class OverlayManager {
  /** displayId -> window */
  private windows = new Map<number, BrowserWindow>();
  /** displayId -> screenIndex used in capture labeling. */
  private indexByDisplayId = new Map<number, number>();
  private started = false;
  /** Crash recovery budget shared across ALL overlay windows. */
  private crashGuard = new CrashLoopGuard(3, 5 * 60_000, 'overlay');

  /** Create overlays for all current displays and start watching hotplug. */
  start(): void {
    if (this.started) return;
    this.started = true;
    activeManager = this;
    this.syncDisplays();
    screen.on('display-added', () => this.syncDisplays());
    screen.on('display-removed', () => this.syncDisplays());
    screen.on('display-metrics-changed', () => this.syncDisplays());
  }

  /** Number of live overlay windows (debug /state). */
  count(): number {
    return [...this.windows.values()].filter((w) => !w.isDestroyed()).length;
  }

  /** Send a typed event to every overlay window. */
  broadcast<C extends MainToOverlayChannel>(channel: C, payload: MainToOverlayEvents[C]): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  /** Send a typed event to the overlay covering one screenIndex. */
  sendTo<C extends MainToOverlayChannel>(
    screenIndex: number,
    channel: C,
    payload: MainToOverlayEvents[C],
  ): void {
    for (const [displayId, index] of this.indexByDisplayId) {
      if (index !== screenIndex) continue;
      const win = this.windows.get(displayId);
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  /**
   * Route a pointer command per the buddy residency rule:
   * - 'animate' → addressed screenIndex gets the command, all others 'hide'
   * - 'idle'    → primary display gets 'idle' (rest corner), others 'hide'
   * - 'hide'    → everyone hides
   */
  routePointer(cmd: PointerCommand): void {
    if (cmd.type === 'animate') {
      for (const [displayId, index] of this.indexByDisplayId) {
        const win = this.windows.get(displayId);
        if (!win || win.isDestroyed()) continue;
        win.webContents.send(
          'overlay:pointer',
          index === cmd.screenIndex ? cmd : ({ type: 'hide' } satisfies PointerCommand),
        );
      }
    } else if (cmd.type === 'idle') {
      const primaryId = screen.getPrimaryDisplay().id;
      for (const [displayId, win] of this.windows) {
        if (win.isDestroyed()) continue;
        win.webContents.send(
          'overlay:pointer',
          displayId === primaryId ? cmd : ({ type: 'hide' } satisfies PointerCommand),
        );
      }
    } else {
      this.broadcast('overlay:pointer', cmd);
    }
  }

  destroy(): void {
    if (activeManager === this) activeManager = null;
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
    this.indexByDisplayId.clear();
  }

  // -------------------------------------------------------------------------

  /** Reconcile windows with the current display set. */
  private syncDisplays(): void {
    const displays = screen.getAllDisplays();
    const liveIds = new Set(displays.map((d) => d.id));

    // Remove overlays for departed displays.
    for (const [displayId, win] of this.windows) {
      if (!liveIds.has(displayId)) {
        if (!win.isDestroyed()) win.destroy();
        this.windows.delete(displayId);
      }
    }

    // Stable screenIndex assignment: order of screen.getAllDisplays().
    this.indexByDisplayId.clear();
    displays.forEach((display, index) => {
      this.indexByDisplayId.set(display.id, index);
      const existing = this.windows.get(display.id);
      if (existing && !existing.isDestroyed()) {
        existing.setBounds(display.bounds);
      } else {
        this.windows.set(display.id, this.createWindow(display, index));
      }
    });
  }

  private createWindow(display: Display, screenIndex: number): BrowserWindow {
    const isPrimary = screen.getPrimaryDisplay().id === display.id;
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      focusable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep animations running while the (never-focused) overlay is "unfocused".
        backgroundThrottling: false,
      },
    });

    lockdownNavigation(win);
    // Crash recovery: a dead overlay renderer = invisible buddy. Drop the dead
    // window and let syncDisplays build a fresh one (bounded by crashGuard).
    recoverOnRenderProcessGone(win, this.crashGuard, `overlay(display ${display.id})`, () => {
      if (!win.isDestroyed()) win.destroy();
      if (this.windows.get(display.id) === win) this.windows.delete(display.id);
      this.syncDisplays();
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    // Click-through at the OS level; no forwarding — the overlay never reacts
    // to the mouse, so forwarding move events would only burn CPU.
    win.setIgnoreMouseEvents(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Belt-and-braces: bounds again after frameless quirks on scaled displays.
    win.setBounds(display.bounds);

    // Known limitation: ?screenIndex/?primary are creation-time snapshots and
    // go stale if displays are re-ordered while the window lives. Harmless
    // today — routing/residency are enforced main-side (routePointer +
    // did-finish-load below); the renderer only uses ?primary as its
    // pre-subscription default. A live update would need a new shared IPC
    // channel (src/shared/ipc.ts is frozen), so it is documented instead.
    // CLICKY_BOB_IDLE_MS: test hook to shrink the renderer's idle bob-pause
    // timeout (default 5min) without a rebuild.
    const bobIdleMs = Number(process.env['CLICKY_BOB_IDLE_MS']);
    const query =
      `?screenIndex=${screenIndex}&primary=${isPrimary ? '1' : '0'}` +
      (Number.isFinite(bobIdleMs) && bobIdleMs > 0 ? `&bobIdleMs=${bobIdleMs}` : '');
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html${query}`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay/index.html'), {
        search: query,
      });
    }

    // Authoritative initial residency (the ?primary flag is the renderer's
    // pre-subscription default; this message settles any race).
    win.webContents.on('did-finish-load', () => {
      const primaryNow = screen.getPrimaryDisplay().id === display.id;
      win.webContents.send('overlay:pointer', {
        type: primaryNow ? 'idle' : 'hide',
      } satisfies PointerCommand);
    });

    win.once('ready-to-show', () => win.showInactive());
    return win;
  }
}
