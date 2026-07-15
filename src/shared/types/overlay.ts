/**
 * Overlay types: buddy hover / dwell / rest position (M15), captions, and the
 * overlay-facing indicator payloads.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

import type { Rect } from './capture';

/** A buddy rest position as fractions of the hosting overlay-window size. */
export interface BuddyRestFraction {
  xFrac: number;
  yFrac: number;
}

/**
 * M15: user-defined buddy rest position, persisted in settings after a
 * drag-reposition. Fractions of the hosting display's overlay-window size
 * (window-local DIP / innerWidth|innerHeight) so the spot survives display
 * resolution changes; re-snapped to edge margins on restore.
 */
export interface BuddyRest extends BuddyRestFraction {
  /** screenIndex (capture-labeling order) of the hosting display. */
  screenIndex: number;
}

/** Main -> overlay hover configuration (pushed on load and settings change). */
export interface OverlayHoverConfig {
  /** Display string for the push-to-talk hotkey (Settings.hotkeyLabel). */
  hotkeyLabel: string;
  /** Whether the hotkey toggles an open-mic Realtime session. */
  fullRealtimeMode: boolean;
  /**
   * Rest fraction for THIS overlay when it hosts the buddy at rest;
   * null = default bottom-right corner.
   */
  rest: BuddyRestFraction | null;
}

/** Native top-of-display geometry, expressed in overlay-local DIP. */
export interface OverlayDisplaySurface {
  kind: 'notch' | 'floating' | 'off';
  notchWidth: number;
  notchHeight: number;
  menuBarHeight: number;
}

/** Renderer hover-machine snapshot, reported on transitions (debug/QA). */
export interface OverlayHoverStatus {
  zone: 'far' | 'aware' | 'hover';
  hint: boolean;
  dragging: boolean;
  /** Buddy center, window-local DIP. */
  buddy: { x: number; y: number };
}

/**
 * Renderer -> main hover event.
 * - 'dwell': cursor dwelled in the buddy footprint; make this overlay
 *   interactive while the cursor stays inside `region` (also sent as a
 *   region refresh while dragging).
 * - 'exit': cursor left the padded region; RESTORE CLICK-THROUGH NOW
 *   (safety-critical: the user's clicks elsewhere must never be eaten).
 * - 'status': debug/QA snapshot on hover-state transitions.
 */
export interface OverlayHoverEvent {
  kind: 'dwell' | 'exit' | 'status';
  /** Padded buddy region, window-local DIP (present on 'dwell'). */
  region?: Rect;
  /** Present on 'status'. */
  status?: OverlayHoverStatus;
}

/** This overlay window's click-through state flipped (dwell-to-interact). */
export interface OverlayInteractiveUpdate {
  interactive: boolean;
}

/** Show/hide the "capture in progress" indicator (always signposted). */
export interface CaptureIndicatorUpdate {
  active: boolean;
}

/** Streaming caption text (the spoken words) for the overlay bubble. */
export interface CaptionUpdate {
  /** Id of the response item this caption belongs to (resets the bubble on change). */
  itemId: string;
  /** Full text so far (not a delta) — simplifies renderer state. */
  text: string;
  done: boolean;
}
