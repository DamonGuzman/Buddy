/**
 * Global hold-to-talk hotkey via uiohook-napi.
 *
 * State machine: idle -> holding (Ctrl and LEFT Alt down) -> idle (either up).
 * `hold-start` fires on entry to holding (capture + listen), `hold-end` on
 * exit (commit + respond), and `hold-cancel` on any FORCED release — the hold
 * is abandoned with no turn. Electron's globalShortcut has no keyup, hence
 * the low-level hook. Degrades gracefully: if the hook fails to start, the
 * app keeps running with `hookAlive === false` (text fallback still works).
 *
 * F1 fix (AltGr): on Windows international layouts AltGr arrives as a
 * synthetic LEFT Ctrl press + RIGHT Alt press, so accepting either Alt key
 * would fire hold-start (capture flash + mic blip) on every €/@/{ keystroke.
 * Only LEFT Alt participates in the hotkey; Right Alt / AltGr never triggers.
 *
 * F1 fix (C1, stuck hold): keyups can be swallowed wholesale — Ctrl+Alt+Del /
 * Win+L switch to the secure desktop and the hook never sees the release —
 * which would latch the hold (and the mic) forever. Two guards:
 *  - a max-hold watchdog force-cancels after MAX_HOLD_MS;
 *  - index.ts calls forceCancel() on powerMonitor 'lock-screen'/'suspend'.
 * Every forced release fully resets ctrl/alt/holding so a swallowed keyup
 * can't leave a phantom modifier latched.
 */

import { EventEmitter } from 'node:events';

/**
 * M11: why a hold was force-cancelled. 'watchdog' = the 30s max-hold guard
 * (surfaced to the user as hold_too_long); 'forced' = lock/suspend/secure
 * desktop (silent — the user did not do anything wrong).
 */
export type HoldCancelReason = 'watchdog' | 'forced';

export interface HotkeyEvents {
  'hold-start': [];
  'hold-end': [];
  /** Forced release: watchdog / lock / suspend. Cancel the hold, no turn. */
  'hold-cancel': [reason: HoldCancelReason];
  /** Global primary-button click (used to hit-test click-through Buddy on macOS). */
  'primary-click': [];
  error: [Error];
}

interface HotkeyStatus {
  hookAlive: boolean;
  holding: boolean;
  error?: string | undefined;
}

/** Minimal surface of uiohook-napi's uIOhook (injectable for unit tests). */
export interface UiohookLike {
  on(event: 'keydown' | 'keyup', cb: (e: { keycode: number }) => void): unknown;
  on(event: 'click', cb: (e: { button: unknown }) => void): unknown;
  start(): void;
  stop(): void;
}

export interface HotkeyOptions {
  /** Test seam: the global hook implementation. Default: uiohook-napi. */
  hook?: UiohookLike;
  /** Max hold duration before the watchdog force-cancels. Default 30s. */
  maxHoldMs?: number;
}

/** A hold longer than this is a swallowed keyup, not a question (C1). */
export const MAX_HOLD_MS = 30_000;

// uiohook keycodes (UiohookKey). Ctrl: both variants. Alt: LEFT ONLY —
// Right Alt (3640) is AltGr on international layouts and must never trigger.
const CTRL_KEYCODES = new Set<number>([29 /* L */, 3613 /* R */]);
const ALT_LEFT_KEYCODE = 56;

export class HotkeyManager extends EventEmitter<HotkeyEvents> {
  private readonly options: HotkeyOptions;
  private ctrlDown = false;
  private altDown = false;
  private holding = false;
  private hookAlive = false;
  private lastError: string | undefined;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(options: HotkeyOptions = {}) {
    super();
    this.options = options;
  }

  /** Start the global hook. Never throws; check status().hookAlive. */
  start(): void {
    try {
      const hook = this.options.hook ?? this.loadUiohook();

      hook.on('keydown', (e: { keycode: number }) => {
        if (CTRL_KEYCODES.has(e.keycode)) this.ctrlDown = true;
        if (e.keycode === ALT_LEFT_KEYCODE) this.altDown = true;
        this.evaluate();
      });
      hook.on('keyup', (e: { keycode: number }) => {
        if (CTRL_KEYCODES.has(e.keycode)) this.ctrlDown = false;
        if (e.keycode === ALT_LEFT_KEYCODE) this.altDown = false;
        this.evaluate();
      });
      hook.on('click', (e: { button: unknown }) => {
        // libuiohook numbers the primary/left mouse button as 1 on both
        // macOS and Windows. Coordinates are deliberately read through
        // Electron at the consumer so mixed-DPI screens stay in DIP space.
        if (e.button === 1) this.emit('primary-click');
      });

      hook.start();
      this.hookAlive = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.hookAlive = false;
      this.lastError = error.message;
      console.error('[hotkey] failed to start uiohook, hold-to-talk disabled:', error);
      // M11 CRASH FIX: an EventEmitter 'error' with no listener THROWS — the
      // throw escaped start() and aborted app boot (tray/powerMonitor/debug
      // server never ran). index.ts now subscribes before start(); this guard
      // keeps the "never throws" contract even for callers that don't.
      if (this.listenerCount('error') > 0) this.emit('error', error);
    }
  }

  stop(): void {
    this.clearWatchdog();
    this.ctrlDown = false;
    this.altDown = false;
    this.holding = false;
    if (!this.hookAlive) return;
    if (!this.options.hook) {
      try {
        this.loadUiohook().stop();
      } catch (err) {
        console.error('[hotkey] failed to stop uiohook:', err);
      }
    } else {
      try {
        this.options.hook.stop();
      } catch (err) {
        console.error('[hotkey] failed to stop hook:', err);
      }
    }
    this.hookAlive = false;
  }

  /**
   * Force-release the current hold as a CANCEL (no turn) and fully reset the
   * modifier state, so swallowed keyups (secure desktop, lock screen, sleep)
   * can never latch the hold or a phantom Ctrl/Alt. Safe to call anytime.
   */
  forceCancel(reason: HoldCancelReason = 'forced'): void {
    this.ctrlDown = false;
    this.altDown = false;
    this.clearWatchdog();
    if (this.holding) {
      this.holding = false;
      this.emit('hold-cancel', reason);
    }
  }

  /** Debug-harness entry point: simulate a press/release without real keys. */
  simulate(kind: 'press' | 'release'): void {
    if (kind === 'press') {
      this.ctrlDown = true;
      this.altDown = true;
    } else {
      this.ctrlDown = false;
      this.altDown = false;
    }
    this.evaluate();
  }

  status(): HotkeyStatus {
    return { hookAlive: this.hookAlive, holding: this.holding, error: this.lastError };
  }

  // -------------------------------------------------------------------------

  private loadUiohook(): UiohookLike {
    // Lazy require so a broken native module can't crash app startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('uiohook-napi') as typeof import('uiohook-napi')).uIOhook;
  }

  private evaluate(): void {
    const shouldHold = this.ctrlDown && this.altDown;
    if (shouldHold && !this.holding) {
      this.holding = true;
      this.armWatchdog();
      this.emit('hold-start');
    } else if (!shouldHold && this.holding) {
      this.holding = false;
      this.clearWatchdog();
      this.emit('hold-end');
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      // Nobody asks a question for 30s straight: the keyup was swallowed —
      // OR the user genuinely held for 30s (M11: hold_too_long tells them).
      this.forceCancel('watchdog');
    }, this.options.maxHoldMs ?? MAX_HOLD_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
