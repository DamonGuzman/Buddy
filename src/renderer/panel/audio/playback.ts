/**
 * Model-voice playback. 'audio:output' deltas (pcm16 24kHz mono) are decoded
 * to Float32 and posted to the pcm-player worklet, which renders the queue
 * contiguously — gapless by construction, with no per-chunk source nodes.
 *
 * Item tracking: chunks carry an `itemId`. A 'flush' (barge-in / supersede)
 * clears the worklet queue and marks the current item stale so its in-flight
 * stragglers are dropped; the next new itemId becomes current and plays.
 * 'stop' does the same but exists as an explicit halt.
 */

import type { AudioOutputDelta, PlaybackCommand } from '../../../shared/types';
import playerWorkletUrl from '../worklets/pcm-player.worklet.js?url&no-inline';

const STALE_IDS_MAX = 64;

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private currentItemId: string | null = null;
  private staleItemIds: string[] = [];
  private onDrainedCb: (() => void) | null = null;

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
      node.port.postMessage({ type: 'chunk', samples: samples.buffer }, [samples.buffer]);
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
        };
        this.node.connect(this.ctx.destination);
        if (this.ctx.state !== 'running') await this.ctx.resume();
      })();
    }
    return this.ready;
  }
}

export const audioPlayer = new AudioPlayer();
