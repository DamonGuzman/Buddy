/**
 * JsonLinesDaemonClient tests (M9 transport half):
 * - wire codec: request encoding, response decoding, PS 5.1 candidate
 *   normalization,
 * - request/response correlation against a fake JSON-lines daemon (a Node
 *   child process, no PowerShell/UIA needed),
 * - failure modes: timeout, consecutive-timeout restart, counter reset on
 *   success, spawn failure, dispose.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  JsonLinesDaemonClient,
  decodeDaemonResponse,
  encodeDaemonRequest,
  normalizeCandidates,
} from '../src/main/grounding/daemon-client';
import type { DaemonQuery, DaemonSpawnSpec } from '../src/main/grounding/daemon-client';

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

describe('daemon codec: encodeDaemonRequest', () => {
  it('emits one JSON line, newline-terminated, id included', () => {
    const line = encodeDaemonRequest({
      id: 7,
      x: 1,
      y: 2,
      radiusPx: 350,
      budgetMs: 450,
      maxNodes: 3000,
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      id: 7,
      x: 1,
      y: 2,
      radiusPx: 350,
      budgetMs: 450,
      maxNodes: 3000,
    });
  });

  it('carries excludePid when present', () => {
    const line = encodeDaemonRequest({
      id: 1,
      x: 0,
      y: 0,
      radiusPx: 350,
      budgetMs: 100,
      maxNodes: 3000,
      excludePid: 4242,
    });
    expect(JSON.parse(line).excludePid).toBe(4242);
  });
});

describe('daemon codec: decodeDaemonResponse', () => {
  it('parses a JSON line', () => {
    expect(decodeDaemonResponse('{"id":3,"elapsedMs":12}')).toEqual({ id: 3, elapsedMs: 12 });
  });

  it('returns null for stray non-JSON output', () => {
    expect(decodeDaemonResponse('Loading assembly...')).toBeNull();
    expect(decodeDaemonResponse('{broken')).toBeNull();
  });
});

describe('daemon codec: normalizeCandidates', () => {
  const save = { name: 'Save', x: 1, y: 2, w: 80, h: 40 };

  it('passes arrays through, keeping ct when present', () => {
    expect(normalizeCandidates([save, { ...save, ct: 'Button' }])).toEqual([
      save,
      { ...save, ct: 'Button' },
    ]);
  });

  it('wraps a scalar-ized single object (PS 5.1 ConvertTo-Json)', () => {
    expect(normalizeCandidates(save)).toEqual([save]);
  });

  it('drops null/undefined and malformed entries', () => {
    expect(normalizeCandidates(null)).toEqual([]);
    expect(normalizeCandidates(undefined)).toEqual([]);
    expect(
      normalizeCandidates([save, 'junk', 42, { name: 'NoRect' }, { ...save, w: 'wide' }]),
    ).toEqual([save]);
  });
});

// ---------------------------------------------------------------------------
// Client against a fake daemon
// ---------------------------------------------------------------------------

/**
 * Fake JSON-lines daemon: answers every request with one "Save" candidate at
 * the request's own point, after `budgetMs` ms — so each request controls its
 * own response delay. FAKE_STRAY=1 prepends non-JSON noise lines.
 */
