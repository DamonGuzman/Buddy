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
 * F1 fix (M2): chunks also carry a main-owned playback `epoch`. The itemId
 * stale list can't drop a cancelled response whose FIRST chunk never reached
 * the renderer (no itemId known yet), so 'audio:playback' commands carry the
 * new epoch floor and any delta tagged with an older epoch is dropped by the
 * PlaybackEpochGate. The epoch part of the command is consumed by this
 * module's own onPlayback subscription (the frozen App wiring only forwards
 * the command string to control()).
 *
 * F1 fix (battery + macOS reliability): Windows suspends the AudioContext
 * shortly after the queue drains and resumes it on the next enqueue. macOS
 * closes the idle graph instead: Chromium's process-wide CoreAudio session can
 * detach a logically `running` output graph when the mic graph closes.
 *
 * M8.5 addition (orchestrator-approved): playback tap. The worklet streams
 * back the samples it ACTUALLY rendered ('played' blocks); this class
 * accumulates per-item stats {samplesPlayed, rms, peak, underruns}, keeps a
 * ring buffer of the last ~15s of played audio, and reports both to main via
 * 'audio:playback-stats' (on first play, ~1s cadence, and on item done) and
 * 'audio:playback-ring' (Int16 PCM, on item done).
 */

import { clicky } from '../clicky';
import { PlaybackEpochGate } from './epoch-gate';
import { isMacOS, macAudioLifecycle } from './mac-audio-lifecycle';
import type { AudioOutputDelta, PlaybackCommand, PlaybackStatsUpdate } from '../../../shared/types';
import playerWorkletUrl from '../worklets/pcm-player.worklet.js?url&no-inline';

const STALE_IDS_MAX = 64;
/**
 * Suspend the AudioContext this long after the queue drains. Longer than the
 * worklet's done-silence window (~0.5s) so the final 'played' stats block
 * flushes before the render thread stops.
 */
