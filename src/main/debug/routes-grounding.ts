/**
 * M9 grounding debug routes.
 *
 *   POST /grounding/query   {x, y, label, radiusPx?}  (x/y in GLOBAL DIP)
 *     -> drives the UIA snapper daemon directly against whatever is on
 *        screen (no model, no cost): matched element, score, elapsed, and
 *        the full scored candidate list for diagnosis. Token-gated like
 *        every other route.
 */

import { asRecord, isFiniteNumber, readJsonBody, sendJson } from './debug-http';
import type { RouteTable } from './deps';

export const GROUNDING_ROUTES: RouteTable = {
  'POST /grounding/query': async (deps, req, res) => {
    if (!deps.grounding) {
      sendJson(res, 503, { error: 'grounding hooks not wired' });
      return;
    }
    const body = asRecord(await readJsonBody(req));
    const x = body?.['x'];
    const y = body?.['y'];
    const label = body?.['label'];
    const radiusPx = body?.['radiusPx'];
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      typeof label !== 'string' ||
      label.length === 0 ||
      (radiusPx !== undefined && typeof radiusPx !== 'number')
    ) {
      sendJson(res, 400, {
        error: 'expected {x: number, y: number, label: string, radiusPx?: number} (global DIP)',
      });
      return;
    }
    const result = await deps.grounding.query({
      x,
      y,
      label,
      ...(typeof radiusPx === 'number' ? { radiusPx } : {}),
    });
    sendJson(res, 200, result);
  },
};
