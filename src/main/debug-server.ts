/**
 * Debug harness: CLICKY_DEBUG=1 starts a local HTTP server on
 * 127.0.0.1:8199. QA and E2E tests drive the app through it (no API key
 * needed).
 *
 * M1 routes:
 *   GET /state  -> DebugState JSON (assistant state, overlay count, hotkey...)
 *
 * Later milestones extend ROUTES with: simulate hotkey press/release, inject
 * text turn, trigger pointer, dump last capture metadata.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DEBUG_HOST, DEBUG_PORT, ENV_DEBUG } from '../shared/constants';
import type { DebugState } from '../shared/types';

export interface DebugServerDeps {
  getState: () => DebugState;
}

type RouteHandler = (
  deps: DebugServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/** method + path -> handler. Extend here (integration-approved). */
const ROUTES: Record<string, RouteHandler> = {
  'GET /state': (deps, _req, res) => {
    sendJson(res, 200, deps.getState());
  },
};

export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_DEBUG] === '1';
}

/** Start the debug server. Returns null when CLICKY_DEBUG !== '1'. */
export function startDebugServer(deps: DebugServerDeps): Server | null {
  if (!isDebugEnabled()) return null;

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const handler = ROUTES[`${req.method ?? 'GET'} ${path}`];
    if (!handler) {
      sendJson(res, 404, { error: 'not found', routes: Object.keys(ROUTES) });
      return;
    }
    void Promise.resolve(handler(deps, req, res)).catch((err: unknown) => {
      sendJson(res, 500, { error: String(err) });
    });
  });

  server.listen(DEBUG_PORT, DEBUG_HOST, () => {
    console.log(`[debug] listening on http://${DEBUG_HOST}:${DEBUG_PORT}`);
  });
  server.on('error', (err) => {
    console.error('[debug] server error:', err);
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}
