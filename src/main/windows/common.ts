/**
 * Shared construction helpers for Buddy BrowserWindows, so the
 * hardening (navigation lockdown, sandboxed webPreferences) and the
 * dev-server-vs-packaged page loading live in exactly one place.
 *
 * Kept separate from harden.ts on purpose: harden.ts only imports Electron
 * TYPES (its CrashLoopGuard is unit-tested without an Electron runtime); this
 * module needs the real BrowserWindow.
 */

import { BrowserWindow } from 'electron';
import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron';
import { join } from 'node:path';
import { lockdownNavigation } from './harden';

/**
 * Keep Buddy above ordinary application windows without crossing above the
 * Windows taskbar. Electron's `screen-saver` band sits above the taskbar and a
 * full-display overlay in that band can make the shell demote the taskbar as
 * though a fullscreen app were active.
 */
export const TASKBAR_SAFE_TOPMOST_LEVEL = 'floating' as const;

/**
 * The webPreferences every Buddy renderer window uses: contextIsolation on,
 * sandboxed, no nodeIntegration (hard rules), and no background throttling —
 * the overlay animates while never focused, and the hidden panel must keep
 * its AudioWorklets (mic capture + playback) running at full speed.
 */
export function hardenedWebPreferences(preloadFile: string): WebPreferences {
  return {
    preload: join(__dirname, '../preload', preloadFile),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  };
}

/** Construct a BrowserWindow with navigation lockdown applied immediately. */
export function createHardenedWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow(options);
  lockdownNavigation(win);
  return win;
}

/**
 * Load a renderer page: the electron-vite dev server when
 * ELECTRON_RENDERER_URL is set, the packaged file otherwise. `search` is the
 * optional `?a=b` query string (overlay residency snapshot).
 */
export function loadRendererPage(
  win: BrowserWindow,
  page: 'overlay' | 'panel' | 'approval' | 'whisper' | 'markdown',
  search?: string,
): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}/index.html${search ?? ''}`);
  } else if (search) {
    void win.loadFile(join(__dirname, `../renderer/${page}/index.html`), { search });
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}/index.html`));
  }
}
