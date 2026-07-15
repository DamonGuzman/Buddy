/**
 * Pointer choreography: multi-point flights with per-point dwell, the
 * return-home dwell after a turn settles, arrival pulses + label chips, and
 * buddy visibility/mode across all of it. Owns the command generation counter
 * (a superseding command silently cancels everything in flight) and the
 * PointerReturnLifecycle rendezvous with assistant-state events.
 *
 * No DOM: the flight engine, clock and timers are injected, and view changes
 * are pushed through the ports (main.tsx binds them to useState mirrors).
 * Unit-tested with a fake flight + fake time in
 * tests/overlay-controllers.test.ts.
 */

import { REST_ROT, SETTLE_ROT } from './flight-math';
import type { FlightOptions, Vec } from './flight-math';
import { PointerReturnLifecycle } from './pointer-lifecycle';
import type { BuddyMode, PointerReturnAction } from './pointer-lifecycle';
import type { AssistantState, PointerPoint } from '../../shared/types';
import type { TimerBag } from './timer-bag';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Dwell at each point of a multi-point command. */
export const POINT_DWELL_MS = 1200;
/** Keep the final point visible this long after the current turn settles. */
export const HOME_AFTER_MS = 6000;
/**
 * When settled at SETTLE_ROT (tip up-left, like a cursor) the triangle's tip
 * sits at center + (-8.4, -10.7); offset the flight target so the TIP kisses
 * the exact point while the body sits just below-right of it.
 */
export const TIP_OFFSET: Vec = { x: 8.4, y: 10.7 };
/** Pulse chips flip left of points within this many px of the right edge. */
const CHIP_FLIP_RIGHT_PX = 260;
/** Pulse chips flip above points within this many px of the bottom edge. */
const CHIP_FLIP_BOTTOM_PX = 60;

// ---------------------------------------------------------------------------

/** Arrival pulse + label chip at one pointed-at spot. */
export interface PulseView {
  id: number;
  x: number;
  y: number;
  label?: string;
  side: 'left' | 'right';
  /** Chip flips above the point near the bottom screen edge (mirror of side). */
  vside: 'above' | 'below';
}

/** The slice of FlightController the choreographer drives (fake in tests). */
export interface FlightDriver {
  jumpTo(pos: Vec, rot?: number): void;
  cancel(): void;
  flyTo(target: Vec, opts?: FlightOptions): Promise<boolean>;
}

export interface ChoreographerPorts {
  flight: FlightDriver;
  timers: TimerBag;
  /** Buddy rest pose (the user's drag spot or the default corner). */
  restPos(): Vec;
  /** Overlay window size (pulse chip flip thresholds). */
  viewport(): { width: number; height: number };
  /** Visibility changed (React mirror + hover gating). */
  onVisible(visible: boolean): void;
  /** Mode changed (React mirror + hover gating). */
  onMode(mode: BuddyMode): void;
  setPulses(pulses: PulseView[]): void;
  updatePlacement(pos: Vec): void;
}

export class PointerChoreographer {
  private gen = 0;
  private pulseSeq = 0;
  private visible: boolean;
  private currentMode: BuddyMode = 'rest';
  private readonly pointerReturn = new PointerReturnLifecycle();

