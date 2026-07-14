/// <reference lib="dom" />
/// <reference types="vite/client" />

import { beforeEach, describe, expect, it, vi } from 'vitest';

const clicky = vi.hoisted(() => ({
  onPlayback: vi.fn(() => () => undefined),
  reportAudioError: vi.fn(),
  sendPlaybackRing: vi.fn(),
  sendPlaybackStats: vi.fn(),
}));

const lifecycle = vi.hoisted(() => {
  const listeners: Array<() => void> = [];
  return {
    listeners,
    wait: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
});

vi.mock('../src/renderer/panel/clicky', () => ({ clicky }));
vi.mock('../src/renderer/panel/audio/mac-audio-lifecycle', () => ({
  isMacOS: () => true,
  macAudioLifecycle: {
    onCaptureTeardown: (cb: () => void) => {
      lifecycle.listeners.push(cb);
      return () => undefined;
    },
    waitForCaptureTeardown: () => lifecycle.wait(),
  },
}));

import { AudioPlayer } from '../src/renderer/panel/audio/playback';

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];

  readonly port = {
    onmessage: null as ((event: MessageEvent<{ type?: string }>) => void) | null,
    postMessage: vi.fn(),
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    FakeAudioWorkletNode.instances.push(this);
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'running';
  readonly destination = {} as AudioDestinationNode;
  readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

function chunk(itemId: string, sample = 8_192): {
  chunk: ArrayBuffer;
  itemId: string;
  epoch: number;
} {
  return { chunk: new Int16Array([sample, -sample]).buffer, itemId, epoch: 0 };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AudioPlayer macOS graph lifecycle', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeAudioWorkletNode.instances = [];
    lifecycle.wait.mockReset().mockResolvedValue(undefined);
    clicky.reportAudioError.mockReset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  });

  it('does not create an idle output graph for a clear command', async () => {
    const player = new AudioPlayer();
    player.control('flush');
    await Promise.resolve();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('waits for microphone teardown before creating and feeding output', async () => {
    const teardown = deferred();
    lifecycle.wait.mockReturnValue(teardown.promise);
    const player = new AudioPlayer();

    player.enqueue(chunk('answer'));
    await Promise.resolve();
    expect(FakeAudioContext.instances).toHaveLength(0);

    teardown.resolve();
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    expect(FakeAudioWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledOnce();
    expect(clicky.reportAudioError).not.toHaveBeenCalled();
  });

  it('replaces a graph invalidated by capture teardown and keeps the next chunk', async () => {
    const player = new AudioPlayer();
    const listener = lifecycle.listeners.at(-1)!;
    player.enqueue(chunk('first'));
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(1));
    const firstContext = FakeAudioContext.instances[0]!;
    const firstNode = FakeAudioWorkletNode.instances[0]!;

    const teardown = deferred();
    lifecycle.wait.mockReturnValue(teardown.promise);
    listener();
    player.enqueue(chunk('second'));

    expect(firstContext.close).toHaveBeenCalledOnce();
    expect(firstNode.disconnect).toHaveBeenCalledOnce();
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);

    teardown.resolve();
    await vi.waitFor(() => expect(FakeAudioWorkletNode.instances).toHaveLength(2));
    expect(FakeAudioWorkletNode.instances[1]?.port.postMessage).toHaveBeenCalledOnce();
    expect(clicky.reportAudioError).not.toHaveBeenCalled();
  });

  it('drops a chunk invalidated by flush while output initialization is pending', async () => {
    const teardown = deferred();
    lifecycle.wait.mockReturnValue(teardown.promise);
    const player = new AudioPlayer();
    player.enqueue(chunk('cancelled'));
    await Promise.resolve();

    player.control('flush');
    teardown.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(FakeAudioWorkletNode.instances).toHaveLength(0);
    expect(clicky.reportAudioError).not.toHaveBeenCalled();
  });
});
