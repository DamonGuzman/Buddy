#!/usr/bin/env node
/**
 * M8.5 voice round-trip eval: proves real audio flows IN through the actual
 * getUserMedia path (Chromium fake-mic device fed a TTS WAV) and OUT through
 * the playback worklet (playback tap), with per-turn latency numbers.
 *
 * Phases (all against the mock by default; --live once a key exists):
 *   A. VOICE ROUND-TRIP x5 — /hotkey/press, hold 3.5s, /hotkey/release;
 *      collect /timings + /audio/output-stats + spectral verify of
 *      /audio/last-output.wav after each turn.
 *   B. BARGE-IN x3 — /ask a spoken response, /hotkey/press mid-speech,
 *      measure cancel -> playback-actually-stopped (bargeInStopMs).
 *   C. TEXT TURN x3 — /ask latency profile.
 *   D. SHORT-HOLD — 100ms hold must produce NO turn.
 *   E. SILENCE — relaunch with silence.wav; a 3.5s silent hold must commit
 *      gracefully (mock replies) instead of erroring.
 *
 * Usage: node eval/voice-roundtrip.mjs [--live] [--debug-port N]
 */

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  EVAL_DIR,
  debugApi,
  fmtMs,
  launchApp,
  median,
  newToken,
  parseWav,
  sleep,
  startMock,
  timestampSlug,
  waitFor,
  waitForIdle,
} from './lib.mjs';
import { analyzePlayedAudio } from './verify-audio.mjs';

const argv = process.argv.slice(2);
const live = argv.includes('--live');
const debugPort = Number(argv.includes('--debug-port') ? argv[argv.indexOf('--debug-port') + 1] : '8199');

const backend = live ? 'LIVE OPENAI API' : 'MOCK (tools/mock-realtime)';
console.log(`\n=== VOICE ROUND-TRIP EVAL — backend: ${backend} ===\n`);

const token = newToken();
const resultsDir = path.join(EVAL_DIR, 'results', `${timestampSlug()}-voice`);
mkdirSync(resultsDir, { recursive: true });
const api = debugApi(`http://127.0.0.1:${debugPort}`, token);
const appLog = createWriteStream(path.join(resultsDir, 'app.log'));

const utteranceWav = path.join(EVAL_DIR, 'audio', 'ask-point-save.wav');
const silenceWav = path.join(EVAL_DIR, 'audio', 'silence.wav');
for (const wav of [utteranceWav, silenceWav]) {
  if (!existsSync(wav)) {
    console.error(`missing ${wav} — run: node eval/tts.mjs`);
    process.exit(2);
  }
}

let mock = null;
let app = null;
const cleanup = () => {
  app?.kill();
  void mock?.close();
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

async function bootApp(fakeMicWav) {
  if (app) {
    app.kill();
    await sleep(1500);
  }
  app = launchApp({
    token,
    mockUrl: mock?.url,
    fakeMicWav,
    userDataDir: path.join(resultsDir, 'userdata'),
    debugPort: debugPort === 8199 ? undefined : debugPort,
    logFile: appLog,
  });
  await waitFor(() => api.alive(), { timeoutMs: 30_000, label: 'app boot' });
  await sleep(2500); // overlay + panel renderer + mic prewarm settle
}

/** Latest committed-audio seconds parsed from the mock's ASR transcript. */
async function committedAudioSeconds() {
  const transcript = await api.get('/transcript');
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = /mock transcript of (\d+) audio bytes/.exec(transcript[i].text ?? '');
    if (transcript[i].role === 'user' && m) return Number(m[1]) / 48_000; // 24kHz * 2 bytes
  }
  return null;
}

/** Live mode: the latest REAL ASR transcript of the user's audio (or null). */
async function latestUserTranscript() {
  const transcript = await api.get('/transcript');
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role === 'user' && e.text && e.text !== '…' && e.text !== '(voice message)') return e.text;
  }
  return null;
}

/** Wait until a NEW turn (id != prevId) reaches tResponseDone. */
async function waitTurnDone(prevTurnId, { needAudioPlayed = true, timeoutMs = 25_000 } = {}) {
  return waitFor(
    async () => {
      const { last } = await api.get('/timings');
      if (!last || last.turnId === prevTurnId || last.tResponseDone === undefined) return null;
      if (needAudioPlayed && last.tFirstAudioPlayed === undefined) return null;
      return last;
    },
    { timeoutMs, intervalMs: 150, label: 'turn completion' },
  );
}

