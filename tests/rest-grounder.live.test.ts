/**
 * M10 headless LIVE validation of the REST grounding fallback — the REAL
 * production module (rest-grounder.ts) against the coord-study ground truth
 * (eval/experiments/coord-study: synthetic layout A, exact by construction,
 * plus hand-measured real-screenshot targets). No app, no windows, nothing
 * on screen — pure REST calls. Costs a few cents.
 *
 * Skipped unless CLICKY_LIVE_GROUND=1. The API key comes from the
 * environment (`OPENAI_API_KEY`) or the user-scope registry value — the same
 * source the coord-study harness used; it is never logged.
 *
 * Expected (docs/COORD-STUDY.md §8-§9, gpt-5.4-mini low): ~10px median
 * error, 93% in-element, p50 ~1.3s.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RestGrounder } from '../src/main/grounding/rest-grounder';

const LIVE = process.env['CLICKY_LIVE_GROUND'] === '1';
const STUDY = join(__dirname, '..', 'eval', 'experiments', 'coord-study');

function liveApiKey(): string | null {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'], {
      encoding: 'utf8',
    });
    const m = out.match(/OPENAI_API_KEY\s+REG_[A-Z_]+\s+(\S+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

interface StudyTarget {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  ask: string;
  zone: string;
}

describe.skipIf(!LIVE)('RestGrounder LIVE validation (CLICKY_LIVE_GROUND=1)', () => {
  it('grounds the coord-study targets at ~10px median via the production module', async () => {
    const key = liveApiKey();
    expect(key, 'OPENAI_API_KEY must be available for the live run').not.toBeNull();
    const grounder = new RestGrounder({ getApiKey: () => key, env: {} });

    const layouts = JSON.parse(readFileSync(join(STUDY, 'layouts.json'), 'utf8')) as {
      width: number;
      height: number;
      layouts: Record<string, { targets: StudyTarget[] }>;
    };
    const real = JSON.parse(readFileSync(join(STUDY, 'real-targets.json'), 'utf8')) as {
      targets: StudyTarget[];
    };
    const syntheticJpeg = readFileSync(join(STUDY, 'images', 'A-plain.jpg')).toString('base64');
    const realJpeg = readFileSync(join(STUDY, 'images', 'real-plain.jpg')).toString('base64');

    const jobs: { image: string; kind: string; t: StudyTarget }[] = [
      ...layouts.layouts['A']!.targets.map((t) => ({ image: syntheticJpeg, kind: 'synthetic', t })),
      ...real.targets
        .filter((t) => ['clock', 'review', 'openin'].includes(t.id))
        .map((t) => ({ image: realJpeg, kind: 'real', t })),
    ];
    expect(jobs.length).toBeGreaterThanOrEqual(10);

    const rows: {
      id: string;
      kind: string;
      err: number | null;
      hit: boolean;
      ms: number;
    }[] = [];
    for (const { image, kind, t } of jobs) {
      const t0 = Date.now();
      const res = await grounder.groundWithModel({
        jpegBase64: image,
        imageW: layouts.width,
        imageH: layouts.height,
        label: t.ask,
      });
      const ms = Date.now() - t0;
      if (res === null) {
        rows.push({ id: t.id, kind, err: null, hit: false, ms });
      } else {
        const err = Math.hypot(res.x - t.cx, res.y - t.cy);
        const hit = Math.abs(res.x - t.cx) <= t.w / 2 && Math.abs(res.y - t.cy) <= t.h / 2;
        rows.push({ id: t.id, kind, err, hit, ms });
      }
    }

    const errs = rows
      .filter((r) => r.err !== null)
      .map((r) => r.err!)
      .sort((a, b) => a - b);
    const lats = rows.map((r) => r.ms).sort((a, b) => a - b);
    const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? NaN;
    console.log('\n[live-ground] per-target results (gpt-5.4-mini, low, pixel JSON):');
    for (const r of rows) {
      console.log(
        `  ${r.id.padEnd(9)} ${r.kind.padEnd(9)} ` +
          `err=${r.err === null ? 'NULL' : Math.round(r.err) + 'px'}`.padEnd(14) +
          ` hit=${r.hit ? 'yes' : 'no '} latency=${r.ms}ms`,
      );
    }
    console.log(
      `[live-ground] n=${rows.length} ok=${errs.length} ` +
        `median=${Math.round(median(errs))}px max=${Math.round(errs[errs.length - 1] ?? NaN)}px ` +
        `in-element=${rows.filter((r) => r.hit).length}/${rows.length} ` +
        `p50=${median(lats)}ms max=${lats[lats.length - 1]}ms`,
    );

    // Persist next to the study's other result files (docs/EVAL.md §10).
    writeFileSync(
      join(STUDY, 'results', 'm10-live-validation.json'),
      JSON.stringify(
        {
          module: 'src/main/grounding/rest-grounder.ts (production code path)',
          model: 'gpt-5.4-mini',
          timestamp: new Date().toISOString(),
          rows,
          summary: {
            n: rows.length,
            ok: errs.length,
            medianErrPx: Math.round(median(errs)),
            maxErrPx: Math.round(errs[errs.length - 1] ?? NaN),
            inElement: rows.filter((r) => r.hit).length,
            p50LatencyMs: median(lats),
            maxLatencyMs: lats[lats.length - 1],
          },
        },
        null,
        2,
      ),
    );

    // Gate loosely (n is small): the study says ~10px median, 93% in-element.
    expect(errs.length).toBeGreaterThanOrEqual(rows.length - 2); // allow rare timeout nulls
    expect(median(errs)).toBeLessThanOrEqual(40);
  }, 180_000);
});
