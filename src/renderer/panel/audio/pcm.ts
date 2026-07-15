/**
 * Pure PCM16 (24kHz mono) helpers shared by the panel audio engines.
 *
 * The worklets (`../worklets/*.worklet.js`) keep local copies of these
 * constants/formulas — they load standalone via `audioWorklet.addModule`
 * and cannot import modules.
 */

/** Audio wire format: PCM16 mono @ 24kHz (docs/ARCHITECTURE.md §3). */
export const SAMPLE_RATE = 24_000;

/** Capture/dev-tone chunk size: 60ms @ 24kHz = 1440 samples = 2880 bytes. */
export const CHUNK_SAMPLES = 1_440;

/** Decode Int16 PCM LE bytes to Float32 samples in [-1, 1). */
export function int16ToFloat32(pcm: ArrayBuffer): Float32Array<ArrayBuffer> {
  const ints = new Int16Array(pcm);
  const floats = new Float32Array(ints.length);
  for (let i = 0; i < ints.length; i++) floats[i] = (ints[i] ?? 0) / 32768;
  return floats;
}

/** Re-encode Float32 samples as Int16 PCM, clamping out-of-range samples. */
export function float32ToInt16Clamped(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round((samples[i] ?? 0) * 32768)));
  }
  return out;
}

/** RMS (0..1) of an Int16 PCM chunk. */
export function rmsOfInt16(buf: ArrayBuffer): number {
  const samples = new Int16Array(buf);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = (samples[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}
