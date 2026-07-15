/**
 * Shared window hardening + crash recovery for the overlay and panel windows.
 *
 * - Navigation lockdown: window.open is always denied; will-navigate is
 *   cancelled unless the target is the window's own loaded file / dev-server
 *   URL (i.e. a reload of itself).
 * - Crash-loop guard: render-process-gone recovery is capped so a renderer
 *   that dies on boot can't spin destroy/create forever.
 */

import type { BrowserWindow, RenderProcessGoneDetails } from 'electron';

/**
 * Deny popups and any navigation away from the URL the window itself loaded.
 * Reloads (same URL) stay allowed so crash recovery / devtools reloads work.
 */
export function lockdownNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const own = win.webContents.getURL();
    if (url !== own) {
      console.warn(`[windows] blocked navigation to ${url}`);
      event.preventDefault();
    }
  });
}

/** Default recreate budget shared by the overlay + panel guards. */
export const CRASH_LOOP_MAX_RECREATES = 3;
/** Default sliding window for the recreate budget. */
export const CRASH_LOOP_WINDOW_MS = 5 * 60_000;

/** Sliding-window crash counter: at most `max` recoveries per `windowMs`. */
export class CrashLoopGuard {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly max = CRASH_LOOP_MAX_RECREATES,
    private readonly windowMs = CRASH_LOOP_WINDOW_MS,
    private readonly label = 'renderer',
  ) {}

  /** Record a crash; true when recreation is still allowed. */
  allowRecreate(details: RenderProcessGoneDetails): boolean {
    const now = Date.now();
    while (this.timestamps.length > 0 && now - (this.timestamps[0] ?? 0) > this.windowMs) {
      this.timestamps.shift();
    }
    this.timestamps.push(now);
    if (this.timestamps.length > this.max) {
      console.error(
        `[windows] ${this.label} renderer crashed ${this.timestamps.length} times in ` +
          `${Math.round(this.windowMs / 60_000)}min (last reason: ${details.reason}) — ` +
          'giving up on recreation.',
      );
      return false;
    }
    return true;
  }
}

/**
 * Recreate-on-crash wiring. `recreate` must fully replace the window (destroy
 * the dead one and build a fresh one). 'clean-exit' is a normal teardown and
 * is ignored. When the guard gives up, `onGiveUp` (if provided) must clean up
 * the dead window — otherwise a zombie BrowserWindow with a gone renderer
 * lingers (and, for overlays, keeps inflating overlayWindowCount).
 */
export function recoverOnRenderProcessGone(
  win: BrowserWindow,
  guard: CrashLoopGuard,
  label: string,
  recreate: () => void,
  onGiveUp?: () => void,
): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error(
      `[windows] ${label} renderer gone (reason: ${details.reason}, exitCode: ${details.exitCode})`,
    );
    if (!guard.allowRecreate(details)) {
      onGiveUp?.();
      return;
    }
    console.log(`[windows] recreating ${label} window after renderer crash`);
    recreate();
  });
}
