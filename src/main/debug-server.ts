/**
 * Debug harness: CLICKY_DEBUG=1 starts a local HTTP server on
 * 127.0.0.1:8199. QA and E2E tests drive the app through it (no API key
 * needed).
 *
 * M1 routes:
 *   GET /state  -> DebugState JSON (assistant state, overlay count, hotkey...)
 *
 * M2 routes (overlay — see the marked section at the bottom of this file):
 *   POST /overlay/pointer            {screenIndex, points:[{x,y,label?}]} | {type:'idle'|'hide'}
 *   POST /overlay/assistant-state    {state}
 *   POST /overlay/caption            {itemId, text, done}
 *   POST /overlay/capture-indicator  {active}
 *
 * Later milestones extend ROUTES with: simulate hotkey press/release, inject
 * text turn, dump last capture metadata.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DEBUG_HOST, DEBUG_PORT, ENV_DEBUG } from '../shared/constants';
import type { AssistantState, DebugState, PointerCommand, PointerPoint } from '../shared/types';
import { getOverlayManager } from './windows/overlay';
import type { OverlayManager } from './windows/overlay';

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

// ===========================================================================
// --- overlay debug routes (M2) ---
//
// Each route forwards to the overlay windows through the exact same
// OverlayManager paths production dispatch uses (routePointer / broadcast),
// so QA drives the real code paths:
//
//   POST /overlay/pointer            {screenIndex, points:[{x,y,label?}]}
//                                    or {type:'idle'} / {type:'hide'}
//   POST /overlay/assistant-state    {state: 'idle'|'listening'|'thinking'|'speaking'|'error'}
//   POST /overlay/caption            {itemId: string, text: string, done?: boolean}
//   POST /overlay/capture-indicator  {active: boolean}
// ===========================================================================

const MAX_DEBUG_BODY_BYTES = 64 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ASSISTANT_STATES: readonly AssistantState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'error',
];

function parseAssistantState(value: unknown): AssistantState | null {
  return typeof value === 'string' && (ASSISTANT_STATES as readonly string[]).includes(value)
    ? (value as AssistantState)
    : null;
}

function parsePointerPoints(value: unknown): PointerPoint[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const points: PointerPoint[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) return null;
    const x = rec['x'];
    const y = rec['y'];
    const label = rec['label'];
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (typeof y !== 'number' || !Number.isFinite(y)) return null;
    if (label !== undefined && typeof label !== 'string') return null;
    points.push({ x, y, ...(typeof label === 'string' ? { label } : {}) });
  }
  return points;
}

/** 503s when overlays are not started yet; otherwise hands them to `use`. */
function withOverlays(res: ServerResponse, use: (overlays: OverlayManager) => void): void {
  const overlays = getOverlayManager();
  if (!overlays) {
    sendJson(res, 503, { error: 'overlay windows not started' });
    return;
  }
  use(overlays);
}

const OVERLAY_ROUTES: Record<string, RouteHandler> = {
  'POST /overlay/pointer': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    if (!body) {
      sendJson(res, 400, { error: 'JSON object body required' });
      return;
    }
    let cmd: PointerCommand;
    const type = body['type'];
    if (type === 'idle' || type === 'hide') {
      cmd = { type };
    } else {
      const points = parsePointerPoints(body['points']);
      const screenIndex = body['screenIndex'];
      if (!points || typeof screenIndex !== 'number' || !Number.isInteger(screenIndex)) {
        sendJson(res, 400, {
          error:
            'expected {screenIndex: int, points: [{x: number, y: number, label?: string}, ...]}' +
            " or {type: 'idle' | 'hide'}",
        });
        return;
      }
      cmd = { type: 'animate', points, screenIndex };
    }
    withOverlays(res, (overlays) => {
      overlays.routePointer(cmd);
      sendJson(res, 200, { ok: true, sent: cmd });
    });
  },

  'POST /overlay/assistant-state': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const state = parseAssistantState(body?.['state']);
    if (!state) {
      sendJson(res, 400, { error: `expected {state: ${ASSISTANT_STATES.join(' | ')}}` });
      return;
    }
    withOverlays(res, (overlays) => {
      overlays.broadcast('overlay:assistant-state', state);
      sendJson(res, 200, { ok: true, sent: state });
    });
  },

  'POST /overlay/caption': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const itemId = body?.['itemId'];
    const text = body?.['text'];
    const done = body?.['done'] ?? false;
    if (typeof itemId !== 'string' || typeof text !== 'string' || typeof done !== 'boolean') {
      sendJson(res, 400, { error: 'expected {itemId: string, text: string, done?: boolean}' });
      return;
    }
    withOverlays(res, (overlays) => {
      overlays.broadcast('overlay:caption', { itemId, text, done });
      sendJson(res, 200, { ok: true });
    });
  },

  'POST /overlay/capture-indicator': async (_deps, req, res) => {
    const body = asRecord(await readJsonBody(req));
    const active = body?.['active'];
    if (typeof active !== 'boolean') {
      sendJson(res, 400, { error: 'expected {active: boolean}' });
      return;
    }
    withOverlays(res, (overlays) => {
      overlays.broadcast('overlay:capture-indicator', { active });
      sendJson(res, 200, { ok: true });
    });
  },
};

Object.assign(ROUTES, OVERLAY_ROUTES);
// --- end overlay debug routes (M2) ---
