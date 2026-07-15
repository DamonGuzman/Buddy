/**
 * Quadratic-bezier flight for the buddy: a rAF-driven controller that writes
 * poses through a callback (no React re-render per frame). The rAF loop runs
 * ONLY while a flight is in progress — at rest the buddy costs nothing here
 * (idle bob is pure CSS). The pure math lives in flight-math.ts (node-safe,
 * unit-tested); this module owns the DOM-bound animation loop.
 */

import {
  REST_ROT,
  SETTLE_ROT,
  controlPoint,
  easeFlight,
  lerpAngle,
  quadPoint,
  quadTangent,
  smoothstep,
} from './flight-math';
import type { FlightOptions, FlightPose, Vec } from './flight-math';

export { REST_ROT, SETTLE_ROT } from './flight-math';
export type { FlightOptions, FlightPose, Vec } from './flight-math';

export class FlightController {
  private raf = 0;
  private gen = 0;
  private pose: FlightPose = { pos: { x: 0, y: 0 }, rot: REST_ROT };

  constructor(private readonly apply: (pose: FlightPose) => void) {}

  get currentPose(): FlightPose {
    return { pos: { ...this.pose.pos }, rot: this.pose.rot };
  }

  /** Teleport (no animation) — used for init and display-resize re-anchoring. */
  jumpTo(pos: Vec, rot: number = REST_ROT): void {
    this.cancel();
    this.pose = { pos: { ...pos }, rot };
    this.apply(this.pose);
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
      this.apply(this.pose);
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
        this.apply(this.pose);

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
