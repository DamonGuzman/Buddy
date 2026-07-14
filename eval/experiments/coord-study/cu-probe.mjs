/**
 * cu-probe.mjs — computer-use-preview on the coord task via its NATIVE shape:
 * the Responses API computer_use_preview tool. We show the screenshot and ask
 * the model to click the named target; the first computer_call click's (x,y)
 * is the prediction (clicks aim at element centers by design).
 *
 * Usage: node cu-probe.mjs [--model computer-use-preview] [--layouts A] [--real 1] [--limit N]
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
const model = args.model ?? 'computer-use-preview';
const limit = args.limit ? Number(args.limit) : Infinity;
const apiKey = getApiKey();
const spec = JSON.parse(readFileSync(join(ROOT, 'layouts.json'), 'utf8'));
const W = spec.width,
  H = spec.height;

async function clickOnce(imageB64, ask) {
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      tools: [
        {
          type: 'computer_use_preview',
          display_width: W,
          display_height: H,
          environment: 'windows',
        },
      ],
      truncation: 'auto',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                `Click on ${ask}. The screenshot shows the current screen ` +
                `(${W}x${H}). Click exactly on the center of the target.`,
            },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${imageB64}` },
          ],
        },
      ],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message ?? `http ${res.status}`);
  const items = j.output ?? [];
  const call = items.find((it) => it.type === 'computer_call' && it.action?.type === 'click');
  const anyCall = call ?? items.find((it) => it.type === 'computer_call');
  const texts = items
    .filter((it) => it.type === 'message')
    .map((it) => (it.content ?? []).map((c) => c.text ?? '').join(''))
    .join(' ');
  return {
    action: anyCall?.action ?? null,
    text: texts,
    latencyMs: Date.now() - t0,
    usage: j.usage,
  };
}

const jobs = [];
if (args.real !== undefined) {
  const rt = JSON.parse(readFileSync(join(ROOT, 'real-targets.json'), 'utf8'));
  jobs.push({ layoutName: 'real', imageFile: 'real-plain.jpg', targets: rt.targets });
} else {
  for (const layoutName of (args.layouts ?? 'A').split(',')) {
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
  console.log(`[${model} | cu-click | ${layoutName}] ${targets.length} targets`);
  for (const t of targets) {
    const rec = { id: t.id, ask: t.ask, zone: t.zone, gt: { x: t.cx, y: t.cy }, w: t.w, h: t.h };
    try {
      const res = await clickOnce(image, t.ask);
      if (res.action && typeof res.action.x === 'number' && typeof res.action.y === 'number') {
        rec.pred = { x: res.action.x, y: res.action.y };
        rec.rawArgs = res.action;
        rec.errX = res.action.x - t.cx;
        rec.errY = res.action.y - t.cy;
        rec.err = Math.hypot(rec.errX, rec.errY);
        rec.hit = Math.abs(rec.errX) <= t.w / 2 && Math.abs(rec.errY) <= t.h / 2;
      } else {
        rec.refused = true;
        rec.invalidArgs = res.text.slice(0, 300);
      }
      rec.modelText = res.text.slice(0, 300);
      rec.latencyMs = res.latencyMs;
      rec.status = 'completed';
      if (res.usage) usage.push(res.usage);
      console.log(
        `  ${t.id.padEnd(8)} gt(${t.cx},${t.cy}) -> ${rec.pred ? `(${rec.pred.x},${rec.pred.y})` : 'NO-CLICK'} err=${rec.err !== undefined ? Math.round(rec.err) + 'px' : '-'}`,
      );
    } catch (err) {
      rec.error = String(err.message ?? err);
      rec.status = 'failed';
      console.log(`  ${t.id.padEnd(8)} ERROR: ${rec.error}`);
    }
    records.push(rec);
  }
  const outPath = join(ROOT, 'results', `${model}--cu-click--${layoutName}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        model,
        condition: 'cu-click',
        layout: layoutName,
        imageDims: { W, H },
        timestamp: new Date().toISOString(),
        records,
        usage,
      },
      null,
      2,
    ),
  );
  console.log(`  -> ${outPath}`);
}
