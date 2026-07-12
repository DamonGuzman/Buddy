/**
 * coord-study harness: speaks the OpenAI Realtime WS protocol directly
 * (same GA v1 subset as src/main/realtime/session.ts) to measure the MODEL's
 * raw point_at coordinate estimation against known-exact ground truth.
 *
 * Usage:
 *   node harness.mjs --condition baseline-plain --model gpt-realtime-2.1 \
 *     [--layouts A,B] [--image images/real-plain.jpg --targets real-targets.json]
 *
 * One WS session per condition x layout; each target is its own user turn
 * (framing text + image + "point at the ..."), mirroring production where the
 * screenshot is attached to every ask. Tool output {"ok":true} is returned
 * but NO continue is requested (saves output tokens; next turn supersedes).
 * Results: results/<model>--<condition>--<layout>.json
 */
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime';
const RESPONSE_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// API key: process.env, else HKCU\Environment (never printed/logged).
export function getApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'], {
    encoding: 'utf8',
  });
  const m = out.match(/OPENAI_API_KEY\s+REG_[A-Z_]+\s+(\S+)/);
  if (!m) throw new Error('OPENAI_API_KEY not found in user registry');
  return m[1];
}

// ---------------------------------------------------------------------------
// Tool definitions (copied conventions from src/main/persona.ts POINT_AT_TOOL)
const POINT_AT_PIXELS = {
  type: 'function',
  name: 'point_at',
  description:
    'Fly the on-screen pointer to the thing you are currently talking about. Point at the ' +
    'CENTER of the target element (button, icon, field, ...), not its edge. Coordinates are ' +
    'PIXELS in the screenshot of the given screen index (screen0..N), origin at the top-left ' +
    'of that screenshot.',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'integer', description: 'X of the CENTER of the target, in pixels of the screenshot for `screen`.' },
      y: { type: 'integer', description: 'Y of the CENTER of the target, in pixels of the screenshot for `screen`.' },
      label: { type: 'string', description: 'Short human label of what is at this spot, e.g. "the save button".' },
      screen: { type: 'integer', description: 'Index of the screenshot the coordinates refer to (screen0 = 0, ...).' },
    },
    required: ['x', 'y', 'label', 'screen'],
  },
};

const POINT_AT_NORMALIZED = {
  ...POINT_AT_PIXELS,
  description:
    'Fly the on-screen pointer to the thing you are currently talking about. Point at the ' +
    'CENTER of the target element. Coordinates are NORMALIZED: x and y are integers 0-1000, ' +
    'where (0,0) is the top-left corner and (1000,1000) is the bottom-right corner of the ' +
    'screenshot, regardless of its pixel size.',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'integer', description: 'X of the CENTER of the target, normalized 0-1000 across the screenshot width.' },
      y: { type: 'integer', description: 'Y of the CENTER of the target, normalized 0-1000 down the screenshot height.' },
      label: { type: 'string', description: 'Short human label of what is at this spot.' },
      screen: { type: 'integer', description: 'Index of the screenshot the coordinates refer to (screen0 = 0, ...).' },
    },
    required: ['x', 'y', 'label', 'screen'],
  },
};

const BASE_INSTRUCTIONS =
  'you are a precise ui pointing assistant. the user names an on-screen target; call the ' +
  'point_at tool with its location, aiming for the center of the target. you always have what ' +
  "you need to point: estimate the position by looking at the screenshot. never refuse because " +
  "you 'don't have exact pixel coordinates' — nobody does; your best visual estimate is exactly " +
  'what point_at expects. keep any text reply to one short sentence.';

const THINK_FIRST_INSTRUCTIONS =
  BASE_INSTRUCTIONS +
  ' IMPORTANT: before calling point_at, first output one short sentence stating where the ' +
  'target sits — which quadrant of the screen, what fraction across and down (e.g. "about 1/4 ' +
  'across, 3/4 down"), and any nearby landmark — THEN call point_at with coordinates consistent ' +
  'with that description.';

