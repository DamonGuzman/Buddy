/**
 * M9 element-snap grounding tests:
 * - scoring.ts (pure): label/name normalization, similarity, selection
 *   (threshold + proximity tie-breaks),
 * - convert.ts (pure): DIP <-> physical px at 100%/150%/200% and roundtrip,
 *   plus the prefer-screen seam (injected Electron screen API + fallback),
 * - snapper.ts service: timebox fallback, crash respawn, dispose — against a
 *   fake JSON-lines daemon (a Node child process, no PowerShell/UIA needed),
 * - snapper.ts retry/budget policy — against a stubbed daemon client
 *   (transport-level behavior lives in tests/daemon-client.test.ts).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  levenshtein,
  normalizeTokens,
  selectCandidate,
  textSimilarity,
  SNAP_TEXT_THRESHOLD,
} from '../src/main/grounding/scoring';
import type { SnapCandidate } from '../src/main/grounding/scoring';
import {
  dipToPhysicalPreferScreen,
  dipToPhysicalViaMeta,
  physicalToDipPreferScreen,
  physicalToDipViaMeta,
} from '../src/main/grounding/convert';
import type { Pt, ScreenPointApi } from '../src/main/grounding/convert';
import { GroundingService } from '../src/main/grounding/snapper';
import type {
  DaemonQuery,
  DaemonRequester,
  DaemonResponse,
} from '../src/main/grounding/daemon-client';
import type { CaptureMeta } from '../src/shared/types';

// ---------------------------------------------------------------------------
// scoring: normalization
// ---------------------------------------------------------------------------

describe('grounding scoring: normalizeTokens', () => {
  it('lowercases, strips punctuation and UI stopwords', () => {
    expect(normalizeTokens('the Save button')).toEqual(['save']);
    expect(normalizeTokens('The "Save As" menu item!')).toEqual(['save', 'as']);
    expect(normalizeTokens('the subscribe to the newsletter checkbox')).toEqual([
      'subscribe',
      'newsletter',
    ]);
  });

  it('keeps numbers and inner punctuation (prices)', () => {
    expect(normalizeTokens('the headphones price $249.00 on the product card')).toEqual([
      'headphones',
      'price',
      '249.00',
      'product',
      'card',
    ]);
  });

  it('a purely generic name normalizes to nothing', () => {
    expect(normalizeTokens('button')).toEqual([]);
    expect(normalizeTokens('the')).toEqual([]);
  });
});

describe('grounding scoring: levenshtein', () => {
  it('computes classic distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('save', 'save')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// scoring: similarity
// ---------------------------------------------------------------------------

describe('grounding scoring: textSimilarity', () => {
  it('"the save button" matches the element named "Save"', () => {
    expect(textSimilarity('the save button', 'Save')).toBeGreaterThanOrEqual(0.85);
  });

  it('ranks "Save As" above "Save" for the label "the save as button"', () => {
    const saveAs = textSimilarity('the save as button', 'Save As');
    const save = textSimilarity('the save as button', 'Save');
    expect(saveAs).toBeGreaterThan(save);
    expect(saveAs).toBeGreaterThanOrEqual(0.95);
    expect(save).toBeGreaterThanOrEqual(SNAP_TEXT_THRESHOLD); // still plausible
  });

  it('partial name containment scores high ($249.00 price label)', () => {
    expect(
      textSimilarity('the headphones price $249.00 on the product card', '$249.00'),
    ).toBeGreaterThanOrEqual(0.7);
  });

  it('verbose scene labels still match their element names', () => {
    expect(
      textSimilarity('the subscribe to the newsletter checkbox', 'Subscribe to our newsletter'),
    ).toBeGreaterThanOrEqual(SNAP_TEXT_THRESHOLD);
    expect(textSimilarity('the email address field', 'Email address')).toBeGreaterThanOrEqual(0.8);
  });

  it('label-in-name containment: "the search box" matches a placeholder-derived name', () => {
    const contained = textSimilarity('the search box', 'Search headphones, speakers, accessories…');
    expect(contained).toBeGreaterThanOrEqual(SNAP_TEXT_THRESHOLD);
    // ...but an element literally NAMED like the label always outranks it.
    expect(textSimilarity('the search box', 'Search')).toBeGreaterThan(contained);
  });

  it('unrelated names stay under the threshold', () => {
    expect(textSimilarity('the save button', 'Export')).toBeLessThan(SNAP_TEXT_THRESHOLD);
    expect(textSimilarity('the save button', 'Open File')).toBeLessThan(SNAP_TEXT_THRESHOLD);
    expect(textSimilarity('the shopping cart icon', 'Customer Reviews')).toBeLessThan(
      SNAP_TEXT_THRESHOLD,
    );
  });

  it('tolerates small typos / plural drift', () => {
    expect(textSimilarity('the setings button', 'Settings')).toBeGreaterThanOrEqual(
      SNAP_TEXT_THRESHOLD,
    );
    expect(textSimilarity('the headphone card', 'Headphones')).toBeGreaterThanOrEqual(
      SNAP_TEXT_THRESHOLD,
    );
  });

  it('empty / generic-only names never match', () => {
    expect(textSimilarity('the save button', '')).toBe(0);
    expect(textSimilarity('the save button', 'button')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoring: selection
// ---------------------------------------------------------------------------

function cand(name: string, x: number, y: number, w = 80, h = 40): SnapCandidate {
  return { name, x, y, w, h };
}

describe('grounding scoring: selectCandidate', () => {
  const point = { x: 500, y: 300 };

  it('picks the label match even when a wrong element is closer', () => {
    const best = selectCandidate(
      'the save button',
      point,
      [cand('Export', 480, 290), cand('Save', 700, 300)],
      350,
    );
    expect(best?.candidate.name).toBe('Save');
    expect(best?.textScore).toBeGreaterThanOrEqual(0.85);
  });

  it('proximity breaks ties between identical names', () => {
    const best = selectCandidate(
      'the save button',
      point,
      [cand('Save', 900, 300), cand('Save', 520, 300)],
      350,
    );
    expect(best?.candidate.x).toBe(520);
  });

  it('returns null when nothing clears the threshold (raw-point fallback)', () => {
    const best = selectCandidate(
      'the save button',
      point,
      [cand('Export', 480, 290), cand('Reviews', 520, 310)],
      350,
    );
    expect(best).toBeNull();
  });

  it('ignores zero-area and unnamed candidates', () => {
    const best = selectCandidate(
      'the save button',
      point,
      [cand('Save', 480, 290, 0, 0), cand('', 480, 290)],
      350,
    );
    expect(best).toBeNull();
  });

  it('snap target is the element center', () => {
    const best = selectCandidate('the save button', point, [cand('Save', 600, 280, 100, 40)], 350);
    expect(best?.cx).toBe(650);
    expect(best?.cy).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// convert: DIP <-> physical px
// ---------------------------------------------------------------------------

function meta(scale: number, x = 0, y = 0, w = 2560, h = 1440): CaptureMeta {
  return {
    screenIndex: 0,
    displayId: 1,
    imageW: 2048,
    imageH: 1152,
    displayBounds: { x, y, width: w, height: h },
    scaleFactor: scale,
    isActive: true,
  };
}

describe('grounding convert: DIP <-> physical', () => {
  it('identity at 100% scale', () => {
    expect(dipToPhysicalViaMeta({ x: 123, y: 456 }, meta(1))).toEqual({ x: 123, y: 456 });
    expect(physicalToDipViaMeta({ x: 123, y: 456 }, meta(1))).toEqual({ x: 123, y: 456 });
  });

  it('scales at 150% (the M9 target machine: 4K @ 150%)', () => {
    expect(dipToPhysicalViaMeta({ x: 1280, y: 720 }, meta(1.5))).toEqual({ x: 1920, y: 1080 });
    expect(physicalToDipViaMeta({ x: 1920, y: 1080 }, meta(1.5))).toEqual({ x: 1280, y: 720 });
  });

  it('scales at 200%', () => {
    expect(dipToPhysicalViaMeta({ x: 100, y: 50 }, meta(2))).toEqual({ x: 200, y: 100 });
  });

  it('roundtrips within rounding error', () => {
    const m = meta(1.5);
    const original = { x: 1111, y: 777 };
    const back = physicalToDipViaMeta(dipToPhysicalViaMeta(original, m), m);
    expect(Math.abs(back.x - original.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(back.y - original.y)).toBeLessThanOrEqual(0.5);
  });

  it('display corner maps to the physical corner', () => {
    const m = meta(1.5);
    expect(dipToPhysicalViaMeta({ x: 2560, y: 1440 }, m)).toEqual({ x: 3840, y: 2160 });
  });

  it('two-step rounding is preserved (not collapsible to round(p*sf))', () => {
    // Documented in convert.ts: the direct product rounds the other way here.
    const m = meta(1.25, 2560);
    const p = { x: -1023.6000000000001, y: 0 };
    expect(dipToPhysicalViaMeta(p, m).x).toBe(-1279);
    expect(Math.round(p.x * m.scaleFactor)).toBe(-1280);
  });
});

// ---------------------------------------------------------------------------
// convert: prefer-screen seam (injectable Electron screen API)
// ---------------------------------------------------------------------------

/** A ScreenPointApi stub that records calls and returns canned points. */
function apiStub(result: Pt | (() => Pt)): ScreenPointApi & { calls: Pt[] } {
  const calls: Pt[] = [];
  const produce = (point: Pt): Pt => {
    calls.push(point);
    return typeof result === 'function' ? result() : result;
  };
  return { calls, dipToScreenPoint: produce, screenToDipPoint: produce };
}

