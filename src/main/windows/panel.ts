/**
 * Panel window: ~380x520 frameless control panel toggled from the tray.
 * Hides on blur. Positioned near the tray (bottom-right work area).
 */

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { PANEL_HEIGHT, PANEL_WIDTH } from '../../shared/constants';
import type { MainToPanelChannel, MainToPanelEvents } from '../../shared/ipc';

const MARGIN = 12;

export class PanelManager {
  private win: BrowserWindow | null = null;

  isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  toggle(): void {
    if (this.isVisible()) {
      this.hide();
    } else {
      this.show();
    }
  }

  show(): void {
    const win = this.ensureWindow();
    this.positionNearTray(win);
    win.show();
    win.focus();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Send a typed event to the panel (no-op if never opened). */
  send<C extends MainToPanelChannel>(channel: C, payload: MainToPanelEvents[C]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // -------------------------------------------------------------------------

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

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
      webPreferences: {
        preload: join(__dirname, '../preload/panel.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.on('blur', () => {
      if (!win.isDestroyed()) win.hide();
    });
    win.on('closed', () => {
      this.win = null;
    });

    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/panel/index.html`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/panel/index.html'));
    }

    this.win = win;
    return win;
  }

  /** Bottom-right of the primary display's work area — near the Windows tray. */
  private positionNearTray(win: BrowserWindow): void {
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(
      Math.round(workArea.x + workArea.width - PANEL_WIDTH - MARGIN),
      Math.round(workArea.y + workArea.height - PANEL_HEIGHT - MARGIN),
    );
  }
}