const FAKE_DAEMON = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (process.env.FAKE_STRAY === '1') process.stdout.write('Loading assembly...\\n\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: req.id,
        elapsedMs: req.budgetMs,
        visited: 7,
        candidates: [{ name: 'Save', x: req.x, y: req.y, w: 80, h: 40 }],
      }) + '\\n');
    }, req.budgetMs);
  }
});
`;

/** budgetMs doubles as the fake daemon's response delay. */
function query(budgetMs: number): DaemonQuery {
  return { x: 10, y: 20, radiusPx: 350, budgetMs, maxNodes: 3000 };
}

function fakeClient(overrides: Partial<{ spec: DaemonSpawnSpec }> = {}): {
  client: JsonLinesDaemonClient;
  spawnCount: () => number;
} {
  let spawns = 0;
  const client = new JsonLinesDaemonClient({
    resolveCommand: () => {
      spawns += 1;
      return overrides.spec ?? { command: process.execPath, args: ['-e', FAKE_DAEMON] };
    },
  });
  return { client, spawnCount: () => spawns };
}

describe('JsonLinesDaemonClient (fake daemon)', () => {
  const clients: JsonLinesDaemonClient[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.dispose();
    delete process.env['FAKE_STRAY'];
  });

  it('round-trips a request and decodes the candidates payload', async () => {
    const { client, spawnCount } = fakeClient();
    clients.push(client);
    const resp = await client.request(query(0), 2_000);
    expect(resp).not.toBeNull();
    expect(resp!.visited).toBe(7);
    expect(normalizeCandidates(resp!.candidates)).toEqual([
      { name: 'Save', x: 10, y: 20, w: 80, h: 40 },
    ]);
    expect(spawnCount()).toBe(1);
  });

  it('correlates concurrent requests by id (single spawned child)', async () => {
    const { client, spawnCount } = fakeClient();
    clients.push(client);
    const [slow, fast] = await Promise.all([
      client.request({ ...query(120), x: 1 }, 2_000),
      client.request({ ...query(0), x: 2 }, 2_000),
    ]);
    expect(normalizeCandidates(slow!.candidates)[0]!.x).toBe(1);
    expect(normalizeCandidates(fast!.candidates)[0]!.x).toBe(2);
    expect(spawnCount()).toBe(1);
  });

  it('ignores stray non-JSON stdout lines', async () => {
    process.env['FAKE_STRAY'] = '1';
    const { client } = fakeClient();
    clients.push(client);
    const resp = await client.request(query(0), 2_000);
    expect(resp).not.toBeNull();
    expect(resp!.id).toBe(1);
  });

  it('resolves null on timeout without waiting for the daemon', async () => {
    const { client } = fakeClient();
    clients.push(client);
    const t0 = Date.now();
    const resp = await client.request(query(5_000), 60);
    expect(resp).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('restarts the daemon after consecutive timeouts and keeps answering', async () => {
    const { client, spawnCount } = fakeClient();
    clients.push(client);
    // MAX_CONSECUTIVE_TIMEOUTS = 2: two timed-out requests wedge-detect.
    expect(await client.request(query(5_000), 40)).toBeNull();
    expect(await client.request(query(5_000), 40)).toBeNull();
    // Let the killed child's exit land (a request racing the death fails
    // soft by design); the NEXT request spawns a FRESH child and succeeds.
    await new Promise((r) => setTimeout(r, 250));
    const resp = await client.request(query(0), 2_000);
    expect(resp).not.toBeNull();
    expect(spawnCount()).toBe(2);
  });

  it('a successful answer resets the consecutive-timeout counter', async () => {
    const { client, spawnCount } = fakeClient();
    clients.push(client);
    expect(await client.request(query(5_000), 40)).toBeNull(); // timeout #1
    expect(await client.request(query(0), 2_000)).not.toBeNull(); // reset
    expect(await client.request(query(5_000), 40)).toBeNull(); // timeout #1 again
    expect(await client.request(query(0), 2_000)).not.toBeNull(); // still same child
    expect(spawnCount()).toBe(1);
  });

  it('resolves null when the command cannot be spawned', async () => {
    const { client } = fakeClient({
      spec: { command: 'definitely-not-a-real-command-xyz', args: [] },
    });
    clients.push(client);
    const resp = await client.request(query(0), 5_000);
    expect(resp).toBeNull();
  });

  it('resolves null when resolveCommand itself throws', async () => {
    const client = new JsonLinesDaemonClient({
      resolveCommand: () => {
        throw new Error('no script dir');
      },
    });
    clients.push(client);
    await expect(client.request(query(0), 1_000)).resolves.toBeNull();
    expect(() => client.ensureSpawned()).toThrow('no script dir');
  });

  it('dispose() fails in-flight requests soft and blocks respawns', async () => {
    const { client } = fakeClient();
    clients.push(client);
    const inflight = client.request(query(5_000), 10_000);
    client.dispose();
    await expect(inflight).resolves.toBeNull();
    await expect(client.request(query(0), 1_000)).resolves.toBeNull();
    expect(() => client.ensureSpawned()).toThrow(/disposed/);
  });
});
