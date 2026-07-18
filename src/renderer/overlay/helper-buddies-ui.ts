/**
 * M19 helper buddies: PURE view-model logic for representing background helpers
 * on the overlay as tiny "helper buddy" sprites beside the mascot, with a
 * friendly hover card. No DOM, no Electron — unit-tested as plain functions
 * (tests/helper-buddies-ui.test.ts). The DOM/IPC wiring lives in main.tsx and the
 * components in HelperBuddies.tsx.
 *
 * Voice: written for a completely non-technical user — no implementation jargon, "steps",
 * "sources" or status codes. Lowercase, warm, matches the persona.
 */

import type { HelperBuddyStep, HelperBuddySummary, Rect } from '../../shared/types';
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
/** Helper buddy card width (must keep the merged hover region under main's cap). */
export const HELPER_BUDDY_CARD_W = 248;
/**
 * Click-to-expand full-status card width. Region math: buddy half-footprint
 * (36) + HELPER_BUDDY_CARD_GAP (70) + width + AUX_PAD (10) must stay under
 * REGION_CAP (398) -> width <= 282.
 */
export const HELPER_BUDDY_CARD_EXPANDED_W = 264;
/** Most recent activity rows shown on the expanded card. */
export const EXPANDED_STEPS_MAX = 6;
/** Findings text cap on the expanded card (bounds the DOM, card scrolls). */
export const EXPANDED_FINDINGS_MAX = 1500;
/** Horizontal gap between the buddy center and the card's near edge. */
export const HELPER_BUDDY_CARD_GAP = 70;
/** Hovered key for the overflow pebble (never collides with helper-buddy ids). */
export const OVERFLOW_KEY = '::more';
/** Hover this long before the helper buddy card shows (anti-flicker). */
export const CARD_SHOW_DELAY_MS = 140;
/** Grace period to travel from a sprite into the card before it hides. */
export const CARD_HIDE_DELAY_MS = 280;

// ---------------------------------------------------------------------------
// Which helper buddies are visible, and where
// ---------------------------------------------------------------------------

export interface HelperView {
  /** Individually rendered sprites (≤ MAX_HELPER_SPRITES). */
  shown: HelperBuddySummary[];
  /** Folded into the "+N" pebble, listed on its card. */
  overflow: HelperBuddySummary[];
}

function isActive(helperBuddy: HelperBuddySummary): boolean {
  return (
    helperBuddy.status === 'queued' ||
    helperBuddy.status === 'running' ||
    helperBuddy.status === 'waiting_approval'
  );
}

/**
 * Where a helper is in its on-screen life:
 * - 'active'    queued/running/waiting approval — stays until the runtime advances it
 * - 'settled'   finished — celebrating / available to hover
 * - 'departing' last HELPER_DEPART_MS of the linger — shrinking back home
 * - 'gone'      not shown (expired, viewed in the panel, or cancelled)
 *
 * `keepId` freezes that helper at 'settled' — the one being hovered must
 * never vanish under the cursor.
 */
export type HelperPhase = 'active' | 'settled' | 'departing' | 'gone';

export function helperPhase(
  helperBuddy: HelperBuddySummary,
  now: number,
  keepId?: string,
): HelperPhase {
  if (isActive(helperBuddy)) return 'active';
  if (helperBuddy.status === 'cancelled') return 'gone';
  if (!helperBuddy.unseen) return 'gone';
  if (helperBuddy.id === keepId) return 'settled';
  const t = now - (helperBuddy.finishedAt ?? helperBuddy.createdAt);
  if (t >= FINISHED_LINGER_MS) return 'gone';
  if (t >= FINISHED_LINGER_MS - HELPER_DEPART_MS) return 'departing';
  return 'settled';
}

/**
 * Helper buddies worth showing beside Buddy: everything active, plus recently
 * finished runs still in their celebrate-and-leave window. Cancelled runs
 * never show — the user asked for them to go away.
 */
