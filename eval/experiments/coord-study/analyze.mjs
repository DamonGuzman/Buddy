/**
 * analyze.mjs — aggregates results/*.json into per-condition stats:
 * median/p90 error, %within 40px / 100px, hit rate (inside element bounds),
 * per-zone breakdown, and a per-layout affine drift fit (is the error a
 * stable linear transform, or scene-dependent noise?).
 *
 * Usage: node analyze.mjs [--json]   (writes results/summary.json too)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RES = join(ROOT, 'results');

const files = readdirSync(RES).filter((f) => f.endsWith('.json') && f !== 'summary.json');
const runs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(join(RES, f), 'utf8')) }));

const q = (sorted, p) => {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const r1 = (x) => Math.round(x * 10) / 10;

/** Least-squares fit pred = [a b; c d] * gt + [e f]; returns params + R^2. */
function affineFit(pairs) {
  // Solve two independent regressions: px = a*gx + b*gy + e ; py = c*gx + d*gy + f
  const n = pairs.length;
  if (n < 4) return null;
  const solve = (ys) => {
    // design matrix columns: gx, gy, 1
    let sxx = 0, sxy = 0, sx1 = 0, syy = 0, sy1 = 0, s11 = n;
    let bx = 0, by = 0, b1 = 0;
    for (let i = 0; i < n; i++) {
      const { gx, gy } = pairs[i];
      const y = ys[i];
      sxx += gx * gx; sxy += gx * gy; sx1 += gx;
      syy += gy * gy; sy1 += gy;
      bx += gx * y; by += gy * y; b1 += y;
    }
    // 3x3 normal equations via Cramer
    const M = [ [sxx, sxy, sx1], [sxy, syy, sy1], [sx1, sy1, s11] ];
    const B = [bx, by, b1];
    const det3 = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(M);
    if (Math.abs(D) < 1e-9) return null;
    const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? B[i] : v)));
    return [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D];
  };
  const cx = solve(pairs.map((p) => p.px));
  const cy = solve(pairs.map((p) => p.py));
  if (!cx || !cy) return null;
  // R^2 over the combined residuals (vs identity-mean baseline), plus residual RMS
  let ssRes = 0, ssTot = 0, rawSS = 0;
  const mpx = pairs.reduce((s, p) => s + p.px, 0) / n;
  const mpy = pairs.reduce((s, p) => s + p.py, 0) / n;
  for (const p of pairs) {
    const fx = cx[0] * p.gx + cx[1] * p.gy + cx[2];
    const fy = cy[0] * p.gx + cy[1] * p.gy + cy[2];
    ssRes += (p.px - fx) ** 2 + (p.py - fy) ** 2;
    ssTot += (p.px - mpx) ** 2 + (p.py - mpy) ** 2;
    rawSS += (p.px - p.gx) ** 2 + (p.py - p.gy) ** 2;
  }
  return {
    xCoef: cx.map(r1), yCoef: cy.map(r1),
    r2: r1(1 - ssRes / ssTot),
    rawRmsPx: r1(Math.sqrt(rawSS / n)),
    residualRmsPx: r1(Math.sqrt(ssRes / n)),
  };
}

function stats(records) {
  const valid = records.filter((r) => r.err !== undefined);
  const failed = records.filter((r) => r.status === 'failed' || r.error);
  const refused = records.filter((r) => r.refused && r.status !== 'failed' && !r.error);
  const errs = valid.map((r) => r.err).sort((a, b) => a - b);
  const hit = valid.filter((r) => r.hit).length;
  return {
    n: records.length,
    valid: valid.length,
    refused: refused.length,
    apiFailed: failed.length,
    medianErr: r1(q(errs, 0.5)),
    p90Err: r1(q(errs, 0.9)),
    maxErr: r1(errs[errs.length - 1] ?? NaN),
    within40: valid.length ? r1((errs.filter((e) => e <= 40).length / valid.length) * 100) : NaN,
    within100: valid.length ? r1((errs.filter((e) => e <= 100).length / valid.length) * 100) : NaN,
    hitRate: valid.length ? r1((hit / valid.length) * 100) : NaN,
  };
}