describe('grounding convert: prefer-screen seam', () => {
  const m = meta(1.5);

  it('uses the screen API result when finite, rounding the input first', () => {
    const api = apiStub({ x: 111, y: 222 });
    expect(dipToPhysicalPreferScreen({ x: 10.4, y: 20.6 }, m, api)).toEqual({ x: 111, y: 222 });
    expect(api.calls).toEqual([{ x: 10, y: 21 }]);
    expect(physicalToDipPreferScreen({ x: 1919.5, y: 1080.4 }, m, api)).toEqual({ x: 111, y: 222 });
    expect(api.calls[1]).toEqual({ x: 1920, y: 1080 });
  });

  it('falls back to viaMeta (with the UNROUNDED point) when the API throws', () => {
    const throwing = apiStub(() => {
      throw new Error('screen API unavailable');
    });
    const p = { x: 10.4, y: 20.6 };
    expect(dipToPhysicalPreferScreen(p, m, throwing)).toEqual(dipToPhysicalViaMeta(p, m));
    expect(dipToPhysicalPreferScreen(p, m, throwing)).toEqual({ x: 16, y: 31 });
    const q = { x: 1920, y: 1080 };
    expect(physicalToDipPreferScreen(q, m, throwing)).toEqual(physicalToDipViaMeta(q, m));
  });

  it('falls back when the API returns non-finite coordinates', () => {
    const p = { x: 100, y: 50 };
    expect(dipToPhysicalPreferScreen(p, m, apiStub({ x: NaN, y: 5 }))).toEqual(
      dipToPhysicalViaMeta(p, m),
    );
    expect(dipToPhysicalPreferScreen(p, m, apiStub({ x: 5, y: Infinity }))).toEqual(
      dipToPhysicalViaMeta(p, m),
    );
    expect(physicalToDipPreferScreen(p, m, apiStub({ x: NaN, y: NaN }))).toEqual(
      physicalToDipViaMeta(p, m),
    );
  });

  it('falls back when the API returns null/undefined at runtime', () => {
    const p = { x: 100, y: 50 };
    const nullApi = apiStub(() => null as unknown as Pt);
    const undefApi = apiStub(() => undefined as unknown as Pt);
    expect(dipToPhysicalPreferScreen(p, m, nullApi)).toEqual(dipToPhysicalViaMeta(p, m));
    expect(physicalToDipPreferScreen(p, m, undefApi)).toEqual(physicalToDipViaMeta(p, m));
  });
});

