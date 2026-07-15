/**
 * Auth for the debug server (hardened — replaces the M8.5 optional-token
 * scheme):
 * - EVERY route requires a token via the `X-Debug-Token` header or a
 *   `?token=` query param (the latter for eval scene pages, which POST from a
 *   file:// origin with a simple no-cors request).
 * - The token comes from CLICKY_DEBUG_TOKEN; when unset, a random per-launch
 *   token is generated, logged once, and written to <userData>/debug-token.txt
 *   so local tooling can pick it up with zero setup.
 * - Requests carrying a cross-site Origin header (anything but the literal
 *   "null" a local file:// page sends) are rejected — a browser CSRF POST from
 *   a website always carries its Origin.
 * - Requests whose Host isn't 127.0.0.1:<port> / localhost:<port> are
 *   rejected — DNS-rebinding defense.
 * - In packaged builds (app.isPackaged) the server refuses to start unless
 *   BOTH CLICKY_DEBUG=1 and an explicit CLICKY_DEBUG_TOKEN are set.
 *
 * Everything here is pure node (userData path and env injected) so the
 * security behavior is directly unit-testable without Electron.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { debugTokenOverride } from '../env';

/** Constant-time string comparison (length leak is fine for random tokens). */
export function tokenEquals(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Mandatory token check: the request must carry the token in the
 * X-Debug-Token header or a ?token= query param (the latter for eval scene
 * pages, which POST from a file:// origin with a simple no-cors request).
 */
export function checkDebugToken(req: IncomingMessage, expected: string): boolean {
  if (expected.length === 0) return false;
  const header = req.headers['x-debug-token'];
  if (typeof header === 'string' && tokenEquals(header, expected)) return true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const qp = url.searchParams.get('token');
    return qp !== null && tokenEquals(qp, expected);
  } catch {
    return false;
  }
}

/**
 * CSRF defense: any request a BROWSER makes cross-site carries an Origin
 * header. We accept only requests without one (curl / node fetch / same-app
 * tooling) or with the literal "null" (a local file:// eval scene page).
 * Anything else is a web page doing a cross-site request — reject.
 */
export function checkOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === 'null';
}

/**
 * DNS-rebinding defense: the Host header must be the loopback address (or
 * localhost) with our port. A rebound hostname (attacker.com -> 127.0.0.1)
 * shows up here as the attacker's hostname.
 */
export function checkHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

/**
 * Packaged builds never run on a random token: without an explicit
 * CLICKY_DEBUG_TOKEN the server must refuse to start.
 */
export function refusesPackagedStart(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isPackaged && debugTokenOverride(env) === null;
}

/**
 * Resolve the auth token: explicit CLICKY_DEBUG_TOKEN, or a random per-launch
 * token persisted to <userData>/debug-token.txt for zero-setup local tooling.
 */
export function resolveToken(userDataPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = debugTokenOverride(env);
  if (explicit !== null) return explicit;
  const token = randomBytes(24).toString('hex');
  const tokenPath = join(userDataPath, 'debug-token.txt');
  try {
    writeFileSync(tokenPath, token, { encoding: 'utf8' });
    console.log(`[debug] auth token generated for this launch: ${token} (also at ${tokenPath})`);
  } catch (err) {
    console.error(`[debug] could not write ${tokenPath}:`, err);
    console.log(`[debug] auth token generated for this launch: ${token}`);
  }
  return token;
}
