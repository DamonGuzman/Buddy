/**
 * M8.5 addition (orchestrator-approved): playback tap — proof that model
 * audio was actually rendered, not just queued. The pcm-player worklet
 * streams back the samples it ACTUALLY rendered ('played' blocks); this
 * class accumulates per-item stats {samplesPlayed, rms, peak, underruns},
 * keeps a ring buffer of the last ~15s of played audio, and reports both to
 * main via 'audio:playback-stats' (on first play, ~1s cadence, and on item
 * done) and 'audio:playback-ring' (Int16 PCM, on item done). The stats
 * cadence/fields feed the voice eval and the session journal.
 *
 * Pure accumulation logic (no DOM/audio deps) so it is unit-testable in
 * node; AudioPlayer feeds it the worklet's 'played' messages.
 */

import { float32ToInt16Clamped, SAMPLE_RATE } from './pcm';
import type { PlaybackTapPort } from './port';
import type { PlayedBlock } from './worklet-messages';
import type { PlaybackStatsUpdate } from '../../../shared/types';

/** Played-audio ring buffer length: 15s @ 24kHz mono. */
export const RING_SAMPLES = 15 * SAMPLE_RATE;
/** Minimum interval between non-final stats IPC sends per item. */
export const STATS_INTERVAL_MS = 1_000;
/** Keep the per-item stats map bounded (items are short-lived). */
const MAX_TRACKED_ITEMS = 64;

interface ItemStatsAccum {
  samplesPlayed: number;
  sumSquares: number;
  peak: number;
  underruns: number;
  firstPlayedAt: number;
  lastSentAt: number;
  done: boolean;
}

export interface PlaybackTapOptions {
  /** Ring capacity override (tests). Default RING_SAMPLES. */
  ringSamples?: number;
  /** Clock override (tests). Default Date.now. */
  now?: () => number;
}

export class PlaybackTap {
  private readonly ringSamples: number;
  private readonly now: () => number;
  private readonly ring: Float32Array;
  private ringWrite = 0;
  private ringFilled = 0;
  private readonly itemStats = new Map<string, ItemStatsAccum>();

  constructor(
    private readonly port: PlaybackTapPort,
    opts: PlaybackTapOptions = {},
  ) {
    this.ringSamples = opts.ringSamples ?? RING_SAMPLES;
    this.now = opts.now ?? Date.now;
    this.ring = new Float32Array(this.ringSamples);
  }

  /** Account a worklet 'played' block; report stats/ring per the cadence rules. */
  onPlayedBlock(block: PlayedBlock): void {
    const samples = new Float32Array(block.samples);
    let stats = this.itemStats.get(block.itemId);
    const isFirst = stats === undefined;
    if (stats === undefined) {
      stats = {
        samplesPlayed: 0,
        sumSquares: 0,
        peak: 0,
        underruns: 0,
        firstPlayedAt: block.firstPlayedAt,
        lastSentAt: 0,
        done: false,
      };
      this.itemStats.set(block.itemId, stats);
      // Keep the map bounded (items are short-lived).
      if (this.itemStats.size > MAX_TRACKED_ITEMS) {
        const oldest = this.itemStats.keys().next().value;
        if (oldest !== undefined && oldest !== block.itemId) this.itemStats.delete(oldest);
      }
    }
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      stats.sumSquares += s * s;
      const abs = Math.abs(s);
      if (abs > stats.peak) stats.peak = abs;
      this.ring[this.ringWrite] = s;
      this.ringWrite = (this.ringWrite + 1) % this.ringSamples;
    }
    stats.samplesPlayed += samples.length;
    this.ringFilled = Math.min(this.ringSamples, this.ringFilled + samples.length);
    stats.underruns = block.underruns;
    if (block.done) stats.done = true;

    const now = this.now();
    if (isFirst || block.done || now - stats.lastSentAt >= STATS_INTERVAL_MS) {
      stats.lastSentAt = now;
      this.sendStats(block.itemId, stats);
    }
    if (block.done) {
      this.sendRing();
      this.itemStats.delete(block.itemId);
    }
  }

  /** Items currently accumulating (diagnostics/tests). */
  trackedItemCount(): number {
    return this.itemStats.size;
  }

  private sendStats(itemId: string, s: ItemStatsAccum): void {
    const update: PlaybackStatsUpdate = {
      itemId,
      samplesPlayed: s.samplesPlayed,
      rms: s.samplesPlayed > 0 ? Math.sqrt(s.sumSquares / s.samplesPlayed) : 0,
      peak: s.peak,
      underruns: s.underruns,
      firstPlayedAt: s.firstPlayedAt,
      done: s.done,
    };
    try {
      this.port.sendPlaybackStats(update);
    } catch (err) {
      console.warn('[playback] stats report failed:', err);
    }
  }

  /** Ship the played-audio ring buffer (oldest→newest) as Int16 PCM. */
  private sendRing(): void {
    const n = this.ringFilled;
    if (n === 0) return;
    // The window spans at most two contiguous ring segments — reassemble
    // oldest→newest, then re-encode.
    const ordered = new Float32Array(n);
    const start = (this.ringWrite - n + this.ringSamples) % this.ringSamples;
    const firstSegment = Math.min(n, this.ringSamples - start);
    ordered.set(this.ring.subarray(start, start + firstSegment), 0);
    if (firstSegment < n) ordered.set(this.ring.subarray(0, n - firstSegment), firstSegment);
    const out = float32ToInt16Clamped(ordered);
    try {
      this.port.sendPlaybackRing(out.buffer);
    } catch (err) {
      console.warn('[playback] ring report failed:', err);
    }
  }
}
