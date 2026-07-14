/**
 * audit-55.mjs — gpt-5.5 latency audit (headless, warm-connection, streaming).
 *
 * Phases:
 *  1. enum probe: which reasoning_effort values does gpt-5.5 accept? (text-only)
 *  2. floor re-measure: 1 warm-up + 12 synthetic (layout A) + 3 real targets at
 *     the floor effort, sequential on a keep-alive connection, streaming so we
 *     can split TTFB (time to first streamed chunk) from total.
 *  3. low reproduction: 5 warm calls at effort 'low' on layout A.
 *
 * Writes results/gpt-5.5-audit.json. Usage via stream_options.include_usage.
 * Usage: node audit-55.mjs [--floor minimal]  (default: auto from probe)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApiKey } from './harness.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const key = getApiKey();
const MODEL = 'gpt-5.5';

const spec = JSON.parse(readFileSync(join(ROOT, 'layouts.json'), 'utf8'));
const real = JSON.parse(readFileSync(join(ROOT, 'real-targets.json'), 'utf8'));
const W = spec.width,
  H = spec.height;
const imgA = readFileSync(join(ROOT, 'images', 'A-plain.jpg')).toString('base64');
const imgReal = readFileSync(join(ROOT, 'images', 'real-plain.jpg')).toString('base64');

const SYSTEM =
  'You are a precise UI grounding model. The user names an on-screen target in the attached ' +
  `screenshot (${W}x${H} pixels, origin top-left). Respond with ONLY a JSON object ` +
  '{"x": <int>, "y": <int>, "label": "<short label>"} giving the pixel coordinates of the ' +
  'CENTER of the target. No prose, no code fences.';

async function probeEffort(effort) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'reply with the word ok' }],
      max_completion_tokens: 200,
      reasoning_effort: effort,
    }),
  });
  const j = await r.json();
  if (!r.ok) return { effort, ok: false, error: (j.error?.message ?? '').slice(0, 200) };
  return {
    effort,
    ok: true,
    reasoningTokens: j.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    completionTokens: j.usage?.completion_tokens ?? null,
  };
}

/** Streaming grounding call: returns TTFB (first chunk) + total + usage. */
async function pointStreaming(imageB64, ask, effort) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: `point at ${ask}.` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 4000,
      reasoning_effort: effort,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  const tHeaders = Date.now();
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error?.message ?? `http ${res.status}`);
  }
  let tFirstChunk = null;
  let tFirstContent = null;
  let text = '';
  let usage = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (tFirstChunk === null) tFirstChunk = Date.now();
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = evt.choices?.[0]?.delta?.content;
      if (delta) {
        if (tFirstContent === null) tFirstContent = Date.now();
        text += delta;
      }
      if (evt.usage) usage = evt.usage;
    }
  }
  const tDone = Date.now();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep */
  }
  return {
    parsed,
    text,
    ttfbMs: (tFirstChunk ?? tDone) - t0, // first SSE bytes (incl. server queue + reasoning for stream head)
    firstContentMs: (tFirstContent ?? tDone) - t0, // first visible answer token
    headersMs: tHeaders - t0,
    totalMs: tDone - t0,
    usage,
  };
}

function score(rec, t) {
  if (rec.parsed && typeof rec.parsed.x === 'number' && typeof rec.parsed.y === 'number') {
    const errX = rec.parsed.x - t.cx,
      errY = rec.parsed.y - t.cy;
    return {
      pred: { x: rec.parsed.x, y: rec.parsed.y },
      err: Math.hypot(errX, errY),
      hit: Math.abs(errX) <= t.w / 2 && Math.abs(errY) <= t.h / 2,
    };
  }
  return { invalid: rec.text?.slice(0, 120) };
}

const args = process.argv.slice(2);
const floorArg = args.includes('--floor') ? args[args.indexOf('--floor') + 1] : null;

const out = { model: MODEL, timestamp: new Date().toISOString(), probes: [], runs: [] };

