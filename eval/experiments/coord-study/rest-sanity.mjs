/**
 * rest-sanity.mjs — sanity condition on a strong NON-realtime vision model
 * via the REST chat completions API: is coordinate weakness realtime-family
 * specific, or a general vision-model ceiling?
 *
 * Same plain images + baseline-plain framing; strict-JSON coords out.
 * Usage: node rest-sanity.mjs [--model gpt-5.2] [--layouts A,B] [--limit N]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getApiKey } from './harness.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  return args;
}

const args = parseArgs(process.argv);
const model = args.model ?? 'gpt-5.2';
const layouts = (args.layouts ?? 'A,B').split(',');
const limit = args.limit ? Number(args.limit) : Infinity;
/** reasoning effort (gpt-5.x): --effort low|medium|high; omitted = API default */
const effort = args.effort ?? null;
/** --norm 1: ask for 0-1000 normalized coords instead of pixels (converted for scoring) */
const norm = args.norm !== undefined;
const conditionName = (norm ? 'rest-norm' : 'rest-plain') + (effort ? `-${effort}` : '');
const apiKey = getApiKey();
const spec = JSON.parse(readFileSync(join(ROOT, 'layouts.json'), 'utf8'));
const W = spec.width, H = spec.height;

const SYSTEM = norm
  ? 'You are a precise UI grounding model. The user names an on-screen target in the attached ' +
    'screenshot. Respond with ONLY a JSON object {"x": <int>, "y": <int>, "label": "<short label>"} ' +
    'giving NORMALIZED coordinates of the CENTER of the target: x and y are integers 0-1000, ' +
    'where (0,0) is the top-left corner and (1000,1000) is the bottom-right corner of the ' +
    'screenshot. No prose, no code fences.'
  : 'You are a precise UI grounding model. The user names an on-screen target in the attached ' +
    `screenshot (${W}x${H} pixels, origin top-left). Respond with ONLY a JSON object ` +
    '{"x": <int>, "y": <int>, "label": "<short label>"} giving the pixel coordinates of the ' +
    "CENTER of the target. No prose, no code fences.";

async function pointOnce(imageB64, ask) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
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
      ...(effort ? { reasoning_effort: effort } : {}),
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message ?? `http ${res.status}`);
  const text = j.choices?.[0]?.message?.content ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep null */ }
  return { parsed, text, latencyMs: Date.now() - t0, usage: j.usage };
}

// --real: run the 5 hand-measured real-screenshot targets instead of layouts
const jobs = [];
if (args.real !== undefined) {
  const rt = JSON.parse(readFileSync(join(ROOT, 'real-targets.json'), 'utf8'));
  jobs.push({ layoutName: 'real', imageFile: 'real-plain.jpg', targets: rt.targets });
} else {
  for (const layoutName of layouts) {
    jobs.push({
      layoutName,
      imageFile: `${layoutName}-plain.jpg`,
      targets: spec.layouts[layoutName].targets,
    });
  }
}

for (const { layoutName, imageFile, targets: allTargets } of jobs) {
  const image = readFileSync(join(ROOT, 'images', imageFile)).toString('base64');
  const targets = allTargets.slice(0, limit);
  const records = [];
  const usage = [];
  console.log(`[${model} | ${conditionName} | ${layoutName}] ${targets.length} targets`);
  for (const t of targets) {
    const rec = { id: t.id, ask: t.ask, zone: t.zone, gt: { x: t.cx, y: t.cy }, w: t.w, h: t.h };
    try {
      const res = await pointOnce(image, t.ask);
      if (res.parsed && typeof res.parsed.x === 'number' && typeof res.parsed.y === 'number') {
        const px = norm ? (res.parsed.x / 1000) * W : res.parsed.x;
        const py = norm ? (res.parsed.y / 1000) * H : res.parsed.y;
        rec.pred = { x: px, y: py };
        rec.rawArgs = res.parsed;
        rec.errX = px - t.cx;
        rec.errY = py - t.cy;
        rec.err = Math.hypot(rec.errX, rec.errY);
        rec.hit = Math.abs(rec.errX) <= t.w / 2 && Math.abs(rec.errY) <= t.h / 2;
      } else {
        rec.invalidArgs = res.text;
      }
      rec.latencyMs = res.latencyMs;
      rec.status = 'completed';
      if (res.usage) usage.push(res.usage);
      console.log(`  ${t.id.padEnd(8)} gt(${t.cx},${t.cy}) -> ${rec.pred ? `(${rec.pred.x},${rec.pred.y})` : '-'} err=${rec.err !== undefined ? Math.round(rec.err) + 'px' : 'INVALID'}`);
    } catch (err) {
      rec.error = String(err.message ?? err);
      rec.status = 'failed';
      console.log(`  ${t.id.padEnd(8)} ERROR: ${rec.error}`);
    }
    records.push(rec);
  }
  const outPath = join(ROOT, 'results', `${model}--${conditionName}--${layoutName}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    model, condition: conditionName, layout: layoutName, imageDims: { W, H },
    timestamp: new Date().toISOString(), records, usage,
  }, null, 2));
  console.log(`  -> ${outPath}`);
}
