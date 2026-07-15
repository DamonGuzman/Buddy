/**
 * M15 buddy-hover wiring: feeds cursor observation into the pure HoverMachine
 * and applies its edge-triggered effects — the dwell/exit IPC events (the
 * TIMING of these is a contract with main's click-through management), zone
 * visuals, hint bubble show/fade, eye tracking, drag-to-reposition, and the
 * hover-enabled gate (the buddy must never be interactive while flying or
 * during a physical push-to-talk hold).
 *
 * Mouse observation arrives only while main forwards mousemove to this
 * window (i.e. only while it hosts the buddy) or while it is interactive.
 * Budget: when the cursor is far from the buddy the per-event cost is one
 * squared-distance compare; processing is rAF-throttled otherwise.
 *
 * No DOM here: frames, timers, clock and the pupil/flight sinks are injected
 * (main.tsx adapts the real events), so the wiring is unit-testable with
 * fake time.
 */

import { REST_ROT } from './flight-math';
import type { FlightOptions, Vec } from './flight-math';
import {
  AWARE_RADIUS,
  DRAG_THRESHOLD,
  HOVER_RADIUS,
  HoverMachine,
  REGION_PAD,
  eyeOffset,
  hoverInteractionEnabled,
  restToFrac,
  snapRest,
} from './hover';
import type { AuxHoverGeometry, HoverEffects, HoverGateInput, HoverZone } from './hover';
import type { BuddyRestFraction, OverlayHoverEvent } from '../../shared/types';
import type { Clock, TimerBag } from './timer-bag';

/** M15: hint bubble fade-out duration (matches overlay.css .hint-bubble). */
export const HINT_FADE_MS = 300;
/** M15: min interval between drag-time region refresh IPC sends. */
export const DRAG_REGION_SEND_MS = 50;
/** Glide duration back to the snapped rest spot after a drag release. */
const DRAG_SNAP_DURATION_MS = 260;
/** Passive-observation gate: ignore mousemoves this far beyond the aware ring. */
const FAR_GATE_PAD_PX = 40;
const FAR_GATE_SQ = (AWARE_RADIUS + FAR_GATE_PAD_PX) ** 2;

export type HintBubbleState = 'hidden' | 'shown' | 'fading';

/** The slice of FlightController the drag path drives. */
export interface DragFlight {
  jumpTo(pos: Vec, rot?: number): void;
  flyTo(target: Vec, opts?: FlightOptions): Promise<boolean>;
}

export interface HoverDragPorts {
  clock: Clock;
  timers: TimerBag;
  /** rAF seam — must return a nonzero id (0 is the "no frame pending" sentinel). */
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  flight: DragFlight;
  /** Live buddy center (window-local DIP), fed by the flight engine. */
  buddyPos(): Vec;
  viewport(): { width: number; height: number };
  /** Inputs for the hover-enabled gate (visible / at-rest / state / mode). */
  gateInput(): HoverGateInput;
  sendHover(evt: OverlayHoverEvent): void;
  sendBuddyClick(): void;
  sendBuddyMove(rest: BuddyRestFraction): void;
  bumpActivity(): void;
  updatePlacement(pos: Vec): void;
  /** React mirrors. */
  setZone(zone: HoverZone): void;
  setHintState(update: HintBubbleState | ((prev: HintBubbleState) => HintBubbleState)): void;
  setDraggingState(dragging: boolean): void;
  setInteractiveState(interactive: boolean): void;
  /** Eye tracking: transform-only pupil offset (imperative, no re-render). */
  setPupilTransform(css: string): void;
  /** M19: sprite/card hover rides the same cursor feed. */
  helperHover: {
    updateFromCursor(): void;
    /** Called when hover interaction disables — the card must not linger. */
    release(): void;
  };
}

interface DragState {
  grabDx: number;
  grabDy: number;
  sx: number;
  sy: number;
  moved: boolean;
}

export class HoverDragController {
  private readonly hover = new HoverMachine();
  private hoverEnabled = true;
  private lastCursor: Vec | null = null;
  private raf = 0;
  private interactiveNow = false; // as confirmed by main via overlay:interactive
  private drag: DragState | null = null;
  private lastRegionSentAt = 0;
  private lastZone: HoverZone = 'far';
  private lastHintVisible = false;
  private lastEyeCss = '';

  constructor(private readonly ports: HoverDragPorts) {}

