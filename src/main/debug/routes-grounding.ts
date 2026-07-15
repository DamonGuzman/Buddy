/**
 * M9 grounding debug routes.
 *
 *   POST /grounding/query   {x, y, label, radiusDip?}  (x/y/radius in GLOBAL DIP)
 *     -> drives native accessibility directly against whatever is on
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
    const radiusDip = body?.['radiusDip'];
    const legacyRadiusPx = body?.['radiusPx'];
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      typeof label !== 'string' ||
      label.length === 0 ||
      (radiusDip !== undefined && (!isFiniteNumber(radiusDip) || radiusDip <= 0)) ||
      legacyRadiusPx !== undefined
    ) {
      sendJson(res, 400, {
        error:
          'expected {x: number, y: number, label: string, radiusDip?: positive number} (global DIP)',
      });
      return;
    }
    const result = await deps.grounding.query({
      x,
      y,
      label,
      ...(typeof radiusDip === 'number' ? { radiusDip } : {}),
    });
    sendJson(res, 200, result);
  },
};