// ---------------------------------------------------------------------------
// snapper service against a fake daemon
// ---------------------------------------------------------------------------

/**
 * Fake JSON-lines daemon: answers every request with one "Save" candidate at
 * (100,100,80,40) after FAKE_DELAY_MS; exits after the first answer when
 * FAKE_EXIT_AFTER=1 (crash-respawn testing).
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
    const delay = Number(process.env.FAKE_DELAY_MS || 0);
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        id: req.id,
        elapsedMs: delay,
        candidates: [{ name: 'Save', x: 100, y: 100, w: 80, h: 40 }],
      }) + '\\n');
      if (process.env.FAKE_EXIT_AFTER === '1') process.exit(0);
    }, delay);
  }
});
`;

function fakeService(timeboxMs: number): GroundingService {
  return new GroundingService({
    scriptDir: 'unused-for-fake-daemon',
    timeboxMs,
    command: process.execPath,
    args: ['-e', FAKE_DAEMON],
  });
}

describe('GroundingService (fake daemon)', () => {
  const services: GroundingService[] = [];
  afterEach(() => {
    for (const s of services.splice(0)) s.dispose();
    delete process.env['FAKE_DELAY_MS'];
    delete process.env['FAKE_EXIT_AFTER'];
  });

  it('snaps to the matching element (label does the work)', async () => {
    const service = fakeService(2_000);
    services.push(service);
    const outcome = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(outcome.matched).toBe(true);
    expect(outcome.point).toEqual({ x: 140, y: 120 }); // element center
    expect(outcome.name).toBe('Save');
    expect(outcome.score).toBeGreaterThanOrEqual(0.85);
    expect(outcome.timedOut).toBe(false);
  });

  it('reports no match (raw-point fallback) for an unrelated label', async () => {
    const service = fakeService(2_000);
    services.push(service);
    const outcome = await service.snap({ x: 150, y: 120, label: 'the export button' });
    expect(outcome.matched).toBe(false);
    expect(outcome.point).toBeNull();
    expect(outcome.candidates).toBe(1);
  });

  it('times out within the timebox and falls back (slow daemon)', async () => {
    process.env['FAKE_DELAY_MS'] = '1500';
    const service = fakeService(300);
    services.push(service);
    const t0 = Date.now();
    const outcome = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(outcome.matched).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_200); // never waits for the daemon
  });

  it('respawns after the daemon exits and keeps answering', async () => {
    process.env['FAKE_EXIT_AFTER'] = '1';
    const service = fakeService(2_000);
    services.push(service);
    const first = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(first.matched).toBe(true);
    // Let the daemon's exit land (a snap racing the death falls back to the
    // raw point by design); the NEXT snap must respawn and answer again.
    await new Promise((r) => setTimeout(r, 250));
    const second = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(second.matched).toBe(true);
  });

  it('dispose() kills the daemon and later snaps fail soft', async () => {
    const service = fakeService(2_000);
    services.push(service);
    await service.snap({ x: 150, y: 120, label: 'the save button' });
    service.dispose();
    const after = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(after.matched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// snapper retry/budget policy against a stubbed daemon client
// ---------------------------------------------------------------------------

interface StubClient extends DaemonRequester {
  /** Every daemon query, in order, with its transport timeout. */
  calls: { query: DaemonQuery; timeoutMs: number }[];
}

