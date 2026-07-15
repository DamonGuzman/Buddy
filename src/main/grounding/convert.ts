/**
 * Global DIP <-> global physical px conversion (M9) — PURE fallback math.
 *
 * UIA works in physical screen pixels; the app's coordinate space is global
 * DIP. At runtime the caller prefers Electron's `screen.dipToScreenPoint` /
 * `screen.screenToDipPoint` (which know the true physical layout of every
 * display); these meta-derived versions are the unit-testable fallback and
 * are EXACT whenever the display's DIP origin equals its physical origin
 * scaled — always true for a primary/single display at (0,0), the M9 target
 * machine (docs/EVAL.md baseline).
 */

import type { CaptureMeta } from '../../shared/types';

export interface Pt {
  x: number;
  y: number;
}

/** The slice of CaptureMeta the conversion needs (also satisfied by Display). */
export type DisplayGeom = Pick<CaptureMeta, 'displayBounds' | 'scaleFactor'>;

/**
 * Rounding asymmetry (intentional): dip->physical ROUNDS to whole pixels
 * because physical px is the integer space UIA/the snapper daemon works in;
 * physical->dip stays FRACTIONAL because global DIP is a continuous space
 * (overlay/pointer math downstream does its own clamping/rounding).
 *
 * Do NOT collapse the algebra below to `Math.round(p.x * sf)`: it is
 * algebraically equal but not bit-identical in floating point — e.g.
 * sf=1.25, b.x=2560, p.x=-1023.6000000000001 rounds to -1279 via the
 * two-step form but -1280 via the direct product.
 */

/** Global DIP -> global physical px (meta-derived; see header caveat). */
export function dipToPhysicalViaMeta(p: Pt, meta: DisplayGeom): Pt {
  const b = meta.displayBounds;
  const sf = meta.scaleFactor;
  return {
    x: Math.round(b.x * sf + (p.x - b.x) * sf),
    y: Math.round(b.y * sf + (p.y - b.y) * sf),
  };
}

/** Global physical px -> global DIP (inverse of dipToPhysicalViaMeta). */
export function physicalToDipViaMeta(p: Pt, meta: DisplayGeom): Pt {
  const b = meta.displayBounds;
  const sf = meta.scaleFactor;
  return {
    x: b.x + (p.x - b.x * sf) / sf,
    y: b.y + (p.y - b.y * sf) / sf,
  };
}

// ---------------------------------------------------------------------------
// Preferred-path seam (M9)
// ---------------------------------------------------------------------------

/**
 * The slice of Electron's `screen` module the preferred conversion path
 * needs. Injectable so the try-API-fall-back-to-meta idiom is unit-testable
 * without Electron; at runtime pass `screen` itself (it matches structurally).
 */
export interface ScreenPointApi {
  dipToScreenPoint(point: Pt): Pt;
  screenToDipPoint(point: Pt): Pt;
}

/** A point is usable only if the API returned finite coordinates. */
function isUsablePoint(p: Pt | null | undefined): p is Pt {
  return p !== null && p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * M9: global DIP -> global physical px. The injected Electron screen API
 * knows the true physical layout (mixed-DPI multi-monitor) so it is tried
 * first — with the input rounded, as Electron expects integer DIP — and the
 * meta-derived math is the fallback (fed the UNROUNDED point; exact on
 * single/origin displays). Throwing or non-finite results (non-Windows or
 * API unavailable) fall back silently.
 */
export function dipToPhysicalPreferScreen(p: Pt, meta: DisplayGeom, api: ScreenPointApi): Pt {
  try {
    const converted = api.dipToScreenPoint({ x: Math.round(p.x), y: Math.round(p.y) });
    if (isUsablePoint(converted)) return converted;
  } catch {
    /* non-Windows or API unavailable */
  }
  return dipToPhysicalViaMeta(p, meta);
}

/** M9: global physical px -> global DIP (see dipToPhysicalPreferScreen). */
export function physicalToDipPreferScreen(p: Pt, meta: DisplayGeom, api: ScreenPointApi): Pt {
  try {
    const converted = api.screenToDipPoint({ x: Math.round(p.x), y: Math.round(p.y) });
    if (isUsablePoint(converted)) return converted;
  } catch {
    /* non-Windows or API unavailable */
  }
  return physicalToDipViaMeta(p, meta);
}
