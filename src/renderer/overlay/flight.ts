/**
 * Quadratic-bezier flight for the buddy: pure math helpers + a rAF-driven
 * controller that writes poses through a callback (no React re-render per
 * frame). The rAF loop runs ONLY while a flight is in progress — at rest the
 * buddy costs nothing here (idle bob is pure CSS).
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

function smoothstep(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

export interface FlightOptions {
  /** Base duration in ms (scaled mildly by distance when omitted). */
  duration?: number;
  /** Rotation to settle into on arrival (default SETTLE_ROT). */
  settleRot?: number;
}

export class FlightController {
  private raf = 0;
  private gen = 0;
  private pose: FlightPose = { pos: { x: 0, y: 0 }, rot: REST_ROT };

  constructor(private readonly apply: (pose: FlightPose, flying: boolean) => void) {}

  get currentPose(): FlightPose {
    return { pos: { ...this.pose.pos }, rot: this.pose.rot };
  }

  /** Teleport (no animation) — used for init and display-resize re-anchoring. */
  jumpTo(pos: Vec, rot: number = REST_ROT): void {
    this.cancel();
    this.pose = { pos: { ...pos }, rot };
    this.apply(this.pose, false);
  }

  /** Abort any in-progress flight (its promise resolves false). */
  cancel(): void {
    this.gen += 1;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /**
   * Fly along a lifted quadratic bezier to `target`. Resolves true when the
   * flight completed, false when it was cancelled/superseded.
   */
  flyTo(target: Vec, opts: FlightOptions = {}): Promise<boolean> {
    this.cancel();
    const gen = this.gen;
    const p0 = { ...this.pose.pos };
    const dist = Math.hypot(target.x - p0.x, target.y - p0.y);
    const settleRot = opts.settleRot ?? SETTLE_ROT;

    if (dist < 3) {
      this.pose = { pos: { ...target }, rot: settleRot };
      this.apply(this.pose, false);
      return Promise.resolve(true);
    }

    // ~700ms nominal, gently stretched/compressed with distance.
    const duration = opts.duration ?? Math.min(950, Math.max(480, 700 * Math.sqrt(dist / 500)));
    const ctrl = controlPoint(p0, target);
    const startRot = this.pose.rot;
    let lastHeading = startRot;

    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (now: number): void => {
        if (gen !== this.gen) {
          resolve(false);
          return;
        }
        const t = Math.min((now - t0) / duration, 1);
        const s = easeFlight(t);
        const pos = quadPoint(p0, ctrl, target, s);

        // Face travel direction; freeze the heading before the overshoot
        // reversal so the settle blend never sees a 180° flip.
        if (t <= 0.7) {
          const tan = quadTangent(p0, ctrl, target, s);
          lastHeading = (Math.atan2(tan.y, tan.x) * 180) / Math.PI + 90;
        }
        let rot: number;
        if (t < 0.15) {
          rot = lerpAngle(startRot, lastHeading, smoothstep(t / 0.15));
        } else if (t > 0.7) {
          rot = lerpAngle(lastHeading, settleRot, smoothstep((t - 0.7) / 0.3));
        } else {
          rot = lastHeading;
        }

        this.pose = { pos, rot };
        this.apply(this.pose, t < 1);

        if (t < 1) {
          this.raf = requestAnimationFrame(frame);
        } else {
          this.raf = 0;
          resolve(true);
        }
      };
      this.raf = requestAnimationFrame(frame);
    });
  }
}