const SUSPEND_AFTER_DRAIN_MS = 1_500;
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
  /** F1 (M2): drops deltas whose epoch predates the newest flush. */
  private readonly gate = new PlaybackEpochGate();
  /** F1 (battery): pending context-suspend after the queue drained. */
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  /** Invalidates an output graph while it is being initialized. */
  private graphGeneration = 0;
  /** Invalidates queued async chunk deliveries on flush/stop. */
  private deliveryGeneration = 0;
  /** Preserves PCM chunk order across async context initialization/recovery. */
  private deliveryChain: Promise<void> = Promise.resolve();
  /** Prevents a replacement graph overlapping teardown of its predecessor. */
  private graphClose: Promise<void> = Promise.resolve();

  // ---- playback tap state (M8.5) ----
  private readonly ring = new Float32Array(RING_SAMPLES);
  private ringWrite = 0;
  private ringFilled = 0;
  private readonly itemStats = new Map<string, ItemStatsAccum>();

  constructor() {
    // F1 (M2): the App wiring (frozen panel component) forwards only the
    // command string to control(); the epoch floor rides in here directly.
    try {
      clicky.onPlayback(({ epoch }) => this.gate.flush(epoch));
    } catch (err) {
      console.warn('[playback] epoch subscription unavailable:', err);
    }
    macAudioLifecycle.onCaptureTeardown(() => this.disposeGraph());
  }

  /** Queue a model audio chunk (drops stale-item and stale-epoch chunks). */
  enqueue(delta: AudioOutputDelta): void {
    if (!this.gate.admitDelta(delta.epoch)) return; // F1 (M2): cancelled response
    if (this.staleItemIds.includes(delta.itemId)) return;
    if (delta.itemId !== this.currentItemId) {
      // A new response item supersedes the old one.
      this.currentItemId = delta.itemId;
    }
    this.cancelSuspend();
    const pcm = new Int16Array(delta.chunk);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 32768;
    const generation = this.deliveryGeneration;
    this.deliveryChain = this.deliveryChain
      .then(async () => {
        if (generation !== this.deliveryGeneration) return;
        const { ctx, node } = await this.ensureNode();
        if (generation !== this.deliveryGeneration) return;
        if (ctx.state !== 'running') await ctx.resume();
        if (generation !== this.deliveryGeneration || ctx.state !== 'running') return;
        node.port.postMessage(
          { type: 'chunk', samples: samples.buffer, itemId: delta.itemId },
          [samples.buffer],
        );
        this.initErrorReported = false;
      })
      .catch((err: unknown) => this.handleOutputError(err));
  }

  /**
   * 'stop' = halt immediately + clear queue; 'flush' = drop queued audio.
   * The optional epoch raises the stale-delta floor (M2) — App's wiring calls
   * this without it; the internal onPlayback subscription covers that path.
   */
  control(command: PlaybackCommand, epoch?: number): void {
    void command; // both commands clear the queue and staleify the current item
    this.gate.flush(epoch);
    this.deliveryGeneration++;
    this.cancelSuspend();
    if (this.currentItemId !== null) {
      this.markStale(this.currentItemId);
      this.currentItemId = null;
    }
    // A clear must never create an idle output graph. On macOS, discard the
    // graph because a following microphone teardown can detach it from the
    // physical device while AudioContext.state still says `running`.
    this.node?.port.postMessage({ type: 'clear' });
    if (isMacOS()) this.disposeGraph();
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

  // ---- F1 (battery): suspend the context while nothing is queued ----

  private scheduleSuspend(generation: number, ctx: AudioContext): void {
    this.cancelSuspend();
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      if (generation !== this.graphGeneration || ctx !== this.ctx) return;
      if (isMacOS()) {
        this.disposeGraph();
      } else {
        void ctx.suspend().catch(() => undefined);
      }
    }, SUSPEND_AFTER_DRAIN_MS);
  }

  private cancelSuspend(): void {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  /** M11: playback init failed and main was told (re-armed on recovery). */
  private initErrorReported = false;

  private handleOutputError(err: unknown): void {
    console.warn('[playback] audio output unavailable:', err);
    // M11 addition (orchestrator-approved): report the failure to main —
    // audio_output_failed copy + forced captions — instead of a silent
    // console.warn while the user hears nothing. A later chunk retries init.
    this.disposeGraph();
    if (!this.initErrorReported) {
      this.initErrorReported = true;
      try {
        clicky.reportAudioError({
          source: 'playback',
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* reporting is best-effort */
      }
    }
  }

  private async ensureNode(): Promise<{ ctx: AudioContext; node: AudioWorkletNode }> {
    for (;;) {
      const generation = this.graphGeneration;
      try {
        await this.ensure();
      } catch (err) {
        if (generation !== this.graphGeneration) continue;
        throw err;
      }
      if (generation !== this.graphGeneration) continue;
      if (this.ctx && this.node) return { ctx: this.ctx, node: this.node };
    }
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      const generation = this.graphGeneration;
      const ready = (async () => {
        await Promise.all([macAudioLifecycle.waitForCaptureTeardown(), this.graphClose]);
        if (generation !== this.graphGeneration) return;
        const ctx = new AudioContext({ sampleRate: 24_000 });
        this.ctx = ctx;
        await ctx.audioWorklet.addModule(playerWorkletUrl);
        if (generation !== this.graphGeneration || ctx !== this.ctx) {
          await ctx.close().catch(() => undefined);
          return;
        }
        const node = new AudioWorkletNode(ctx, 'pcm-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.node = node;
        node.port.onmessage = (e: MessageEvent<{ type?: string }>) => {
          if (generation !== this.graphGeneration || node !== this.node) return;
          if (e.data?.type === 'drained') {
            this.scheduleSuspend(generation, ctx); // F1 (battery)
            this.onDrainedCb?.();
          } else if (e.data?.type === 'played') {
            this.onPlayedBlock(e.data as PlayedBlock);
          }
        };
        node.connect(ctx.destination);
        if (ctx.state !== 'running') await ctx.resume();
      })();
      this.ready = ready;
      void ready.then(
        () => {
          if (this.ready === ready && generation !== this.graphGeneration) this.ready = null;
        },
        () => {
          if (this.ready === ready && generation !== this.graphGeneration) this.ready = null;
        },
      );
    }
    return this.ready;
  }

  private disposeGraph(): void {
    this.cancelSuspend();
    this.graphGeneration++;
    const ctx = this.ctx;
    const node = this.node;
    this.ready = null;
    this.ctx = null;
    this.node = null;
    if (node) {
      node.port.onmessage = null;
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (ctx) {
      const priorClose = this.graphClose;
      this.graphClose = Promise.all([priorClose, ctx.close().catch(() => undefined)]).then(
        () => undefined,
      );
    }
  }
}

export const audioPlayer = new AudioPlayer();
