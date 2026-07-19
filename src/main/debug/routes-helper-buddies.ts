/**
 * Helper-buddy debug routes (docs/HELPER-BUDDY-MODE.md): list, spawn, and cancel
 * helper buddies through the same HelperBuddyManager production uses.
 */

import { asRecord, isNonBlankString, readJsonBody, sendJson } from './debug-http';
import { requireCanonicalHelperBuddyId } from '../helper-buddy-id';
import type { RouteTable } from './deps';

export const HELPER_BUDDY_ROUTES: RouteTable = {
  'GET /helper-buddies': (deps, _req, res) => {
    if (!deps.helperBuddies) return sendJson(res, 503, { error: 'helper buddy runtime not wired' });
    sendJson(res, 200, deps.helperBuddies.list());
  },
  'POST /helper-buddies/spawn': async (deps, req, res) => {
    if (!deps.helperBuddies) return sendJson(res, 503, { error: 'helper buddy runtime not wired' });
    const body = asRecord(await readJsonBody(req));
    const task = body?.['task'];
    if (!isNonBlankString(task)) return sendJson(res, 400, { error: 'expected {task: string}' });
    const result = await deps.helperBuddies.spawn(task.trim());
    sendJson(res, result.ok ? 202 : 409, result);
  },
  'POST /helper-buddies/cancel': async (deps, req, res) => {
    if (!deps.helperBuddies) return sendJson(res, 503, { error: 'helper buddy runtime not wired' });
    const body = asRecord(await readJsonBody(req));
    let id: string;
    try {
      id = requireCanonicalHelperBuddyId(body?.['id']);
    } catch {
      return sendJson(res, 400, { error: 'expected {id: valid helper buddy id}' });
    }
    deps.helperBuddies.cancel(id);
    sendJson(res, 200, { ok: true });
  },
};
