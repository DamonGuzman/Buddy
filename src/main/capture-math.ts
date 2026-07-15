/**
 * Capture math (M3) — PURE helpers for the screenshot pipeline in capture.ts
 * (resize planning, source<->display matching, meta construction). No
 * Electron imports, so everything here is unit-testable directly
 * (tests/capture.test.ts).
 */

import { CAPTURE_MAX_EDGE } from '../shared/constants';
import type { CaptureMeta, Rect } from '../shared/types';

export interface ResizePlan {
  width: number;
  height: number;
  /** False when the source already fits within maxEdge (no resize needed). */
  resized: boolean;
}

/**
 * Final image dimensions: longest edge <= maxEdge, aspect preserved.
 * The longest edge lands exactly on maxEdge; the other edge rounds.
 */
export function planResize(srcW: number, srcH: number, maxEdge = CAPTURE_MAX_EDGE): ResizePlan {
  if (!(srcW > 0) || !(srcH > 0)) {
    throw new Error(`planResize: invalid source size ${srcW}x${srcH}`);
  }
  const longest = Math.max(srcW, srcH);
  if (longest <= maxEdge) return { width: srcW, height: srcH, resized: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.round(srcW * ratio),
    height: Math.round(srcH * ratio),
    resized: true,
  };
}

/** Physical pixel size of a display (DIP bounds x scaleFactor). */
export function displayPhysicalSize(
  bounds: Rect,
  scaleFactor: number,
): { width: number; height: number } {
  return {
    width: Math.round(bounds.width * scaleFactor),
    height: Math.round(bounds.height * scaleFactor),
  };
}

/** Minimal display shape needed by the pure matching/meta helpers. */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

/** Minimal desktopCapturer source shape needed for matching. */
export interface SourceLike {
  /** Electron display id as a string; '' or garbage on some Windows setups. */
  display_id: string;
  name: string;
}

export interface SourceMatch {
  /** Per display (same order as input), the index into `sources` or null. */
  sourceIndexByDisplay: (number | null)[];
  /**
   * True when every display was matched via display_id. False means the
   * order-based fallback was used (Windows display_id matching is
   * historically flaky — empty or mismatched ids).
   */
  matchedByDisplayId: boolean;
}

/**
 * Match desktopCapturer screen sources to displays.
 *
 * Preferred: source.display_id === String(display.id), each source used at
 * most once. If ANY display fails to match that way, fall back to order
 * matching (screen sources are enumerated in the same order as
 * screen.getAllDisplays() on Windows in practice).
 */
export function matchSourcesToDisplays(
  displays: readonly { id: number }[],
  sources: readonly SourceLike[],
): SourceMatch {
  const used = new Set<number>();
  const byId: (number | null)[] = displays.map((display) => {
    const idx = sources.findIndex(
      (s, i) => !used.has(i) && s.display_id !== '' && s.display_id === String(display.id),
    );
    if (idx === -1) return null;
    used.add(idx);
    return idx;
  });

  if (byId.every((idx) => idx !== null)) {
    return { sourceIndexByDisplay: byId, matchedByDisplayId: true };
  }

  return {
    sourceIndexByDisplay: displays.map((_, i) => (i < sources.length ? i : null)),
    matchedByDisplayId: false,
  };
}

/** Build the per-display CaptureMeta (imageW/imageH = FINAL sent-image size). */
export function buildCaptureMeta(
  display: DisplayLike,
  screenIndex: number,
  imageW: number,
  imageH: number,
  activeDisplayId: number,
): CaptureMeta {
  return {
    screenIndex,
    displayId: display.id,
    imageW,
    imageH,
    displayBounds: { ...display.bounds },
    scaleFactor: display.scaleFactor,
    isActive: display.id === activeDisplayId,
  };
}
