/**
 * Flight-math unit tests: the pure bezier/easing/angle helpers behind the
 * buddy's pointer flights (src/renderer/overlay/flight-math.ts — no DOM; the
 * rAF-driven FlightController in flight.ts stays thin over these).
 */

import { describe, expect, it } from 'vitest';
import {
  controlPoint,
  easeFlight,
  lerpAngle,
  quadPoint,
  quadTangent,
  smoothstep,
} from '../src/renderer/overlay/flight-math';
import type { Vec } from '../src/renderer/overlay/flight-math';

const P0: Vec = { x: 0, y: 0 };
const P1: Vec = { x: 100, y: 0 };

describe('quadPoint / quadTangent', () => {
  const C: Vec = { x: 50, y: -25 };

  it('hits the endpoints at t=0 and t=1', () => {
    expect(quadPoint(P0, C, P1, 0)).toEqual(P0);
    expect(quadPoint(P0, C, P1, 1)).toEqual(P1);
  });

  it('bows toward the control point at the midpoint', () => {
    expect(quadPoint(P0, C, P1, 0.5)).toEqual({ x: 50, y: -12.5 });
  });

  it('keeps extrapolating for t > 1 (easing overshoot rides past the target)', () => {
    const over = quadPoint(P0, C, P1, 1.02);
    expect(over.x).toBeGreaterThan(100);
  });

  it('tangent points along travel at the ends', () => {
    // At t=0 the tangent is 2(c - p0); at t=1 it is 2(p1 - c).
    expect(quadTangent(P0, C, P1, 0)).toEqual({ x: 100, y: -50 });
    expect(quadTangent(P0, C, P1, 1)).toEqual({ x: 100, y: 50 });
  });
});

describe('controlPoint', () => {
  it('lifts the travel midpoint 25% of the distance, screen-upward', () => {
    expect(controlPoint(P0, P1)).toEqual({ x: 50, y: -25 });
  });

  it('chooses the upward side regardless of travel direction', () => {
    // Same segment walked backwards still arcs up (negative y).
    expect(controlPoint(P1, P0)).toEqual({ x: 50, y: -25 });
    const up = controlPoint({ x: 0, y: 100 }, { x: 0, y: 0 });
    const down = controlPoint({ x: 0, y: 0 }, { x: 0, y: 100 });
    // Vertical travel: the perpendicular is horizontal; both stay at y=50.
    expect(up.y).toBe(50);
    expect(down.y).toBe(50);
  });

  it('is offset perpendicular to the travel vector', () => {
    const a: Vec = { x: 10, y: 20 };
    const b: Vec = { x: 110, y: 80 };
    const c = controlPoint(a, b);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const travel = { x: b.x - a.x, y: b.y - a.y };
    const lift = { x: c.x - mid.x, y: c.y - mid.y };
    expect(travel.x * lift.x + travel.y * lift.y).toBeCloseTo(0, 8);
    const dist = Math.hypot(travel.x, travel.y);
    expect(Math.hypot(lift.x, lift.y)).toBeCloseTo(dist * 0.25, 8);
  });

  it('survives a zero-length segment (dist guarded to 1)', () => {
    expect(controlPoint(P0, P0)).toEqual({ x: 0, y: 0 });
  });
});

describe('easeFlight', () => {
  it('starts at 0, ends at 1, continuous at the halfway handoff', () => {
    expect(easeFlight(0)).toBe(0);
    expect(easeFlight(1)).toBeCloseTo(1, 12);
    expect(easeFlight(0.5)).toBeCloseTo(0.5, 12);
    expect(easeFlight(0.25)).toBeCloseTo(0.0625, 12);
  });

  it('overshoots slightly past 1 in the back half, then settles', () => {
    let max = 0;
    for (let t = 0.5; t <= 1.0001; t += 0.005) max = Math.max(max, easeFlight(t));
    expect(max).toBeGreaterThan(1); // the ~2% "alive" overshoot
    expect(max).toBeLessThan(1.05);
  });
});

describe('lerpAngle', () => {
  it('interpolates plainly within a half-turn', () => {
    expect(lerpAngle(0, 90, 0.5)).toBe(45);
    expect(lerpAngle(-38, 0, 1)).toBe(-38 + 38);
  });

  it('takes the short way across the 0/360 seam', () => {
    // 350 -> 10 is +20 through 360, not -340.
    expect(lerpAngle(350, 10, 0.5)).toBe(360);
    expect(lerpAngle(10, 350, 0.5)).toBe(0);
  });

  it('holds the endpoints', () => {
    expect(lerpAngle(123, -45, 0)).toBe(123);
    // t=1 lands on an angle equivalent to b (mod 360).
    expect(((lerpAngle(350, 10, 1) % 360) + 360) % 360).toBe(10);
  });
});

describe('smoothstep', () => {
  it('is clamped hermite easing', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(2)).toBe(1);
    expect(smoothstep(0.25)).toBeCloseTo(0.15625, 12);
  });
});
