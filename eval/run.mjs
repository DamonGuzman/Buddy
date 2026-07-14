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
  focusWindowOfTree,
  killTree,
  launchApp,
  median,
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
// M9: element snapping is always-on in the app; --no-snap (or CLICKY_NO_SNAP=1
// in the caller's env) launches the app with snapping disabled for A/B
// attribution runs.
const noSnap = has('--no-snap') || process.env.CLICKY_NO_SNAP === '1';
const debugPort = Number(val('--debug-port', '8199'));
const scenes = (val('--scenes', SCENES.join(',')) || '').split(',').filter(Boolean);
// Token resolution (auth is mandatory server-side): explicit env wins; for
// --attach fall back to the running app's <userData>/debug-token.txt; when we
// launch the app ourselves we mint a fresh token and hand it over via env.
const token = process.env.CLICKY_DEBUG_TOKEN || (attach ? readTokenFile() : null) || newToken();

const backend =
  (live ? 'LIVE OPENAI API' : 'MOCK (tools/mock-realtime)') + (noSnap ? ' — SNAP OFF' : '');
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
  return {
    verdict: rectDist <= NEAR_DIP ? 'near' : 'miss',
    errorPx,
    rectDistPx: Math.round(rectDist),
  };
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
    // M9: grounding attribution recorded by the app (absent when snap off).
    snap: cmd.snap ?? null,
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
    // M9: a machine-wide external extension (e.g. Power Automate) pops an
    // "added to Microsoft Edge" bubble over fresh profiles — it overlays the
    // scene toolbar in both screenshots and UIA grounding. Keep it out.
    '--disable-extensions',
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
    extraEnv: noSnap ? { CLICKY_NO_SNAP: '1' } : {},
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
  // The relaunched app restarts turn ids at turn_1: the caller's prevTurnId
  // (read from the PREVIOUS instance) must not be compared against it.
  return null;
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

