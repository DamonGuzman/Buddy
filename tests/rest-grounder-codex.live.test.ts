/**
 * M13-core LIVE validation of the Codex-subscription grounding transport —
 * the REAL production module (rest-grounder.ts `ground()` on the chatgptCodex
 * arm) driven by REAL credentials from `~/.codex/auth.json`, against the
 * coord-study ground truth. No app, no windows — pure REST/SSE calls on the
 * user's ChatGPT plan (authorized; ~10 calls).
 *
 * Skipped unless CLICKY_LIVE_CODEX=1. The token is read fresh by CodexAuth,
 * used header-only, and NEVER logged. The run self-limits: it aborts the batch
 * if the primary plan-usage header climbs past 40%.
 *
 * Expected (docs/COORD-STUDY §8.2, gpt-5.6-sol low): ~1px synthetic / ≤7px
 * real median, 100% in-element, ~1.4-1.9s p50.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RestGrounder } from '../src/main/grounding/rest-grounder';
import { CodexAuth } from '../src/main/auth/codex-auth';
import { resolveGroundingAuth } from '../src/main/auth/auth-source';

const LIVE = process.env['CLICKY_LIVE_CODEX'] === '1';
const STUDY = join(__dirname, '..', 'eval', 'experiments', 'coord-study');
/** Safety valve: stop consuming the plan if primary usage crosses this. */
const USAGE_STOP_PERCENT = 40;

interface StudyTarget {
  id: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  ask: string;
  zone: string;
}

describe.skipIf(!LIVE)('Codex transport LIVE validation (CLICKY_LIVE_CODEX=1)', () => {
  it(
    'grounds coord-study targets via the production Codex path at ~100% in-element',
    async () => {
      // No Electron here: inject a no-op token store so CodexAuth doesn't touch
      // app.getPath. The valid ~100h token needs no refresh caching for this run.
      const codex = new CodexAuth({
        tokenStore: { load: () => null, save: () => {}, clear: () => {} },
      });
      const state = codex.codexSignInState();
      expect(state.signedIn, 'must be signed in via `codex login`').toBe(true);
      expect(state.valid, 'the Codex access token must be valid').toBe(true);

      const auth = resolveGroundingAuth({ getApiKey: () => null, codex });
      expect(auth?.kind, 'resolver must pick the Codex sub').toBe('chatgptCodex');
      if (auth === null || auth.kind !== 'chatgptCodex') return;

      // env:{} so the mock-mode guard is off; timeout generous for gpt-5.6-sol.
      const grounder = new RestGrounder({ getApiKey: () => null, env: {}, timeoutMs: 8_000 });

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
        source: string;
        primaryPct: number | null;
      }[] = [];
      let lastPrimary: number | null = null;
      let lastSecondary: number | null = null;
      let totalInputTok = 0;
      let totalOutputTok = 0;

      for (const { image, kind, t } of jobs) {
        if (lastPrimary !== null && lastPrimary > USAGE_STOP_PERCENT) {
          console.warn(`[live-codex] primary usage ${lastPrimary}% > ${USAGE_STOP_PERCENT}% — stopping`);
          break;
        }
        const t0 = Date.now();
        const outcome = await grounder.ground(
          { jpegBase64: image, imageW: layouts.width, imageH: layouts.height, label: t.ask },
          auth,
        );
        const ms = Date.now() - t0;
        if (outcome.usedPercent !== null) {
          lastPrimary = outcome.usedPercent.primary ?? lastPrimary;
          lastSecondary = outcome.usedPercent.secondary ?? lastSecondary;
        }
        if (outcome.usage !== undefined) {
          totalInputTok += outcome.usage.inputTokens;
          totalOutputTok += outcome.usage.outputTokens;
        }
        const res = outcome.point;
        if (res === null) {
          rows.push({ id: t.id, kind, err: null, hit: false, ms, source: outcome.source, primaryPct: lastPrimary });
        } else {
          const err = Math.hypot(res.x - t.cx, res.y - t.cy);
          const hit = Math.abs(res.x - t.cx) <= t.w / 2 && Math.abs(res.y - t.cy) <= t.h / 2;
          rows.push({ id: t.id, kind, err, hit, ms, source: outcome.source, primaryPct: lastPrimary });
        }
      }

      const errs = rows.filter((r) => r.err !== null).map((r) => r.err!).sort((a, b) => a - b);
      const lats = rows.map((r) => r.ms).sort((a, b) => a - b);
      const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? NaN;
      console.log('\n[live-codex] per-target (gpt-5.6-sol via ChatGPT sub, low, pixel JSON):');
      for (const r of rows) {
        console.log(
          `  ${r.id.padEnd(9)} ${r.kind.padEnd(9)} ` +
            `err=${r.err === null ? 'NULL' : Math.round(r.err) + 'px'}`.padEnd(14) +
            ` hit=${r.hit ? 'yes' : 'no '} latency=${r.ms}ms src=${r.source}`,
        );
      }
      console.log(
        `[live-codex] n=${rows.length} ok=${errs.length} ` +
          `median=${Math.round(median(errs))}px max=${Math.round(errs[errs.length - 1] ?? NaN)}px ` +
          `in-element=${rows.filter((r) => r.hit).length}/${rows.length} ` +
          `p50=${median(lats)}ms max=${lats[lats.length - 1]}ms ` +
          `usage(primary=${lastPrimary ?? '?'}% secondary=${lastSecondary ?? '?'}%) ` +
          `tokens(in=${totalInputTok} out=${totalOutputTok})`,
      );

      writeFileSync(
        join(STUDY, 'results', 'm13-codex-live-validation.json'),
        JSON.stringify(
          {
            module: 'src/main/grounding/rest-grounder.ts ground() — chatgptCodex arm',
            model: 'gpt-5.6-sol',
            timestamp: new Date().toISOString(),
            rows,
            usage: { primaryPercent: lastPrimary, secondaryPercent: lastSecondary, inputTokens: totalInputTok, outputTokens: totalOutputTok },
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

      // gpt-5.6-sol is pixel-exact in the study — gate a touch loose for n small.
      expect(errs.length).toBeGreaterThanOrEqual(rows.length - 1);
      expect(median(errs)).toBeLessThanOrEqual(40);
      expect(rows.filter((r) => r.hit).length).toBeGreaterThanOrEqual(rows.length - 1);
    },
    240_000,
  );
});
