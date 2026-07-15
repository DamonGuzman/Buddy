/**
 * M19 agent helpers: which helper sprites are on screen, where the cluster
 * sits, which helper the cursor is hovering (with anti-flicker grace timers),
 * and the phase-boundary sweep that retires finished helpers on time.
 *
 * The pure decisions live in agents-ui.ts (selectHelpers / helperSlotViews /
 * desiredHelperHover / helperHoverStep / nextHelperTransition); this
 * controller owns their state + timing over an injected clock and TimerBag,
 * and pushes view changes through ports (main.tsx binds them to useState
 * mirrors, and applyAux feeds the hover machine's merged region). No DOM —
 * unit-tested with fake time in tests/overlay-controllers.test.ts.
 */

import {
  HELPER_HIT_RADIUS,
  OVERFLOW_KEY,
  desiredHelperHover,
  helperHoverStep,
  helperSlotViews,
  nextHelperTransition,
  selectHelpers,
} from './agents-ui';
import type { HelperSlot, HelperView } from './agents-ui';
import { placementFor } from './hover';
import type { AuxHoverGeometry, Vec } from './hover';
import type { AgentSummary, Rect } from '../../shared/types';
import type { Clock, TimerBag } from './timer-bag';

/** Sweep again this soon after a hover release (an exempt departure may be overdue). */
const RELEASE_RESWEEP_MS = 250;
/** Never arm a sweep sooner than this (coalesces boundary bursts). */
const SWEEP_MIN_DELAY_MS = 60;
/** Fire slightly after the boundary so the phase test is unambiguous. */
const SWEEP_SLACK_MS = 30;

/** Cluster anchor + sweep direction (dir: +1 = rightward, vdir: +1 = downward). */
export interface ClusterGeom {
  anchor: Vec;
  dir: 1 | -1;
  vdir: 1 | -1;
}

export interface HelperHoverPorts {
  clock: Clock;
  timers: TimerBag;
  /** Buddy REST spot — the cluster is anchored there. */
  anchor(): Vec;
  /** Last known cursor position (window-local DIP), null = outside. */
  cursor(): Vec | null;
  /** Hovering is eligible: machine enabled OR overlay confirmed interactive. */
  hoverEligible(): boolean;
  /** Measured open-card bounds (window-local DIP), or null. */
  cardRect(): Rect | null;
  /** Push sprite/card geometry into the hover machine (merged region). */
  applyAux(aux: AuxHoverGeometry | null): void;
  /** React mirrors. */
  onView(view: HelperView): void;
  onCluster(cluster: ClusterGeom | null): void;
  onHover(key: string | null): void;
  onNow(now: number): void;
}

export class HelperHoverController {
  private agents: AgentSummary[] = [];
  private view: HelperView = { shown: [], overflow: [] };
  /** Visible sprite/pebble slots (key + absolute center), in render order. */
  private slots: HelperSlot[] = [];
  private hovered: string | null = null;
  /** Key a grace timer will commit (null = pending hide); see timers 'grace'. */
  private pending: string | null = null;
  /**
   * M22: agent whose full-status card is expanded (clicked). Pinned like the
   * hovered helper — exempt from the linger clock so the card the user is
   * reading never vanishes, even when it was opened from the overflow card
   * (where `hovered` is OVERFLOW_KEY, not the agent id).
   */
  private pinned: string | null = null;

  constructor(private readonly ports: HelperHoverPorts) {}

  /** Agent list push from main ('overlay:agents'). */
  setAgents(list: AgentSummary[]): void {
    this.agents = list;
    this.recompute();
  }

  /** Bootstrap for late-created overlays (display hotplug) — push wins races. */
  bootstrap(list: AgentSummary[]): void {
    if (this.agents.length === 0 && list.length > 0) this.setAgents(list);
  }

  /** M22: pin/unpin the expanded full-status card's agent (null = none). */
  setPinned(id: string | null): void {
    if (id === this.pinned) return;
    this.pinned = id;
    this.recompute();
  }

