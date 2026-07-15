/**
 * Debug harness: CLICKY_DEBUG=1 starts a local HTTP server on
 * 127.0.0.1:8199. QA and E2E tests drive the app through it (no API key
 * needed).
 *
 * This file is the composition root: it owns the listener, the request auth
 * gate, and the explicit route-table composition. The pieces live in
 * src/main/debug/:
 *   debug-auth.ts        token / Origin / Host / packaged-build hardening
 *   debug-http.ts        JSON body + response plumbing, field validators
 *   deps.ts              dependency seams + the RouteHandler contract
 *   routes-overlay.ts    M2   POST /overlay/*
 *   routes-pipeline.ts   M6   /hotkey/*, /ask, /transcript, /playback
 *   routes-agents.ts          /agents*
 *   routes-audio-eval.ts M8.5 /timings, /audio/*, /eval/ground-truth
 *   routes-grounding.ts  M9   POST /grounding/query
 *   routes-hover.ts      M15  GET /hover/state
 *
 * Auth (hardened — replaces the M8.5 optional-token scheme): every route
 * requires the per-launch token, cross-site Origins and non-loopback Hosts
 * are rejected, and packaged builds refuse to start without BOTH
 * CLICKY_DEBUG=1 and an explicit CLICKY_DEBUG_TOKEN. Details: debug/debug-auth.ts.
 */

import { app } from 'electron';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { DEBUG_HOST, DEBUG_PORT } from '../shared/constants';
import { debugPortOverride, isDebugEnabled } from './env';
import {
  checkDebugToken,
  checkHost,
  checkOrigin,
  refusesPackagedStart,
  resolveToken,
} from './debug/debug-auth';
import { sendJson } from './debug/debug-http';
import type { DebugServerDeps, RouteHandler } from './debug/deps';
import { AGENT_ROUTES } from './debug/routes-agents';
import { AUDIO_EVAL_ROUTES } from './debug/routes-audio-eval';
import { GROUNDING_ROUTES } from './debug/routes-grounding';
import { HOVER_ROUTES } from './debug/routes-hover';
import { OVERLAY_ROUTES } from './debug/routes-overlay';
import { PIPELINE_ROUTES } from './debug/routes-pipeline';

export { isDebugEnabled } from './env';
export type {
  AgentDebugDeps,
  AudioEvalDebugDeps,
  DebugServerDeps,
  GroundingDebugDeps,
  PipelineDebugDeps,
} from './debug/deps';

/**
 * method + path -> handler. Composition order is part of the contract: the
 * 404 body lists the routes in this order (extend here, integration-approved).
 */
const ROUTES: Record<string, RouteHandler> = {
  'GET /state': (deps, _req, res) => {
    sendJson(res, 200, deps.getState());
  },
  ...OVERLAY_ROUTES,
  ...PIPELINE_ROUTES,
  ...AGENT_ROUTES,
  ...AUDIO_EVAL_ROUTES,
  ...GROUNDING_ROUTES,
  ...HOVER_ROUTES,
};

/**
 * Start the debug server. Returns null when CLICKY_DEBUG !== '1', or when
 * running packaged without BOTH CLICKY_DEBUG=1 and an explicit token.
 */
export function startDebugServer(deps: DebugServerDeps): Server | null {
  if (!isDebugEnabled()) return null;
  if (refusesPackagedStart(app.isPackaged)) {
    console.error(
      '[debug] refusing to start in a packaged build: set BOTH CLICKY_DEBUG=1 ' +
        'and an explicit CLICKY_DEBUG_TOKEN to enable the debug server.',
    );
    return null;
  }

  const token = resolveToken(app.getPath('userData'));
  // M8.5: CLICKY_DEBUG_PORT overrides the default port so parallel QA
  // instances (other agents' dev apps hold 8199) can coexist.
  const port = debugPortOverride() ?? DEBUG_PORT;

  const server = createServer((req, res) => {
    if (!checkHost(req, port)) {
      sendJson(res, 403, { error: 'bad Host header' });
      return;
    }
    if (!checkOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin requests are not allowed' });
      return;
    }
    if (!checkDebugToken(req, token)) {
      sendJson(res, 401, { error: 'X-Debug-Token header (or ?token=) required' });
      return;
    }
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

  server.listen(port, DEBUG_HOST, () => {
    console.log(`[debug] listening on http://${DEBUG_HOST}:${port}`);
  });
  server.on('error', (err) => {
    console.error('[debug] server error:', err);
  });
  return server;
}
