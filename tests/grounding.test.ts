/**
 * M9 element-snap grounding tests:
 * - scoring.ts (pure): label/name normalization, similarity, selection
 *   (threshold + proximity tie-breaks),
 * - convert.ts (pure): DIP <-> physical px at 100%/150%/200% and roundtrip,
 * - snapper.ts service: timebox fallback, crash respawn, dispose — against a
 *   fake JSON-lines daemon (a Node child process, no PowerShell/UIA needed).
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
import { dipToPhysicalViaMeta, physicalToDipViaMeta } from '../src/main/grounding/convert';
import { GroundingService } from '../src/main/grounding/snapper';
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

  it('front-to-back window rank breaks an otherwise exact tie', () => {
    const behind = { ...cand('Save', 520, 300), windowRank: 3 };
    const front = { ...cand('Save', 520, 300), windowRank: 0 };
    const best = selectCandidate('save', point, [behind, front], 350);
    expect(best?.candidate.windowRank).toBe(0);
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

  it('ignores stale 1px accessibility slivers', () => {
    const best = selectCandidate('save', point, [cand('Save', 480, 290, 120, 1)], 350);
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
});

// ---------------------------------------------------------------------------
// snapper service against a fake daemon
// ---------------------------------------------------------------------------

/**
 * Fake JSON-lines daemon: answers every request with one "Save" candidate at
 * (100,100,80,40) after FAKE_DELAY_MS; supports a macOS AX-shaped candidate
 * and permission-error response; exits after the first answer when
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
      const candidates = process.env.FAKE_PERMISSION_ERROR === '1'
        ? []
        : process.env.FAKE_MAC_CANDIDATE === '1'
          ? [{ name: 'System Settings', ct: 'Button', x: 400, y: 240, w: 160, h: 80 }]
          : [{ name: 'Save', x: 100, y: 100, w: 80, h: 40 }];
      process.stdout.write(JSON.stringify({
        id: req.id,
        elapsedMs: delay,
        ...(process.env.FAKE_PERMISSION_ERROR === '1'
          ? { error: 'accessibility_permission_required' }
          : {}),
        candidates,
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
    delete process.env['FAKE_MAC_CANDIDATE'];
    delete process.env['FAKE_PERMISSION_ERROR'];
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

  it('accepts macOS Accessibility candidates through the same scoring contract', async () => {
    process.env['FAKE_MAC_CANDIDATE'] = '1';
    const service = fakeService(2_000);
    services.push(service);
    const outcome = await service.snap(
      { x: 430, y: 260, label: 'the System Settings button' },
      { debug: true },
    );
    expect(outcome.matched).toBe(true);
    expect(outcome.point).toEqual({ x: 480, y: 280 });
    expect(outcome.name).toBe('System Settings');
    expect(outcome.debug?.[0]).toMatchObject({ name: 'System Settings', ct: 'Button' });
  });

  it('fails soft when macOS Accessibility permission is not granted', async () => {
    process.env['FAKE_PERMISSION_ERROR'] = '1';
    const service = fakeService(2_000);
    services.push(service);
    const outcome = await service.snap({ x: 150, y: 120, label: 'the save button' });
    expect(outcome).toMatchObject({ matched: false, point: null, candidates: 0, timedOut: false });
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