// ---------------------------------------------------------------------------
// Conditions: framing text builder (+ tool + instructions variants).
// W/H are the true image pixel dims. App conventions from session.ts
// buildImageContent (CONTEXT_PREFIX 'context:').
function plainFraming(W, H) {
  return (
    `context: 1 screenshot attached. screen0 is ${W}x${H} pixels. ` +
    'point_at coordinates must be pixel coordinates within the screenshot, origin at the top-left.'
  );
}

// Verbatim replica of the production anchor framing (session.ts, anchors v2).
function anchorsFraming(W, H) {
  return (
    `context: 1 screenshot(s) attached. screen0 is ${W}x${H} pixels (active screen, the cursor is here). ` +
    `point_at coordinates must be pixel coordinates within the named screenshot. ` +
    `coordinate anchors — screen0: top-left corner (0,0), bottom-right corner (${W},${H}). ` +
    `to point accurately: judge how far across and down the target sits as a fraction ` +
    `of the full screenshot, then multiply by that screenshot's pixel size ` +
    `(e.g. a target 1/3 across and 1/4 down screen0 is at (${Math.round(W / 3)},${Math.round(H / 4)})); ` +
    `commit to the target's actual offset — never default to the middle of the screen.`
  );
}

export const CONDITIONS = {
  'baseline-plain': {
    variant: 'plain',
    tool: POINT_AT_PIXELS,
    instructions: BASE_INSTRUCTIONS,
    framing: plainFraming,
  },
  'baseline-anchors': {
    variant: 'plain',
    tool: POINT_AT_PIXELS,
    instructions: BASE_INSTRUCTIONS,
    framing: anchorsFraming,
  },
  'grid-100': {
    variant: 'grid100',
    tool: POINT_AT_PIXELS,
    instructions: BASE_INSTRUCTIONS,
    framing: (W, H) =>
      plainFraming(W, H) +
      ' a light coordinate grid with 100-pixel spacing is overlaid on the screenshot; the red ' +
      'numbers along the top edge are x coordinates and along the left edge are y coordinates, ' +
      'labeled every 200 pixels. read the target position off the gridlines to get exact coordinates.',
  },
  'ruler-edge': {
    variant: 'ruler',
    tool: POINT_AT_PIXELS,
    instructions: BASE_INSTRUCTIONS,
    framing: (W, H) =>
      plainFraming(W, H) +
      ' ruler tick marks run along all four edges of the screenshot: small ticks every 50 pixels, ' +
      'long ticks with red coordinate numbers every 200 pixels. project the target onto the top/bottom ' +
      'rulers for x and the left/right rulers for y to read off exact coordinates.',
  },
  fiducials: {
    variant: 'fiducials',
    tool: POINT_AT_PIXELS,
    instructions: BASE_INSTRUCTIONS,
    framing: (W, H) =>
      plainFraming(W, H) +
      ' nine red crosshair markers are drawn on the screenshot at known positions, each labeled ' +
      'with its exact (x,y) pixel coordinates. locate the markers nearest the target and interpolate ' +
      "from their labeled coordinates to get the target's exact position.",
  },
  normalized: {
    variant: 'plain',
    tool: POINT_AT_NORMALIZED,
    instructions: BASE_INSTRUCTIONS,
    framing: (W, H) =>
      `context: 1 screenshot attached. screen0 is ${W}x${H} pixels. ` +
      'point_at takes NORMALIZED coordinates: x and y are integers 0-1000, where (0,0) is the ' +
      'top-left corner and (1000,1000) is the bottom-right corner of the screenshot.',
  },
  'think-first': {
    variant: 'plain',
    tool: POINT_AT_PIXELS,
    instructions: THINK_FIRST_INSTRUCTIONS,
    framing: plainFraming,
  },
};

