/**
 * Microphone capture (push-to-talk). Runs entirely in the panel renderer —
 * which main keeps alive (hidden, unthrottled) from app start — so capture
 * works even while the panel window has never been shown.
 *
 * Pipeline: getUserMedia → MediaStreamAudioSourceNode → pcm-capture worklet
 * (Float32 → Int16 PCM LE, ~60ms chunks) → clicky.sendAudioChunk(ArrayBuffer).
 *
 * The AudioContext (24kHz) and worklet module are created once and reused;
 * the mic stream itself is acquired per hold and fully released on stop, so
 * the OS mic-in-use indicator is only on while the hotkey is held.
 */

import { clicky } from '../clicky';
import captureWorkletUrl from '../worklets/pcm-capture.worklet.js?url&no-inline';

export interface CaptureStats {
  running: boolean;
  /** Chunks forwarded during the current/last capture. */
  chunks: number;
  /** RMS (0..1) of the most recent chunk. */
  lastRms: number;
  /** Peak RMS seen during the current/last capture. */
  peakRms: number;
}

const DEBUG_LOG_EVERY = 16; // ~once per second at 60ms chunks

function rmsOfInt16(buf: ArrayBuffer): number {
  const samples = new Int16Array(buf);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = (samples[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private testOsc: OscillatorNode | null = null;
  private moduleReady: Promise<void> | null = null;
  private generation = 0; // invalidates in-flight async starts on stop()
  private running = false;
  private chunkCount = 0;
  private lastRms = 0;
  private peakRms = 0;
  private lastError: string | null = null;

  /**
   * One-time permission pre-warm: open + immediately release the default mic
   * so the real hotkey path never blocks on a permission prompt, and so
   * enumerateDevices() returns labels. Returns false if no mic is usable.
   */
  async prewarm(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      this.lastError = null;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn('[capture] mic pre-warm failed (no default microphone?):', this.lastError);
      return false;
    }
  }

  /** Begin streaming PCM chunks to main. No-op if already running. */
  async start(deviceId: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    this.chunkCount = 0;
    this.peakRms = 0;

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
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      const ctx = await this.ensureContext();
      if (gen !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      this.stream = stream;
      console.debug('[capture] using device:', stream.getAudioTracks()[0]?.label ?? '(unknown)');
      this.node?.port.postMessage({ type: 'reset' });
      this.source = ctx.createMediaStreamSource(stream);
      if (this.node) this.source.connect(this.node);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn('[capture] failed to start mic capture:', this.lastError);
      this.running = false;
      // M11 addition (orchestrator-approved): report the failure to main so
      // the hold that produced no audio surfaces mic_unavailable (with the
      // NotAllowedError privacy-toggle variant) instead of a silent nothing.
      try {
        clicky.reportAudioError({
          source: 'mic',
          name: err instanceof Error ? err.name : 'Error',
          message: this.lastError,
        });
      } catch {
        /* reporting is best-effort */
      }
    }
  }

  /**
   * Dev-only: run a synthetic 440Hz oscillator MediaStream through the exact
   * same worklet → sendAudioChunk pipeline (everything downstream of
   * getUserMedia), so chunking/PCM conversion can be verified with a known
   * nonzero signal even on machines whose only mic yields silence.
   */
  async startWithTestTone(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    this.chunkCount = 0;
    this.peakRms = 0;
    try {
      const ctx = await this.ensureContext();
      if (gen !== this.generation) return;
      const osc = ctx.createOscillator();
      osc.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      this.testOsc = osc;
      this.stream = dest.stream;
      console.debug('[capture] using device: (dev test tone)');
      this.node?.port.postMessage({ type: 'reset' });
      this.source = ctx.createMediaStreamSource(dest.stream);
      if (this.node) this.source.connect(this.node);
    } catch (err) {
      console.warn('[capture] test tone failed:', err);
      this.running = false;
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
      for (const track of this.stream.getTracks()) track.stop();
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

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24_000 });
    }
    if (!this.moduleReady) {
      this.moduleReady = this.ctx.audioWorklet.addModule(captureWorkletUrl);
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
    clicky.sendAudioChunk(buf);
    if (this.chunkCount % DEBUG_LOG_EVERY === 0) {
      // Quiet debug-level counter (visible only with verbose devtools levels).
      console.debug(
        `[capture] chunks=${this.chunkCount} rms=${this.lastRms.toFixed(4)} peak=${this.peakRms.toFixed(4)}`,
      );
    }
  }
}

export const micCapture = new MicCapture();
