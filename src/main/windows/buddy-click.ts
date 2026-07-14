/**
 * Pure hit-test for global clicks against Buddy's renderer-reported center.
 * Electron cursor/window coordinates and overlay CSS coordinates are all DIP.
 */

export interface Point {
  x: number;
  y: number;
}

export interface WindowBounds extends Point {
  width: number;
  height: number;
}

/** Buddy's visible SVG is 34px wide; allow a small, forgiving click halo. */
export const BUDDY_CLICK_RADIUS = 22;

export function isBuddyClick(
  cursor: Point,
  windowBounds: WindowBounds,
  buddyCenter: Point,
): boolean {
  const localX = cursor.x - windowBounds.x;
  const localY = cursor.y - windowBounds.y;
  return Math.hypot(localX - buddyCenter.x, localY - buddyCenter.y) <= BUDDY_CLICK_RADIUS;
}
