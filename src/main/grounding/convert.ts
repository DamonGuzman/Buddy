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