/** A DaemonRequester stub answering from a scripted per-call sequence. */
function stubClient(
  respond: (query: DaemonQuery, call: number) => Promise<DaemonResponse | null>,
): StubClient {
  const calls: StubClient['calls'] = [];
  return {
    calls,
    ensureSpawned: () => {},
    dispose: () => {},
    request: (query, timeoutMs) => {
      calls.push({ query, timeoutMs });
      return respond(query, calls.length);
    },
  };
}

/** One daemon answer carrying the given candidates. */
function answer(candidates: unknown, elapsedMs = 5): DaemonResponse {
  return { id: 1, elapsedMs, candidates };
}

const SAVE = { name: 'Save', x: 100, y: 100, w: 80, h: 40 };
const EXPORT = { name: 'Export', x: 100, y: 100, w: 80, h: 40 };

function stubService(client: DaemonRequester, options: Partial<{ excludePid: number }> = {}) {
  return new GroundingService({ scriptDir: 'unused-for-stub-client', ...options }, client);
}

describe('GroundingService (stubbed client): retry + budget policy', () => {
  it('retries once at the wider radius when nothing near the point matches', async () => {
    const client = stubClient((_query, call) =>
      Promise.resolve(call === 1 ? answer([EXPORT]) : answer([SAVE])),
    );
    const outcome = await stubService(client).snap({ x: 150, y: 120, label: 'the save button' });
    expect(client.calls.map((c) => c.query.radiusPx)).toEqual([350, 700]);
    expect(outcome.matched).toBe(true);
    expect(outcome.point).toEqual({ x: 140, y: 120 });
    expect(outcome.daemonMs).toBe(5);
  });

  it('a first-round match never triggers the retry', async () => {
    const client = stubClient(() => Promise.resolve(answer([SAVE])));
    const outcome = await stubService(client).snap({ x: 150, y: 120, label: 'the save button' });
    expect(client.calls).toHaveLength(1);
    expect(outcome.matched).toBe(true);
  });

  it('gives up after the widest radius (no third attempt)', async () => {
    const client = stubClient(() => Promise.resolve(answer([EXPORT])));
    const outcome = await stubService(client).snap({ x: 150, y: 120, label: 'the save button' });
    expect(client.calls.map((c) => c.query.radiusPx)).toEqual([350, 700]);
    expect(outcome.matched).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.candidates).toBe(1);
  });

  it('a caller radius >= the retry radius is tried only once', async () => {
    const client = stubClient(() => Promise.resolve(answer([EXPORT])));
    const outcome = await stubService(client).snap({
      x: 150,
      y: 120,
      label: 'the save button',
      radiusPx: 700,
    });
    expect(client.calls.map((c) => c.query.radiusPx)).toEqual([700]);
    expect(outcome.matched).toBe(false);
  });

  it('a null transport answer reports timedOut (raw-point fallback)', async () => {
    const client = stubClient(() => Promise.resolve(null));
    const outcome = await stubService(client).snap({ x: 150, y: 120, label: 'the save button' });
    expect(client.calls).toHaveLength(1);
    expect(outcome.matched).toBe(false);
    expect(outcome.timedOut).toBe(true);
  });

  it('skips the retry when the remaining budget is under the attempt floor', async () => {
    // First round burns most of the 200ms timebox; the 700px retry would
    // start with < 120ms left and must be skipped as a timeout.
    const client = stubClient(() => new Promise((r) => setTimeout(() => r(answer([EXPORT])), 120)));
    const outcome = await stubService(client).snap(
      { x: 150, y: 120, label: 'the save button' },
      { timeboxMs: 200 },
    );
    expect(client.calls).toHaveLength(1);
    expect(outcome.matched).toBe(false);
    expect(outcome.timedOut).toBe(true);
  });

  it('clamps the daemon budget to 450ms under a roomy timebox', async () => {
    const client = stubClient(() => Promise.resolve(answer([SAVE])));
    await stubService(client).snap({ x: 150, y: 120, label: 'the save button' });
    const { query, timeoutMs } = client.calls[0]!;
    expect(query.budgetMs).toBe(450); // min(450, 600 - 60)
    expect(query.maxNodes).toBe(3000);
    expect(timeoutMs).toBeLessThanOrEqual(600);
  });

  it('floors the daemon budget at 100ms under a tight timebox', async () => {
    const client = stubClient(() => Promise.resolve(answer([SAVE])));
    await stubService(client).snap(
      { x: 150, y: 120, label: 'the save button' },
      { timeboxMs: 130 },
    );
    expect(client.calls[0]!.query.budgetMs).toBe(100); // max(100, 130 - 60)
  });

  it('rounds the query point and carries excludePid on every attempt', async () => {
    const client = stubClient(() => Promise.resolve(answer([EXPORT])));
    await stubService(client, { excludePid: 4242 }).snap({
      x: 150.6,
      y: 119.4,
      label: 'the save button',
    });
    for (const { query } of client.calls) {
      expect(query.x).toBe(151);
      expect(query.y).toBe(119);
      expect(query.excludePid).toBe(4242);
    }
  });

  it('debug mode surfaces every scored candidate from the answering query', async () => {
    const client = stubClient(() => Promise.resolve(answer([EXPORT, { ...SAVE, ct: 'Button' }])));
    const outcome = await stubService(client).snap(
      { x: 150, y: 120, label: 'the save button' },
      { debug: true },
    );
    expect(outcome.matched).toBe(true);
    expect(outcome.debug).toHaveLength(2);
    const save = outcome.debug!.find((c) => c.name === 'Save')!;
    expect(save.ct).toBe('Button');
    expect(save.rect).toEqual({ x: 100, y: 100, w: 80, h: 40 });
    expect(save.textScore).toBeGreaterThanOrEqual(0.85);
    const exp = outcome.debug!.find((c) => c.name === 'Export')!;
    expect(exp.textScore).toBeLessThan(SNAP_TEXT_THRESHOLD);
  });

  it('normalizes a scalar-ized single candidate (PS 5.1 ConvertTo-Json)', async () => {
    const client = stubClient(() => Promise.resolve(answer(SAVE)));
    const outcome = await stubService(client).snap({ x: 150, y: 120, label: 'the save button' });
    expect(outcome.matched).toBe(true);
    expect(outcome.candidates).toBe(1);
  });

  it('a disposed service answers immediately without touching the client', async () => {
    const client = stubClient(() => Promise.resolve(answer([SAVE])));
    const service = stubService(client);
    service.dispose();
    const outcome = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(outcome.matched).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect(client.calls).toHaveLength(0);
  });
});
