#!/usr/bin/env node
/**
 * M8.5 pointing-accuracy eval runner.
 *
 * For each scene in eval/scenes/: opens it fullscreen in an Edge/Chrome kiosk
 * window, waits for the page to POST its ground-truth rects (global DIP) to
 * the app's debug server, then for every [data-target]:
 *   - TEXT mode (default): POST /ask {"text": "point at the <desc>"}
 *   - VOICE mode (--voice, expensive): relaunch the app with
 *     CLICKY_FAKE_MIC=eval/audio/<scene>--<target>.wav and drive
 *     /hotkey/press + /hotkey/release (real mic path, real audio commit)
 * and scores the resulting pointer command: HIT = mapped global-DIP point
 * inside the target rect, NEAR = within 40 DIP of the rect, MISS otherwise
 * (plus px error from the rect center).
 *
 * !!! MOCK LIMITATION !!!
 * The mock server always points at the CENTER of screen0 regardless of the
 * ask, so a mock run validates PLUMBING (pointer fires, coordinate mapping
 * lands inside the scene window, scoring math) — NOT model accuracy. The
 * dedicated calibration scene has a target covering the display center; the
 * mock MUST score a hit there, proving the pipeline. Run with --live (needs
 * an OpenAI key in settings or OPENAI_API_KEY) for real accuracy numbers.
 *
 * Usage:
 *   node eval/run.mjs                     # mock, text mode, all scenes
 *   node eval/run.mjs --live              # real API (no CLICKY_MOCK_URL)
 *   node eval/run.mjs --voice             # voice turns via fake mic (slow)
 *   node eval/run.mjs --scenes calibration,form
 *   node eval/run.mjs --attach            # use an already-running app on 8199
 *   node eval/run.mjs --debug-port 8299   # avoid another agent's 8199
 */

import { mkdirSync, writeFileSync, existsSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  EVAL_DIR,
  debugApi,
  findChrome,
  findEdge,
  killTree,
  launchApp,
  newToken,
  readTokenFile,
  sleep,
  startMock,
  timestampSlug,
  waitFor,
  waitForIdle,
} from './lib.mjs';

const SCENES = ['calibration', 'app-toolbar', 'form', 'shop', 'tricky'];
const NEAR_DIP = 40;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);

const live = has('--live');
const voice = has('--voice');
const attach = has('--attach');
const debugPort = Number(val('--debug-port', '8199'));
const scenes = (val('--scenes', SCENES.join(',')) || '').split(',').filter(Boolean);
// Token resolution (auth is mandatory server-side): explicit env wins; for
// --attach fall back to the running app's <userData>/debug-token.txt; when we
// launch the app ourselves we mint a fresh token and hand it over via env.
const token = process.env.CLICKY_DEBUG_TOKEN || (attach ? readTokenFile() : null) || newToken();

const backend = live ? 'LIVE OPENAI API' : 'MOCK (tools/mock-realtime)';
const banner = `\n${'='.repeat(72)}\n  POINTING EVAL — backend: ${backend}${live ? '' : '\n  NOTE: the mock points at screen center; this run validates PLUMBING,\n  not model accuracy. Only the calibration target is expected to HIT.'}\n${'='.repeat(72)}\n`;
console.log(banner);

const resultsDir = path.join(EVAL_DIR, 'results', timestampSlug());
mkdirSync(resultsDir, { recursive: true });
const api = debugApi(`http://127.0.0.1:${debugPort}`, token);

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
function scorePoint(p, rect) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const errorPx = Math.round(Math.hypot(p.x - cx, p.y - cy));
  const inside =
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  if (inside) return { verdict: 'hit', errorPx };
  // Distance from the point to the rect (0 when inside).
  const dx = Math.max(rect.x - p.x, 0, p.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - p.y, 0, p.y - (rect.y + rect.height));
  const rectDist = Math.hypot(dx, dy);
  return { verdict: rectDist <= NEAR_DIP ? 'near' : 'miss', errorPx, rectDistPx: Math.round(rectDist) };
}