  constructor(
    private readonly ports: ChoreographerPorts,
    initialVisible: boolean,
  ) {
    this.visible = initialVisible;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get mode(): BuddyMode {
    return this.currentMode;
  }

  // ------------------------------------------------------------- commands --

  /** Pointer 'animate': fly the point sequence (kicks the async run). */
  runPoints(points: PointerPoint[]): void {
    void this.run(points);
  }

  /**
   * Return to the rest corner. Without `expectedGen` this is a fresh command
   * (pointer 'idle' / config re-anchor) that supersedes any run in flight;
   * with it, an internal continuation of that generation (settle dwell).
   */
  async goHome(expectedGen?: number): Promise<void> {
    let myGen: number;
    if (expectedGen === undefined) {
      this.gen += 1;
      myGen = this.gen;
      this.ports.timers.clear('dwell');
    } else {
      myGen = expectedGen;
    }
    this.ports.timers.clear('home');
    this.pointerReturn.homeStarted();
    this.ports.setPulses([]);
    this.setVisible(true);
    this.applyMode('flying');
    const done = await this.ports.flight.flyTo(this.ports.restPos(), {
      settleRot: REST_ROT,
      duration: 650,
    });
    if (!done || this.gen !== myGen) return;
    this.applyMode('rest');
    this.ports.updatePlacement(this.ports.restPos());
  }

  /** Pointer 'hide': fade the buddy out entirely. */
  hide(): void {
    this.gen += 1;
    this.ports.timers.clear('dwell');
    this.ports.timers.clear('home');
    this.ports.flight.cancel();
    this.ports.setPulses([]);
    this.setVisible(false);
    this.applyMode('rest');
  }

  /** Teleport to the rest pose (init, resize, silent config re-anchor). */
  jumpToRest(): void {
    const target = this.ports.restPos();
    this.ports.flight.jumpTo(target, REST_ROT);
    this.ports.updatePlacement(target);
  }

  // ------------------------------------------- assistant-state rendezvous --

  /**
   * Feed an assistant-state event into the pointer-return rendezvous. The
   * returned action is dispatched separately (applyReturnAction) so the
   * caller can keep its original ordering — e.g. applyState re-syncs hover
   * gating and flushes captions BETWEEN the decision and the dispatch.
   */
  assistantStateChanged(state: AssistantState, fullRealtimeMode: boolean): PointerReturnAction {
    return this.pointerReturn.assistantStateChanged(state, this.gen, fullRealtimeMode);
  }

  /** Dispatch a pending pointer-return action for the current generation. */
  applyReturnAction(action: PointerReturnAction): void {
    if (action === 'home') void this.goHome(this.gen);
    else if (action === 'schedule') this.scheduleHome(this.gen);
  }

  dispose(): void {
    this.ports.timers.clearAll();
  }

  // ---------------------------------------------------------------- internals

  private setVisible(v: boolean): void {
    this.visible = v;
    this.ports.onVisible(v);
  }

  private applyMode(m: BuddyMode): void {
    this.currentMode = m;
    this.pointerReturn.setMode(m);
    this.ports.onMode(m);
  }

  private spawnPulse(p: PointerPoint): void {
    this.pulseSeq += 1;
    const { width, height } = this.ports.viewport();
    this.ports.setPulses([
      {
        id: this.pulseSeq,
        x: p.x,
        y: p.y,
        side: p.x > width - CHIP_FLIP_RIGHT_PX ? 'left' : 'right',
        // Mirror of the horizontal flip: chips for points near the bottom
        // edge would clip off-screen, so flip them above the point.
        vside: p.y > height - CHIP_FLIP_BOTTOM_PX ? 'above' : 'below',
        ...(p.label !== undefined ? { label: p.label } : {}),
      },
    ]);
  }

  private scheduleHome(myGen: number): void {
    this.ports.timers.set('home', HOME_AFTER_MS, () => {
      if (this.gen !== myGen) return;
      if (this.pointerReturn.homeTimerFired(myGen) === 'home') void this.goHome(myGen);
    });
  }

  /** Resolves with whether the generation is still current after `ms`. */
  private wait(ms: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      this.ports.timers.set('dwell', ms, () => resolve(this.gen === myGen));
    });
  }

  private async run(points: PointerPoint[]): Promise<void> {
    this.gen += 1;
    const myGen = this.gen;
    this.ports.timers.clear('dwell');
    this.ports.timers.clear('home');
    this.pointerReturn.beginPoints(myGen);
    if (!this.visible) {
      // Appearing on this display for the first time: rise from the rest corner.
      this.ports.flight.jumpTo(this.ports.restPos(), REST_ROT);
      this.setVisible(true);
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      this.ports.setPulses([]);
      this.applyMode('flying');
      const target = { x: p.x + TIP_OFFSET.x, y: p.y + TIP_OFFSET.y };
      const done = await this.ports.flight.flyTo(target, { settleRot: SETTLE_ROT });
      if (!done || this.gen !== myGen) return;
      this.applyMode('pointing');
      this.ports.updatePlacement(target);
      this.spawnPulse(p);
      if (i < points.length - 1) {
        const still = await this.wait(POINT_DWELL_MS, myGen);
        if (!still) return;
      }
    }
    // response.done can settle the turn while the final pointer flight is
    // still in progress. Start the dwell only once both signals have
    // arrived, so it is always six seconds rather than the response length.
    if (this.pointerReturn.pointsFinished(myGen) === 'schedule') this.scheduleHome(myGen);
  }
}
