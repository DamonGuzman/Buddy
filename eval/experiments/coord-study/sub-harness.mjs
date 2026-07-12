/**
 * sub-harness.mjs — coordinate-grounding eval via the ChatGPT Codex
 * SUBSCRIPTION pool (NOT the paid API key, which is out of credit).
 *
 * Speaks the Codex `responses` endpoint at chatgpt.com with the CLI's own
 * bearer + account-id, SSE streamed. Same plain images + strict-JSON coords
 * as rest-sanity.mjs, so results are directly comparable.
 *
 * Auth: %USERPROFILE%\.codex\auth.json { tokens: { access_token, account_id } }.
 * The token is read fresh and NEVER printed, logged, or written to results.
 *
 * Usage:
 *   node sub-harness.mjs --model gpt-5.6-luna [--effort low] [--layouts A,B]
 *   node sub-harness.mjs --model gpt-5.6-sol --real 1 [--only clock,openin]
 *   node sub-harness.mjs --probe            # single luna call, shape discovery
 *
 * Results: results/<model>--sub-plain-<effort>--<layout>.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const OAUTH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALL_TIMEOUT_MS = 60_000;

// --- auth: read fresh, refresh only if exp < 5 min. Token stays in-process. ---
function authPath() {
  return join(homedir(), '.codex', 'auth.json');
}
function decodeJwtExp(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = p.length % 4;
    const b64 = p + (pad === 2 ? '==' : pad === 3 ? '=' : '');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).exp ?? 0;
  } catch { return 0; }
}
async function loadAuth() {
  const raw = JSON.parse(readFileSync(authPath(), 'utf8'));
  let { access_token, refresh_token, account_id } = raw.tokens ?? {};
  if (!access_token || !account_id) throw new Error('auth.json missing access_token/account_id');
  const exp = decodeJwtExp(access_token);
  const secsLeft = exp - Math.floor(Date.now() / 1000);
  if (secsLeft < 300) {
    // refresh (form-encoded) and write rotated token back
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: CLIENT_ID,
      scope: 'openid profile email offline_access',
    });
    const r = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error(`token refresh failed: ${r.status}`);
    const j = await r.json();
    access_token = j.access_token ?? access_token;
    refresh_token = j.refresh_token ?? refresh_token;
    raw.tokens.access_token = access_token;
    raw.tokens.refresh_token = refresh_token;
    raw.last_refresh = new Date().toISOString();
    writeFileSync(authPath(), JSON.stringify(raw, null, 2));
    console.log('  [auth] token refreshed');
  }
  return { access_token, account_id };
}

function headers(auth) {
  return {
    Authorization: `Bearer ${auth.access_token}`,
    'ChatGPT-Account-Id': auth.account_id,
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown',
    'Content-Type': 'application/json',
  };
}

const SYSTEM = (W, H) =>
  'You are a precise UI grounding model. The user names an on-screen target in the attached ' +
  `screenshot (${W}x${H} pixels, origin top-left). Respond with ONLY a JSON object ` +
  '{"x": <int>, "y": <int>, "label": "<short label>"} giving the pixel coordinates of the ' +
  'CENTER of the target. No prose, no code fences.';

// quota headers we care about (plan usage %)
const QUOTA_HEADERS = [
  'x-codex-primary-used-percent',
  'x-codex-secondary-used-percent',
  'x-codex-primary-over-secondary-limit-percent',
  'x-codex-primary-window-minutes',
  'x-codex-secondary-window-minutes',
];

/** One grounding call. Returns { parsed, text, usage, latencyMs, ttfbMs, quota, status }. */
async function pointOnce({ auth, model, effort, imageB64, ask, W, H }) {
  const t0 = Date.now();
  const bodyObj = {
    model,
    instructions: SYSTEM(W, H),
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: `point at ${ask}. Reply with ONLY the JSON object.` },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${imageB64}` },
        ],
      },
    ],
    stream: true,
    store: false,
    reasoning: { effort },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: headers(auth),
      body: JSON.stringify(bodyObj),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`fetch failed: ${err.message}`);
  }
  const quota = {};
  for (const h of QUOTA_HEADERS) { const v = res.headers.get(h); if (v != null) quota[h] = v; }
  if (!res.ok) {
    clearTimeout(timer);
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    const e = new Error(`http ${res.status}: ${detail}`);
    e.status = res.status;
    e.quota = quota;
    throw e;
  }
  // Stream SSE
  let text = '';
  let usage = null;
  let ttfbMs = null;
  let sawCompleted = false;
  const decoder = new TextDecoder();
  let buf = '';
  const handleEvent = (payload) => {
    if (payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; }
    const type = evt.type ?? '';
    if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      if (ttfbMs == null) ttfbMs = Date.now() - t0;
      text += evt.delta;
    } else if (type === 'response.output_item.done' && evt.item?.type === 'message') {
      // fallback: assemble from final item content if deltas were missed
      for (const c of evt.item.content ?? []) {
        if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string' && !text) text += c.text;
      }
    } else if (type === 'response.completed' || type === 'response.done') {
      sawCompleted = true;
      const u = evt.response?.usage;
      if (u) usage = u;
    }
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const rawEvt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of rawEvt.split('\n')) {
          const t = line.trimStart();
          if (t.startsWith('data:')) handleEvent(t.slice(5).trim());
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // parse tolerantly: first {...} with x & y
  let parsed = null;
  const m = text.match(/\{[\s\S]*?\}/);
  const candidate = m ? m[0] : text;
  try { parsed = JSON.parse(candidate); } catch {
    // try to pull x/y with regex as last resort
    const mx = text.match(/"?x"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
    const my = text.match(/"?y"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
    if (mx && my) parsed = { x: Number(mx[1]), y: Number(my[1]) };
  }
  return { parsed, text, usage, latencyMs: Date.now() - t0, ttfbMs, quota, status: sawCompleted ? 'completed' : 'incomplete' };
}

// normalize Responses-API usage → { in, out, reasoning }
function normUsage(u) {
  if (!u) return null;
  const inp = u.input_tokens ?? u.prompt_tokens ?? 0;
  const out = u.output_tokens ?? u.completion_tokens ?? 0;
  const reasoning = u.output_tokens_details?.reasoning_tokens
    ?? u.completion_tokens_details?.reasoning_tokens ?? 0;
  const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return { in: inp, out, reasoning, cached };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      args[k] = v;
    }
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callWithRetry(opts, label) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pointOnce(opts);
    } catch (err) {
      lastErr = err;
      const st = err.status;
      const retryable = st === 429 || st === 401 || st === 403 || st === 500 || st === 502 || st === 503 || /fetch failed|aborted/.test(err.message);
      if (!retryable || attempt === 2) throw err;
      const backoff = 2000 * (attempt + 1);
      console.log(`  ${label} retry ${attempt + 1} after ${st ?? 'net'} (${backoff}ms)`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

async function main() {
  const args = parseArgs(process.argv);
  const spec = JSON.parse(readFileSync(join(ROOT, 'layouts.json'), 'utf8'));
  const W = spec.width, H = spec.height;
  const auth = await loadAuth();

  if (args.probe) {
    const image = readFileSync(join(ROOT, 'images', 'A-plain.jpg')).toString('base64');
    console.log('[probe] gpt-5.6-luna low, target=SAVE (gt 180,96)');
    const r = await pointOnce({ auth, model: 'gpt-5.6-luna', effort: 'low', imageB64: image, ask: 'the SAVE button', W, H });
    console.log('  status:', r.status, '| text:', JSON.stringify(r.text));
    console.log('  parsed:', JSON.stringify(r.parsed));
    console.log('  usage:', JSON.stringify(normUsage(r.usage)), '| latency:', r.latencyMs, 'ttfb:', r.ttfbMs);
    console.log('  quota:', JSON.stringify(r.quota));
    return;
  }

  const model = args.model ?? 'gpt-5.6-luna';
  const effort = args.effort ?? 'low';
  const condition = `sub-plain-${effort}`;
  const onlyIds = args.only ? new Set(args.only.split(',')) : null;

  const jobs = [];
  if (args.real) {
    const rt = JSON.parse(readFileSync(join(ROOT, 'real-targets.json'), 'utf8'));
    jobs.push({ layoutName: 'real', imageFile: 'real-plain.jpg', targets: rt.targets });
  } else {
    for (const layoutName of (args.layouts ?? 'A,B').split(',')) {
      jobs.push({ layoutName, imageFile: `${layoutName}-plain.jpg`, targets: spec.layouts[layoutName].targets });
    }
  }

  let lastQuota = {};
  for (const { layoutName, imageFile, targets: all } of jobs) {
    const image = readFileSync(join(ROOT, 'images', imageFile)).toString('base64');
    let targets = all;
    if (onlyIds) targets = targets.filter((t) => onlyIds.has(t.id));
    const records = [];
    const usage = [];
    console.log(`[${model} | ${condition} | ${layoutName}] ${targets.length} targets`);
    for (const t of targets) {
      const rec = { id: t.id, ask: t.ask, zone: t.zone, kind: t.kind, gt: { x: t.cx, y: t.cy }, w: t.w, h: t.h };
      try {
        const res = await callWithRetry({ auth, model, effort, imageB64: image, ask: t.ask, W, H }, t.id);
        if (res.parsed && typeof res.parsed.x === 'number' && typeof res.parsed.y === 'number') {
          const px = res.parsed.x, py = res.parsed.y;
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
        rec.ttfbMs = res.ttfbMs;
        rec.status = res.status;
        const nu = normUsage(res.usage);
        if (nu) { rec.usage = nu; usage.push(nu); }
        if (Object.keys(res.quota).length) lastQuota = res.quota;
        const errStr = rec.err !== undefined ? `${Math.round(rec.err)}px${rec.hit ? '' : ' MISS'}` : 'INVALID';
        console.log(`  ${t.id.padEnd(9)} w${String(t.w).padStart(3)} gt(${t.cx},${t.cy}) -> ${rec.pred ? `(${rec.pred.x},${rec.pred.y})` : '-'} err=${errStr} ${res.latencyMs}ms r${nu?.reasoning ?? '?'}`);
      } catch (err) {
        rec.error = String(err.message ?? err);
        rec.status = 'failed';
        if (err.quota) lastQuota = err.quota;
        console.log(`  ${t.id.padEnd(9)} ERROR: ${rec.error}`);
        if (err.status === 429 && /quota|limit/i.test(rec.error)) {
          console.log('  !! quota-limited, stopping this job');
          records.push(rec);
          break;
        }
      }
      records.push(rec);
      // gentle pacing to avoid hammering
      await sleep(250);
    }
    const outPath = join(ROOT, 'results', `${model}--${condition}--${layoutName}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({
      model, condition, layout: layoutName, imageDims: { W, H },
      transport: 'codex-subscription', endpoint: ENDPOINT,
      timestamp: new Date().toISOString(), records, usage, quota: lastQuota,
    }, null, 2));
    console.log(`  -> ${outPath}  quota=${JSON.stringify(lastQuota)}`);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exitCode = 1; });
