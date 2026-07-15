/**
 * Overlay debug routes (M2).
 *
 * Each route forwards to the overlay windows through the exact same
 * OverlayManager paths production dispatch uses (routePointer / broadcast),
 * so QA drives the real code paths:
 *
 *   POST /overlay/pointer            {screenIndex, points:[{x,y,label?}]}
 *                                    or {type:'idle'} / {type:'hide'}
 *   POST /overlay/assistant-state    {state: 'idle'|'listening'|'thinking'|'speaking'|'error'}
 *   POST /overlay/caption            {itemId: string, text: string, done?: boolean}
 *   POST /overlay/capture-indicator  {active: boolean}
 */

import type { ServerResponse } from 'node:http';
import type { AssistantState, PointerCommand, PointerPoint } from '../../shared/types';
import { getOverlayManager } from '../windows/overlay';
import type { OverlayManager } from '../windows/overlay';
import { asRecord, isFiniteNumber, readJsonBody, sendJson } from './debug-http';
import type { RouteTable } from './deps';

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
    if (!isFiniteNumber(x)) return null;
    if (!isFiniteNumber(y)) return null;
    if (label !== undefined && typeof label !== 'string') return null;
    points.push({ x, y, ...(typeof label === 'string' ? { label } : {}) });
  }
  return points;
}

/** 503s when overlays are not started yet; otherwise hands them to `use`. */
export function withOverlays(res: ServerResponse, use: (overlays: OverlayManager) => void): void {
  const overlays = getOverlayManager();
  if (!overlays) {
    sendJson(res, 503, { error: 'overlay windows not started' });
    return;
  }
  use(overlays);
}

export const OVERLAY_ROUTES: RouteTable = {
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