/** Map the overlay-local pointer command to global DIP via the capture meta. */
function pointerToGlobal(state) {
  const cmd = state.lastPointer;
  if (!cmd || cmd.type !== 'animate' || cmd.points.length === 0) return null;
  const meta = (state.lastCapture ?? []).find((m) => m.screenIndex === cmd.screenIndex);
  if (!meta) return null;
  const p = cmd.points[cmd.points.length - 1];
  return {
    x: meta.displayBounds.x + p.x,
    y: meta.displayBounds.y + p.y,
    screenIndex: cmd.screenIndex,
    label: p.label ?? '',
  };
}

// ---------------------------------------------------------------------------
// Kiosk browser management
// ---------------------------------------------------------------------------
function openKiosk(sceneName) {
  const edge = findEdge();
  const chrome = findChrome();
  const browser = edge ?? chrome;
  if (!browser) throw new Error('neither msedge.exe nor chrome.exe found for kiosk scenes');
  const fileUrl =
    'file:///' +
    path.join(EVAL_DIR, 'scenes', `${sceneName}.html`).replace(/\\/g, '/') +
    `?token=${encodeURIComponent(token)}&port=${debugPort}`;
  const profileDir = path.join(resultsDir, 'kiosk-profile');
  const args = [
    '--kiosk',
    fileUrl,
    ...(edge ? ['--edge-kiosk-type=fullscreen'] : []),
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-session-crashed-bubble',
    '--new-window',
  ];
  const proc = spawn(browser, args, { stdio: 'ignore', detached: false });
  return { proc, kill: () => killTree(proc.pid), browser: path.basename(browser) };
}

// ---------------------------------------------------------------------------
// Turn drivers
// ---------------------------------------------------------------------------
async function askByText(desc) {
  await api.post('/ask', { text: `point at ${desc}` });
}

let appHandle = null; // set when we own the app process
let appLog = null;

async function relaunchAppWithMic(wavPath, mockUrl) {
  if (!appHandle) throw new Error('--voice needs the runner to own the app (drop --attach)');
  appHandle.kill();
  await sleep(1200);
  appHandle = launchApp({
    token,
    mockUrl,
    fakeMicWav: wavPath,
    userDataDir: path.join(resultsDir, 'userdata'),
    debugPort: debugPort === 8199 ? undefined : debugPort,
    logFile: appLog,
  });
  await waitFor(() => api.alive(), { timeoutMs: 30_000, label: 'app restart' });
  await sleep(2500); // renderer prewarm
}

