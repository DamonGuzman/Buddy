/**
 * Agent-mode debug routes (docs/AGENT-MODE.md): list, spawn, and cancel the
 * read-only research agents through the same AgentManager production uses.
 */

import { asRecord, isNonBlankString, readJsonBody, sendJson } from './debug-http';
import type { RouteTable } from './deps';

export const AGENT_ROUTES: RouteTable = {
  'GET /agents': (deps, _req, res) => {
    if (!deps.agents) return sendJson(res, 503, { error: 'agent runtime not wired' });
    sendJson(res, 200, deps.agents.list());
  },
  'POST /agents/spawn': async (deps, req, res) => {
    if (!deps.agents) return sendJson(res, 503, { error: 'agent runtime not wired' });
    const body = asRecord(await readJsonBody(req));
    const task = body?.['task'];
    if (!isNonBlankString(task)) return sendJson(res, 400, { error: 'expected {task: string}' });
    const result = deps.agents.spawn(task.trim());
    sendJson(res, result.ok ? 202 : 409, result);
  },
  'POST /agents/cancel': async (deps, req, res) => {
    if (!deps.agents) return sendJson(res, 503, { error: 'agent runtime not wired' });
    const body = asRecord(await readJsonBody(req));
    const id = body?.['id'];
    if (typeof id !== 'string') return sendJson(res, 400, { error: 'expected {id: string}' });
    deps.agents.cancel(id);
    sendJson(res, 200, { ok: true });
  },
};
