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
 * - CLICKY_SHOW_PANEL=1  → show the panel on launch and don't hide on blur
 *                          (useful for screenshots / visual QA).
 * - CLICKY_TEST_CAPTURE=1 → after load, send a capture start/stop cycle to the
 *                          hidden renderer and mirror its console to stdout
 *                          (proves hidden-window mic capture end-to-end).
 * - CLICKY_USER_DATA=dir  → use a separate userData dir (settings + the
 *                          single-instance lock), so parallel dev instances
 *                          don't fight over the lock. Applied in index.ts
 *                          bootstrap, before the single-instance lock (M6).
 */

import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { PANEL_HEIGHT, PANEL_WIDTH } from '../../shared/constants';
import type { MainToPanelChannel, MainToPanelEvents } from '../../shared/ipc';

const MARGIN = 12;

const SHOW_ON_LAUNCH = process.env['CLICKY_SHOW_PANEL'] === '1';
const TEST_CAPTURE = process.env['CLICKY_TEST_CAPTURE'] === '1';

export class PanelManager {
  private win: BrowserWindow | null = null;

  constructor() {
    // Pre-create the (hidden) window as soon as the app is ready so the
    // renderer is alive for hotkey-driven mic capture and permission pre-warm.
    void app.whenReady().then(() => {
      const win = this.ensureWindow();
      if (SHOW_ON_LAUNCH) {
        win.webContents.once('did-finish-load', () => this.show());
      }
    });
  }

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
        // Keep the renderer (and its AudioWorklets) running at full speed
        // while the window is hidden — mic capture must work unseen.
        backgroundThrottling: false,
      },
    });

    win.on('blur', () => {
      if (SHOW_ON_LAUNCH) return; // visual QA mode: keep the panel up
      if (!win.isDestroyed()) win.hide();
    });
    win.on('closed', () => {
      this.win = null;
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

  /** Bottom-right of the primary display's work area — near the Windows tray. */
  private positionNearTray(win: BrowserWindow): void {
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(
      Math.round(workArea.x + workArea.width - PANEL_WIDTH - MARGIN),
      Math.round(workArea.y + workArea.height - PANEL_HEIGHT - MARGIN),
    );
  }
}
