/**
 * Element-snap scoring (M9) — PURE functions only (unit-tested, no Electron
 * or child-process imports).
 *
 * The snapper daemon (snapper.ts + the embedded PowerShell script) stays
 * deliberately dumb: it only ENUMERATES nearby UIA elements and returns
 * {name, rect} candidates. Selection lives here in TS:
 *
 *   1. normalize the model's spoken label and each element Name into tokens
 *      (lowercase, punctuation-stripped, UI-noise stopwords removed — so
 *      "the Save button" and "Save" are the same thing),
 *   2. text similarity = max(fuzzy token dice, name-coverage, whole-string
 *      Levenshtein) — robust to "the save button" vs "Save", partial names
 *      ("$249.00" inside "the headphones price $249.00"), and small typos,
 *   3. rank by similarity minus a small proximity penalty (the label does
 *      the work; the model's point only breaks ties between equal names,
 *      e.g. two identical "Save" buttons),
 *   4. reject everything under SNAP_TEXT_THRESHOLD — snapping must never be
 *      worse than the raw model point.
 */

/** Candidate element as reported by the snapper daemon (physical px rect). */
export interface SnapCandidate {
  name: string;
  /** UIA ControlType programmatic name (diagnosis only). */
  ct?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Front-to-back visible-window rank (0 is frontmost), when available. */
  windowRank?: number;
}

export interface ScoredCandidate {
  candidate: SnapCandidate;
  /** Label↔Name text similarity in [0, 1] (threshold applies to this). */
  textScore: number;
  /** textScore minus the proximity penalty (ranking key). */
  rankScore: number;
  /** Distance from the query point to the candidate rect center, px. */
  distPx: number;
  /** Rect center (the clickable point we snap to), physical px. */
  cx: number;
  cy: number;
}

/** Below this text similarity a candidate is never a match. */
export const SNAP_TEXT_THRESHOLD = 0.55;
/** How much being a full search-radius away costs in rank score. */
const PROXIMITY_WEIGHT = 0.15;
/** Window order only breaks otherwise-near ties; label identity remains primary. */
const WINDOW_RANK_WEIGHT = 0.012;

/**
 * Generic UI words that carry no identity: "the save button" == "Save".
 * Kept small on purpose — over-stripping ("save as" -> "save") loses meaning.
 */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'at',
  'on',
  'in',
  'of',
  'for',
  'and',
  'or',
  'with',
  'my',
  'your',
  'our',
  'that',
  'this',
  'button',
  'buttons',
  'icon',
  'link',
  'field',
  'box',
  'input',
  'control',
  'element',
  'item',
  'label',
  'checkbox',
  'menu',
  'tab',
  'bar',
  'option',
  'section',
]);

/**
 * Lowercase, split on whitespace, strip leading/trailing punctuation from
 * each token ("$249.00," -> "249.00"), drop stopwords and empties.
 */
export function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Levenshtein distance (iterative two-row; strings are short UI labels). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Normalized string similarity in [0, 1]. */
function charSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  return 1 - levenshtein(a, b) / max;
}

/** Fuzzy token-pair similarity: exact, prefix, or high char similarity. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  // Prefix match ("head" vs "headphones", "sub" vs "subscribe"): strong when
  // the shorter token is meaningful (>= 3 chars).
  if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  const sim = charSimilarity(a, b);
  return sim >= 0.8 ? sim : 0;
}

/**
 * Text similarity between the model's label and an element Name, in [0, 1].
 *
 * Components (max wins):
 * - fuzzy token dice over stopword-stripped tokens,
 * - name coverage (all of the element's name appears inside the label:
 *   "the headphones price $249.00" fully covers the name "$249.00") damped
 *   to 0.85 so exact matches still rank above containment,
 * - whole-string normalized Levenshtein (both joined) for spacing/typos.
 */
export function textSimilarity(label: string, name: string): number {
  const la = normalizeTokens(label);
  const nb = normalizeTokens(name);
  if (la.length === 0 || nb.length === 0) return 0;

  const bestFor = (t: string, pool: string[]): number =>
    pool.reduce((best, p) => Math.max(best, tokenSimilarity(t, p)), 0);

  const matchedA = la.reduce((sum, t) => sum + bestFor(t, nb), 0);
  const matchedB = nb.reduce((sum, t) => sum + bestFor(t, la), 0);
  const dice = (matchedA + matchedB) / (la.length + nb.length);
  const nameCoverage = matchedB / nb.length;
  // Label-in-name containment: a short label fully present inside a longer
  // name ("search" inside the placeholder-derived "Search headphones,
  // speakers, accessories…"). Damped below name-coverage so an element
  // actually NAMED like the label always outranks a verbose container.
  const labelCoverage = nb.length > la.length ? 0.7 * (matchedA / la.length) : 0;
  const whole = charSimilarity(la.join(' '), nb.join(' '));

  return Math.min(1, Math.max(dice, 0.85 * nameCoverage, labelCoverage, whole));
}

/**
 * Pick the best-matching candidate for the label near the model's point.
 * Returns null when nothing clears the text threshold (use the raw point).
 */
export function selectCandidate(
  label: string,
  point: { x: number; y: number },
  candidates: SnapCandidate[],
  radiusPx: number,
  threshold: number = SNAP_TEXT_THRESHOLD,
): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const c of candidates) {
    // AX/WebArea trees sometimes expose stale virtual nodes as 1px slivers.
    // They are not useful pointing targets and can otherwise win on text.
    if (!(c.w >= 3) || !(c.h >= 3) || typeof c.name !== 'string' || c.name.length === 0) continue;
    const textScore = textSimilarity(label, c.name);
    if (textScore < threshold) continue;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    const distPx = Math.hypot(cx - point.x, cy - point.y);
    const windowPenalty = WINDOW_RANK_WEIGHT * Math.min(Math.max(c.windowRank ?? 0, 0), 5);
    const rankScore =
      textScore -
      PROXIMITY_WEIGHT * Math.min(distPx / Math.max(radiusPx, 1), 1) -
      windowPenalty;
    if (best === null || rankScore > best.rankScore) {
      best = { candidate: c, textScore, rankScore, distPx, cx, cy };
    }
  }
  return best;
}