  /** Last known cursor (window-local DIP), null once it left the window. */
  get cursor(): Vec | null {
    return this.lastCursor;
  }

  /** Helper-sprite hover eligibility: enabled machine OR confirmed interactive. */
  get isEligible(): boolean {
    return this.hoverEnabled || this.interactiveNow;
  }

  get isDragging(): boolean {
    return this.hover.isDragging;
  }

  // --------------------------------------------------------- cursor events --

  onMouseMove(x: number, y: number): void {
    this.lastCursor = { x, y };
    if (!this.hoverEnabled && !this.interactiveNow) return;

    // Drag: move the buddy with the cursor (imperative, no re-render).
    if (this.drag !== null) {
      if (!this.drag.moved) {
        const moved = Math.hypot(x - this.drag.sx, y - this.drag.sy) > DRAG_THRESHOLD;
        if (moved) {
          this.drag.moved = true;
          this.ports.setDraggingState(true);
          this.applyEffects(this.hover.setDragging(true, this.ports.clock()));
          this.sendStatus();
        }
      }
      if (this.drag.moved) {
        this.ports.flight.jumpTo({ x: x + this.drag.grabDx, y: y + this.drag.grabDy }, REST_ROT);
      }
      this.processHover();
      return;
    }

    // Interactive: run the exit check SYNCHRONOUSLY on every move — click-
    // through must be restored the instant the cursor leaves the region.
    if (this.interactiveNow || this.hover.isInteractive) {
      this.processHover();
      return;
    }

    // Passive observation: do nothing when far from the buddy (budget), and
    // rAF-throttle the rest.
    const buddy = this.ports.buddyPos();
    const dx = x - buddy.x;
    const dy = y - buddy.y;
    if (this.hover.currentZone === 'far' && dx * dx + dy * dy > FAR_GATE_SQ) return;
    if (this.raf === 0) {
      this.raf = this.ports.requestFrame(() => {
        this.raf = 0;
        this.processHover();
      });
    }
  }

  /** The cursor left the window (mouseout with relatedTarget null). */
  onCursorLeftWindow(): void {
    this.lastCursor = null;
    this.processHover();
  }

  /** Returns true when the event was consumed (caller preventDefaults). */
  onMouseDown(x: number, y: number, button: number): boolean {
    if (!this.interactiveNow || button !== 0) return false;
    const buddy = this.ports.buddyPos();
    const half = HOVER_RADIUS + REGION_PAD;
    if (Math.abs(x - buddy.x) > half || Math.abs(y - buddy.y) > half) return false;
    this.drag = { grabDx: buddy.x - x, grabDy: buddy.y - y, sx: x, sy: y, moved: false };
    return true;
  }

  onMouseUp(button: number): void {
    if (this.drag === null || button !== 0) return;
    const wasDrag = this.drag.moved;
    if (wasDrag) {
      this.endDrag();
    } else {
      this.drag = null;
      // CLICK on the buddy -> main toggles the control panel.
      this.ports.sendBuddyClick();
      this.ports.bumpActivity();
    }
  }

  // ------------------------------------------------------------ main events --

  /** 'overlay:interactive' — main confirmed/revoked the click-through flip. */
  setInteractiveFromMain(on: boolean): void {
    this.interactiveNow = on;
    this.ports.setInteractiveState(on);
    if (!on) {
      // Main force-restored click-through (exit event, safety poll, PTT,
      // pointer routing). Reconcile: abort any drag (persisting the spot)
      // and resync the machine if it still thinks it is interactive.
      if (this.drag !== null && this.drag.moved) {
        this.endDrag();
      } else {
        this.drag = null;
      }
      if (this.hover.isInteractive) {
        this.hover.setDragging(false, this.ports.clock());
        this.applyEffects(this.hover.update(null, this.ports.buddyPos(), this.ports.clock()));
        this.lastCursor = null;
      }
    }
  }

  /** Re-evaluate the hover gate (visibility/mode/state/config changed). */
  syncEnabled(): void {
    const enabled = hoverInteractionEnabled(this.ports.gateInput());
    if (enabled === this.hoverEnabled) return;
    this.hoverEnabled = enabled;
    if (!enabled && this.drag !== null) this.drag = null; // drop a drag mid-flight/PTT
    if (!enabled) this.ports.helperHover.release(); // M19: card must not linger
    this.applyEffects(this.hover.setEnabled(enabled, this.ports.clock()));
  }