/** Wait for the playback tap to report the latest item finished, then stats. */
async function waitPlaybackFinished(timeoutMs = 20_000) {
  return waitFor(
    async () => {
      const { items } = await api.get('/audio/output-stats');
      const latest = items[items.length - 1];
      return latest && latest.done && latest.samplesPlayed > 0 ? latest : null;
    },
    { timeoutMs, intervalMs: 200, label: 'playback finished' },
  );
}

async function fetchAndVerifyOutput() {
  const buf = await waitFor(
    async () => {
      try {
        return await api.getBinary('/audio/last-output.wav');
      } catch {
        return null;
      }
    },
    { timeoutMs: 10_000, intervalMs: 300, label: 'output ring' },
  );
  const { sampleRate, samples } = parseWav(buf);
  return { buf, analysis: analyzePlayedAudio(samples, sampleRate) };
}

const results = {
  backend,
  startedAt: new Date().toISOString(),
  voiceTurns: [],
  bargeIns: [],
  textTurns: [],
  shortHold: null,
  silenceHold: null,
};

try {
  if (!live) {
    mock = await startMock();
    console.log(`mock realtime server: ${mock.url}`);
  }
  await bootApp(utteranceWav);
  console.log(`app up (debug ${api.base}, fake mic: ${path.basename(utteranceWav)})\n`);

  // -------------------------------------------------------------------------
  // A. VOICE ROUND-TRIP x5
  // -------------------------------------------------------------------------
  console.log('--- phase A: voice round-trip x5 (hold 3.5s) ---');
  for (let i = 1; i <= 5; i++) {
    let prev = (await api.get('/timings')).last?.turnId ?? null;
    await api.post('/hotkey/press');
    await sleep(3500);
    await api.post('/hotkey/release');
    let t;
    try {
      t = await waitTurnDone(prev);
    } catch {
      // M9: a hold whose mic spun up too late carries <200ms of appended
      // audio and is CANCELLED by design (no commit — the live API would
      // reject it and used to wedge; docs/EVAL.md §8.3/§9.5). No turn record
      // appears in that case, so retry the turn once.
      console.log(`  turn ${i}: no turn (guarded cancel) — retrying once`);
      prev = (await api.get('/timings')).last?.turnId ?? null;
      await api.post('/hotkey/press');
      await sleep(3500);
      await api.post('/hotkey/release');
      t = await waitTurnDone(prev);
    }
    // Live speech can drain for tens of seconds after response.done.
    await waitPlaybackFinished(live ? 90_000 : 20_000);
    const { analysis } = await fetchAndVerifyOutput();
    const stats = (await api.get('/audio/output-stats')).items.at(-1);
    const committedSec = await committedAudioSeconds();
    const row = {
      turnId: t.turnId,
      chunksIn: t.chunksIn,
      chunksOut: t.chunksOut,
      committedAudioSec: committedSec,
      userTranscript: live ? await latestUserTranscript() : null,
      captureMs: t.captureMs ?? null,
      releaseToCommitMs: t.tCommitSent - t.tHoldEnd,
      releaseToFirstUserTranscriptMs:
        t.tFirstUserTranscript !== undefined ? t.tFirstUserTranscript - t.tHoldEnd : null,
      releaseToFirstAudioDeltaMs: t.tFirstAudioDelta - t.tHoldEnd,
      firstDeltaToFirstPlayedMs: t.tFirstAudioPlayed - t.tFirstAudioDelta,
      releaseToFirstTranscriptMs:
        t.tFirstAssistantTranscript !== undefined ? t.tFirstAssistantTranscript - t.tHoldEnd : null,
      releaseToFirstToolCallMs:
        t.tFirstToolCall !== undefined ? t.tFirstToolCall - t.tHoldEnd : null,
      releaseToDoneMs: t.tResponseDone - t.tHoldEnd,
      ...(t.usage ? { usage: t.usage } : {}),
      playback: { rms: stats.rms, peak: stats.peak, underruns: stats.underruns, samplesPlayed: stats.samplesPlayed },
      spectral: { pass: analysis.spectralPass, notes: analysis.notes, playedSeconds: analysis.playedSeconds },
    };
    results.voiceTurns.push(row);
    console.log(
      `  turn ${i}: in=${row.chunksIn}ch (${committedSec?.toFixed(2)}s committed) capture=${fmtMs(row.captureMs)} ` +
        `rel->delta=${fmtMs(row.releaseToFirstAudioDeltaMs)} delta->played=${fmtMs(row.firstDeltaToFirstPlayedMs)} ` +
        `rms=${stats.rms.toFixed(3)} underruns=${stats.underruns} spectral=${analysis.spectralPass ? 'PASS' : 'FAIL'}`,
    );
    await waitForIdle(api);
    await sleep(800); // let the ring's post-item silence detector settle
  }
  // Keep the final ring as evidence.
  const finalOutput = await fetchAndVerifyOutput();
  writeFileSync(path.join(resultsDir, 'last-output.wav'), finalOutput.buf);
  writeFileSync(path.join(resultsDir, 'last-output.analysis.json'), JSON.stringify(finalOutput.analysis, null, 2));

  // -------------------------------------------------------------------------
  // B. BARGE-IN x3
  // -------------------------------------------------------------------------
  console.log('\n--- phase B: barge-in x3 ---');
  for (let i = 1; i <= 3; i++) {
    const statsBefore = (await api.get('/audio/output-stats')).items.map((s) => s.itemId);
    const prev = (await api.get('/timings')).last?.turnId ?? null;
    await api.post('/ask', { text: 'point at the demo button please' });
    // Wait until NEW audio is actually playing (first tap block arrives fast).
    await waitFor(
      async () => {
        const { items } = await api.get('/audio/output-stats');
        return items.some((s) => !statsBefore.includes(s.itemId) && s.samplesPlayed > 0 && !s.done);
      },
      { timeoutMs: 15_000, intervalMs: 80, label: 'audio playing' },
    );
    await api.post('/hotkey/press'); // BARGE-IN (cancels + stops playback)
    const timed = await waitFor(
      async () => {
        const { history } = await api.get('/timings');
        const turn = history.find((h) => h.turnId !== prev && h.kind === 'text' && h.bargeInStopMs !== undefined);
        return turn ?? null;
      },
      { timeoutMs: 10_000, intervalMs: 80, label: 'bargeInStopMs' },
    );
    await sleep(120);
    await api.post('/hotkey/release'); // short hold -> discarded, no new turn
    results.bargeIns.push({ turnId: timed.turnId, bargeInStopMs: timed.bargeInStopMs });
    console.log(`  barge-in ${i}: stop in ${timed.bargeInStopMs}ms`);
    await waitForIdle(api);
    await sleep(500);
  }

  // -------------------------------------------------------------------------
  // C. TEXT TURN x3
  // -------------------------------------------------------------------------
  console.log('\n--- phase C: text turn x3 ---');
  for (let i = 1; i <= 3; i++) {
    const prev = (await api.get('/timings')).last?.turnId ?? null;
    await api.post('/ask', { text: 'hello there friend' });
    const t = await waitTurnDone(prev);
    const row = {
      turnId: t.turnId,
      captureMs: t.captureMs ?? null,
      askToCommitMs: t.tCommitSent - t.tAsk,
      askToFirstTranscriptMs:
        t.tFirstAssistantTranscript !== undefined ? t.tFirstAssistantTranscript - t.tAsk : null,
      askToFirstAudioDeltaMs: t.tFirstAudioDelta - t.tAsk,
      firstDeltaToFirstPlayedMs: t.tFirstAudioPlayed - t.tFirstAudioDelta,
      askToDoneMs: t.tResponseDone - t.tAsk,
    };
    results.textTurns.push(row);
    console.log(
      `  text ${i}: capture=${fmtMs(row.captureMs)} ask->delta=${fmtMs(row.askToFirstAudioDeltaMs)} ` +
        `delta->played=${fmtMs(row.firstDeltaToFirstPlayedMs)} ask->done=${fmtMs(row.askToDoneMs)}`,
    );
    await waitForIdle(api);
    await sleep(800);
  }

  // -------------------------------------------------------------------------
  // D. SHORT-HOLD (100ms) -> no turn
  // -------------------------------------------------------------------------
  console.log('\n--- phase D: short hold (100ms) ---');
  {
    const before = (await api.get('/timings')).history.length;
    await api.post('/hotkey/press');
    await sleep(100);
    await api.post('/hotkey/release');
    await sleep(1200);
    const after = await api.get('/timings');
    const state = await api.get('/state');
    results.shortHold = {
      turnCreated: after.history.length > before,
      assistantState: state.assistantState,
      pass: after.history.length === before && state.assistantState === 'idle',
    };
    console.log(`  no turn created: ${!results.shortHold.turnCreated}, state: ${state.assistantState}`);
  }

  // -------------------------------------------------------------------------
  // E. SILENCE hold (3.5s of digital silence) -> graceful commit, mock replies
  // -------------------------------------------------------------------------
  console.log('\n--- phase E: silent hold (silence.wav) ---');
  {
    await bootApp(silenceWav);
    const prev = (await api.get('/timings')).last?.turnId ?? null;
    await api.post('/hotkey/press');
    await sleep(3500);
    await api.post('/hotkey/release');
    const t = await waitTurnDone(prev, { needAudioPlayed: true });
    const state = await api.get('/state');
    results.silenceHold = {
      turnId: t.turnId,
      chunksIn: t.chunksIn,
      committedAudioSec: await committedAudioSeconds(),
      responseDone: t.tResponseDone !== undefined,
      assistantStateAfter: state.assistantState,
      pass: t.tResponseDone !== undefined && state.assistantState !== 'error',
    };
    console.log(
      `  committed ${results.silenceHold.committedAudioSec?.toFixed(2)}s of silence, ` +
        `mock replied: ${results.silenceHold.responseDone}`,
    );
  }
} finally {
  cleanup();
}

