/**
 * Global hold-to-talk hotkey via uiohook-napi.
 *
 * State machine: idle -> holding (both Ctrl and Alt down) -> idle (either up).
 * `hold-start` fires on entry to holding (capture + listen), `hold-end` on
 * exit (commit + respond). Electron's globalShortcut has no keyup, hence the
 * low-level hook. Degrades gracefully: if the hook fails to start, the app
 * keeps running with `hookAlive === false` (text fallback still works).
 */

import { EventEmitter } from 'node:events';

export interface HotkeyEvents {
  'hold-start': [];
  'hold-end': [];
  error: [Error];
}

interface HotkeyStatus {
  hookAlive: boolean;
  holding: boolean;
  error?: string | undefined;
}

// uiohook keycodes (UiohookKey): both left/right variants of each modifier.
const CTRL_KEYCODES = new Set<number>([29 /* L */, 3613 /* R */]);
const ALT_KEYCODES = new Set<number>([56 /* L */, 3640 /* R */]);

export class HotkeyManager extends EventEmitter<HotkeyEvents> {
  private ctrlDown = false;
  private altDown = false;
  private holding = false;
  private hookAlive = false;
  private lastError: string | undefined;

  /** Start the global hook. Never throws; check status().hookAlive. */
  start(): void {
    try {
      // Lazy require so a broken native module can't crash app startup.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi');

      uIOhook.on('keydown', (e: { keycode: number }) => {
        if (CTRL_KEYCODES.has(e.keycode)) this.ctrlDown = true;
        if (ALT_KEYCODES.has(e.keycode)) this.altDown = true;
        this.evaluate();
      });
      uIOhook.on('keyup', (e: { keycode: number }) => {
        if (CTRL_KEYCODES.has(e.keycode)) this.ctrlDown = false;
        if (ALT_KEYCODES.has(e.keycode)) this.altDown = false;
        this.evaluate();
      });

      uIOhook.start();
      this.hookAlive = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.hookAlive = false;
      this.lastError = error.message;
      console.error('[hotkey] failed to start uiohook, hold-to-talk disabled:', error);
      this.emit('error', error);
    }
  }

  stop(): void {
    if (!this.hookAlive) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi');
      uIOhook.stop();
    } catch (err) {
      console.error('[hotkey] failed to stop uiohook:', err);
    }
    this.hookAlive = false;
    this.holding = false;
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

  private evaluate(): void {
    const shouldHold = this.ctrlDown && this.altDown;
    if (shouldHold && !this.holding) {
      this.holding = true;
      this.emit('hold-start');
    } else if (!shouldHold && this.holding) {
      this.holding = false;
      this.emit('hold-end');
    }
  }
}
