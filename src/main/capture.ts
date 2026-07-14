/**
 * Multi-display screenshot pipeline (M3).
 *
 * Contract (docs/ARCHITECTURE.md §2, §6): on hotkey press, capture every
 * display via desktopCapturer, resize to <= CAPTURE_MAX_EDGE on the longest
 * edge, encode JPEG ~CAPTURE_JPEG_QUALITY, label screen0..N with the cursor's
 * display flagged active, and exclude Clicky's own windows (content
 * protection during capture). Capture happens ONLY on hotkey / explicit
 * request — never continuous.
 *
 * Pure math (resize planning, source<->display matching, meta construction)
 * is exported separately so it can be unit-tested without Electron.
 */

import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { CAPTURE_JPEG_QUALITY, CAPTURE_MAX_EDGE } from '../shared/constants';
import type { CaptureMeta, Rect } from '../shared/types';

export interface CaptureResult {
  meta: CaptureMeta;
  /** JPEG bytes, base64 (ready for an input_image content part). */
  jpegBase64: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/capture.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Self-exclusion (content protection)
// ---------------------------------------------------------------------------

/**
 * Windows exempted from capture-time content protection. QA/self-test only:
 * lets a control window stay visible in captures to prove protection works.
 */
const captureVisibleWindows = new WeakSet<BrowserWindow>();

/** Exempt a window from the capture-time content protection toggle. */
export function exemptFromCaptureProtection(win: BrowserWindow): void {
  captureVisibleWindows.add(win);
}

/**
 * Toggle content protection on every Clicky BrowserWindow so the model never
 * sees the buddy/caption/panel in screenshots. Best-effort per window (a
 * window may be destroyed mid-iteration).
 */
function setClickyWindowsContentProtection(enabled: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || captureVisibleWindows.has(win)) continue;
    try {
      win.setContentProtection(enabled);
    } catch (err) {
      console.warn('[capture] setContentProtection failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

/**
 * Capture all displays: desktopCapturer at physical resolution, per-display
 * source matching, resize to <= CAPTURE_MAX_EDGE longest edge, JPEG encode.
 *
 * Clicky's own windows are content-protected for the duration of the actual
 * screen grab (try/finally restores them so normal QA screenshots still see
 * them afterwards).
 */
export async function captureAllDisplays(): Promise<CaptureResult[]> {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return [];

  const cursor = screen.getCursorScreenPoint();
  const activeDisplayId = screen.getDisplayNearestPoint(cursor).id;

  // One thumbnailSize serves all sources: request the max physical
  // resolution; the capturer fits each screen's thumbnail within it,
  // preserving aspect ratio.
  let thumbW = 0;
  let thumbH = 0;
  for (const d of displays) {
    const phys = displayPhysicalSize(d.bounds, d.scaleFactor);
    thumbW = Math.max(thumbW, phys.width);
    thumbH = Math.max(thumbH, phys.height);
  }

  // SELF-EXCLUSION: hide Clicky's windows from the grab, always restore.
  setClickyWindowsContentProtection(true);
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
  } finally {
    setClickyWindowsContentProtection(false);
  }

  const match = matchSourcesToDisplays(
    displays,
    sources.map((s) => ({ display_id: s.display_id, name: s.name })),
  );
  if (!match.matchedByDisplayId) {
    console.warn(
      '[capture] display_id matching failed (ids:',
      sources.map((s) => s.display_id),
      'displays:',
      displays.map((d) => d.id),
      ') — using order-based fallback',
    );
  }

  const results: CaptureResult[] = [];
  displays.forEach((display, screenIndex) => {
    const sourceIndex = match.sourceIndexByDisplay[screenIndex] ?? null;
    const source = sourceIndex === null ? undefined : sources[sourceIndex];
    if (!source) {
      console.warn(
        `[capture] no source for display ${display.id} (screen${screenIndex}) — skipped`,
      );
      return;
    }

    const thumb = source.thumbnail;
    const size = thumb.getSize();
    if (size.width <= 0 || size.height <= 0) {
      console.warn(`[capture] empty thumbnail for display ${display.id} — skipped`);
      return;
    }

    const plan = planResize(size.width, size.height);
    const image = plan.resized
      ? thumb.resize({ width: plan.width, height: plan.height, quality: 'good' })
      : thumb;
    const finalSize = image.getSize();

    results.push({
      meta: buildCaptureMeta(
        display,
        screenIndex,
        finalSize.width,
        finalSize.height,
        activeDisplayId,
      ),
      jpegBase64: image.toJPEG(CAPTURE_JPEG_QUALITY).toString('base64'),
    });
  });

  return results;
}
