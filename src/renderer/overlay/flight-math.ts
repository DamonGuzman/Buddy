/**
 * PURE math for the buddy's quadratic-bezier flights: bezier evaluation,
 * heading tangents, arc-lift control points, easing and angle interpolation.
 * No DOM, no timers — unit-tested directly (tests/flight.test.ts) and safe to
 * import under the node tsconfig. The rAF-driven FlightController that drives
 * these lives in flight.ts.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface FlightPose {
  pos: Vec;
  /** Rotation in degrees; 0 = triangle tip pointing straight up. */
  rot: number;
}

/** Cursor-like settle: tip pointing up-left on arrival at a target. */
export const SETTLE_ROT = -38;
/** Upright, cheerful stance at the rest position. */
export const REST_ROT = 0;

export interface FlightOptions {
  /** Base duration in ms (scaled mildly by distance when omitted). */
  duration?: number;
  /** Rotation to settle into on arrival (default SETTLE_ROT). */
  settleRot?: number;
}

/** Point on a quadratic bezier (works for t slightly > 1 → overshoot). */
export function quadPoint(p0: Vec, c: Vec, p1: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/** Tangent (unnormalized travel direction) of a quadratic bezier at t. */
export function quadTangent(p0: Vec, c: Vec, p1: Vec, t: number): Vec {
  return {
    x: 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x),
    y: 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y),
  };
}

/**
 * Control point: travel midpoint lifted perpendicular to the travel vector by
 * ~25% of the distance, always choosing the screen-upward side so the arc
 * feels like a hop, not a dive.
 */
export function controlPoint(p0: Vec, p1: Vec): Vec {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy) || 1;
  let px = -dy / dist;
  let py = dx / dist;
  if (py > 0) {
    px = -px;
    py = -py;
  }
  const lift = dist * 0.25;
  return { x: (p0.x + p1.x) / 2 + px * lift, y: (p0.y + p1.y) / 2 + py * lift };
}

/**
 * Flight easing: cubic ease-in for the first half, then an ease-out with a
 * tiny (~2%) overshoot past 1 that settles back — evaluated on the bezier this
 * overshoots along the path and springs back, which reads as "alive".
 */
export function easeFlight(t: number): number {
  if (t < 0.5) return 4 * t * t * t;
  const c1 = 1.0;
  const c3 = c1 + 1;
  const u = t * 2 - 2; // -1..0
  return 0.5 + 0.5 * (1 + c3 * u * u * u + c1 * u * u);
}

/** Shortest-path angle interpolation in degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

/** Hermite smoothstep, clamped to 0..1. */
export function smoothstep(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}
