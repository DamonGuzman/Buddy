/**
 * End-to-end auth + routing tests for the composed debug server
 * (src/main/debug-server.ts): the token/Origin/Host gate in front of every
 * route, the packaged-build refusal, and the composed route-table order the
 * 404 body exposes (external QA tooling reads it).
 *
 * Electron and the overlay manager are mocked; requests go over real HTTP on
 * a per-run random loopback port (CLICKY_DEBUG_PORT).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DebugState } from '../src/shared/types';

const control = vi.hoisted(() => ({
  isPackaged: false,
  userDataPath: '',
  groundingQueries: [] as Array<{
    x: number;
    y: number;
    label: string;
    radiusDip?: number;
  }>,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return control.isPackaged;
    },
    getPath: () => control.userDataPath,
  },
}));

// The overlay manager drags in the whole window stack; the auth gate and
// route table are what's under test.
vi.mock('../src/main/windows/overlay', () => ({
  getOverlayManager: () => null,
}));

const { startDebugServer } = await import('../src/main/debug-server');

const TOKEN = 'test-debug-token';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const FAKE_STATE = { appVersion: '0.0.0-test', assistantState: 'idle' } as unknown as DebugState;

const ENV_KEYS = ['CLICKY_DEBUG', 'CLICKY_DEBUG_TOKEN', 'CLICKY_DEBUG_PORT'] as const;
const savedEnv = new Map<string, string | undefined>();

interface Response {
  status: number;
  json: unknown;
}

function request(options: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  host?: string;
  body?: string;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        method: options.method ?? 'GET',
        path: options.path ?? '/state',
        headers: {
          ...(options.host !== undefined ? { host: options.host } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

let tmp = '';
let server: Server | null = null;

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  tmp = mkdtempSync(join(tmpdir(), 'clicky-debug-server-'));
  control.userDataPath = tmp;
  process.env['CLICKY_DEBUG'] = '1';
  process.env['CLICKY_DEBUG_TOKEN'] = TOKEN;
  process.env['CLICKY_DEBUG_PORT'] = String(PORT);

  server = startDebugServer({
    getState: () => FAKE_STATE,
    grounding: {
      query: async (query) => {
        control.groundingQueries.push(query);
        return {
          query,
          matched: false,
          snappedDip: null,
          name: null,
          score: null,
          elapsedMs: 1,
          nativeMs: null,
          timedOut: false,
          candidates: [],
        };
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
  rmSync(tmp, { recursive: true, force: true });
});

describe('debug server auth gate', () => {
  it('serves an authorized request (X-Debug-Token header)', async () => {
    const res = await request({ headers: { 'x-debug-token': TOKEN } });
    expect(res.status).toBe(200);
    expect(res.json).toEqual(FAKE_STATE);
  });

  it('accepts the token as a ?token= query param', async () => {
    const res = await request({ path: `/state?token=${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('401s a request with no token', async () => {
    const res = await request({});
    expect(res.status).toBe(401);
    expect(res.json).toEqual({ error: 'X-Debug-Token header (or ?token=) required' });
  });

  it('401s a request with a wrong token', async () => {
    const res = await request({ headers: { 'x-debug-token': 'wrong-token' } });
    expect(res.status).toBe(401);
  });

  it('403s a cross-site Origin even with a valid token (CSRF)', async () => {
    const res = await request({
      headers: { 'x-debug-token': TOKEN, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'cross-origin requests are not allowed' });
  });

  it("accepts the literal 'null' Origin of a file:// eval page", async () => {
    const res = await request({ headers: { 'x-debug-token': TOKEN, origin: 'null' } });
    expect(res.status).toBe(200);
  });

  it('403s a rebound Host header even with a valid token (DNS rebinding)', async () => {
    const res = await request({
      host: `attacker.example:${PORT}`,
      headers: { 'x-debug-token': TOKEN },
    });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'bad Host header' });
  });
});

describe('debug server routing', () => {
  it('404s unknown routes and lists the composed table in contract order', async () => {
    const res = await request({ path: '/nope', headers: { 'x-debug-token': TOKEN } });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({
      error: 'not found',
      routes: [
        'GET /state',
        'POST /overlay/pointer',
        'POST /overlay/assistant-state',
        'POST /overlay/caption',
        'POST /overlay/capture-indicator',
        'POST /hotkey/press',
        'POST /hotkey/release',
        'POST /ask',
        'GET /transcript',
        'POST /playback',
        'GET /agents',
        'POST /agents/spawn',
        'POST /agents/cancel',
        'GET /mock/agent-scenarios',
        'POST /gate/assess',
        'GET /grants',
        'GET /timings',
        'GET /audio/output-stats',
        'GET /audio/last-output.wav',
        'POST /eval/ground-truth',
        'GET /eval/ground-truth',
        'POST /grounding/query',
        'GET /hover/state',
        'POST /approvals/:approvalId/approve',
        'POST /approvals/:approvalId/deny',
      ],
    });
  });

  it('503s a route family whose dependency is not wired', async () => {
    const res = await request({
      method: 'POST',
      path: '/hotkey/press',
      headers: { 'x-debug-token': TOKEN },
    });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({ error: 'conversation pipeline not wired' });
  });

  it('passes a positive global-DIP search radius to native grounding', async () => {
    control.groundingQueries.length = 0;
    const res = await request({
      method: 'POST',
      path: '/grounding/query',
      headers: { 'x-debug-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 120, y: 80, label: 'save', radiusDip: 420 }),
    });

    expect(res.status).toBe(200);
    expect(control.groundingQueries).toEqual([{ x: 120, y: 80, label: 'save', radiusDip: 420 }]);
  });

  it('rejects the removed physical-pixel radius contract', async () => {
    const res = await request({
      method: 'POST',
      path: '/grounding/query',
      headers: { 'x-debug-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 120, y: 80, label: 'save', radiusPx: 420 }),
    });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error:
        'expected {x: number, y: number, label: string, radiusDip?: positive number} (global DIP)',
    });
  });
});

describe('debug server start refusals', () => {
  it('returns null when CLICKY_DEBUG is not 1', () => {
    const saved = process.env['CLICKY_DEBUG'];
    delete process.env['CLICKY_DEBUG'];
    try {
      expect(startDebugServer({ getState: () => FAKE_STATE })).toBeNull();
    } finally {
      process.env['CLICKY_DEBUG'] = saved;
    }
  });

  it('refuses to start packaged without an explicit CLICKY_DEBUG_TOKEN', () => {
    const savedToken = process.env['CLICKY_DEBUG_TOKEN'];
    delete process.env['CLICKY_DEBUG_TOKEN'];
    control.isPackaged = true;
    try {
      expect(startDebugServer({ getState: () => FAKE_STATE })).toBeNull();
    } finally {
      control.isPackaged = false;
      process.env['CLICKY_DEBUG_TOKEN'] = savedToken;
    }
  });
});
