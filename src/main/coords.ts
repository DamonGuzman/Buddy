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
 * Since each overlay window exactly covers its display, overlay-local ==
 * display-local DIP; global DIP is still exposed for cross-display logic.
 */

import type { CaptureMeta, PointerPoint } from '../shared/types';

export interface MappedPoint {
  /** Overlay-window-local DIP (what the overlay renderer animates to). */
  local: { x: number; y: number };
  /** Global DIP (screen coordinate space). */
  global: { x: number; y: number };
  label?: string;
}

/** Physical pixels of the captured display, derived from meta. */
export function physicalSize(meta: CaptureMeta): { width: number; height: number } {
  return {
    width: meta.displayBounds.width * meta.scaleFactor,
    height: meta.displayBounds.height * meta.scaleFactor,
  };
}

/** The resize ratio applied when the screenshot was produced (<= 1). */
export function resizeRatio(meta: CaptureMeta): number {
  const { width } = physicalSize(meta);
  if (width <= 0) throw new Error(`invalid capture meta: physical width ${width}`);
  return meta.imageW / width;
}

/** Map one point from screenshot px space to overlay-local + global DIP. */
export function mapScreenshotPoint(point: PointerPoint, meta: CaptureMeta): MappedPoint {
  const ratio = resizeRatio(meta);
  if (ratio <= 0) throw new Error(`invalid capture meta: resize ratio ${ratio}`);

  // screenshot px -> physical px
  const physX = point.x / ratio;
  const physY = point.y / ratio;

  // physical px -> display-local DIP
  const localX = physX / meta.scaleFactor;
  const localY = physY / meta.scaleFactor;

  return {
    local: { x: localX, y: localY },
    global: { x: meta.displayBounds.x + localX, y: meta.displayBounds.y + localY },
    ...(point.label !== undefined ? { label: point.label } : {}),
  };
}

/** Map a whole point_at payload against the capture batch it referenced. */
export function mapPoints(
  points: PointerPoint[],
  screenIndex: number,
  captures: CaptureMeta[],
): MappedPoint[] {
  const meta = captures.find((c) => c.screenIndex === screenIndex);
  if (!meta) {
    throw new Error(`point_at referenced unknown screenIndex ${screenIndex}`);
  }
  return points.map((p) => mapScreenshotPoint(p, meta));
}

/** Clamp a local point into the display (defensive against model overshoot). */
export function clampToDisplay(
  local: { x: number; y: number },
  meta: CaptureMeta,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(local.x, 0), meta.displayBounds.width),
    y: Math.min(Math.max(local.y, 0), meta.displayBounds.height),
  };
}