  /** Re-derive visible helpers + slot geometry (agents / anchor changed). */
  recompute(): void {
    const now = this.ports.clock();
    this.ports.onNow(now);
    this.view = selectHelpers(this.agents, now, this.keepKey());
    this.ports.onView(this.view);
    const count = this.view.shown.length + (this.view.overflow.length > 0 ? 1 : 0);
    if (count === 0) {
      this.slots = [];
      this.ports.onCluster(null);
      this.commitHover(null);
      this.syncAux();
      this.scheduleSweep();
      return;
    }
    const geom = this.clusterGeom();
    this.slots = helperSlotViews(this.view, geom.anchor, geom.dir, geom.vdir);
    this.ports.onCluster(geom);
    // A hovered helper that vanished entirely (seen / expired) drops its card.
    if (this.hovered !== null && !this.slots.some((s) => s.key === this.hovered)) {
      const stillListed =
        this.hovered !== OVERFLOW_KEY &&
        [...this.view.shown, ...this.view.overflow].some((a) => a.id === this.hovered);
      if (!stillListed) this.commitHover(null);
    }
    this.syncAux();
    this.updateFromCursor();
    this.scheduleSweep();
  }

  /**
   * Cursor -> hovered helper, with show/hide grace timers (anti-flicker +
   * time to travel from a sprite into its card). Rides the same cursor feed
   * as the hover machine (called from processHover).
   */
  updateFromCursor(): void {
    const want = desiredHelperHover({
      cursor: this.ports.cursor(),
      slots: this.slots,
      hovered: this.hovered,
      cardRect: this.ports.cardRect(),
      enabled: this.ports.hoverEligible(),
    });
    const step = helperHoverStep(want, this.hovered);
    if (step.kind === 'hold') {
      this.ports.timers.clear('grace');
      this.pending = null;
      return;
    }
    if (step.kind === 'commit') {
      this.commitHover(want);
      return;
    }
    if (this.pending === want && this.ports.timers.has('grace')) return;
    this.pending = want;
    this.ports.timers.set('grace', step.delayMs, () => {
      const key = this.pending;
      this.pending = null;
      this.commitHover(key);
    });
  }

  /** Drop any hover NOW (hover interaction disabled — card must not linger). */
  release(): void {
    this.commitHover(null);
  }

  /** Re-push aux geometry (the open card was measured/re-measured). */
  syncAux(): void {
    const aux: AuxHoverGeometry | null =
      this.slots.length > 0
        ? {
            targets: this.slots.map((s) => s.pos),
            targetRadius: HELPER_HIT_RADIUS,
            rect: this.hovered !== null ? this.ports.cardRect() : null,
          }
        : null;
    this.ports.applyAux(aux);
  }

  dispose(): void {
    this.ports.timers.clearAll();
  }

  // ---------------------------------------------------------------- internals

  /** Linger-clock exemption: the pinned (expanded) helper wins over hover. */
  private keepKey(): string | undefined {
    return this.pinned ?? this.hovered ?? undefined;
  }

  /** Cluster anchor = the buddy REST spot; content extends toward the roomy
   *  side of the screen (same edge thresholds as bubble placement). */
  private clusterGeom(): ClusterGeom {
    const anchor = this.ports.anchor();
    const placement = placementFor(anchor);
    return {
      anchor,
      dir: placement.h === 'left' ? 1 : -1,
      vdir: placement.v === 'below' ? 1 : -1,
    };
  }

  private commitHover(key: string | null): void {
    this.ports.timers.clear('grace');
    this.pending = null;
    if (key === this.hovered) return;
    this.hovered = key;
    this.ports.onHover(key);
    this.syncAux();
    // A hover release may unfreeze an overdue departure (the hovered helper
    // is exempt from the linger clock) — sweep again shortly.
    if (key === null) this.scheduleSweep(RELEASE_RESWEEP_MS);
    else this.scheduleSweep();
  }

  /** (Re)arm a recompute at the next finished-helper phase boundary. */
  private scheduleSweep(delayOverrideMs?: number): void {
    this.ports.timers.clear('sweep');
    const now = this.ports.clock();
    const next =
      delayOverrideMs !== undefined
        ? now + delayOverrideMs
        : nextHelperTransition(this.agents, now, this.keepKey());
    if (next === null) return;
    this.ports.timers.set('sweep', Math.max(SWEEP_MIN_DELAY_MS, next - now + SWEEP_SLACK_MS), () =>
      this.recompute(),
    );
  }
}