async function askByVoice(scene, targetName, mockUrl) {
  const wav = path.join(EVAL_DIR, 'audio', `${scene}--${targetName}.wav`);
  if (!existsSync(wav)) throw new Error(`missing utterance wav ${wav} — run node eval/tts.mjs`);
  await relaunchAppWithMic(wav, mockUrl);
  await api.post('/hotkey/press');
  await sleep(3500);
  await api.post('/hotkey/release');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let mock = null;
let kiosk = null;
process.on('SIGINT', () => {
  kiosk?.kill();
  appHandle?.kill();
  mock?.close();
  process.exit(130);
});

const results = { backend, mode: voice ? 'voice' : 'text', startedAt: new Date().toISOString(), scenes: [] };

try {
  let mockUrl;
  if (!attach) {
    if (!live) {
      mock = await startMock();
      mockUrl = mock.url;
      console.log(`mock realtime server: ${mockUrl}`);
    }
    appLog = createWriteStream(path.join(resultsDir, 'app.log'));
    appHandle = launchApp({
      token,
      mockUrl,
      userDataDir: path.join(resultsDir, 'userdata'),
      debugPort: debugPort === 8199 ? undefined : debugPort,
      logFile: appLog,
    });
    console.log('waiting for app debug server...');
    await waitFor(() => api.alive(), { timeoutMs: 30_000, label: 'app boot' });
    await sleep(2000); // let overlays + panel renderer settle
  } else if (!(await api.alive())) {
    throw new Error(
      `--attach: no app answering on port ${debugPort} with this token ` +
        '(set CLICKY_DEBUG_TOKEN or make sure <userData>/debug-token.txt is readable)',
    );
  }

  for (const scene of scenes) {
    console.log(`\n--- scene: ${scene} ---`);
    const openedAt = Date.now();
    kiosk = openKiosk(scene);
    console.log(`kiosk (${kiosk.browser}) opening ${scene}.html`);
    const gt = await waitFor(
      async () => {
        const res = await api.get('/eval/ground-truth');
        const report = res.scenes?.[scene];
        return report && report.receivedAt >= openedAt ? report : null;
      },
      { timeoutMs: 25_000, intervalMs: 300, label: `ground truth from ${scene}` },
    );
    console.log(`ground truth: ${gt.targets.length} targets (window ${JSON.stringify(gt.window)})`);
    await sleep(500); // let the kiosk finish painting before captures

    const sceneResult = { scene, window: gt.window, targets: [] };
    for (const target of gt.targets) {
      // Match by TURN: pointerHistory is capped (its length stops growing),
      // so wait for a new turnId whose tFirstToolCall fired, then read the
      // pointer it dispatched.
      const prevTurnId = (await api.get('/timings')).last?.turnId ?? null;
      const desc = target.desc ?? target.name;
      process.stdout.write(`  ${target.name}: ask("point at ${desc}") ... `);
      try {
        if (voice) await askByVoice(scene, target.name, mockUrl);
        else await askByText(desc);
        await waitFor(
          async () => {
            const { last } = await api.get('/timings');
            return last && last.turnId !== prevTurnId && last.tFirstToolCall !== undefined
              ? last
              : null;
          },
          { timeoutMs: 25_000, intervalMs: 150, label: `pointer for ${target.name}` },
        );
        const state = await api.get('/state');
        if (!state.lastPointer) throw new Error('turn finished without a pointer command');
        const p = pointerToGlobal(state);
        if (!p) throw new Error('pointer command had no mappable point');
        const score = scorePoint(p, target.rect);
        sceneResult.targets.push({ name: target.name, desc, rect: target.rect, pointed: p, ...score });
        console.log(`${score.verdict.toUpperCase()} (pointed ${p.x},${p.y}; err ${score.errorPx}px)`);
        await waitForIdle(api);
      } catch (err) {
        sceneResult.targets.push({ name: target.name, desc, rect: target.rect, verdict: 'error', error: String(err) });
        console.log(`ERROR: ${err.message ?? err}`);
      }
    }
    results.scenes.push(sceneResult);
    kiosk.kill();
    kiosk = null;
    await sleep(700);
  }
} finally {
  kiosk?.kill();
  if (!attach) appHandle?.kill();
  await mock?.close();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const flat = results.scenes.flatMap((s) => s.targets.map((t) => ({ scene: s.scene, ...t })));
const counts = { hit: 0, near: 0, miss: 0, error: 0 };
for (const t of flat) counts[t.verdict] = (counts[t.verdict] ?? 0) + 1;
results.summary = counts;
results.finishedAt = new Date().toISOString();

const jsonPath = path.join(resultsDir, 'results.json');
writeFileSync(jsonPath, JSON.stringify(results, null, 2));

const md = [
  `# Pointing eval — ${results.startedAt}`,
  '',
  `Backend: **${backend}** — mode: **${results.mode}**`,
  '',
  live ? '' : '> Mock run: validates plumbing only (mock always points at screen center). Only the calibration target is expected to hit.',
  '',
  '| scene | target | verdict | error px | pointed (global DIP) | target rect |',
  '|---|---|---|---:|---|---|',
  ...flat.map((t) =>
    `| ${t.scene} | ${t.name} | ${t.verdict} | ${t.errorPx ?? ''} | ${t.pointed ? `${t.pointed.x},${t.pointed.y}` : ''} | ${t.rect.x},${t.rect.y} ${t.rect.width}x${t.rect.height} |`,
  ),
  '',
  `**Summary:** ${counts.hit} hit / ${counts.near} near / ${counts.miss} miss / ${counts.error} error (of ${flat.length})`,
  '',
].join('\n');
const mdPath = path.join(resultsDir, 'results.md');
writeFileSync(mdPath, md);

console.log(`\n${md}`);
console.log(`results: ${jsonPath}`);
console.log(banner);
process.exit(counts.error > 0 ? 1 : 0);
