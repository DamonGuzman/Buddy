/**
 * Pure PCM helpers (src/renderer/panel/audio/pcm.ts): the Int16↔Float32
 * conversions used by playback and the playback-tap ring re-encode, plus the
 * RMS used by capture stats.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNK_SAMPLES,
  SAMPLE_RATE,
  float32ToInt16Clamped,
  int16ToFloat32,
  rmsOfInt16,
} from '../src/renderer/panel/audio/pcm';

describe('pcm constants', () => {
  it('match the pcm16 wire format (24kHz, 60ms chunks)', () => {
    expect(SAMPLE_RATE).toBe(24_000);
    expect(CHUNK_SAMPLES).toBe(1_440); // 60ms @ 24kHz
    expect((CHUNK_SAMPLES / SAMPLE_RATE) * 1000).toBe(60);
  });
});

describe('int16ToFloat32', () => {
  it('scales by 1/32768', () => {
    const pcm = new Int16Array([-32768, -16384, 0, 16384, 32767]);
    const floats = int16ToFloat32(pcm.buffer);
    expect([...floats]).toEqual([-1, -0.5, 0, 0.5, 32767 / 32768]);
  });

  it('handles an empty buffer', () => {
    expect(int16ToFloat32(new ArrayBuffer(0)).length).toBe(0);
  });
});

describe('float32ToInt16Clamped', () => {
  it('scales by 32768 and rounds', () => {
    const out = float32ToInt16Clamped(new Float32Array([-1, -0.5, 0, 0.5]));
    expect([...out]).toEqual([-32768, -16384, 0, 16384]);
  });

  it('clamps out-of-range samples instead of wrapping', () => {
    const out = float32ToInt16Clamped(new Float32Array([1, 1.5, -1.5]));
    expect([...out]).toEqual([32767, 32767, -32768]);
  });

  it('round-trips every int16 amplitude produced by int16ToFloat32', () => {
    const pcm = new Int16Array([-32768, -12345, -1, 0, 1, 12345, 32767]);
    const back = float32ToInt16Clamped(int16ToFloat32(pcm.buffer));
    expect([...back]).toEqual([...pcm]);
  });
});

describe('rmsOfInt16', () => {
  it('returns 0 for an empty chunk', () => {
    expect(rmsOfInt16(new ArrayBuffer(0))).toBe(0);
  });

  it('returns the normalized amplitude of a constant signal', () => {
    const pcm = new Int16Array(480).fill(16384);
    expect(rmsOfInt16(pcm.buffer)).toBeCloseTo(0.5, 10);
  });

  it('is amplitude-only (sign does not matter)', () => {
    const pcm = new Int16Array([16384, -16384, 16384, -16384]);
    expect(rmsOfInt16(pcm.buffer)).toBeCloseTo(0.5, 10);
  });
});
