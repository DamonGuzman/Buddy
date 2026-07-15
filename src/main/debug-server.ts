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
import type { ApprovalGrant } from '../shared/types';
import {
  isMockAgentScenario,
  markMockAgentTask,
  MOCK_AGENT_SCENARIOS,
  type MockAgentScenario,
} from './agents/mock-backend';
import { debugPortOverride, isDebugEnabled } from './env';
import {
  checkDebugToken,
  checkHost,
  checkOrigin,
  refusesPackagedStart,
  resolveToken,
} from './debug/debug-auth';
import { asRecord, isNonBlankString, readJsonBody, sendJson } from './debug/debug-http';
import type { AgentDebugDeps, DebugServerDeps, RouteHandler } from './debug/deps';
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

export interface BrowserAgentDebugDeps extends AgentDebugDeps {
  /** Spawn through the production AgentManager with browserEnabled=true. */
  spawnBrowser?: (
    task: string,
    scenario?: MockAgentScenario,
  ) => { ok: true; agentId: string } | { ok: false; reason: string };
}

export interface GateDebugAssessmentInput {
  agentId?: string;
  userRequest: string;
  taskClaim?: string;
  action: Record<string, unknown>;
}

/**
 * Explicit service seams for computer-use QA. The HTTP server never reaches
 * into gate/store/coordinator internals and therefore cannot accidentally
 * grow a second execution path.
 */
export interface ComputerUseDebugDeps {
  assessGate(input: GateDebugAssessmentInput): Promise<unknown>;
  listGrants(): ApprovalGrant[] | Promise<ApprovalGrant[]>;
  resolveAgentApproval(
    agentId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): boolean | Promise<boolean>;
}

export type ComputerUseDebugServerDeps = Omit<DebugServerDeps, 'agents'> & {
  agents?: BrowserAgentDebugDeps;
  computerUse?: ComputerUseDebugDeps;
};

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
  // Overrides the legacy task-only route with the browser-capability-aware
  // contract while keeping the read-only request backward compatible.
  'POST /agents/spawn': async (deps, req, res) => {
    if (!deps.agents) return sendJson(res, 503, { error: 'agent runtime not wired' });
    const body = asRecord(await readJsonBody(req));
    const task = body?.['task'];
    const browserEnabled = body?.['browserEnabled'] ?? false;
    const scenario = body?.['scenario'];
    if (!isNonBlankString(task))
      return sendJson(res, 400, {
        error: 'expected {task: string, browserEnabled?: boolean, scenario?: string}',
      });
    if (typeof browserEnabled !== 'boolean')
      return sendJson(res, 400, { error: 'browserEnabled must be a boolean' });
    if (scenario !== undefined && !isMockAgentScenario(scenario))
      return sendJson(res, 400, {
        error: 'unknown mock scenario',
        scenarios: MOCK_AGENT_SCENARIOS,
      });
    if (scenario !== undefined && scenario !== 'research' && browserEnabled !== true)
      return sendJson(res, 400, {
        error: 'computer-use mock scenarios require browserEnabled:true',
      });

    const agentDeps = deps.agents as BrowserAgentDebugDeps;
    const result = browserEnabled
      ? agentDeps.spawnBrowser
        ? agentDeps.spawnBrowser(
            scenario === undefined ? task.trim() : markMockAgentTask(scenario, task),
            scenario,
          )
        : { ok: false as const, reason: 'browser debug spawn is not wired' }
      : agentDeps.spawn(
          scenario === undefined || scenario === 'research'
            ? task.trim()
            : markMockAgentTask(scenario, task),
        );
    sendJson(res, result.ok ? 202 : browserEnabled && !agentDeps.spawnBrowser ? 503 : 409, result);
  },
  'GET /mock/agent-scenarios': (_deps, _req, res) => {
    sendJson(res, 200, { scenarios: MOCK_AGENT_SCENARIOS });
  },
  'POST /gate/assess': async (deps, req, res) => {
    const computerUse = (deps as ComputerUseDebugServerDeps).computerUse;
    if (!computerUse) return sendJson(res, 503, { error: 'computer-use gate not wired' });
    const body = asRecord(await readJsonBody(req));
    const actionRecord = asRecord(body?.['action']);
    if (
      !body ||
      !isNonBlankString(body['userRequest']) ||
      actionRecord === null ||
      (body['agentId'] !== undefined && !isNonBlankString(body['agentId'])) ||
      (body['taskClaim'] !== undefined && typeof body['taskClaim'] !== 'string')
    )
      return sendJson(res, 400, {
        error:
          'expected {userRequest: string, action: object, agentId?: string, taskClaim?: string}',
      });
    const input: GateDebugAssessmentInput = {
      userRequest: body['userRequest'].trim(),
      action: actionRecord,
      ...(typeof body['agentId'] === 'string' ? { agentId: body['agentId'].trim() } : {}),
      ...(typeof body['taskClaim'] === 'string' ? { taskClaim: body['taskClaim'] } : {}),
    };
    sendJson(res, 200, await computerUse.assessGate(input));
  },
  'GET /grants': async (deps, _req, res) => {
    const computerUse = (deps as ComputerUseDebugServerDeps).computerUse;
    if (!computerUse) return sendJson(res, 503, { error: 'computer-use grants not wired' });
    sendJson(res, 200, await computerUse.listGrants());
  },
  ...AUDIO_EVAL_ROUTES,
  ...GROUNDING_ROUTES,
  ...HOVER_ROUTES,
};

