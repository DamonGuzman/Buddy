/**
 * M15 buddy-hover debug routes.
 *
 *   GET /hover/state -> OverlayManager.hoverDebugInfo(): assistant state,
 *     buddy host, interactive window + region, persisted buddyRest, and per-
 *     overlay {displayId, screenIndex, bounds, scaleFactor, forwarding,
 *     interactive, rendererPid, hover status} — everything the hover QA
 *     harness needs (cursor targeting, CPU sampling by pid, state asserts).
 *
 * Same pattern as the M2 overlay routes: reach the overlays through
 * getOverlayManager(), never a parallel code path.
 */

import { sendJson } from './debug-http';
import type { RouteTable } from './deps';
import { withOverlays } from './routes-overlay';

export const HOVER_ROUTES: RouteTable = {
  'GET /hover/state': (_deps, _req, res) => {
    withOverlays(res, (overlays) => {
      sendJson(res, 200, overlays.hoverDebugInfo());
    });
  },
};
