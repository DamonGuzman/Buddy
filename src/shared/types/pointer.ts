/**
 * Pointer commands and grounding attribution (docs/ARCHITECTURE.md §6, §6b).
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

/** A point in screenshot pixel space (see coordinate contract §6), with optional label. */
export interface PointerPoint {
  x: number;
  y: number;
  label?: string;
}

/**
 * M9: element-snap grounding attribution. Recorded on pointer commands so the
 * eval can attribute hits to the raw model point vs the UIA-snapped element
 * (docs/EVAL.md §9).
 */
export interface PointerSnapInfo {
  /** The model's own point after §6 mapping, global DIP (pre-snap). */
  rawPoint: { x: number; y: number };
  /** Center of the matched native accessibility element, global DIP — null when no match. */
  snappedPoint: { x: number; y: number } | null;
  /** Label↔Name text-similarity score of the match (0..1), null when none. */
  snapScore: number | null;
  /** Native accessibility name of the matched element, null when none. */
  snapName: string | null;
  /** Wall time spent querying the snapper (incl. timeout fallbacks). */
  snapMs: number;
  /** Candidates the snapper enumerated (diagnosis). */
  candidates?: number;
}

/**
 * M10: which grounding layer produced the final point (layered pipeline:
 * native accessibility snap -> REST grounding -> raw model point).
 */
export type GroundingSource = 'uia' | 'ax' | 'rest' | 'raw';

/** Command from main driving the buddy pointer on one overlay. */
export type PointerCommand =
  | {
      type: 'animate';
      /** Points in overlay-window-local DIP coordinates (already mapped by coords.ts). */
      points: PointerPoint[];
      screenIndex: number;
      /** M9: grounding attribution (absent when snapping was skipped). */
      snap?: PointerSnapInfo;
      /** M10: which grounding layer produced the final point. */
      groundingSource?: GroundingSource;
      /** M10: true when a REST grounding call was attempted for this pointer. */
      restUsed?: boolean;
      /** M10: wall time of the REST grounding call, ms (present when attempted). */
      restMs?: number;
    }
  | { type: 'idle' }
  | { type: 'hide' };

// ---------------------------------------------------------------------------
// M17: grounding-auth attribution
// ---------------------------------------------------------------------------

/**
 * Which grounding TRANSPORT actually ran for a pointer: the ChatGPT
 * subscription ('codex' = the codex-sub / gpt-5.6-sol path), the metered
 * platform key ('apiKey' = gpt-5.4-mini), or neither ('none' = UIA/AX alone,
 * skipped, or no auth). Mirrors `GroundSource` in main's rest-grounder — the
 * renderer-safe copy so `DebugState` can carry it without a main-side import.
 */
export type GroundingBackend = 'apiKey' | 'codex' | 'none';

/**
 * ChatGPT-plan rate-limit telemetry parsed from the `x-codex-*-used-percent`
 * response headers (renderer-safe copy of main's rest-grounder shape). A field
 * is null when its header was absent/unparsable.
 */
export interface CodexUsedPercent {
  /** Primary (short) window used %, 0..100. */
  primary: number | null;
  /** Secondary (long / weekly) window used %, 0..100. */
  secondary: number | null;
}

/**
 * Grounding-auth attribution for the most recent pointer, surfaced on
 * `DebugState.lastGrounding`. `backend` names the transport that ran; `source`
 * is the layer that produced the final point (UIA/AX / REST re-ground / raw
 * model point); `quotaExhausted` is the FAIL-CLOSED signal (the ChatGPT plan
 * quota was hit and the metered key was NOT spent for that call).
 */
export interface GroundingAttribution {
  backend: GroundingBackend;
  source: GroundingSource;
  quotaExhausted: boolean;
  usedPercent: CodexUsedPercent | null;
}
