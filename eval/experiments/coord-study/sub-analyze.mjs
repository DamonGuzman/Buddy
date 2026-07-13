/**
 * sub-analyze.mjs — aggregate the Codex-subscription grounding results
 * (results/<model>--sub-plain-<effort>--{A,B,real}.json) into a per-model
 * summary + comparison table. Writes results/sub-summary.json.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RES = join(ROOT, 'results');

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};
const median = (a) => pct(a, 50);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// "small/hard" = the deliberately tough targets: the 16px square, 24px dot,
// and the tight real targets (Start icon 44, Review 58x26, New task h24,
// Open in h26). Threshold on the smaller extent isolates these from the
// ~130x48 buttons.
const isSmall = (r) => Math.min(r.w, r.h) <= 44;

const files = readdirSync(RES).filter((f) => /--sub-plain-/.test(f) && f.endsWith('.json'));
const byModelEffort = {};
for (const f of files) {
  const j = JSON.parse(readFileSync(join(RES, f), 'utf8'));
  const key = `${j.model}||${j.condition}`;
  (byModelEffort[key] ??= { model: j.model, condition: j.condition, records: [], quota: j.quota }).records.push(...j.records);
}

const rows = [];
for (const key of Object.keys(byModelEffort).sort()) {
  const { model, condition, records, quota } = byModelEffort[key];
  const scored = records.filter((r) => r.err !== undefined);
  const errs = scored.map((r) => r.err);
  const hits = scored.filter((r) => r.hit);
  const small = scored.filter(isSmall);
  const smallHits = small.filter((r) => r.hit);
  const lat = scored.map((r) => r.latencyMs).filter((v) => v != null);
  const ttfb = scored.map((r) => r.ttfbMs).filter((v) => v != null);
  const out = scored.map((r) => r.usage?.out).filter((v) => v != null);
  const reasoning = scored.map((r) => r.usage?.reasoning).filter((v) => v != null);
  const inp = scored.map((r) => r.usage?.in).filter((v) => v != null);
  const cost = scored.map((r) => (r.usage ? r.usage.out + r.usage.reasoning : null)).filter((v) => v != null);
  const misses = scored.filter((r) => !r.hit).map((r) => ({ id: r.id, err: round(r.err), w: r.w }));
  const invalid = records.filter((r) => r.err === undefined && !r.error);
  const failed = records.filter((r) => r.error);

  rows.push({
    model, condition,
    n: records.length, valid: scored.length,
    invalid: invalid.length, failed: failed.length,
    inElementPct: round((hits.length / scored.length) * 100, 1),
    inElementSmallPct: round((smallHits.length / small.length) * 100, 1),
    smallN: small.length,
    medianErr: round(median(errs)),
    p90Err: round(pct(errs, 90)),
    maxErr: round(Math.max(...errs)),
    within40: round((scored.filter((r) => r.err <= 40).length / scored.length) * 100, 1),
    within100: round((scored.filter((r) => r.err <= 100).length / scored.length) * 100, 1),
    latencyP50: median(lat),
    latencyP90: pct(lat, 90),
    ttfbP50: median(ttfb),
    tokens: {
      inMedian: round(median(inp), 0),
      outMedian: round(median(out), 0),
      reasoningMedian: round(median(reasoning), 0),
      costMedian: round(median(cost), 0),   // reasoning+output, the plan-quota draw
      costTotal: cost.reduce((a, b) => a + b, 0),
      reasoningTotal: reasoning.reduce((a, b) => a + b, 0),
      reasoningSmallTotal: small.reduce((a, r) => a + (r.usage?.reasoning ?? 0), 0),
    },
    misses,
    quota,
  });
}

const summary = { generatedAt: new Date().toISOString(), transport: 'codex-subscription', rows };
writeFileSync(join(RES, 'sub-summary.json'), JSON.stringify(summary, null, 2));

// pretty print
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('model', 15), pad('in-el%', 7), pad('sm-el%', 9), pad('medPx', 6), pad('p90Px', 6), pad('maxPx', 6), pad('latP50', 7), pad('out~', 5), pad('rsnMed', 7), pad('rsnTot', 7), pad('costTot', 8));
for (const r of rows) {
  console.log(
    pad(r.model, 15),
    pad(r.inElementPct, 7), pad(`${r.inElementSmallPct}(${r.smallN})`, 9),
    pad(r.medianErr, 6), pad(r.p90Err, 6), pad(r.maxErr, 6),
    pad(r.latencyP50, 7), pad(r.tokens.outMedian, 5),
    pad(r.tokens.reasoningMedian, 7), pad(r.tokens.reasoningTotal, 7), pad(r.tokens.costTotal, 8),
  );
  if (r.misses.length) console.log('    misses:', JSON.stringify(r.misses));
}
console.log('\n-> results/sub-summary.json');