// ---------------------------------------------------------------------------
// Minimal realtime WS session for text-in/text-out tool-call turns.
class StudySession {
  constructor({ model, instructions, tool, apiKey }) {
    this.model = model;
    this.instructions = instructions;
    this.tool = tool;
    this.apiKey = apiKey;
    this.ws = null;
    this.pending = null; // resolver bundle for the in-flight turn
    this.usage = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${REALTIME_BASE_URL}?model=${encodeURIComponent(this.model)}`;
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
      this.ws = ws;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; ws.terminate(); reject(new Error('handshake timeout')); }
      }, 15_000);
      ws.on('message', (data) => {
        let evt;
        try { evt = JSON.parse(data.toString('utf8')); } catch { return; }
        if (!settled && evt.type === 'session.created') {
          settled = true;
          clearTimeout(timeout);
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'realtime',
              instructions: this.instructions,
              output_modalities: ['text'],
              tools: [this.tool],
            },
          }));
          resolve();
          return;
        }
        this.onEvent(evt);
      });
      ws.on('error', (err) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(err); }
        else this.pending?.fail(err);
      });
      ws.on('close', () => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error('closed during handshake')); }
        else this.pending?.fail(new Error('connection closed mid-turn'));
      });
    });
  }

  onEvent(evt) {
    const p = this.pending;
    switch (evt.type) {
      case 'response.output_text.delta':
        if (p) p.text += evt.delta;
        break;
      case 'response.output_audio_transcript.delta':
        if (p) p.text += evt.delta;
        break;
      case 'response.function_call_arguments.done': {
        if (!p) break;
        p.toolCalls.push({ callId: evt.call_id, name: evt.name, rawArgs: evt.arguments, tMs: Date.now() - p.t0 });
        // ack the tool call so the item isn't dangling; do NOT request a continue
        this.ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify({ ok: true }) },
        }));
        break;
      }
      case 'response.done': {
        if (!p) break;
        const status = evt.response?.status ?? 'completed';
        if (evt.response?.usage) this.usage.push(evt.response.usage);
        p.done({ status, usage: evt.response?.usage });
        break;
      }
      case 'error': {
        const msg = evt.error?.message ?? 'unknown server error';
        console.error(`  [server error] ${msg}`);
        if (p && !/response.cancel/i.test(msg)) p.fail(new Error(msg));
        break;
      }
      default:
        break;
    }
  }

  /** One target turn: framing + image + ask -> wait response.done. */
  ask({ framingText, imageBase64, askText }) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timeout = setTimeout(() => {
        this.pending = null;
        // cancel the stuck response server-side, otherwise every subsequent
        // response.create in this session is rejected with
        // "conversation already has an active response"
        try { this.ws.send(JSON.stringify({ type: 'response.cancel' })); } catch { /* dead ws */ }
        reject(new Error(`response timeout after ${RESPONSE_TIMEOUT_MS}ms`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending = {
        t0,
        text: '',
        toolCalls: [],
        done: (info) => {
          clearTimeout(timeout);
          const out = { text: this.pending.text, toolCalls: this.pending.toolCalls, totalMs: Date.now() - t0, ...info };
          this.pending = null;
          resolve(out);
        },
        fail: (err) => {
          clearTimeout(timeout);
          this.pending = null;
          reject(err);
        },
      };
      const content = [
        { type: 'input_text', text: framingText },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${imageBase64}` },
        { type: 'input_text', text: askText },
      ];
      this.ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content },
      }));
      this.ws.send(JSON.stringify({ type: 'response.create' }));
    });
  }

  close() {
    try { this.ws?.close(1000, 'done'); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Runner
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] ?? '';
  }
  return args;
}

