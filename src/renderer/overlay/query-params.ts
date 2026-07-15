/**
 * The overlay window's query-param protocol, typed in one place.
 *
 * Main builds the URL in src/main/windows/overlay.ts (createWindow); this is
 * the single renderer-side parser, shared by the overlay preload
 * (screenIndex) and main.tsx (primary / bobIdleMs). The param names, formats
 * and defaults here are part of that contract — keep them in lockstep with
 * the builder. Known limitation (documented at the builder): the values are
 * creation-time snapshots and can go stale on display re-ordering; routing/
 * residency stay enforced main-side.
 *
 * No DOM — must stay importable under the node tsconfig (preload).
 */

export interface OverlayPageParams {
  /** `?screenIndex=N` — capture-labeling index of the display this overlay covers. */
  screenIndex: number;
  /** `?primary=1|0` — pre-subscription default for hosting the buddy at rest. */
  primary: boolean;
  /**
   * `?bobIdleMs=N` — CLICKY_BOB_IDLE_MS test hook shrinking the renderer's
   * idle bob-pause timeout; null = use the built-in default.
   */
  bobIdleMs: number | null;
}

/** Parse `location.search`; malformed/absent params fall back to defaults. */
export function parseOverlayParams(search: string): OverlayPageParams {
  const params = new URLSearchParams(search);
  const screenIndex = Number(params.get('screenIndex') ?? '0');
  const bobIdleMs = Number(params.get('bobIdleMs'));
  return {
    screenIndex: Number.isFinite(screenIndex) ? screenIndex : 0,
    primary: params.get('primary') !== '0',
    bobIdleMs: Number.isFinite(bobIdleMs) && bobIdleMs > 0 ? bobIdleMs : null,
  };
}