const results = {
  backend,
  mode: voice ? 'voice' : 'text',
  startedAt: new Date().toISOString(),
  scenes: [],
};

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
      extraEnv: noSnap ? { CLICKY_NO_SNAP: '1' } : {},
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
    // M9: if the user is actively working, the kiosk can open BEHIND their
    // focused window — force it to the foreground before capturing/grounding.
    focusWindowOfTree(kiosk.proc.pid);
    await sleep(500); // let the kiosk finish painting before captures

    const sceneResult = { scene, window: gt.window, targets: [] };
    for (const target of gt.targets) {
      // Match by TURN: pointerHistory is capped (its length stops growing),
      // so wait for a new turnId whose tFirstToolCall fired, then read the
      // pointer it dispatched.
      let prevTurnId = (await api.get('/timings')).last?.turnId ?? null;
      const txCountBefore = (await api.get('/transcript')).length;
      const desc = target.desc ?? target.name;
      process.stdout.write(`  ${target.name}: ask("point at ${desc}") ... `);
      try {
        if (voice) prevTurnId = await askByVoice(scene, target.name, mockUrl);
        else await askByText(desc);
        await waitFor(
          async () => {
            const { last } = await api.get('/timings');
            // M9: gate on tPointerDispatched — the pointer command now goes
            // out AFTER the async element-snap query, so tFirstToolCall can
            // fire several hundred ms before lastPointer is this turn's.
            return last && last.turnId !== prevTurnId && last.tPointerDispatched !== undefined
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
        await waitForIdle(api);
        // M8.5 live eval: keep what was SAID (diagnosable mislabels), the
        // final turn timings and (live) token usage alongside the score.
        const t = (await api.get('/timings')).last ?? {};
        const newEntries =
          (voice
            ? await api.get('/transcript')
            : (await api.get('/transcript')).slice(txCountBefore)) ?? [];
        const userText = newEntries.find((e) => e.role === 'user')?.text ?? null;
        const assistantText =
          newEntries
            .filter((e) => e.role === 'assistant')
            .map((e) => e.text)
            .join(' ') || null;
        const tBase = t.tHoldEnd ?? t.tAsk;
        // M9 snap attribution: what the verdict WOULD have been at the raw
        // model point (recorded by the app pre-snap).
        const rawScore = p.snap ? scorePoint(p.snap.rawPoint, target.rect) : null;
        sceneResult.targets.push({
          name: target.name,
          desc,
          rect: target.rect,
          pointed: p,
          ...score,
          ...(p.snap
            ? {
                snap: {
                  snapped: p.snap.snappedPoint !== null,
                  name: p.snap.snapName,
                  score: p.snap.snapScore,
                  ms: p.snap.snapMs,
                  candidates: p.snap.candidates ?? null,
                  rawPoint: p.snap.rawPoint,
                  rawVerdict: rawScore.verdict,
                  rawErrorPx: rawScore.errorPx,
                },
              }
            : {}),
          userText,
          assistantText,
          latency: {
            askToFirstToolCallMs:
              t.tFirstToolCall !== undefined && tBase !== undefined
                ? t.tFirstToolCall - tBase
                : null,
            askToFirstAudioDeltaMs:
              t.tFirstAudioDelta !== undefined && tBase !== undefined
                ? t.tFirstAudioDelta - tBase
                : null,
            askToDoneMs:
              t.tResponseDone !== undefined && tBase !== undefined ? t.tResponseDone - tBase : null,
          },
          ...(t.usage ? { usage: t.usage } : {}),
        });
        const snapNote = p.snap
          ? p.snap.snappedPoint !== null
            ? `; snap->"${(p.snap.snapName || '').slice(0, 30)}" @${p.snap.snapScore} in ${p.snap.snapMs}ms (raw ${rawScore.verdict})`
            : `; no snap match in ${p.snap.snapMs}ms (raw ${rawScore.verdict})`
          : '';
        console.log(
          `${score.verdict.toUpperCase()} (pointed ${p.x},${p.y}; err ${score.errorPx}px; said "${(p.label || '').slice(0, 60)}"${snapNote})`,
        );
        // Live: spoken audio drains much longer than the response lifecycle —
        // silence it between targets (keeps runs quiet + turns independent).
        await api.post('/playback', { command: 'stop' });
      } catch (err) {
        // Capture what was actually said (e.g. the model answered WITHOUT
        // calling point_at) so no-pointer turns are diagnosable.
        let assistantText = null;
        try {
          const tx = (await api.get('/transcript')).slice(voice ? 0 : txCountBefore);
          assistantText =
            tx
              .filter((e) => e.role === 'assistant')
              .map((e) => e.text)
              .join(' ') || null;
        } catch {
          /* app may be gone */
        }
        sceneResult.targets.push({
          name: target.name,
          desc,
          rect: target.rect,
          verdict: 'error',
          error: String(err),
          assistantText,
        });
        console.log(
          `ERROR: ${err.message ?? err}${assistantText ? ` — said: "${assistantText.slice(0, 100)}"` : ''}`,
        );
        try {
          await api.post('/playback', { command: 'stop' });
        } catch {
          /* ignore */
        }
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
// M9: snap attribution — how the final verdicts relate to the raw model
// point's verdicts on the same turns.
const withSnap = flat.filter((t) => t.snap);
if (withSnap.length > 0) {
  const attribution = {
    targetsWithSnapInfo: withSnap.length,
    snapped: withSnap.filter((t) => t.snap.snapped).length,
    rawCounts: { hit: 0, near: 0, miss: 0 },
    savedBySnap: 0, // raw missed/near, snap made it a hit
    brokenBySnap: 0, // raw hit, snap moved it off the target
    medianSnapMs: median(withSnap.map((t) => t.snap.ms).filter((v) => typeof v === 'number')),
  };
  for (const t of withSnap) {
    attribution.rawCounts[t.snap.rawVerdict] = (attribution.rawCounts[t.snap.rawVerdict] ?? 0) + 1;
    if (t.verdict === 'hit' && t.snap.rawVerdict !== 'hit') attribution.savedBySnap += 1;
    if (t.verdict !== 'hit' && t.snap.rawVerdict === 'hit') attribution.brokenBySnap += 1;
  }
  results.snapAttribution = attribution;
}
results.finishedAt = new Date().toISOString();

const jsonPath = path.join(resultsDir, 'results.json');
writeFileSync(jsonPath, JSON.stringify(results, null, 2));

const md = [
  `# Pointing eval — ${results.startedAt}`,
  '',
  `Backend: **${backend}** — mode: **${results.mode}**`,
  '',
  live
    ? ''
    : '> Mock run: validates plumbing only (mock always points at screen center). Only the calibration target is expected to hit.',
  '',
  '| scene | target | verdict | error px | raw verdict | snap (name @ score, ms) | pointed (global DIP) | target rect |',
  '|---|---|---|---:|---|---|---|---|',
  ...flat.map(
    (t) =>
      `| ${t.scene} | ${t.name} | ${t.verdict} | ${t.errorPx ?? ''} | ${t.snap ? t.snap.rawVerdict : ''} | ${
        t.snap
          ? t.snap.snapped
            ? `"${t.snap.name}" @ ${t.snap.score}, ${t.snap.ms}ms`
            : `no match, ${t.snap.ms}ms`
          : ''
      } | ${t.pointed ? `${t.pointed.x},${t.pointed.y}` : ''} | ${t.rect.x},${t.rect.y} ${t.rect.width}x${t.rect.height} |`,
  ),
  '',
  `**Summary:** ${counts.hit} hit / ${counts.near} near / ${counts.miss} miss / ${counts.error} error (of ${flat.length})`,
  '',
  results.snapAttribution
    ? `**Snap attribution:** ${results.snapAttribution.snapped}/${results.snapAttribution.targetsWithSnapInfo} snapped; raw would have been ${results.snapAttribution.rawCounts.hit} hit / ${results.snapAttribution.rawCounts.near} near / ${results.snapAttribution.rawCounts.miss} miss; snap saved ${results.snapAttribution.savedBySnap}, broke ${results.snapAttribution.brokenBySnap}; median snap ${Math.round(results.snapAttribution.medianSnapMs ?? 0)}ms`
    : '',
  '',
].join('\n');
const mdPath = path.join(resultsDir, 'results.md');
writeFileSync(mdPath, md);

console.log(`\n${md}`);
console.log(`results: ${jsonPath}`);
console.log(banner);
process.exit(counts.error > 0 ? 1 : 0);
