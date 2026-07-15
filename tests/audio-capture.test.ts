/// <reference lib="dom" />
/// <reference types="vite/client" />

import { beforeEach, describe, expect, it, vi } from 'vitest';

const clicky = vi.hoisted(() => ({
  reportAudioError: vi.fn(),
  sendAudioChunk: vi.fn(),
}));

vi.mock('../src/renderer/panel/clicky', () => ({ clicky }));

import { MicCapture } from '../src/renderer/panel/audio/capture';
import { macAudioLifecycle } from '../src/renderer/panel/audio/mac-audio-lifecycle';

class FakeAudioWorkletNode {
  readonly port = {
    onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null,
    postMessage: vi.fn(),
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'running';
  readonly destination = {} as AudioDestinationNode;
  readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  readonly source = { connect: vi.fn(), disconnect: vi.fn() };
  readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });

  constructor(_options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }

  createGain(): GainNode {
    return {
      gain: { value: 1 },
      connect: vi.fn(),
    } as unknown as GainNode;
  }
}

function fakeStream(): { stream: MediaStream; stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const track = { stop, label: 'test mic' } as unknown as MediaStreamTrack;
  return {
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream,
    stop,
  };
}

describe('MicCapture audio-context lifecycle', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    clicky.reportAudioError.mockReset();
    clicky.sendAudioChunk.mockReset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  });

  it('closes the capture context on release so playback can own a fresh output route', async () => {
    const lifecycle = vi.spyOn(macAudioLifecycle, 'beginCaptureTeardown');
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
      mediaDevices: { getUserMedia },
    });

    const capture = new MicCapture(clicky, '/pcm-capture.worklet.js');
    await capture.start('');
    const firstContext = FakeAudioContext.instances[0]!;

    capture.stop();
    await vi.waitFor(() => expect(firstContext.close).toHaveBeenCalledOnce());
    expect(lifecycle).toHaveBeenCalledOnce();
    expect(firstContext.suspend).not.toHaveBeenCalled();
    expect(first.stop).toHaveBeenCalledOnce();

    await capture.start('');
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[1]).not.toBe(firstContext);
    expect(clicky.reportAudioError).not.toHaveBeenCalled();

    capture.stop();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('keeps the existing suspend-and-reuse behavior on Windows', async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    vi.stubGlobal('navigator', {
      platform: 'Win32',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      mediaDevices: { getUserMedia },
    });

    const capture = new MicCapture(clicky, '/pcm-capture.worklet.js');
    await capture.start('');
    const context = FakeAudioContext.instances[0]!;
    capture.stop();

    expect(context.suspend).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();

    await capture.start('');
    expect(FakeAudioContext.instances).toEqual([context]);
    expect(context.resume).toHaveBeenCalledOnce();

    capture.stop();
  });
});
