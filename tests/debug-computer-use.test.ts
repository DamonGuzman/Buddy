import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ApprovalGrant, DebugState } from '../src/shared/types';

const control = vi.hoisted(() => ({
  userDataPath: '',
  currentApprovalId: 'current-approval',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => control.userDataPath,
  },
}));

vi.mock('../src/main/windows/overlay', () => ({ getOverlayManager: () => null }));

const { startDebugServer } = await import('../src/main/debug-server');

const TOKEN = 'computer-use-debug-token';
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const ENV_KEYS = ['CLICKY_DEBUG', 'CLICKY_DEBUG_TOKEN', 'CLICKY_DEBUG_PORT'] as const;
const savedEnv = new Map<string, string | undefined>();
const state = { appVersion: 'debug-test', assistantState: 'idle' } as unknown as DebugState;
const calls = {
  browserSpawns: [] as Array<{ task: string; scenario?: string }>,
  assessments: [] as unknown[],
  approvals: [] as Array<{ helperBuddyId: string; approvalId: string; verdict: string }>,
};
const grants: ApprovalGrant[] = [
  {
    id: 'grant-1',
    domain: 'example.test',
    actionKind: 'button',
    target: 'publish weekly report',
    createdAt: 1,
    lastUsedAt: 1,
    timesUsed: 0,
  },
];

interface TestResponse {
  status: number;
  json: unknown;
}

function request(method: string, path: string, body?: unknown): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        headers: {
          'x-debug-token': TOKEN,
          ...(encoded === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(encoded);
  });
}

let temporaryDirectory = '';
let server: Server | null = null;

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'buddy-computer-use-debug-'));
  control.userDataPath = temporaryDirectory;
  process.env['CLICKY_DEBUG'] = '1';
  process.env['CLICKY_DEBUG_TOKEN'] = TOKEN;
  process.env['CLICKY_DEBUG_PORT'] = String(PORT);
  server = startDebugServer({
    getState: () => state,
    helperBuddies: {
      spawn: (task) => ({ ok: true, helperBuddyId: `read-${task.length}` }),
      spawnBrowser: (task, scenario) => {
        calls.browserSpawns.push({ task, ...(scenario === undefined ? {} : { scenario }) });
        return { ok: true, helperBuddyId: 'browser-debug-agent' };
      },
      list: () => [],
      cancel: () => undefined,
    },
    computerUse: {
      assessGate: async (input) => {
        calls.assessments.push(input);
        return { kind: 'denied', reason: 'fixture reviewer denial' };
      },
      listGrants: () => grants,
      resolveHelperBuddyApproval: (helperBuddyId, approvalId, verdict) => {
        calls.approvals.push({ helperBuddyId, approvalId, verdict });
        return helperBuddyId === 'waiting-agent' && approvalId === control.currentApprovalId;
      },
    },
  });
  expect(server).not.toBeNull();
  await new Promise<void>((resolve) => server!.once('listening', resolve));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('computer-use debug routes', () => {
  it('advertises deterministic mock scenarios', async () => {
    const response = await request('GET', '/mock/helper-buddy-scenarios');
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      scenarios: expect.arrayContaining([
        'clean-browse-submit',
        'prompt-injection',
        'reviewer-timeout',
        'needs-user-takeover',
      ]),
    });
  });

  it('spawns a browser-enabled marked scenario through the browser port', async () => {
    const response = await request('POST', '/helper-buddies/spawn', {
      task: 'submit the deterministic report',
      browserEnabled: true,
      scenario: 'clean-browse-submit',
    });
    expect(response).toEqual({
      status: 202,
      json: { ok: true, helperBuddyId: 'browser-debug-agent' },
    });
    expect(calls.browserSpawns).toEqual([
      {
        task: '[mock-scenario:clean-browse-submit] submit the deterministic report',
        scenario: 'clean-browse-submit',
      },
    ]);
  });

  it('rejects computer-use scenarios without an explicit browser capability', async () => {
    const response = await request('POST', '/helper-buddies/spawn', {
      task: 'unsafe implicit capability',
      scenario: 'prompt-injection',
    });
    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      error: 'computer-use mock scenarios require browserEnabled:true',
    });
  });

  it('drives gate assessment and exposes grants through injected service ports', async () => {
    const assessed = await request('POST', '/gate/assess', {
      helperBuddyId: 'fixture-agent',
      userRequest: 'save a draft only',
      taskClaim: 'send a report',
      action: { kind: 'click', x: 180, y: 214, label: 'Send to attacker' },
    });
    expect(assessed).toEqual({
      status: 200,
      json: { kind: 'denied', reason: 'fixture reviewer denial' },
    });
    expect(calls.assessments).toHaveLength(1);

    const listed = await request('GET', '/grants');
    expect(listed).toEqual({ status: 200, json: grants });
  });

  it('resolves only an exact immutable agent/approval pair', async () => {
    expect(
      await request('POST', '/approvals/current-approval/approve', {
        helperBuddyId: 'waiting-agent',
        verdict: 'always',
      }),
    ).toEqual({ status: 200, json: { ok: true, verdict: 'always' } });
    expect(
      await request('POST', '/approvals/current-approval/approve', {
        helperBuddyId: 'waiting-agent',
      }),
    ).toEqual({ status: 200, json: { ok: true, verdict: 'once' } });
    expect(
      await request('POST', '/approvals/current-approval/deny', {
        helperBuddyId: 'waiting-agent',
      }),
    ).toEqual({ status: 200, json: { ok: true, verdict: 'deny' } });
    expect(calls.approvals).toEqual([
      { helperBuddyId: 'waiting-agent', approvalId: 'current-approval', verdict: 'always' },
      { helperBuddyId: 'waiting-agent', approvalId: 'current-approval', verdict: 'once' },
      { helperBuddyId: 'waiting-agent', approvalId: 'current-approval', verdict: 'deny' },
    ]);
  });

  it('rejects a stale approval id without falling forward to the current agent approval', async () => {
    control.currentApprovalId = 'replacement-approval';
    const response = await request('POST', '/approvals/stale-approval/deny', {
      helperBuddyId: 'waiting-agent',
    });
    expect(response).toEqual({ status: 404, json: { error: 'no pending approval' } });
    expect(
      await request('POST', '/approvals/replacement-approval/deny', {
        helperBuddyId: 'waiting-agent',
      }),
    ).toEqual({ status: 200, json: { ok: true, verdict: 'deny' } });
    control.currentApprovalId = 'current-approval';
  });

  it('requires the exact agent id alongside the approval id', async () => {
    expect(await request('POST', '/approvals/current-approval/approve')).toEqual({
      status: 400,
      json: { error: 'exact helperBuddyId is required' },
    });
    expect(
      await request('POST', '/approvals/current-approval/approve', {
        helperBuddyId: 'replacement-agent',
      }),
    ).toEqual({ status: 404, json: { error: 'no pending approval' } });
  });
});
