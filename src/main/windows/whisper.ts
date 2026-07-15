/**
 * M20: the whisper — a small floating composer for talking to buddy by TEXT,
 * for environments where the user can't speak (meetings, open offices). It is
 * the only focusable conversation surface: the overlay itself stays
 * click-through and non-focusable (hard rule), so the whisper is a separate
 * tiny always-on-top window dressed in the caption bubble's visual language,
 * anchored beside the buddy's rest spot.
 *
 * Summoning (wired in index.ts / windows/overlay.ts):
 * - push-to-talk mode: a hotkey TAP (release within TAP_MAX_MS — a hold still
 *   talks). Taps are ignored in full realtime mode, where the press itself
 *   toggles the open-mic session.
 * - any mode: clicking the buddy mascot (was: toggle the panel).
 *
 * Focus policy: the whisper takes focus ONLY on an explicit summon (tap /
 * buddy click) — never on its own. It hides on blur, esc, or a second tap.
 */

import { app } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WHISPER_HEIGHT, WHISPER_WIDTH } from '../../shared/constants';
import type { MainToWhisperChannel, MainToWhisperEvents } from '../../shared/ipc';
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

/** Gap between the buddy rest spot and the whisper's near edge. */
const ANCHOR_GAP_X = 28;
const ANCHOR_GAP_Y = 16;
/** Minimum distance from any work-area edge. */
const EDGE_MARGIN = 12;

/** Where to place the whisper: the buddy rest spot + its display work area. */
export interface WhisperAnchor {
  x: number;
  y: number;
  workArea: Rectangle;
}

export interface WhisperManagerOptions {
  /** Buddy rest spot in global DIP (OverlayManager.restAnchor). null = fallback. */
  getAnchor: () => WhisperAnchor | null;
}

/**
 * Module-level handle so sibling main modules (windows/overlay.ts buddy-click)
 * can toggle the whisper without bootstrap wiring changes — same pattern as
 * panel.ts togglePanel / settings.ts getSettingsStore.
 */
let activeWhisper: WhisperManager | null = null;

export function toggleWhisper(): void {
  activeWhisper?.toggle();
}

/**
 * Blur events inside this window after show() are the OS revoking the focus
 * we are still fighting for (Windows foreground-lock: a hotkey tap does NOT
 * grant Buddy foreground rights the way a tray click does) — not the user
 * clicking away. Ignore them; hide-on-blur applies after the dust settles.
 * Observed fight blurs land within ~40ms of show; 250ms covers them with
 * margin while keeping a genuine quick click-away responsive.
 */
const SHOW_BLUR_GRACE_MS = 250;

/**
 * A toggle arriving this soon after show is a double-click / double-tap —
 * the user asking MORE emphatically for the whisper, not open-then-close.
 * Without this, a habitual double-click on the buddy made the whisper flash
 * (show on click one, hide on click two). A later re-click still dismisses.
 */
const TOGGLE_DEBOUNCE_MS = 450;

/**
 * A toggle arriving this soon after a HIDE is the same gesture that caused
 * the hide (clicking the buddy to dismiss: the mousedown blurs the whisper
 * → hide, the mouseup's buddy-click toggle would otherwise re-show it).
 */
const HIDE_TOGGLE_SWALLOW_MS = 300;

export class WhisperManager {
  private win: BrowserWindow | null = null;
  private lastShownAt = 0;
  private lastHiddenAt = 0;
  /** Fired on every renderer load (boot + crash-recreate) — index.ts replays
   *  the transcript ring through the panel port so the mirror refills. */
  private rendererReadyCb: (() => void) | null = null;
  private crashGuard = new CrashLoopGuard(
    CRASH_LOOP_MAX_RECREATES,
    CRASH_LOOP_WINDOW_MS,
    'whisper',
  );

