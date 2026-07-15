/**
 * M15 dwell-to-interact state machine for the buddy overlays, extracted from
 * windows/overlay.ts behind a narrow window port so it is unit-testable
 * without Electron.
 *
 * SAFETY-CRITICAL: overlays must never eat the user's clicks. While the
 * cursor DWELLS on the buddy footprint, exactly one overlay flips interactive
 * (setIgnoreMouseEvents(false)); `restoreClickThrough()` is reachable from
 * EVERY failure branch — renderer 'exit' events are the primary path, and a
 * belt-and-braces cursor poll here force-restores click-through if they ever
 * go missing (renderer hang, missed events at display edges, dead window,
 * lost region).
 */

import type { Rect } from '../../shared/types';

/** Belt-and-braces cursor poll cadence while an overlay is interactive. */
export const INTERACTIVE_POLL_MS = 150;

/** The narrow slice of the overlay windows the hover machine drives. */
export interface HoverWindowPort {
  /** True while the overlay window for this display exists and is alive. */
  isWindowLive(displayId: number): boolean;
  /** Flip one overlay interactive: setIgnoreMouseEvents(false) + notify renderer. */
  makeWindowInteractive(displayId: number): void;
  /**
   * Restore click-through on one overlay (forwarding-aware: the buddy-hosting
   * window keeps mousemove forwarding) + notify its renderer.
   */
  restoreWindowClickThrough(displayId: number): void;
  /** Overlay window bounds, global DIP — null when the window is gone. */
  windowBounds(displayId: number): Rect | null;
  /** Current cursor position, global DIP. */
  cursorPoint(): { x: number; y: number };
}

export class HoverController {
  /** displayId of the overlay currently interactive (dwell), or null. */
  private interactiveDisplayId: number | null = null;
  /** Latest padded buddy region for the interactive overlay, window-local DIP. */
  private interactiveRegion: Rect | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly port: HoverWindowPort,
    private readonly pollMs = INTERACTIVE_POLL_MS,
  ) {}

  /** displayId of the interactive overlay, or null (debug snapshot). */
  get displayId(): number | null {
    return this.interactiveDisplayId;
  }

  /** Current padded buddy region, window-local DIP (debug snapshot). */
  get region(): Rect | null {
    return this.interactiveRegion;
  }

  isInteractive(displayId: number): boolean {
    return this.interactiveDisplayId === displayId;
  }

  /** Flip one overlay interactive; poll the cursor as a fallback exit path. */
  makeInteractive(displayId: number, region: Rect): void {
    if (!this.port.isWindowLive(displayId)) return;
    this.interactiveRegion = region;
    if (this.interactiveDisplayId === displayId) return; // region refresh only
    if (this.interactiveDisplayId !== null) this.restoreClickThrough();
    this.stopPoll(); // defensive: never two polls
    this.interactiveDisplayId = displayId;
    this.port.makeWindowInteractive(displayId);
    // Belt-and-braces: the renderer's mousemove/mouseleave exit events are
    // the primary path; this poll force-restores click-through if they ever
    // go missing (renderer hang, missed events at display edges).
    this.poll = setInterval(() => {
      if (!this.port.isWindowLive(displayId) || this.interactiveRegion === null) {
        this.restoreClickThrough();
        return;
      }
      const bounds = this.port.windowBounds(displayId); // global DIP
      if (bounds === null) {
        this.restoreClickThrough();
        return;
      }
      const cursor = this.port.cursorPoint(); // global DIP
      const r = this.interactiveRegion; // window-local DIP
      const inside =
        cursor.x >= bounds.x + r.x &&
        cursor.x <= bounds.x + r.x + r.width &&
        cursor.y >= bounds.y + r.y &&
        cursor.y <= bounds.y + r.y + r.height;
      if (!inside) this.restoreClickThrough();
    }, this.pollMs);
  }

  /** Restore click-through on whatever window is interactive (idempotent). */
  restoreClickThrough(): void {
    this.stopPoll();
    if (this.interactiveDisplayId === null) return;
    const displayId = this.interactiveDisplayId;
    this.interactiveDisplayId = null;
    this.interactiveRegion = null;
    if (this.port.isWindowLive(displayId)) {
      this.port.restoreWindowClickThrough(displayId);
    }
  }

  /** Teardown: stop the poll (the windows are being destroyed anyway). */
  dispose(): void {
    this.stopPoll();
  }

  private stopPoll(): void {
    if (this.poll !== null) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }
}
