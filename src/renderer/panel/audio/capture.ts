/**
 * Microphone capture (push-to-talk). Runs entirely in the panel renderer —
 * which main keeps alive (hidden, unthrottled) from app start — so capture
 * works even while the panel window has never been shown.
 *
 * Pipeline: getUserMedia → MediaStreamAudioSourceNode → pcm-capture worklet
 * (Float32 → Int16 PCM LE, ~60ms chunks) → port.sendAudioChunk(ArrayBuffer).
 *
 * The AudioContext (24kHz) and worklet module are created once and reused;
 * the mic stream itself is acquired per hold and fully released on stop, so
 * the OS mic-in-use indicator is only on while the hotkey is held.
 *
 * Chunks and failures are reported through the injected `MicCapturePort`
 * (the preload `clicky` in production — see ./engines.ts), which keeps this
 * engine free of preload imports and node-testable.
 */

import { rmsOfInt16, SAMPLE_RATE } from './pcm';
import type { MicCapturePort } from './port';
import type { CaptureWorkletReset } from './worklet-messages';

export interface CaptureStats {
  running: boolean;
  /** Chunks forwarded during the current/last capture. */
  chunks: number;
  /** RMS (0..1) of the most recent chunk. */
  lastRms: number;
  /** Peak RMS seen during the current/last capture. */
  peakRms: number;
}

/** Outcome of a start attempt (`start()` / `startWithTestTone()`). */
export type MicStartResult =
  | { status: 'started' }
  /** A capture was already running — the call was a no-op. */
  | { status: 'already-running' }
  /** stop() arrived while the mic/context was being acquired. */
  | { status: 'superseded' }
  | { status: 'error'; error: string };

const DEBUG_LOG_EVERY = 16; // ~once per second at 60ms chunks

const RESET_WORKLET: CaptureWorkletReset = { type: 'reset' };

function releaseTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private testOsc: OscillatorNode | null = null;
  private moduleReady: Promise<void> | null = null;
  private prewarmResult: Promise<boolean> | null = null;
  private generation = 0; // invalidates in-flight async starts on stop()
  private running = false;
  private chunkCount = 0;
  private lastRms = 0;
  private peakRms = 0;
  private lastError: string | null = null;

  constructor(
    private readonly port: MicCapturePort,
    private readonly workletUrl: string,
  ) {}

  /**
   * One-time permission pre-warm: open + immediately release the default mic
   * so the real hotkey path never blocks on a permission prompt, and so
   * enumerateDevices() returns labels. Returns false if no mic is usable.
   * Idempotent — repeat callers share the first attempt's outcome.
   */
  prewarm(): Promise<boolean> {
    this.prewarmResult ??= this.doPrewarm();
    return this.prewarmResult;
  }

  /** Begin streaming PCM chunks to main. No-op if already running. */
  async start(deviceId: string): Promise<MicStartResult> {
    const gen = this.beginCapture();
    if (gen === null) return { status: 'already-running' };

    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (gen !== this.generation) {
        // stop() arrived while we were acquiring the mic — release and bail.
        releaseTracks(stream);
        return { status: 'superseded' };
      }

      const ctx = await this.ensureContext();
      if (gen !== this.generation) {
        releaseTracks(stream);
        return { status: 'superseded' };
      }

      this.attach(ctx, stream, stream.getAudioTracks()[0]?.label ?? '(unknown)');
      this.lastError = null;
      return { status: 'started' };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn('[capture] failed to start mic capture:', this.lastError);
      this.running = false;
      // M11 addition (orchestrator-approved): report the failure to main so
      // the hold that produced no audio surfaces mic_unavailable (with the
      // NotAllowedError privacy-toggle variant) instead of a silent nothing.
      try {
        this.port.reportAudioError({
          source: 'mic',
          name: err instanceof Error ? err.name : 'Error',
          message: this.lastError,
        });
      } catch {
        /* reporting is best-effort */
      }
      return { status: 'error', error: this.lastError };
    }
  }

  /**
   * Dev-only: run a synthetic 440Hz oscillator MediaStream through the exact
   * same worklet → sendAudioChunk pipeline (everything downstream of
   * getUserMedia), so chunking/PCM conversion can be verified with a known
   * nonzero signal even on machines whose only mic yields silence.
   */
  async startWithTestTone(): Promise<MicStartResult> {
    const gen = this.beginCapture();
    if (gen === null) return { status: 'already-running' };
    try {
      const ctx = await this.ensureContext();
      if (gen !== this.generation) return { status: 'superseded' };
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      this.testOsc = osc;
      this.attach(ctx, dest.stream, '(dev test tone)');
      return { status: 'started' };
    } catch (err) {
      console.warn('[capture] test tone failed:', err);
      this.running = false;
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stop streaming: release mic tracks, suspend the (reused) context. */
  stop(): void {
    this.generation++;
    if (!this.running && !this.stream) return;
    this.running = false;
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* already disconnected */
      }
      this.source = null;
    }
    if (this.testOsc) {
      try {
        this.testOsc.stop();
        this.testOsc.disconnect();
      } catch {
        /* already stopped */
      }
      this.testOsc = null;
    }
    if (this.stream) {
      releaseTracks(this.stream);
      this.stream = null;
    }
    void this.ctx?.suspend().catch(() => undefined);
    console.debug(
      `[capture] stopped after ${this.chunkCount} chunks (peak rms ${this.peakRms.toFixed(4)})`,
    );
  }

  stats(): CaptureStats {
    return {
      running: this.running,
      chunks: this.chunkCount,
      lastRms: this.lastRms,
      peakRms: this.peakRms,
    };
  }

  error(): string | null {
    return this.lastError;
  }

  // -------------------------------------------------------------------------

  private async doPrewarm(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      releaseTracks(stream);
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn('[capture] mic pre-warm failed (no default microphone?):', this.lastError);
      return false;
    }
  }

  /** Shared start preamble: refuse when running, else claim a new generation. */
  private beginCapture(): number | null {
    if (this.running) return null;
    this.running = true;
    this.chunkCount = 0;
    this.peakRms = 0;
    return ++this.generation;
  }

  /** Shared start tail: adopt the stream and wire it into the worklet. */
  private attach(ctx: AudioContext, stream: MediaStream, deviceLabel: string): void {
    this.stream = stream;
    console.debug('[capture] using device:', deviceLabel);
    // 'reset' at the start of each hold: drop any partial chunk left over
    // from the previous turn so stale audio never leaks into a new one.
    this.node?.port.postMessage(RESET_WORKLET);
    this.source = ctx.createMediaStreamSource(stream);
    if (this.node) this.source.connect(this.node);
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    }
    if (!this.moduleReady) {
      this.moduleReady = this.ctx.audioWorklet.addModule(this.workletUrl);
    }
    await this.moduleReady;
    if (!this.node) {
      this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onChunk(e.data);
      // A worklet with no route to the destination gets culled from the
      // render graph — keep it pulled via a muted gain node.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute);
      mute.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  private onChunk(buf: ArrayBuffer): void {
    if (!this.running) return; // straggler after stop
    this.chunkCount++;
    this.lastRms = rmsOfInt16(buf);
    if (this.lastRms > this.peakRms) this.peakRms = this.lastRms;
    this.port.sendAudioChunk(buf);
    if (this.chunkCount % DEBUG_LOG_EVERY === 0) {
      // Quiet debug-level counter (visible only with verbose devtools levels).
      console.debug(
        `[capture] chunks=${this.chunkCount} rms=${this.lastRms.toFixed(4)} peak=${this.peakRms.toFixed(4)}`,
      );
    }
  }
}
