/**
 * MicCapture (src/renderer/panel/audio/capture.ts) — engine behavior in
 * node, with the Web Audio / getUserMedia environment stubbed and reports
 * observed through the injected MicCapturePort:
 *  - prewarm is idempotent and releases the probe stream;
 *  - start() returns a discriminated result (started / already-running /
 *    superseded / error) and reports failures to main (M11);
 *  - stop() releases tracks, suspends the context, and drops stragglers.
 */

/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicCapture } from '../src/renderer/panel/audio/capture';
import type { AudioDeviceError } from '../src/shared/types';

const WORKLET_URL = 'worklet://pcm-capture';

class FakePort {
  chunks: ArrayBuffer[] = [];
  errors: AudioDeviceError[] = [];
  sendAudioChunk = (chunk: ArrayBuffer): void => {
    this.chunks.push(chunk);
  };
  reportAudioError = (payload: AudioDeviceError): void => {
    this.errors.push(payload);
  };
}

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack(), new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): { label: string }[] {
    return [{ label: 'fake mic' }];
  }
  get allReleased(): boolean {
    return this.tracks.every((t) => t.stopped);
  }
}

class FakeWorkletNode {
  /** The most recently constructed node (the engine builds exactly one). */
  static last: FakeWorkletNode | null = null;
  port = {
    onmessage: null as ((e: MessageEvent<ArrayBuffer>) => void) | null,
    posted: [] as unknown[],
    postMessage(msg: unknown): void {
      this.posted.push(msg);
    },
  };
  connect(): void {}
  constructor() {
    FakeWorkletNode.last = this;
  }
}

class FakeSource {
  connected: unknown = null;
  connect(node: unknown): void {
    this.connected = node;
  }
  disconnect(): void {
    this.connected = null;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = 'suspended';
  destination = {};
  suspendCalls = 0;
  audioWorklet = { addModule: vi.fn(async (_url: string) => undefined) };
  sources: FakeSource[] = [];
  constructor(_opts?: unknown) {
    FakeAudioContext.instances.push(this);
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.suspendCalls++;
    this.state = 'suspended';
  }
  createGain(): { gain: { value: number }; connect: () => void } {
    return { gain: { value: 1 }, connect: () => undefined };
  }
  createMediaStreamSource(_stream: unknown): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createOscillator(): Record<string, unknown> {
    return {
      frequency: { value: 0 },
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      disconnect: () => undefined,
    };
  }
  createMediaStreamDestination(): { stream: FakeStream } {
    return { stream: new FakeStream() };
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let port: FakePort;

function makeMic(): MicCapture {
  return new MicCapture(port, WORKLET_URL);
}

async function acquiredStream(call = 0): Promise<FakeStream> {
  return (await getUserMedia.mock.results[call]!.value) as FakeStream;
}

beforeEach(() => {
  FakeWorkletNode.last = null;
  FakeAudioContext.instances = [];
  port = new FakePort();
  getUserMedia = vi.fn(async () => new FakeStream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MicCapture.prewarm', () => {
  it('opens then releases the default mic, once, no matter how often called', async () => {
    const mic = makeMic();
    await expect(mic.prewarm()).resolves.toBe(true);
    await expect(mic.prewarm()).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect((await acquiredStream()).allReleased).toBe(true);
    expect(mic.error()).toBeNull();
  });

  it('reports an unusable mic without retrying (matching the old once-per-renderer flag)', async () => {
    getUserMedia.mockRejectedValue(new Error('Requested device not found'));
    const mic = makeMic();
    await expect(mic.prewarm()).resolves.toBe(false);
    await expect(mic.prewarm()).resolves.toBe(false);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(mic.error()).toBe('Requested device not found');
  });
});

describe('MicCapture.start', () => {
  it('acquires the preferred device and streams worklet chunks to the port', async () => {
    const mic = makeMic();
    await expect(mic.start('device-1')).resolves.toEqual({ status: 'started' });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { ideal: 'device-1' }, echoCancellation: true, noiseSuppression: true },
    });
    const node = FakeWorkletNode.last!;
    // Each hold resets the worklet so a stale partial chunk can't leak in.
    expect(node.port.posted).toContainEqual({ type: 'reset' });
    // The source is wired into the worklet node.
    expect(FakeAudioContext.instances[0]!.sources[0]!.connected).toBe(node);

    const chunk = new Int16Array([16384, -16384]).buffer;
    node.port.onmessage!({ data: chunk } as MessageEvent<ArrayBuffer>);
    expect(port.chunks).toEqual([chunk]);
    const stats = mic.stats();
    expect(stats).toMatchObject({ running: true, chunks: 1 });
    expect(stats.lastRms).toBeCloseTo(0.5, 4);
  });

  it('omits the deviceId constraint for the system default', async () => {
    const mic = makeMic();
    await mic.start('');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  });

  it('is a no-op while already running', async () => {
    const mic = makeMic();
    await mic.start('');
    await expect(mic.start('')).resolves.toEqual({ status: 'already-running' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('releases the stream and bails when stop() lands mid-acquire', async () => {
    let resolveStream!: (stream: FakeStream) => void;
    getUserMedia.mockImplementation(() => new Promise((res) => (resolveStream = res)));
    const mic = makeMic();
    const pending = mic.start('');
    mic.stop(); // hotkey released before the mic came up
    const stream = new FakeStream();
    resolveStream(stream);
    await expect(pending).resolves.toEqual({ status: 'superseded' });
    expect(stream.allReleased).toBe(true);
    expect(mic.stats().running).toBe(false);
  });

  it('reports a start failure to main (M11) and returns it', async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    const mic = makeMic();
    await expect(mic.start('')).resolves.toEqual({
      status: 'error',
      error: 'Permission denied',
    });
    expect(port.errors).toEqual([
      { source: 'mic', name: 'NotAllowedError', message: 'Permission denied' },
    ]);
    expect(mic.error()).toBe('Permission denied');
    expect(mic.stats().running).toBe(false);
  });
});

describe('MicCapture.stop', () => {
  it('releases tracks, suspends the reused context, and drops stragglers', async () => {
    const mic = makeMic();
    await mic.start('');
    const node = FakeWorkletNode.last!;
    mic.stop();
    expect((await acquiredStream()).allReleased).toBe(true);
    expect(FakeAudioContext.instances[0]!.suspendCalls).toBeGreaterThan(0);
    expect(mic.stats().running).toBe(false);
    node.port.onmessage!({ data: new Int16Array([1]).buffer } as MessageEvent<ArrayBuffer>);
    expect(port.chunks).toHaveLength(0); // straggler after stop
  });

  it('reuses one AudioContext across holds', async () => {
    const mic = makeMic();
    await mic.start('');
    mic.stop();
    await mic.start('');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});

describe('MicCapture.startWithTestTone', () => {
  it('runs the same worklet pipeline without touching getUserMedia', async () => {
    const mic = makeMic();
    await expect(mic.startWithTestTone()).resolves.toEqual({ status: 'started' });
    expect(getUserMedia).not.toHaveBeenCalled();
    const node = FakeWorkletNode.last!;
    const chunk = new Int16Array([8192]).buffer;
    node.port.onmessage!({ data: chunk } as MessageEvent<ArrayBuffer>);
    expect(port.chunks).toEqual([chunk]);
    mic.stop();
    expect(mic.stats().running).toBe(false);
  });
});
