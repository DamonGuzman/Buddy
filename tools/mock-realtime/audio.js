/**
 * PCM16 tone synthesis for the mock Realtime server: a pleasant short melody
 * (three rising sine notes, ~1.5s) so end-to-end playback is audible and
 * testable. 24kHz mono, 16-bit little-endian — exactly the session format.
 */
'use strict';

const SAMPLE_RATE = 24000;

/** C5 -> E5 -> G5, gentle attack/release so there are no clicks. */
const NOTES = [
  { freq: 523.25, seconds: 0.42 },
  { freq: 659.25, seconds: 0.42 },
  { freq: 783.99, seconds: 0.56 },
];
const GAP_SECONDS = 0.045;
const FADE_SECONDS = 0.015;

/**
 * @param {{ amplitude?: number }} [options] amplitude 0..1 (default 0.25 — moderate volume)
 * @returns {Buffer} PCM16LE mono @ 24kHz
 */
function synthesizeMelodyPcm16(options = {}) {
  const amplitude = options.amplitude ?? 0.25;
  const gapSamples = Math.round(GAP_SECONDS * SAMPLE_RATE);
  const fadeSamples = Math.round(FADE_SECONDS * SAMPLE_RATE);

  const segments = [];
  for (let i = 0; i < NOTES.length; i++) {
    const { freq, seconds } = NOTES[i];
    const n = Math.round(seconds * SAMPLE_RATE);
    const seg = new Int16Array(n);
    for (let s = 0; s < n; s++) {
      let env = 1;
      if (s < fadeSamples) env = s / fadeSamples;
      else if (s >= n - fadeSamples) env = (n - 1 - s) / fadeSamples;
      const value = Math.sin((2 * Math.PI * freq * s) / SAMPLE_RATE) * amplitude * env;
      seg[s] = Math.round(value * 32767);
    }
    segments.push(seg);
    if (i < NOTES.length - 1) segments.push(new Int16Array(gapSamples));
  }

  const totalSamples = segments.reduce((sum, seg) => sum + seg.length, 0);
  const out = Buffer.alloc(totalSamples * 2);
  let offset = 0;
  for (const seg of segments) {
    for (let s = 0; s < seg.length; s++) {
      out.writeInt16LE(seg[s], offset);
      offset += 2;
    }
  }
  return out;
}

module.exports = { synthesizeMelodyPcm16, SAMPLE_RATE };