export function selectHelpers(
  helperBuddies: HelperBuddySummary[],
  now: number,
  keepId?: string,
): HelperView {
  const active = helperBuddies.filter(isActive).sort((a, b) => {
    const attention =
      Number(b.status === 'waiting_approval') - Number(a.status === 'waiting_approval');
    return attention || a.createdAt - b.createdAt;
  });
  const finished = helperBuddies
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
  helperBuddies: HelperBuddySummary[],
  now: number,
  keepId?: string,
): number | null {
  let next: number | null = null;
  for (const a of helperBuddies) {
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
  /** Helper-buddy id, or OVERFLOW_KEY for the pebble. */
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
// Per-helper-buddy tint (stable pastel identity, distinct from the buddy blue)
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

/** Stable tint for a helper-buddy id (the same helper buddy keeps its color across updates). */
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
  kind: 'waiting' | 'working' | 'approval' | 'done' | 'trouble';
  /** One warm line about what it's doing / how it ended. */
  line: string;
  /** Muted call-to-action (what a click does), or null. */
  cta: string | null;
}

/** Show the helper's required plain-language tool description verbatim. */
function activityLine(helperBuddy: HelperBuddySummary): string {
  const last = helperBuddy.steps[helperBuddy.steps.length - 1];
  if (!last) return 'figuring out where to start';
  return truncate(last.label.trim() || 'working on it', 150);
}

export function helperStatus(helperBuddy: HelperBuddySummary): HelperStatusView {
  switch (helperBuddy.status) {
    case 'queued':
      return { pill: 'getting ready', kind: 'waiting', line: 'about to get started', cta: null };
    case 'running':
      return {
        pill: 'on it',
        kind: 'working',
        line: activityLine(helperBuddy),
        cta: 'click to watch my progress',
      };
    case 'waiting_approval':
      return {
        pill: 'needs your ok',
        kind: 'approval',
        line: 'i paused before doing something that needs your choice',
        cta: 'click to review this action',
      };
    case 'done':
      return {
        pill: 'all done',
        kind: 'done',
        line: truncate(helperBuddy.summary ?? 'i found what you asked for', 150),
        cta: 'click to see everything i found',
      };
    case 'failed':
      return {
        pill: 'hit a snag',
        kind: 'trouble',
        line: truncate(helperBuddy.error ?? 'something went wrong along the way', 150),
        cta: 'click for the details',
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
export function elapsedPhrase(helperBuddy: HelperBuddySummary, now: number): string {
  if (helperBuddy.status === 'waiting_approval') return 'waiting for your choice';
  if (isActive(helperBuddy)) {
    const ms = Math.max(0, now - helperBuddy.createdAt);
    if (ms < 75_000) return 'just started';
    if (ms < 150_000) return 'working for about a minute';
    return `working for ${Math.round(ms / 60_000)} minutes`;
  }
  const ms = Math.max(0, (helperBuddy.finishedAt ?? helperBuddy.createdAt) - helperBuddy.createdAt);
  if (ms < 60_000) return 'took under a minute';
  const min = Math.round(ms / 60_000);
  return min <= 1 ? 'took about a minute' : `took ${min} minutes`;
}

/** 'checked 3 places on the web', or null when nothing was visited yet. */
export function sourcesPhrase(helperBuddy: HelperBuddySummary): string | null {
  const n = helperBuddy.sources?.length ?? 0;
  if (n === 0) return null;
  return n === 1 ? 'checked 1 place on the web' : `checked ${n} places on the web`;
}

export function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Expanded card (click a helper -> its full status, M22)
// ---------------------------------------------------------------------------

/** Last `max` activity steps, oldest first (reads top-to-bottom). */
export function recentSteps(
  helperBuddy: HelperBuddySummary,
  max = EXPANDED_STEPS_MAX,
): HelperBuddyStep[] {
  return helperBuddy.steps.slice(-max);
}

/** 'just now' / 'a minute ago' / '4 minutes ago' / 'a while ago'. */
export function timeAgoPhrase(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 45_000) return 'just now';
  if (ms < 90_000) return 'a minute ago';
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} minutes ago`;
  return 'a while ago';
}

/** Deduped source hostnames ('rtings.com'), capped for the expanded card. */
export function sourceHosts(
  helperBuddy: HelperBuddySummary,
  max = 5,
): { hosts: string[]; more: number } {
  const hosts: string[] = [];
  for (const url of helperBuddy.sources ?? []) {
    let host: string;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      host = truncate(url, 40);
    }
    if (host !== '' && !hosts.includes(host)) hosts.push(host);
  }
  return { hosts: hosts.slice(0, max), more: Math.max(0, hosts.length - max) };
}

/** Like truncate(), but preserves line breaks (findings are multi-line). */
export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Light-markdown findings -> plain text (headings, emphasis, links, bullets). */
export function plainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .trim();
}

/**
 * Full findings text for the expanded card, or null: finished runs only
 * (while running, the activity log is the story), full output preferred
 * over the short spoken summary.
 */
export function expandedFindings(helperBuddy: HelperBuddySummary): string | null {
  if (
    helperBuddy.status === 'queued' ||
    helperBuddy.status === 'running' ||
    helperBuddy.status === 'waiting_approval'
  )
    return null;
  const text = helperBuddy.output ?? helperBuddy.summary;
  if (text === undefined || text.trim() === '') return null;
  return clip(plainText(text), EXPANDED_FINDINGS_MAX);
}