export async function runCondition({ model, conditionName, layoutName, image, targets, W, H, outPath }) {
  const cond = CONDITIONS[conditionName];
  if (!cond) throw new Error(`unknown condition ${conditionName}`);
  const apiKey = getApiKey();
  const session = new StudySession({ model, instructions: cond.instructions, tool: cond.tool, apiKey });
  await session.connect();
  console.log(`[${model} | ${conditionName} | ${layoutName}] session up, ${targets.length} targets`);
  const framingText = cond.framing(W, H);
  const records = [];
  for (const t of targets) {
    const askText = `point at ${t.ask}.`;
    let rec = { id: t.id, ask: t.ask, zone: t.zone, gt: { x: t.cx, y: t.cy }, w: t.w, h: t.h };
    try {
      const res = await session.ask({ framingText, imageBase64: image, askText });
      const call = res.toolCalls[0] ?? null;
      if (call) {
        let parsed = null;
        try { parsed = JSON.parse(call.rawArgs); } catch { /* keep null */ }
        if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          let px = parsed.x;
          let py = parsed.y;
          if (conditionName === 'normalized') {
            px = (parsed.x / 1000) * W;
            py = (parsed.y / 1000) * H;
          }
          rec.pred = { x: px, y: py };
          rec.rawArgs = parsed;
          rec.errX = px - t.cx;
          rec.errY = py - t.cy;
          rec.err = Math.hypot(px - t.cx, py - t.cy);
          rec.hit = Math.abs(rec.errX) <= t.w / 2 && Math.abs(rec.errY) <= t.h / 2;
        } else {
          rec.invalidArgs = call.rawArgs;
        }
        rec.latencyMs = call.tMs;
        rec.extraCalls = res.toolCalls.length - 1;
      } else {
        rec.refused = true;
      }
      rec.modelText = res.text;
      rec.status = res.status;
      rec.totalMs = res.totalMs;
      const errStr = rec.err !== undefined ? `${Math.round(rec.err)}px` : (rec.refused ? 'REFUSED' : 'INVALID');
      console.log(`  ${t.id.padEnd(8)} gt(${t.cx},${t.cy}) -> ${rec.pred ? `(${Math.round(rec.pred.x)},${Math.round(rec.pred.y)})` : '-'} err=${errStr}`);
    } catch (err) {
      rec.error = String(err.message ?? err);
      console.log(`  ${t.id.padEnd(8)} ERROR: ${rec.error}`);
    }
    records.push(rec);
  }
  session.close();
  const out = {
    model,
    condition: conditionName,
    layout: layoutName,
    imageDims: { W, H },
    timestamp: new Date().toISOString(),
    records,
    usage: session.usage,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`  -> ${outPath}`);
  return out;
}

// CLI entry
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/').replace(/^([a-z]):/i, (m) => m.toUpperCase()) || process.argv[1]?.endsWith('harness.mjs');
if (isMain) {
  const args = parseArgs(process.argv);
  const model = args.model ?? 'gpt-realtime-2.1';
  const conditionName = args.condition;
  if (!conditionName) { console.error('need --condition'); process.exit(1); }
  const spec = JSON.parse(readFileSync(join(ROOT, 'layouts.json'), 'utf8'));
  const cond = CONDITIONS[conditionName];

  const limit = args.limit ? Number(args.limit) : Infinity;
  const cap = (arr) => arr.slice(0, limit);

  if (args.image && args.targets) {
    // real-screenshot mode: explicit image + targets file
    const targets = JSON.parse(readFileSync(join(ROOT, args.targets), 'utf8'));
    const image = readFileSync(join(ROOT, args.image)).toString('base64');
    const outPath = join(ROOT, 'results', `${model}--${conditionName}--real.json`);
    await runCondition({ model, conditionName, layoutName: 'real', image, targets: cap(targets.targets), W: targets.width, H: targets.height, outPath });
  } else {
    const layouts = (args.layouts ?? 'A,B').split(',');
    for (const layoutName of layouts) {
      const image = readFileSync(join(ROOT, 'images', `${layoutName}-${cond.variant}.jpg`)).toString('base64');
      const outPath = join(ROOT, 'results', `${model}--${conditionName}--${layoutName}.json`);
      await runCondition({
        model, conditionName, layoutName, image,
        targets: cap(spec.layouts[layoutName].targets),
        W: spec.width, H: spec.height, outPath,
      });
    }
  }
}
