#!/usr/bin/env node
/**
 * M8.5 eval harness — spectral verification of PLAYED audio.
 *
 * The mock server speaks a fixed three-note melody (C5 523.25Hz, E5 659.25Hz,
 * G5 783.99Hz — see tools/mock-realtime/audio.js). This script fetches
 * GET /audio/last-output.wav (the panel playback tap's ring buffer of what
 * was ACTUALLY rendered to the output) and verifies via Goertzel bins that
 * all three notes appear at >20dB above the noise floor (off-melody control
 * frequencies), plus reports played (non-silent) duration vs expected.
 *
 * This proves the full loop: model audio -> WS -> main -> IPC -> worklet
 * queue -> samples actually scheduled into the output device.
 *
 * Usage:
 *   node eval/verify-audio.mjs --url http://127.0.0.1:8199 --token <t>
 *   node eval/verify-audio.mjs --file path/to/last-output.wav
 */

import { readFileSync } from 'node:fs';
import { debugApi, parseWav } from './lib.mjs';

/** The mock melody (tools/mock-realtime/audio.js NOTES). */
export const MELODY_FREQS = [523.25, 659.25, 783.99];
/** Non-silent seconds of one melody: 0.42 + 0.42 + 0.56. */
export const MELODY_SECONDS = 1.4;
/** Off-melody controls (avoid harmonics of the notes: 1046.5, 1318.5, 1568). */
const CONTROL_FREQS = [391.99, 440.0, 601.0, 711.0, 907.0];
const WINDOW = 4096;
const HOP = 2048;

/** Goertzel power of `freq` over samples[start..start+n). */
function goertzel(samples, start, n, freq, sampleRate) {
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = (samples[start + i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Analyze played audio: per-frequency max windowed power, dB margins vs the
 * control-frequency noise floor, and non-silent duration.
 */
export function analyzePlayedAudio(samples, sampleRate) {
  const maxPower = new Map();
  for (const f of [...MELODY_FREQS, ...CONTROL_FREQS]) maxPower.set(f, 0);
  for (let start = 0; start + WINDOW <= samples.length; start += HOP) {
    for (const f of [...MELODY_FREQS, ...CONTROL_FREQS]) {
      const p = goertzel(samples, start, WINDOW, f, sampleRate);
      if (p > maxPower.get(f)) maxPower.set(f, p);
    }
  }
  // Noise floor: the LOUDEST control bin (strictest comparison).
  const floor = Math.max(1e-12, ...CONTROL_FREQS.map((f) => maxPower.get(f)));
  const notes = MELODY_FREQS.map((f) => {
    const db = 10 * Math.log10(maxPower.get(f) / floor);
    return { freq: f, marginDb: Math.round(db * 10) / 10, pass: db > 20 };
  });

  // Non-silent duration (rms per 20ms frame > threshold).
  const frame = Math.round(sampleRate * 0.02);
  let nonSilentFrames = 0;
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let i = 0; i < frame; i++) sum += samples[start + i] * samples[start + i];
    if (Math.sqrt(sum / frame) > 0.01) nonSilentFrames += 1;
  }
  const playedSeconds = Math.round(nonSilentFrames * 0.02 * 100) / 100;

  return {
    sampleRate,
    totalSeconds: Math.round((samples.length / sampleRate) * 100) / 100,
    playedSeconds,
    expectedMelodySeconds: MELODY_SECONDS,
    melodiesHeard: Math.round((playedSeconds / MELODY_SECONDS) * 10) / 10,
    notes,
    spectralPass: notes.every((n) => n.pass),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const file = arg('--file');
  const url = arg('--url');
  let buf;
  if (file) {
    buf = readFileSync(file);
  } else if (url) {
    buf = await debugApi(url, arg('--token')).getBinary('/audio/last-output.wav');
  } else {
    console.error(
      'usage: verify-audio.mjs (--file x.wav | --url http://127.0.0.1:8199 [--token t])',
    );
    process.exit(2);
  }
  const { sampleRate, samples } = parseWav(buf);
  const result = analyzePlayedAudio(samples, sampleRate);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.spectralPass ? 0 : 1);
}