  /** M19: push the current sprite/card geometry into the hover machine. */
  setAux(aux: AuxHoverGeometry | null): void {
    this.applyEffects(this.hover.setAux(aux, this.ports.clock()));
  }

  /** Hover-machine snapshot for main (debug/QA + initial position report). */
  sendStatus(): void {
    this.ports.sendHover({
      kind: 'status',
      status: {
        zone: this.hover.currentZone,
        hint: this.hover.hintIsVisible,
        dragging: this.hover.isDragging,
        buddy: { x: this.ports.buddyPos().x, y: this.ports.buddyPos().y },
      },
    });
  }

  dispose(): void {
    if (this.raf !== 0) this.ports.cancelFrame(this.raf);
    this.ports.timers.clearAll();
  }

  // ---------------------------------------------------------------- internals

  private processHover(): void {
    this.applyEffects(
      this.hover.update(this.lastCursor, this.ports.buddyPos(), this.ports.clock()),
    );
    this.ports.helperHover.updateFromCursor();
  }

  private endDrag(): void {
    this.drag = null;
    this.ports.setDraggingState(false);
    const { width: vw, height: vh } = this.ports.viewport();
    const snapped = snapRest(this.ports.buddyPos(), vw, vh);
    // Persist FIRST (main updates settings + re-pushes hover config), then
    // glide to the snapped spot. setDraggingState(false) re-enables region-exit.
    this.ports.sendBuddyMove(restToFrac(snapped, vw, vh));
    this.applyEffects(this.hover.setDragging(false, this.ports.clock()));
    void this.ports.flight
      .flyTo(snapped, { settleRot: REST_ROT, duration: DRAG_SNAP_DURATION_MS })
      .then((done) => {
        if (!done) return;
        this.ports.updatePlacement(snapped);
        // Re-evaluate now that the buddy settled: if the cursor stayed at the
        // release point (far from the snapped spot) this releases the
        // interactive flip immediately instead of leaving a stale region.
        this.applyEffects(this.hover.tick(this.ports.buddyPos(), this.ports.clock()));
      });
    this.sendStatus();
  }

  private applyEffects(fx: HoverEffects): void {
    // Interactive flip requests (dwell) / SAFETY-CRITICAL releases (exit).
    if (fx.requestInteractive) {
      const now = this.ports.clock();
      // During a drag these are throttled region-refresh keepalives.
      if (!this.hover.isDragging || now - this.lastRegionSentAt >= DRAG_REGION_SEND_MS) {
        this.lastRegionSentAt = now;
        this.ports.sendHover({ kind: 'dwell', region: fx.region });
      }
    }
    if (fx.releaseInteractive) {
      this.ports.sendHover({ kind: 'exit' });
    }

    // Zone visuals (perk-up / awareness) — only on transitions.
    if (fx.zone !== this.lastZone) {
      this.lastZone = fx.zone;
      this.ports.setZone(fx.zone);
      this.ports.bumpActivity(); // hovering resumes the idle-bob battery saver
      this.sendStatus();
    }

    // Hint bubble show/fade edges.
    if (fx.hintVisible !== this.lastHintVisible) {
      this.lastHintVisible = fx.hintVisible;
      this.ports.timers.clear('hintFade');
      if (fx.hintVisible) {
        this.ports.setHintState('shown');
      } else {
        this.ports.setHintState((s) => (s === 'shown' ? 'fading' : s));
        this.ports.timers.set('hintFade', HINT_FADE_MS, () => this.ports.setHintState('hidden'));
      }
      this.sendStatus();
    }

    // Eye tracking: transform-only pupil offset, quantized in eyeOffset so
    // repeated mousemoves that don't visibly change the gaze are free.
    const offset = eyeOffset(fx.zone === 'far' ? null : this.lastCursor, this.ports.buddyPos());
    const css = offset.x === 0 && offset.y === 0 ? '' : `translate(${offset.x}px, ${offset.y}px)`;
    if (css !== this.lastEyeCss) {
      this.lastEyeCss = css;
      this.ports.setPupilTransform(css);
    }

    // Pending hint/dwell deadlines -> timer tick (cursor may sit still).
    this.ports.timers.clear('deadline');
    if (fx.nextDeadline !== null) {
      this.ports.timers.set('deadline', Math.max(0, fx.nextDeadline - this.ports.clock()), () => {
        this.applyEffects(this.hover.tick(this.ports.buddyPos(), this.ports.clock()));
      });
    }
  }
}
