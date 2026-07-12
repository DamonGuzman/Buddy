/**
 * Model-voice playback. 'audio:output' deltas (pcm16 24kHz mono) are decoded
 * to Float32 and posted to the pcm-player worklet, which renders the queue
 * contiguously — gapless by construction, with no per-chunk source nodes.
 *
 * Item tracking: chunks carry an `itemId`. A 'flush' (barge-in / supersede)
 * clears the worklet queue and marks the current item stale so its in-flight
 * stragglers are dropped; the next new itemId becomes current and plays.
 * 'stop' does the same but exists as an explicit halt.
 *
 * M8.5 addition (orchestrator-approved): playback tap. The worklet streams
 * back the samples it ACTUALLY rendered ('played' blocks); this class
 * accumulates per-item stats {samplesPlayed, rms, peak, underruns}, keeps a
 * ring buffer of the last ~15s of played audio, and reports both to main via
 * 'audio:playback-stats' (on first play, ~1s cadence, and on item done) and
 * 'audio:playback-ring' (Int16 PCM, on item done).
 */

import { clicky } from '../clicky';
import type { AudioOutputDelta, PlaybackCommand, PlaybackStatsUpdate } from '../../../shared/types';
import playerWorkletUrl from '../worklets/pcm-player.worklet.js?url&no-inline';

const STALE_IDS_MAX = 64;
/** Played-audio ring buffer length: 15s @ 24kHz mono. */
const RING_SAMPLES = 15 * 24_000;
/** Minimum interval between non-final stats IPC sends per item. */
const STATS_INTERVAL_MS = 1_000;

/** Message shape posted by the pcm-player worklet's playback tap. */
interface PlayedBlock {
  type: 'played';
  itemId: string;
  samples: ArrayBuffer; // Float32
  underruns: number;
  firstPlayedAt: number;
  done: boolean;
}

interface ItemStatsAccum {
  samplesPlayed: number;
  sumSquares: number;
  peak: number;
  underruns: number;
  firstPlayedAt: number;
  lastSentAt: number;
  done: boolean;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private currentItemId: string | null = null;
  private staleItemIds: string[] = [];
  private onDrainedCb: (() => void) | null = null;

  // ---- playback tap state (M8.5) ----
  private readonly ring = new Float32Array(RING_SAMPLES);
  private ringWrite = 0;
  private ringFilled = 0;
  private readonly itemStats = new Map<string, ItemStatsAccum>();

  /** Queue a model audio chunk (drops chunks from flushed/stale items). */
  enqueue(delta: AudioOutputDelta): void {
    if (this.staleItemIds.includes(delta.itemId)) return;
    if (delta.itemId !== this.currentItemId) {
      // A new response item supersedes the old one.
      this.currentItemId = delta.itemId;
    }
    const pcm = new Int16Array(delta.chunk);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
    void this.withNode((node) => {
      node.port.postMessage(
        { type: 'chunk', samples: samples.buffer, itemId: delta.itemId },
        [samples.buffer],
      );
    });
  }

  /** 'stop' = halt immediately + clear queue; 'flush' = drop queued audio. */
  control(command: PlaybackCommand): void {
    void command; // both commands clear the queue and staleify the current item
    if (this.currentItemId !== null) {
      this.markStale(this.currentItemId);
      this.currentItemId = null;
    }
    void this.withNode((node) => node.port.postMessage({ type: 'clear' }));
  }

  /** Notifies when the worklet queue runs empty (playback finished). */
  onDrained(cb: () => void): void {
    this.onDrainedCb = cb;
  }

  /**
   * Dev-only: synthesize a sine sweep as many small pcm16 chunks and run them
   * through the exact same enqueue path — audible clicks/gaps would indicate
   * a queuing bug.
   */
  playTestTone(seconds = 1.5, freq = 440): void {
    this.enqueueTone(`test-tone-${Date.now()}`, seconds, freq);
  }

  /** Dev-only: enqueue a synthesized tone under a specific itemId (QA). */
  enqueueTone(itemId: string, seconds: number, freq = 440): void {
    const rate = 24_000;
    const chunkSamples = 1440; // 60ms, same as capture
    const total = Math.floor(seconds * rate);
    for (let start = 0; start < total; start += chunkSamples) {
      const n = Math.min(chunkSamples, total - start);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const t = (start + i) / rate;
        const env = Math.min(1, t * 20, (seconds - t) * 20); // fade in/out
        pcm[i] = Math.round(Math.sin(2 * Math.PI * freq * (1 + 0.3 * t) * t) * env * 0.4 * 32767);
      }
      this.enqueue({ chunk: pcm.buffer, itemId });
    }
  }

  // -------------------------------------------------------------------------
  // Playback tap (M8.5)
  // -------------------------------------------------------------------------

  private onPlayedBlock(block: PlayedBlock): void {
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
      if (this.itemStats.size > STALE_IDS_MAX) {
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
      this.ringWrite = (this.ringWrite + 1) % RING_SAMPLES;
    }
    stats.samplesPlayed += samples.length;
    this.ringFilled = Math.min(RING_SAMPLES, this.ringFilled + samples.length);
    stats.underruns = block.underruns;
    if (block.done) stats.done = true;

    const now = Date.now();
    if (isFirst || block.done || now - stats.lastSentAt >= STATS_INTERVAL_MS) {
      stats.lastSentAt = now;
      this.sendStats(block.itemId, stats);
    }
    if (block.done) {
      this.sendRing();
      this.itemStats.delete(block.itemId);
    }
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
      clicky.sendPlaybackStats(update);
    } catch (err) {
      console.warn('[playback] stats report failed:', err);
    }
  }

  /** Ship the played-audio ring buffer (oldest→newest) as Int16 PCM. */
  private sendRing(): void {
    const n = this.ringFilled;
    if (n === 0) return;
    const out = new Int16Array(n);
    const start = (this.ringWrite - n + RING_SAMPLES) % RING_SAMPLES;
    for (let i = 0; i < n; i++) {
      const s = this.ring[(start + i) % RING_SAMPLES] ?? 0;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32768)));
    }
    try {
      clicky.sendPlaybackRing(out.buffer);
    } catch (err) {
      console.warn('[playback] ring report failed:', err);
    }
  }

  // -------------------------------------------------------------------------

  private markStale(itemId: string): void {
    this.staleItemIds.push(itemId);
    if (this.staleItemIds.length > STALE_IDS_MAX) this.staleItemIds.shift();
  }

  private async withNode(fn: (node: AudioWorkletNode) => void): Promise<void> {
    try {
      await this.ensure();
      if (this.node) fn(this.node);
    } catch (err) {
      console.warn('[playback] audio output unavailable:', err);
    }
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        this.ctx = new AudioContext({ sampleRate: 24_000 });
        await this.ctx.audioWorklet.addModule(playerWorkletUrl);
        this.node = new AudioWorkletNode(this.ctx, 'pcm-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.node.port.onmessage = (e: MessageEvent<{ type?: string }>) => {
          if (e.data?.type === 'drained') this.onDrainedCb?.();
          else if (e.data?.type === 'played') this.onPlayedBlock(e.data as PlayedBlock);
        };
        this.node.connect(this.ctx.destination);
        if (this.ctx.state !== 'running') await this.ctx.resume();
      })();
    }
    return this.ready;
  }
}

export const audioPlayer = new AudioPlayer();
