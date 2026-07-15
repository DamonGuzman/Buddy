/**
 * M19 agent helpers: PURE view-model logic for representing background agents
 * on the overlay as tiny "helper buddy" sprites beside the mascot, with a
 * friendly hover card. No DOM, no Electron — unit-tested as plain functions
 * (tests/agents-ui.test.ts). The DOM/IPC wiring lives in main.tsx and the
 * components in AgentHelpers.tsx.
 *
 * Voice: written for a completely non-technical user — no "agents", "steps",
 * "sources" or status codes. Lowercase, warm, matches the persona.
 */

import type { AgentSummary, Rect } from '../../shared/types';
import { AUX_PAD, dist, insideRect, padRect } from './hover';
import type { Vec } from './hover';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Helper sprite footprint hit radius (sprite is 22px; a touch of slack). */
export const HELPER_HIT_RADIUS = 18;
/** Distance of the helper arc from the buddy center. */
export const HELPER_ARC_RADIUS = 48;
/** Degrees between helpers along the arc. */
export const HELPER_ARC_STEP_DEG = 38;
/** At most this many individual sprites; extras fold into the "+N" pebble. */
export const MAX_HELPER_SPRITES = 3;
/**
 * Finished helpers celebrate, then leave on their own — total time on screen
 * after finishing. They exist to help the buddy, not to be managed by the
 * user; the panel stays the permanent record.
 */
export const FINISHED_LINGER_MS = 10_000;
/** Tail of the linger window spent shrinking back into the buddy. */
export const HELPER_DEPART_MS = 650;
/** Agent card width (must keep the merged hover region under main's cap). */
export const AGENT_CARD_W = 248;
/** Horizontal gap between the buddy center and the card's near edge. */
export const AGENT_CARD_GAP = 70;
/** Hovered key for the overflow pebble (never collides with agent ids). */
export const OVERFLOW_KEY = '::more';
/** Hover this long before the agent card shows (anti-flicker). */
export const CARD_SHOW_DELAY_MS = 140;
/** Grace period to travel from a sprite into the card before it hides. */
export const CARD_HIDE_DELAY_MS = 280;

// ---------------------------------------------------------------------------
// Which agents are visible, and where
// ---------------------------------------------------------------------------

export interface HelperView {
  /** Individually rendered sprites (≤ MAX_HELPER_SPRITES). */
  shown: AgentSummary[];
  /** Folded into the "+N" pebble, listed on its card. */
  overflow: AgentSummary[];
}

function isActive(agent: AgentSummary): boolean {
  return agent.status === 'queued' || agent.status === 'running';
}

/**
 * Where a helper is in its on-screen life:
 * - 'active'    queued/running — stays as long as the agent works
 * - 'settled'   finished — celebrating / available to hover
 * - 'departing' last HELPER_DEPART_MS of the linger — shrinking back home
 * - 'gone'      not shown (expired, viewed in the panel, or cancelled)
 *
 * `keepId` freezes that helper at 'settled' — the one being hovered must
 * never vanish under the cursor.
 */
export type HelperPhase = 'active' | 'settled' | 'departing' | 'gone';

export function helperPhase(agent: AgentSummary, now: number, keepId?: string): HelperPhase {
  if (isActive(agent)) return 'active';
  if (agent.status === 'cancelled') return 'gone';
  if (!agent.unseen) return 'gone';
  if (agent.id === keepId) return 'settled';
  const t = now - (agent.finishedAt ?? agent.createdAt);
  if (t >= FINISHED_LINGER_MS) return 'gone';
  if (t >= FINISHED_LINGER_MS - HELPER_DEPART_MS) return 'departing';
  return 'settled';
}

/**
 * Agents worth showing beside the buddy: everything active, plus recently
 * finished runs still in their celebrate-and-leave window. Cancelled runs
 * never show — the user asked for them to go away.
 */
export function selectHelpers(agents: AgentSummary[], now: number, keepId?: string): HelperView {
  const active = agents.filter(isActive).sort((a, b) => a.createdAt - b.createdAt);
  const finished = agents
    .filter((a) => !isActive(a) && helperPhase(a, now, keepId) !== 'gone')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const all = [...active, ...finished];
  return { shown: all.slice(0, MAX_HELPER_SPRITES), overflow: all.slice(MAX_HELPER_SPRITES) };
}

/**
 * Soonest FUTURE phase boundary (settled->departing or departing->gone)
 * among finished helpers, or null when nothing is scheduled to change.
 * Drives the renderer's next recompute timer — no polling.
 */
