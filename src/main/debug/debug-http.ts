/**
 * HTTP plumbing shared by every debug route family: JSON responses, a
 * size-capped JSON body reader, and the narrowing guards route validators
 * compose. Pure node:http — no Electron — so it is directly unit-testable.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { asRecord } from '../util/guards';

// The canonical record guard lives in util/guards; re-exported here so route
// modules have one import point for body handling + narrowing.
export { asRecord };

export const MAX_DEBUG_BODY_BYTES = 64 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DEBUG_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Composable field validators (route modules combine these per body field;
// the per-route error strings stay with the routes).
// ---------------------------------------------------------------------------

/** A finite number (rejects NaN/±Inf, never coerces). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A string with at least one non-whitespace character. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