// group runs by model+condition
const groups = new Map();
for (const run of runs) {
  const key = `${run.model}|${run.condition}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run);
}

const summary = [];
for (const [key, runList] of [...groups.entries()].sort()) {
  const [model, condition] = key.split('|');
  const all = runList.flatMap((r) => r.records.map((rec) => ({ ...rec, layout: r.layout })));
  const s = stats(all);
  const zones = {};
  for (const zone of ['corner', 'center', 'edge', 'cluster', 'icon']) {
    const zr = all.filter((r) => r.zone === zone && r.err !== undefined);
    if (zr.length) {
      const ze = zr.map((r) => r.err).sort((a, b) => a - b);
      zones[zone] = { n: zr.length, median: r1(q(ze, 0.5)), max: r1(ze[ze.length - 1]) };
    }
  }
  const affine = {};
  for (const run of runList) {
    const pairs = run.records
      .filter((r) => r.pred)
      .map((r) => ({ gx: r.gt.x, gy: r.gt.y, px: r.pred.x, py: r.pred.y }));
    const fit = affineFit(pairs);
    if (fit) affine[run.layout] = fit;
  }
  const latencies = all.filter((r) => r.latencyMs).map((r) => r.latencyMs).sort((a, b) => a - b);
  summary.push({
    model, condition, ...s,
    latencyP50: Math.round(q(latencies, 0.5)),
    zones, affine,
  });
}

// usage/cost accounting
let inputTok = 0, cachedTok = 0, outputTok = 0;
for (const run of runs) {
  for (const u of run.usage ?? []) {
    inputTok += u.input_tokens ?? 0;
    cachedTok += u.input_token_details?.cached_tokens ?? 0;
    outputTok += u.output_tokens ?? 0;
  }
}

console.log('=== coord-study summary ===\n');
console.log(
  'model'.padEnd(22) + 'condition'.padEnd(18) + 'n'.padStart(3) + 'ok'.padStart(4) +
  'med'.padStart(7) + 'p90'.padStart(7) + 'max'.padStart(7) +
  '<=40'.padStart(7) + '<=100'.padStart(7) + 'hit%'.padStart(7) + 'lat'.padStart(6),
);
for (const s of summary) {
  console.log(
    s.model.padEnd(22) + s.condition.padEnd(18) + String(s.n).padStart(3) + String(s.valid).padStart(4) +
    String(s.medianErr).padStart(7) + String(s.p90Err).padStart(7) + String(s.maxErr).padStart(7) +
    (s.within40 + '%').padStart(7) + (s.within100 + '%').padStart(7) + (s.hitRate + '%').padStart(7) +
    String(s.latencyP50).padStart(6),
  );
}
console.log('\nzones (median err px):');
for (const s of summary) {
  const z = Object.entries(s.zones).map(([k, v]) => `${k}=${v.median}`).join(' ');
  console.log(`  ${s.model} ${s.condition}: ${z}`);
}
console.log('\naffine drift fits (gt->pred; identity = [1,0,0]/[0,1,0]):');
for (const s of summary) {
  for (const [layout, f] of Object.entries(s.affine)) {
    console.log(
      `  ${s.model} ${s.condition} [${layout}]: x=${JSON.stringify(f.xCoef)} y=${JSON.stringify(f.yCoef)} ` +
      `R2=${f.r2} rawRMS=${f.rawRmsPx} residRMS=${f.residualRmsPx}`,
    );
  }
}
console.log(`\nusage: input=${inputTok} (cached=${cachedTok}) output=${outputTok}`);
// gpt-realtime published text rates (per 1M): input $4, cached $0.40, output $16
const cost = ((inputTok - cachedTok) * 4 + cachedTok * 0.4 + outputTok * 16) / 1e6;
console.log(`approx cost at gpt-realtime full text rates: $${cost.toFixed(2)}`);

writeFileSync(join(RES, 'summary.json'), JSON.stringify({ summary, usage: { inputTok, cachedTok, outputTok } }, null, 2));
console.log('\nwrote results/summary.json');