// Phase 1: enum probe
console.log('== phase 1: reasoning_effort enum probe (text-only)');
for (const e of ['bogus-value', 'none', 'minimal', 'low']) {
  const p = await probeEffort(e);
  out.probes.push(p);
  console.log(
    `  ${e.padEnd(12)} ${p.ok ? `OK reasoning=${p.reasoningTokens}` : `REJECTED: ${p.error}`}`,
  );
  if (!p.ok && /exceeded your current quota/i.test(p.error)) {
    console.log('QUOTA DEAD — aborting audit without burning further calls');
    process.exit(2);
  }
}
const accepted = out.probes.filter((p) => p.ok).map((p) => p.effort);
const floor =
  floorArg ??
  (accepted.includes('none') ? 'none' : accepted.includes('minimal') ? 'minimal' : 'low');
console.log(`  -> floor effort: ${floor}`);

// Phase 2: floor re-measure (warm-up + 12 synthetic + 3 real)
async function runSet(name, effort, jobs) {
  console.log(`== ${name} (effort=${effort})`);
  const records = [];
  for (const { img, t, warmup } of jobs) {
    try {
      const r = await pointStreaming(img, t.ask, effort);
      const s = score(r, t);
      const rec = {
        id: t.id,
        warmup: !!warmup,
        gt: { x: t.cx, y: t.cy },
        ...s,
        ttfbMs: r.ttfbMs,
        firstContentMs: r.firstContentMs,
        totalMs: r.totalMs,
        reasoningTokens: r.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        completionTokens: r.usage?.completion_tokens ?? null,
        promptTokens: r.usage?.prompt_tokens ?? null,
      };
      records.push(rec);
      console.log(
        `  ${(warmup ? '(warmup) ' : '') + t.id.padEnd(9)} err=${s.err !== undefined ? Math.round(s.err) + 'px' : 'INVALID'} ttfb=${r.ttfbMs}ms firstTok=${r.firstContentMs}ms total=${r.totalMs}ms reason=${rec.reasoningTokens}`,
      );
    } catch (err) {
      records.push({ id: t.id, warmup: !!warmup, error: String(err.message ?? err) });
      console.log(`  ${t.id.padEnd(9)} ERROR: ${err.message}`);
    }
  }
  out.runs.push({ name, effort, records });
}

const targetsA = spec.layouts.A.targets;
const floorJobs = [
  { img: imgA, t: targetsA[0], warmup: true }, // discardable warm-up (cold TLS)
  ...targetsA.map((t) => ({ img: imgA, t })),
  ...real.targets.slice(0, 3).map((t) => ({ img: imgReal, t })),
];
await runSet('floor-remeasure', floor, floorJobs);

// Phase 3: 'low' reproduction, warm (5 calls, connection already hot)
const lowJobs = targetsA.slice(0, 5).map((t) => ({ img: imgA, t }));
await runSet('low-reproduction', 'low', lowJobs);

writeFileSync(join(ROOT, 'results', 'gpt-5.5-audit.json'), JSON.stringify(out, null, 2));
console.log('wrote results/gpt-5.5-audit.json');

// summary
const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
for (const run of out.runs) {
  const v = run.records.filter((r) => !r.warmup && !r.error);
  const errs = v.filter((r) => r.err !== undefined).map((r) => r.err);
  console.log(
    `${run.name} [${run.effort}]: n=${v.length} medErr=${Math.round(q(errs, 0.5))} maxErr=${Math.round(Math.max(...errs))} ` +
      `hit=${v.filter((r) => r.hit).length}/${v.length} totalP50=${Math.round(
        q(
          v.map((r) => r.totalMs),
          0.5,
        ),
      )}ms ` +
      `totalP90=${Math.round(
        q(
          v.map((r) => r.totalMs),
          0.9,
        ),
      )}ms ttfbP50=${Math.round(
        q(
          v.map((r) => r.ttfbMs),
          0.5,
        ),
      )}ms ` +
      `reasonP50=${Math.round(
        q(
          v.map((r) => r.reasoningTokens ?? 0),
          0.5,
        ),
      )}`,
  );
}
console.log('AUDIT DONE');
