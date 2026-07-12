/**
 * Overlay window management: one transparent, click-through, always-on-top
 * window per display, covering the full display bounds. Handles display
 * hotplug (add/remove/metrics change).
 *
 * Overlays are NEVER focusable and never intercept mouse input (hard rule).
 */

import { BrowserWindow, screen } from 'electron';
import type { Display } from 'electron';
import { join } from 'node:path';
import type { MainToOverlayChannel, MainToOverlayEvents } from '../../shared/ipc';

export class OverlayManager {
  /** displayId -> window */
  private windows = new Map<number, BrowserWindow>();
  /** displayId -> screenIndex used in capture labeling. */
  private indexByDisplayId = new Map<number, number>();
  private started = false;

  /** Create overlays for all current displays and start watching hotplug. */
  start(): void {
    if (this.started) return;
    this.started = true;
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

  destroy(): void {
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
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Belt-and-braces: bounds again after frameless quirks on scaled displays.
    win.setBounds(display.bounds);

    const query = `?screenIndex=${screenIndex}`;
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html${query}`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay/index.html'), {
        search: query,
      });
    }

    win.once('ready-to-show', () => win.showInactive());
    return win;
  }
}