  constructor(private readonly options: WhisperManagerOptions) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level singleton handle (see toggleWhisper)
    activeWhisper = this;
  }

  /** Pre-create the hidden window at app-ready so the first summon is instant. */
  start(): void {
    void app.whenReady().then(() => {
      this.ensureWindow();
    });
  }

  /** See rendererReadyCb — replay wiring lives in index.ts. */
  onRendererReady(cb: () => void): void {
    this.rendererReadyCb = cb;
  }

  isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  toggle(): void {
    if (this.isVisible()) {
      // Double-click/double-tap lands here as a second toggle — swallow it.
      if (Date.now() - this.lastShownAt < TOGGLE_DEBOUNCE_MS) return;
      this.hide();
    } else {
      // The dismiss-click's own blur just hid the window — don't re-show.
      if (Date.now() - this.lastHiddenAt < HIDE_TOGGLE_SWALLOW_MS) return;
      this.show();
    }
  }

  /**
   * Summon: position beside the buddy rest spot, show, and take focus (the
   * user explicitly asked — this is the one surface that may steal focus).
   */
  show(): void {
    const win = this.ensureWindow();
    this.positionNearBuddy(win);
    this.lastShownAt = Date.now();
    win.show();
    win.focus();
    // Windows foreground-lock: a global-hotkey tap does not hand Buddy
    // foreground rights, so a plain focus() is silently revoked (and the
    // resulting blur used to hide the window the same instant it appeared).
    // steal:true is the sanctioned escape hatch — justified here because the
    // user explicitly summoned a text input.
    app.focus({ steal: true });
    this.reassertTopmost(win);
    this.send('whisper:shown', null);
    // Deliberately NO retry if the steal is denied: a late re-steal yanks
    // focus from whatever the user moved on to (a visible flicker-fight).
    // A denied steal leaves the window visible; clicking it focuses it, and
    // esc / re-tap / a later blur still dismiss it.
  }

  hide(): void {
    this.lastHiddenAt = Date.now();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  /** Send a typed event to the whisper (no-op before first creation). */
  send<C extends MainToWhisperChannel>(channel: C, payload: MainToWhisperEvents[C]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy(): void {
    if (activeWhisper === this) activeWhisper = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  // -------------------------------------------------------------------------

  /** Same Windows topmost-bit re-assert dance as the panel (see panel.ts). */
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

    const icoPath = join(app.getAppPath(), 'build', 'icon.ico');
    const win = createHardenedWindow({
      width: WHISPER_WIDTH,
      height: WHISPER_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      ...(existsSync(icoPath) ? { icon: icoPath } : {}),
      webPreferences: hardenedWebPreferences('whisper.js'),
    });

    // Crash recovery: recreate hidden; the next summon shows a fresh window.
    // No fatal escalation — the whisper is optional chrome, voice still works.
    recoverOnRenderProcessGone(
      win,
      this.crashGuard,
      'whisper',
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        this.ensureWindow();
      },
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
      },
    );

    win.on('blur', () => {
      // Blur during the show grace window = the focus fight, not the user.
      if (Date.now() - this.lastShownAt < SHOW_BLUR_GRACE_MS) return;
      if (!win.isDestroyed()) win.hide();
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[whisper] renderer failed to load: ${code} ${desc} ${url}`);
    });
    win.webContents.on('did-finish-load', () => this.rendererReadyCb?.());
    win.on('closed', () => {
      this.win = null;
    });

    loadRendererPage(win, 'whisper');

    this.win = win;
    return win;
  }

  /**
   * Above-and-left of the buddy rest spot (buddy defaults to bottom-right),
   * clamped inside the hosting display's work area. Falls back to the
   * panel's corner when no overlay is live yet.
   */
  private positionNearBuddy(win: BrowserWindow): void {
    const anchor = this.options.getAnchor();
    if (!anchor) return; // keep last position (or Electron's default)
    const { x, y, workArea } = anchor;
    const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
    win.setPosition(
      Math.round(
        clamp(
          x - WHISPER_WIDTH + ANCHOR_GAP_X,
          workArea.x + EDGE_MARGIN,
          workArea.x + workArea.width - WHISPER_WIDTH - EDGE_MARGIN,
        ),
      ),
      Math.round(
        clamp(
          y - WHISPER_HEIGHT - ANCHOR_GAP_Y,
          workArea.y + EDGE_MARGIN,
          workArea.y + workArea.height - WHISPER_HEIGHT - EDGE_MARGIN,
        ),
      ),
    );
  }
}