const DYNAMIC_ROUTES = [
  'POST /approvals/:approvalId/approve',
  'POST /approvals/:approvalId/deny',
] as const;

/**
 * Start the debug server. Returns null when CLICKY_DEBUG !== '1', or when
 * running packaged without BOTH CLICKY_DEBUG=1 and an explicit token.
 */
export function startDebugServer(deps: ComputerUseDebugServerDeps): Server | null {
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
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const handler = ROUTES[`${req.method ?? 'GET'} ${path}`];
    if (!handler) {
      const approvalRoute =
        req.method === 'POST' ? /^\/approvals\/([^/]+)\/(approve|deny)$/.exec(path) : null;
      if (approvalRoute) {
        const encodedApprovalId = approvalRoute[1];
        const routeAction = approvalRoute[2];
        if (
          encodedApprovalId !== undefined &&
          (routeAction === 'approve' || routeAction === 'deny')
        ) {
          void resolveDebugApproval(deps, req, res, encodedApprovalId, routeAction).catch(
            (err: unknown) => sendJson(res, 500, { error: String(err) }),
          );
        }
        return;
      }
      sendJson(res, 404, {
        error: 'not found',
        routes: [...Object.keys(ROUTES), ...DYNAMIC_ROUTES],
      });
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

async function resolveDebugApproval(
  deps: ComputerUseDebugServerDeps,
  req: Parameters<RouteHandler>[1],
  res: Parameters<RouteHandler>[2],
  encodedApprovalId: string,
  action: 'approve' | 'deny',
): Promise<void> {
  if (!deps.computerUse) return sendJson(res, 503, { error: 'computer-use approvals not wired' });
  let approvalId: string;
  try {
    approvalId = decodeURIComponent(encodedApprovalId).trim();
  } catch {
    return sendJson(res, 400, { error: 'approval id is not valid URL encoding' });
  }
  if (!approvalId) return sendJson(res, 400, { error: 'approval id is required' });
  const body = asRecord(await readJsonBody(req));
  const agentId = typeof body?.['agentId'] === 'string' ? body['agentId'].trim() : '';
  if (!agentId) return sendJson(res, 400, { error: 'exact agentId is required' });
  let verdict: 'once' | 'always' | 'deny' = 'deny';
  if (action === 'approve') {
    const requested = body?.['verdict'] ?? 'once';
    if (requested !== 'once' && requested !== 'always')
      return sendJson(res, 400, { error: "approve verdict must be 'once' or 'always'" });
    verdict = requested;
  }
  const resolved = await deps.computerUse.resolveAgentApproval(agentId, approvalId, verdict);
  sendJson(
    res,
    resolved ? 200 : 404,
    resolved ? { ok: true, verdict } : { error: 'no pending approval' },
  );
}