export function nextHelperTransition(
  agents: AgentSummary[],
  now: number,
  keepId?: string,
): number | null {
  let next: number | null = null;
  for (const a of agents) {
    if (isActive(a) || a.status === 'cancelled' || !a.unseen || a.id === keepId) continue;
    const finished = a.finishedAt ?? a.createdAt;
    for (const boundary of [
      finished + FINISHED_LINGER_MS - HELPER_DEPART_MS,
      finished + FINISHED_LINGER_MS,
    ]) {
      if (boundary > now && (next === null || boundary < next)) next = boundary;
    }
  }
  return next;
}

/**
 * Sprite slot offsets relative to the buddy center: a quarter-ish arc that
 * starts straight "up" and sweeps toward the screen center. dir mirrors
 * horizontally (+1 = helpers extend right of the buddy), vdir vertically
 * (-1 = up, +1 = down for a buddy resting near the top edge).
 */
export function helperSlots(count: number, dir: 1 | -1, vdir: 1 | -1): Vec[] {
  const slots: Vec[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i * HELPER_ARC_STEP_DEG * Math.PI) / 180;
    // Round the magnitude BEFORE applying the mirror signs so mirrored
    // layouts are exact reflections; `+ 0` normalizes -0.
    slots.push({
      x: dir * Math.round(HELPER_ARC_RADIUS * Math.sin(a)) + 0,
      y: vdir * Math.round(HELPER_ARC_RADIUS * Math.cos(a)) + 0,
    });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Hover decision (which helper the cursor wants, anti-flicker grace)
// ---------------------------------------------------------------------------

/** One rendered cluster slot: a helper sprite or the "+N" overflow pebble. */
export interface HelperSlot {
  /** Agent id, or OVERFLOW_KEY for the pebble. */
  key: string;
  /** Absolute sprite/pebble center (window-local DIP). */
  pos: Vec;
}

/** Fuse the visible view + arc layout into keyed, absolutely-positioned slots. */
export function helperSlotViews(
  view: HelperView,
  anchor: Vec,
  dir: 1 | -1,
  vdir: 1 | -1,
): HelperSlot[] {
  const keys = [
    ...view.shown.map((a) => a.id),
    ...(view.overflow.length > 0 ? [OVERFLOW_KEY] : []),
  ];
  const offsets = helperSlots(keys.length, dir, vdir);
  return keys.map((key, i) => {
    const o = offsets[i] ?? { x: 0, y: 0 };
    return { key, pos: { x: anchor.x + o.x, y: anchor.y + o.y } };
  });
}

/**
 * Which helper (if any) the cursor is on: the NEAREST sprite within
 * HELPER_HIT_RADIUS wins; failing that, a cursor still inside the open card
 * (padded by AUX_PAD, matching the hover machine's aux test) keeps the
 * currently hovered helper. null when nothing is hovered or hovering is
 * ineligible (machine disabled and overlay not interactive).
 */
export function desiredHelperHover(input: {
  cursor: Vec | null;
  slots: HelperSlot[];
  hovered: string | null;
  cardRect: Rect | null;
  enabled: boolean;
}): string | null {
  const { cursor, slots, hovered, cardRect } = input;
  if (cursor === null || slots.length === 0 || !input.enabled) return null;
  let want: string | null = null;
  let bestD = Infinity;
  for (const slot of slots) {
    const d = dist(cursor, slot.pos);
    if (d <= HELPER_HIT_RADIUS && d < bestD) {
      bestD = d;
      want = slot.key;
    }
  }
  // Not on a sprite, but still inside the open card: keep it open.
  if (want === null && hovered !== null && cardRect !== null) {
    if (insideRect(cursor, padRect(cardRect, AUX_PAD))) want = hovered;
  }
  return want;
}

/**
 * Anti-flicker transition from the current hover to `want`:
 * - 'hold'   nothing to change — cancel any pending switch
 * - 'commit' switch NOW (moving directly between helpers must not blink)
 * - 'defer'  arm a grace timer (show delay entering, hide delay leaving —
 *            time to travel from a sprite into its card)
 */
export type HelperHoverStep =
  { kind: 'hold' } | { kind: 'commit' } | { kind: 'defer'; delayMs: number };

export function helperHoverStep(want: string | null, hovered: string | null): HelperHoverStep {
  if (want === hovered) return { kind: 'hold' };
  if (want !== null && hovered !== null) return { kind: 'commit' };
  return { kind: 'defer', delayMs: want === null ? CARD_HIDE_DELAY_MS : CARD_SHOW_DELAY_MS };
}

// ---------------------------------------------------------------------------
// Per-agent tint (stable pastel identity, distinct from the buddy blue)
// ---------------------------------------------------------------------------

export interface HelperTint {
  name: string;
  /** Gradient top (light). */
  light: string;
  /** Gradient bottom (saturated). */
  dark: string;
  /** Hover glow (rgba). */
  glow: string;
}

export const HELPER_TINTS: HelperTint[] = [
  { name: 'sunny', light: '#ffd97a', dark: '#f09312', glow: 'rgba(245, 158, 11, 0.8)' },
  { name: 'mint', light: '#7ce8bb', dark: '#0ea371', glow: 'rgba(16, 185, 129, 0.8)' },
  { name: 'lilac', light: '#cabffd', dark: '#8b5cf6', glow: 'rgba(139, 92, 246, 0.8)' },
  { name: 'coral', light: '#ffa8b3', dark: '#ee4463', glow: 'rgba(244, 63, 94, 0.75)' },
  { name: 'sea', light: '#8fe3e0', dark: '#0d9ea8', glow: 'rgba(20, 184, 166, 0.8)' },
];

/** Stable tint for an agent id (same helper keeps its color across updates). */
export function helperTint(id: string): HelperTint {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HELPER_TINTS[h % HELPER_TINTS.length] as HelperTint;
}

// ---------------------------------------------------------------------------
// Friendly copy
// ---------------------------------------------------------------------------

export interface HelperStatusView {
  /** Short status pill, e.g. 'on it' / 'all done'. */
  pill: string;
  /** Drives pill/badge styling. */
  kind: 'waiting' | 'working' | 'done' | 'trouble';
  /** One warm line about what it's doing / how it ended. */
  line: string;
  /** Muted call-to-action (what a click does), or null. */
  cta: string | null;
}

/** 'searched "x"' -> 'searching for "x"', 'read foo.com/…' -> 'reading foo.com/…'. */
function activityLine(agent: AgentSummary): string {
  const last = agent.steps[agent.steps.length - 1];
  if (!last) return 'figuring out where to start';
  switch (last.kind) {
    case 'search': {
      const m = /^searched\s+(.*)$/.exec(last.label);
      return m ? `searching for ${m[1]}` : 'searching the web';
    }
    case 'fetch': {
      const m = /^read\s+(.*)$/.exec(last.label);
      return m ? `reading ${m[1]}` : 'reading a page';
    }
    case 'think':
      return 'thinking it over';
    case 'note':
      return 'writing down what i found';
    default:
      return 'working on it';
  }
}

export function helperStatus(agent: AgentSummary): HelperStatusView {
  switch (agent.status) {
    case 'queued':
      return { pill: 'getting ready', kind: 'waiting', line: 'about to get started', cta: null };
    case 'running':
      return {
        pill: 'on it',
        kind: 'working',
        line: activityLine(agent),
        cta: 'click to watch my progress',
      };
    case 'done':
      return {
        pill: 'all done',
        kind: 'done',
        line: truncate(agent.summary ?? 'i found what you asked for', 150),
        cta: 'click to see everything i found',
      };
    case 'failed':
      return {
        pill: 'hit a snag',
        kind: 'trouble',
        line: truncate(agent.error ?? 'something went wrong along the way', 150),
        cta: 'click for the details',
      };
    case 'timed_out':
      return {
        pill: 'ran long',
        kind: 'trouble',
        line: 'i ran out of time, but i saved what i had',
        cta: 'click to see how far i got',
      };
    case 'cancelled':
      return {
        pill: 'stopped',
        kind: 'trouble',
        line: 'you asked me to stop, so i did',
        cta: null,
      };
  }
}

/** 'just started' / 'working for about a minute' / 'took 3 minutes' … */
export function elapsedPhrase(agent: AgentSummary, now: number): string {
  if (isActive(agent)) {
    const ms = Math.max(0, now - agent.createdAt);
    if (ms < 75_000) return 'just started';
    if (ms < 150_000) return 'working for about a minute';
    return `working for ${Math.round(ms / 60_000)} minutes`;
  }
  const ms = Math.max(0, (agent.finishedAt ?? agent.createdAt) - agent.createdAt);
  if (ms < 60_000) return 'took under a minute';
  const min = Math.round(ms / 60_000);
  return min <= 1 ? 'took about a minute' : `took ${min} minutes`;
}

/** 'checked 3 places on the web', or null when nothing was visited yet. */
export function sourcesPhrase(agent: AgentSummary): string | null {
  const n = agent.sources?.length ?? 0;
  if (n === 0) return null;
  return n === 1 ? 'checked 1 place on the web' : `checked ${n} places on the web`;
}

export function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