// ---------------------------------------------------------------------------
// Medians + report
// ---------------------------------------------------------------------------
const v = results.voiceTurns;
results.medians = {
  captureMs: median(v.map((t) => t.captureMs).filter((x) => x !== null)),
  releaseToCommitMs: median(v.map((t) => t.releaseToCommitMs)),
  releaseToFirstUserTranscriptMs: median(
    v.map((t) => t.releaseToFirstUserTranscriptMs).filter((x) => x !== null),
  ),
  releaseToFirstToolCallMs: median(v.map((t) => t.releaseToFirstToolCallMs).filter((x) => x !== null)),
  releaseToFirstAudioDeltaMs: median(v.map((t) => t.releaseToFirstAudioDeltaMs)),
  firstDeltaToFirstPlayedMs: median(v.map((t) => t.firstDeltaToFirstPlayedMs)),
  releaseToDoneMs: median(v.map((t) => t.releaseToDoneMs)),
  bargeInStopMs: median(results.bargeIns.map((b) => b.bargeInStopMs)),
  textAskToFirstAudioDeltaMs: median(results.textTurns.map((t) => t.askToFirstAudioDeltaMs)),
  textFirstDeltaToFirstPlayedMs: median(results.textTurns.map((t) => t.firstDeltaToFirstPlayedMs)),
};
results.gates = {
  // Mock: committed seconds parsed from the mock's ASR line. Live: the mock
  // line does not exist — audio IN is proven by a real, non-empty ASR
  // transcript of the spoken WAV instead.
  audioIn: live
    ? v.every((t) => t.chunksIn > 0 && (t.userTranscript ?? '').length > 0)
    : v.every((t) => t.chunksIn > 0 && (t.committedAudioSec ?? 0) > 2.5),
  audioOutRms: v.every((t) => t.playback.rms > 0.05),
  underruns: v.every((t) => t.playback.underruns === 0),
  // The spectral melody check is mock-only (live output is speech, not the
  // mock's three-note melody): in live mode require audible played speech.
  spectral: live ? v.every((t) => t.spectral.playedSeconds > 0.5) : v.every((t) => t.spectral.pass),
  ...(live ? { spectralNote: 'live: playedSeconds > 0.5 (speech), melody check is mock-only' } : {}),
  bargeInUnder300: results.bargeIns.every((b) => b.bargeInStopMs < 300),
  shortHold: results.shortHold?.pass ?? false,
  silenceHold: results.silenceHold?.pass ?? false,
};
results.finishedAt = new Date().toISOString();

const outPath = path.join(resultsDir, 'voice-roundtrip.json');
writeFileSync(outPath, JSON.stringify(results, null, 2));

console.log(`\n=== RESULTS (${backend}) ===`);
console.log('medians:', JSON.stringify(results.medians, null, 2));
console.log('gates:', JSON.stringify(results.gates, null, 2));
console.log(`written: ${outPath}`);
const allPass = Object.values(results.gates).every(Boolean);
console.log(allPass ? '\nALL GATES PASS' : '\nSOME GATES FAILED');
process.exit(allPass ? 0 : 1);
