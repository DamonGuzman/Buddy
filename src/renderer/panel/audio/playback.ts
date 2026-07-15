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
 * PlaybackEpochGate. The panel wiring (hooks/use-panel-wiring.ts) forwards
 * the command AND the epoch floor into control().
 *
 * F1 fix (battery): the AudioContext is suspended shortly after the queue
 * drains and resumed on the next enqueue — mirroring what mic capture does —
 * so an idle Clicky doesn't keep the audio render thread spinning.
 *
 * M8.5 addition (orchestrator-approved): playback tap — see ./playback-tap.ts.
 * This class forwards the worklet's 'played' blocks to the injected tap.
 *
 * Stats and failures are reported through the injected `PlaybackPort` (the
 * preload `clicky` in production — see ./engines.ts), which keeps this engine
 * free of preload imports, side-effect-free to import, and node-testable.
 */

import { PlaybackEpochGate } from './epoch-gate';
import { PlaybackTap } from './playback-tap';
import { CHUNK_SAMPLES, int16ToFloat32, SAMPLE_RATE } from './pcm';
import { parsePlayerWorkletMessage, type PlayerWorkletCommand } from './worklet-messages';
import type { PlaybackPort } from './port';
import type { AudioOutputDelta, PlaybackCommand } from '../../../shared/types';

const STALE_IDS_MAX = 64;
/**
 * Suspend the AudioContext this long after the queue drains. Longer than the
 * worklet's done-silence window (~0.5s) so the final 'played' stats block
 * flushes before the render thread stops.
 */
const SUSPEND_AFTER_DRAIN_MS = 1_500;

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
  /** M8.5: accounts the samples the worklet actually rendered. */
  private readonly tap: PlaybackTap;
  /** M11: playback init failed and main was told (re-armed on recovery). */
  private initErrorReported = false;

  constructor(
    private readonly port: PlaybackPort,
    private readonly workletUrl: string,
    tap?: PlaybackTap,
  ) {
    this.tap = tap ?? new PlaybackTap(port);
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
    const samples = int16ToFloat32(delta.chunk);
    void this.withNode((node) => {
      // F1 (battery): wake the render thread back up for the new audio.
      if (this.ctx !== null && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => undefined);
      }
      const msg: PlayerWorkletCommand = {
        type: 'chunk',
        samples: samples.buffer,
        itemId: delta.itemId,
      };
      node.port.postMessage(msg, [samples.buffer]);
    });
  }

  /**
   * 'stop' = halt immediately + clear queue; 'flush' = drop queued audio.
   * The optional epoch raises the stale-delta floor (M2) — the panel wiring
   * passes the floor that rode in on the 'audio:playback' command.
   */
  control(command: PlaybackCommand, epoch?: number): void {
    void command; // both commands clear the queue and staleify the current item
    this.gate.flush(epoch);
    if (this.currentItemId !== null) {
      this.markStale(this.currentItemId);
      this.currentItemId = null;
    }
    void this.withNode((node) => {
      const msg: PlayerWorkletCommand = { type: 'clear' };
      node.port.postMessage(msg);
    });
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
    const total = Math.floor(seconds * SAMPLE_RATE);
    for (let start = 0; start < total; start += CHUNK_SAMPLES) {
      const n = Math.min(CHUNK_SAMPLES, total - start);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        const t = (start + i) / SAMPLE_RATE;
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

  // ---- F1 (battery): suspend the context while nothing is queued ----

  private scheduleSuspend(): void {
    this.cancelSuspend();
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      void this.ctx?.suspend().catch(() => undefined);
    }, SUSPEND_AFTER_DRAIN_MS);
  }

  private cancelSuspend(): void {
    if (this.suspendTimer !== null) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  private async withNode(fn: (node: AudioWorkletNode) => void): Promise<void> {
    try {
      await this.ensure();
      if (this.node) fn(this.node);
      this.initErrorReported = false;
    } catch (err) {
      console.warn('[playback] audio output unavailable:', err);
      // M11 addition (orchestrator-approved): report the failure to main —
      // audio_output_failed copy + forced captions — instead of a silent
      // console.warn while the user hears nothing. Reset `ready` so the next
      // chunk retries init (audio devices come back).
      this.ready = null;
      this.node = null;
      void this.ctx?.close().catch(() => undefined);
      this.ctx = null;
      if (!this.initErrorReported) {
        this.initErrorReported = true;
        try {
          this.port.reportAudioError({
            source: 'playback',
            name: err instanceof Error ? err.name : 'Error',
            message: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* reporting is best-effort */
        }
      }
    }
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
        await this.ctx.audioWorklet.addModule(this.workletUrl);
        this.node = new AudioWorkletNode(this.ctx, 'pcm-player', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.node.port.onmessage = (e: MessageEvent<unknown>) => {
          const msg = parsePlayerWorkletMessage(e.data);
          if (msg === null) return;
          if (msg.type === 'drained') {
            this.scheduleSuspend(); // F1 (battery)
            this.onDrainedCb?.();
          } else {
            this.tap.onPlayedBlock(msg);
          }
        };
        this.node.connect(this.ctx.destination);
        if (this.ctx.state !== 'running') await this.ctx.resume();
      })();
    }
    return this.ready;
  }
}
