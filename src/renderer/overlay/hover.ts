/**
 * M15 buddy-hover: PURE logic for the hover / dwell / drag-rest features.
 * No DOM, no Electron — everything here is unit-tested as plain functions
 * (tests/hover.test.ts). The DOM/IPC wiring lives in main.tsx.
 *
 * Coordinate space: window-local DIP (CSS px of the overlay window, which
 * covers one full display).
 */

import type { AssistantState, Rect } from '../../shared/types';

/**
 * Local Vec (structurally identical to flight.ts's Vec). Deliberately NOT
 * imported from ./flight: this module must stay importable under the node
 * tsconfig (unit tests) and flight.ts uses DOM globals.
 */
export interface Vec {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Cursor within this distance of the buddy center -> eyes track it. */
export const AWARE_RADIUS = 200;
/** Buddy footprint radius (~44px circle) -> perk-up + hint + dwell zone. */
export const HOVER_RADIUS = 22;
/** Padding beyond the footprint for the interactive region / exit test. */
export const REGION_PAD = 14;
/** Hover this long before the hint bubble shows (anti-flicker). */
export const HINT_DELAY_MS = 250;
/** Hover this long before the overlay is flipped interactive. */
export const DWELL_MS = 500;
/** Max pupil offset for eye tracking, px. */
export const MAX_PUPIL_OFFSET = 1.5;
/** Drag starts once the cursor moved this far from the mousedown point. */
export const DRAG_THRESHOLD = 4;
/** "want more?" hint variant window after the last spoken response. */
export const RECENT_RESPONSE_MS = 2 * 60_000;

/** Rest-position edge margins (default rest = bottom-right at these margins). */
export const REST_MARGIN_X = 76;
export const REST_MARGIN_Y_TOP = 90;
export const REST_MARGIN_Y_BOTTOM = 120;

export type HoverZone = 'far' | 'aware' | 'hover';

/**
 * Whether the renderer may observe/dwell the resting Buddy.
 *
 * `listening` means a held hotkey in push-to-talk mode, but it means the
 * long-lived ready state in full realtime mode. Only the former must block
 * mouse interaction.
 */
export function hoverInteractionEnabled(input: {
  visible: boolean;
  atRest: boolean;
  state: AssistantState;
  fullRealtimeMode: boolean;
}): boolean {
  return (
    input.visible &&
    input.atRest &&
    (input.state !== 'listening' || input.fullRealtimeMode)
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function zoneFor(cursor: Vec, buddy: Vec): HoverZone {
  const d = dist(cursor, buddy);
  if (d <= HOVER_RADIUS) return 'hover';
  if (d <= AWARE_RADIUS) return 'aware';
  return 'far';
}

/**
 * Pupil offset toward the cursor, capped at MAX_PUPIL_OFFSET and quantized to
 * 0.25px steps (quantization keeps repeated mousemoves from re-rasterizing
 * the SVG when the resulting offset didn't visibly change). Zero when the
 * cursor is null or beyond the aware radius.
 */
export function eyeOffset(cursor: Vec | null, buddy: Vec): Vec {
  if (!cursor) return { x: 0, y: 0 };
  const dx = cursor.x - buddy.x;
  const dy = cursor.y - buddy.y;
  const d = Math.hypot(dx, dy);
  if (d === 0 || d > AWARE_RADIUS) return { x: 0, y: 0 };
  // Full deflection from ~40px out; ease in closer than that.
  const mag = MAX_PUPIL_OFFSET * Math.min(1, d / 40);
  const q = (v: number): number => Math.round((v / d) * mag * 4) / 4;
  return { x: q(dx), y: q(dy) };
}

/** Padded interactive region (square) around the buddy center, window-local DIP. */
export function paddedRegion(buddy: Vec): Rect {
  const half = HOVER_RADIUS + REGION_PAD;
  return { x: buddy.x - half, y: buddy.y - half, width: half * 2, height: half * 2 };
}

export function insideRect(p: Vec, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

// ---------------------------------------------------------------------------
// M19 agent helpers: auxiliary hover geometry (helper sprites + agent card)
// ---------------------------------------------------------------------------

/** Padding beyond aux targets / the card for the interactive region. */
export const AUX_PAD = 10;
/**
 * Main rejects dwell regions larger than 400x400 (windows/overlay.ts
 * isFiniteRect) — merged regions are clamped just under that.
 */
export const REGION_CAP = 398;

/**
 * Hoverable geometry beyond the buddy footprint: the agent helper sprites
 * (small circles) and, while one is hovered, the open agent card (a rect).
 * All coordinates window-local DIP, like the buddy.
 */
export interface AuxHoverGeometry {
  /** Helper-sprite / overflow-pebble centers. */
  targets: Vec[];
  /** Hover radius around each target. */
  targetRadius: number;
  /** Bounds of the open agent card, or null when no card is showing. */
  rect: Rect | null;
}

function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

function unionRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Is the cursor on any aux target (sprite) or inside the padded card rect? */
export function insideAux(cursor: Vec, aux: AuxHoverGeometry | null): boolean {
  if (aux === null) return false;
  if (aux.rect !== null && insideRect(cursor, padRect(aux.rect, AUX_PAD))) return true;
  return aux.targets.some((t) => dist(cursor, t) <= aux.targetRadius);
}

/**
 * Interactive region covering the padded buddy footprint plus the aux
 * geometry. Clamped to REGION_CAP per axis by trimming the edge FARTHEST
 * from the buddy — the buddy footprint itself always stays inside (the
 * clamp must never strand the buddy outside its own region).
 */
export function mergedRegion(buddy: Vec, aux: AuxHoverGeometry | null): Rect {
  const base = paddedRegion(buddy);
  if (aux === null) return base;
  let region = base;
  const half = aux.targetRadius + AUX_PAD;
  for (const t of aux.targets) {
    region = unionRects(region, { x: t.x - half, y: t.y - half, width: half * 2, height: half * 2 });
  }
  if (aux.rect !== null) region = unionRects(region, padRect(aux.rect, AUX_PAD));
  // Per-axis cap: keep the base (buddy) span, trim the far side.
  let { x, y, width, height } = region;
  if (width > REGION_CAP) {
    x = Math.max(x, Math.min(base.x, x + width - REGION_CAP));
    width = REGION_CAP;
  }
  if (height > REGION_CAP) {
    y = Math.max(y, Math.min(base.y, y + height - REGION_CAP));
    height = REGION_CAP;
  }
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Rest position: defaults, drag snapping, fraction persistence
// ---------------------------------------------------------------------------

/** The pre-M15 default rest pose: near the bottom-right, above the taskbar. */
export function defaultRest(vw: number, vh: number): Vec {
  return { x: vw - REST_MARGIN_X, y: vh - REST_MARGIN_Y_BOTTOM };
}

/**
 * Snap a drag-release position to the nearest edge margin: the closest edge's
 * coordinate is pinned to its margin, the other axis is clamped inside its
 * margins (dragging into a corner naturally yields the corner). Degenerate
 * viewports (smaller than the margins) collapse to the default rest.
 */
export function snapRest(pos: Vec, vw: number, vh: number): Vec {
  if (vw <= REST_MARGIN_X * 2 || vh <= REST_MARGIN_Y_TOP + REST_MARGIN_Y_BOTTOM) {
    return defaultRest(vw, vh);
  }
  const clampX = Math.min(Math.max(pos.x, REST_MARGIN_X), vw - REST_MARGIN_X);
  const clampY = Math.min(Math.max(pos.y, REST_MARGIN_Y_TOP), vh - REST_MARGIN_Y_BOTTOM);
  const dLeft = clampX - REST_MARGIN_X;
  const dRight = vw - REST_MARGIN_X - clampX;
  const dTop = clampY - REST_MARGIN_Y_TOP;
  const dBottom = vh - REST_MARGIN_Y_BOTTOM - clampY;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return { x: REST_MARGIN_X, y: clampY };
  if (min === dRight) return { x: vw - REST_MARGIN_X, y: clampY };
  if (min === dTop) return { x: clampX, y: REST_MARGIN_Y_TOP };
  return { x: clampX, y: vh - REST_MARGIN_Y_BOTTOM };
}

/** Position -> persisted fraction of the viewport. */
export function restToFrac(pos: Vec, vw: number, vh: number): { xFrac: number; yFrac: number } {
  const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
  return { xFrac: clamp01(pos.x / (vw || 1)), yFrac: clamp01(pos.y / (vh || 1)) };
}

/**
 * Persisted fraction -> position, re-snapped to the edge margins (display
 * size may have changed since the drag). null -> the default corner.
 */
export function restFromFrac(
  rest: { xFrac: number; yFrac: number } | null,
  vw: number,
  vh: number,
): Vec {
  if (!rest) return defaultRest(vw, vh);
  return snapRest({ x: rest.xFrac * vw, y: rest.yFrac * vh }, vw, vh);
}

// ---------------------------------------------------------------------------
// Hint text
// ---------------------------------------------------------------------------

export interface HintTextInput {
  state: AssistantState;
  hotkeyLabel: string;
  fullRealtimeMode?: boolean;
  /** Epoch ms when the assistant last finished speaking; null = never. */
  lastSpokeAt: number | null;
  now: number;
  captionShowing: boolean;
  /** Dwell armed: the overlay is currently interactive (click would work). */
  interactive: boolean;
  /** M19: the cursor is on an agent helper / its card — the card IS the hint. */
  agentHover?: boolean;
}

/**
 * State-aware hint bubble copy. null = show nothing (listening / thinking /
 * speaking must not be distracted from; an error caption is never replaced).
 */
export function hintText(input: HintTextInput): { text: string; sub?: string } | null {
  if (input.agentHover === true) return null;
  if (input.captionShowing) return null;
  if (input.state !== 'idle') return null;
  const hk = input.hotkeyLabel.toLowerCase();
  const recent =
    input.lastSpokeAt !== null && input.now - input.lastSpokeAt < RECENT_RESPONSE_MS;
  const text = input.fullRealtimeMode
    ? `press ${hk} to start realtime mode`
    : recent
      ? `want more? hold ${hk} and ask me anything`
      : `hold ${hk} and talk to me`;
  return input.interactive ? { text, sub: 'click me to open the panel' } : { text };
}

// ---------------------------------------------------------------------------
// Hover state machine (dwell / region-exit)
// ---------------------------------------------------------------------------

/**
 * Edge-triggered effects of one machine step. The caller applies them:
 * requestInteractive/releaseInteractive map 1:1 onto the 'overlay:hover'
 * dwell/exit IPC events; hintVisible/zone drive the visuals.
 */
export interface HoverEffects {
  zone: HoverZone;
  hintVisible: boolean;
  /** Fire 'dwell' (make interactive) with `region` now. */
  requestInteractive: boolean;
  /** Fire 'exit' (RESTORE CLICK-THROUGH) now. */
  releaseInteractive: boolean;
  /** Padded buddy region (valid whenever interactive is requested/held). */
  region: Rect;
  /** Caller should call tick() at this time to fire pending hint/dwell. */
  nextDeadline: number | null;
}

/**
 * Deterministic hover machine: time is always passed in, timers are the
 * caller's job (schedule a tick() at nextDeadline). Safety property under
 * test: once interactive, ANY update that puts the cursor outside the padded
 * region (or disables the machine) emits releaseInteractive on that very
 * call — never later.
 */
export class HoverMachine {
  private zone: HoverZone = 'far';
  private hoverSince: number | null = null;
  private hintShown = false;
  private interactive = false;
  private dragging = false;
  private enabled = true;
  private cursor: Vec | null = null;
  private buddy: Vec = { x: 0, y: 0 };
  /** M19: agent-helper geometry (sprites + open card), null when no agents. */
  private aux: AuxHoverGeometry | null = null;
  /** Aux changed since the last step: emit one region refresh if interactive. */
  private auxDirty = false;

  get isInteractive(): boolean {
    return this.interactive;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  get currentZone(): HoverZone {
    return this.zone;
  }

  get hintIsVisible(): boolean {
    return this.hintShown;
  }

  /** Cursor moved (or left: null). */
  update(cursor: Vec | null, buddy: Vec, now: number): HoverEffects {
    this.cursor = cursor;
    this.buddy = buddy;
    return this.step(now);
  }

  /** Re-evaluate with the stored cursor (deadline timers). */
  tick(buddy: Vec, now: number): HoverEffects {
    this.buddy = buddy;
    return this.step(now);
  }

  /**
   * Enable/disable the whole machine (disabled while the buddy is flying/
   * pointing, hidden, or the user is holding push-to-talk). Disabling while
   * interactive releases immediately.
   */
  setEnabled(enabled: boolean, now: number): HoverEffects {
    this.enabled = enabled;
    return this.step(now);
  }

  /**
   * Dragging: the interactive region follows the buddy and region-exit is
   * suppressed (the drag itself owns the mouse; releasing mid-drag would eat
   * the mouseup elsewhere and strand the button state).
   */
  setDragging(dragging: boolean, now: number): HoverEffects {
    this.dragging = dragging;
    return this.step(now);
  }

  /**
   * M19: update the agent-helper hover geometry (sprite centers + open card
   * rect). Hovering any of it counts as the 'hover' zone, and the interactive
   * region grows to cover it (mergedRegion). While interactive, a geometry
   * change emits one requestInteractive so main refreshes its exit-poll
   * region. Shrinking geometry that leaves the cursor outside releases on
   * this very call (the safety property extends to the merged region).
   */
  setAux(aux: AuxHoverGeometry | null, now: number): HoverEffects {
    this.aux = aux;
    this.auxDirty = true;
    return this.step(now);
  }

  // -------------------------------------------------------------------------

  private step(now: number): HoverEffects {
    const region = mergedRegion(this.buddy, this.aux);
    const auxDirty = this.auxDirty;
    this.auxDirty = false;
    let requestInteractive = false;
    let releaseInteractive = false;

    if (!this.enabled || this.cursor === null) {
      if (this.interactive && !this.dragging) {
        this.interactive = false;
        releaseInteractive = true;
      }
      // A disable mid-drag (e.g. push-to-talk) also force-releases: safety
      // beats drag continuity.
      if (this.interactive && !this.enabled) {
        this.interactive = false;
        this.dragging = false;
        releaseInteractive = true;
      }
      this.zone = 'far';
      this.hoverSince = null;
      this.hintShown = false;
      return {
        zone: this.zone,
        hintVisible: false,
        requestInteractive,
        releaseInteractive,
        region,
        nextDeadline: null,
      };
    }

    // M19: the helper sprites / open card count as the hover zone too.
    const zone = insideAux(this.cursor, this.aux) ? 'hover' : zoneFor(this.cursor, this.buddy);

    if (this.interactive) {
      const stillInside = this.dragging || insideRect(this.cursor, region);
      if (!stillInside) {
        // SAFETY-CRITICAL: left the padded region -> release on THIS call.
        this.interactive = false;
        releaseInteractive = true;
        this.zone = zone;
        this.hoverSince = zone === 'hover' ? now : null;
        this.hintShown = false;
        return {
          zone,
          hintVisible: false,
          requestInteractive,
          releaseInteractive,
          region,
          nextDeadline: null,
        };
      }
      // Interactive and inside: hint stays, region refreshes while dragging
      // (keepalive) or when the aux geometry changed (card opened/closed).
      this.zone = 'hover';
      this.hintShown = true;
      return {
        zone: 'hover',
        hintVisible: true,
        requestInteractive: this.dragging || auxDirty,
        releaseInteractive: false,
        region,
        nextDeadline: null,
      };
    }

    // Not interactive: zone transitions + hint/dwell countdowns.
    if (zone === 'hover') {
      if (this.hoverSince === null) this.hoverSince = now;
      const hintAt = this.hoverSince + HINT_DELAY_MS;
      const dwellAt = this.hoverSince + DWELL_MS;
      if (!this.hintShown && now >= hintAt) this.hintShown = true;
      if (now >= dwellAt) {
        this.interactive = true;
        requestInteractive = true;
      }
      this.zone = zone;
      const nextDeadline = this.interactive ? null : this.hintShown ? dwellAt : hintAt;
      return {
        zone,
        hintVisible: this.hintShown,
        requestInteractive,
        releaseInteractive,
        region,
        nextDeadline,
      };
    }

    this.zone = zone;
    this.hoverSince = null;
    this.hintShown = false;
    return {
      zone,
      hintVisible: false,
      requestInteractive: false,
      releaseInteractive,
      region,
      nextDeadline: null,
    };
  }
}
