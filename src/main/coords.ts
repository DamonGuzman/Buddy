/**
 * Coordinate mapping: screenshot pixel space -> overlay-window-local DIP.
 *
 * Pure functions only (unit-tested; no Electron imports). The full chain
 * (docs/ARCHITECTURE.md §6):
 *
 *   screenshot px
 *     ÷ resize ratio   -> physical display px
 *     ÷ scaleFactor    -> display-local DIP
 *     + bounds origin  -> global DIP
 *     - bounds origin  -> overlay-window-local DIP (overlay covers the display)
 *
 * Since each overlay window exactly covers its display (it is positioned at
 * displayBounds), overlay-local == display-local DIP; global DIP is still
 * exposed for cross-display logic.
 *
 * The resize ratio is derived PER AXIS (imageW/physicalW, imageH/physicalH):
 * capture rounds each edge independently when scaling to <= CAPTURE_MAX_EDGE,
 * so per-axis ratios guarantee that the image corner (imageW, imageH) maps
 * exactly onto the display corner — critical on portrait and odd-DPI displays.
 */

import type { CaptureMeta, PointerPoint } from '../shared/types';

export interface Point {
  x: number;
  y: number;
}

/** Result of the §6 mapping chain for one screenshot-space point. */
export interface ScreenMappedPoint {
  /** Global DIP (Electron screen coordinate space). */
  globalDip: Point;
  /** Overlay-window-local DIP (overlay windows sit at displayBounds origin). */
  overlayLocal: Point;
}

/** Compat shape used by the M1 pointer plumbing. */
export interface MappedPoint {
  /** Overlay-window-local DIP (what the overlay renderer animates to). */
  local: Point;
  /** Global DIP (screen coordinate space). */
  global: Point;
  label?: string;
}

// ---------------------------------------------------------------------------
// Meta-derived quantities
// ---------------------------------------------------------------------------

/** Physical pixels of the captured display, derived from meta. */
export function physicalSize(meta: CaptureMeta): { width: number; height: number } {
  return {
    width: meta.displayBounds.width * meta.scaleFactor,
    height: meta.displayBounds.height * meta.scaleFactor,
  };
}

function assertValidMeta(meta: CaptureMeta): void {
  const phys = physicalSize(meta);
  if (!(phys.width > 0) || !(phys.height > 0)) {
    throw new Error(
      `invalid capture meta: physical size ${phys.width}x${phys.height} ` +
        `(bounds ${meta.displayBounds.width}x${meta.displayBounds.height} @ ${meta.scaleFactor}x)`,
    );
  }
  if (!(meta.imageW > 0) || !(meta.imageH > 0)) {
    throw new Error(`invalid capture meta: image size ${meta.imageW}x${meta.imageH}`);
  }
  if (!(meta.scaleFactor > 0)) {
    throw new Error(`invalid capture meta: scaleFactor ${meta.scaleFactor}`);
  }
}

/**
 * The width-axis resize ratio applied when the screenshot was produced (<= 1).
 * Kept for compatibility; mapping itself uses per-axis ratios.
 */
export function resizeRatio(meta: CaptureMeta): number {
  const { width } = physicalSize(meta);
  if (width <= 0) throw new Error(`invalid capture meta: physical width ${width}`);
  return meta.imageW / width;
}

// ---------------------------------------------------------------------------
// §6 mapping chain
// ---------------------------------------------------------------------------

/**
 * Map one point from screenshot pixel space to global DIP + overlay-local DIP.
 *
 * screenshot px -> (unresize, per axis) -> physical px -> (÷ scaleFactor) ->
 * display-local DIP -> (+ displayBounds origin) -> global DIP.
 * overlayLocal = global - displayBounds origin (== display-local DIP).
 */
export function mapPointToScreen(point: Point, meta: CaptureMeta): ScreenMappedPoint {
  assertValidMeta(meta);
  const phys = physicalSize(meta);

  // screenshot px -> physical display px (undo the <=1280 resize, per axis)
  const physX = point.x * (phys.width / meta.imageW);
  const physY = point.y * (phys.height / meta.imageH);

  // physical px -> display-local DIP
  const localX = physX / meta.scaleFactor;
  const localY = physY / meta.scaleFactor;

  return {
    globalDip: { x: meta.displayBounds.x + localX, y: meta.displayBounds.y + localY },
    overlayLocal: { x: localX, y: localY },
  };
}

/** Clamp a display-local DIP point into the display (defensive against overshoot). */
export function clampToDisplay(local: Point, meta: CaptureMeta): Point {
  return {
    x: Math.min(Math.max(local.x, 0), meta.displayBounds.width),
    y: Math.min(Math.max(local.y, 0), meta.displayBounds.height),
  };
}

// ---------------------------------------------------------------------------
// Model-input validation
// ---------------------------------------------------------------------------

/**
 * Validate/repair a model-provided screenshot-space point.
 *
 * - Non-finite coordinates (NaN/Infinity — malformed tool args) fall back to
 *   the image center.
 * - Out-of-range coordinates are clamped onto the image edge.
 *
 * Returns the safe point and whether anything had to be adjusted.
 */
export function normalizeModelPoint(
  point: Point,
  meta: CaptureMeta,
): { point: Point; adjusted: boolean } {
  assertValidMeta(meta);
  const safeAxis = (value: number, max: number): number => {
    if (!Number.isFinite(value)) return max / 2;
    return Math.min(Math.max(value, 0), max);
  };
  const x = safeAxis(point.x, meta.imageW);
  const y = safeAxis(point.y, meta.imageH);
  const adjusted = x !== point.x || y !== point.y;
  return { point: { x, y }, adjusted };
}

/**
 * Full defensive pipeline for one model point: validate/clamp in image space,
 * map via §6, then clamp the result into the display as a final guard.
 */
export function mapModelPoint(
  point: PointerPoint,
  meta: CaptureMeta,
): MappedPoint & { adjusted: boolean } {
  const { point: safe, adjusted } = normalizeModelPoint(point, meta);
  const mapped = mapPointToScreen(safe, meta);
  const local = clampToDisplay(mapped.overlayLocal, meta);
  return {
    local,
    global: { x: meta.displayBounds.x + local.x, y: meta.displayBounds.y + local.y },
    ...(point.label !== undefined ? { label: point.label } : {}),
    adjusted,
  };
}

// ---------------------------------------------------------------------------
// Compat surface (M1 shape, used by pointer plumbing)
// ---------------------------------------------------------------------------

/** Map one point from screenshot px space to overlay-local + global DIP. */
export function mapScreenshotPoint(point: PointerPoint, meta: CaptureMeta): MappedPoint {
  const mapped = mapPointToScreen(point, meta);
  return {
    local: mapped.overlayLocal,
    global: mapped.globalDip,
    ...(point.label !== undefined ? { label: point.label } : {}),
  };
}

/**
 * Map a whole point_at payload against the capture batch it referenced.
 * Model coords are validated/clamped (never trust tool args).
 */
export function mapPoints(
  points: PointerPoint[],
  screenIndex: number,
  captures: CaptureMeta[],
): MappedPoint[] {
  const meta = captures.find((c) => c.screenIndex === screenIndex);
  if (!meta) {
    throw new Error(`point_at referenced unknown screenIndex ${screenIndex}`);
  }
  return points.map((p) => {
    const { adjusted: _adjusted, ...mapped } = mapModelPoint(p, meta);
    return mapped;
  });
}
