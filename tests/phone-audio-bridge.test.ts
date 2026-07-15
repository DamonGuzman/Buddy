import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { PhoneAudioBridgeClient, toArrayBuffer } from '../src/main/phone-audio-bridge';

describe('toArrayBuffer', () => {
  it('copies exactly a Buffer view (no pool neighbors leak in)', () => {
    const pool = Buffer.alloc(16, 0x77);
    const view = pool.subarray(4, 8); // nonzero byteOffset into the pool
    view.set([1, 2, 3, 4]);
    const chunk = toArrayBuffer(view);
    expect(chunk.byteLength).toBe(4);
    expect(new Uint8Array(chunk)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('concatenates a Buffer[] fragment list in order', () => {
    const chunk = toArrayBuffer([Buffer.from([1, 2]), Buffer.from([3]), Buffer.from([4, 5])]);
    expect(new Uint8Array(chunk)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('copies an ArrayBuffer into a standalone buffer', () => {
    const source = new Uint8Array([9, 8, 7]).buffer;
    const chunk = toArrayBuffer(source);
    expect(chunk).not.toBe(source);
    expect(new Uint8Array(chunk)).toEqual(new Uint8Array([9, 8, 7]));
    // Mutating the source must not reach the returned copy.
    new Uint8Array(source)[0] = 0;
    expect(new Uint8Array(chunk)[0]).toBe(9);
  });
});

describe('PhoneAudioBridgeClient', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('carries capture/playback controls and PCM in both directions', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP address');
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.close();
          server.close(() => resolve());
        }),
    );

    const client = new PhoneAudioBridgeClient(`ws://127.0.0.1:${address.port}`);
    cleanups.push(async () => client.close());
    const socketPromise = new Promise<WsWebSocket>((resolve) => server.once('connection', resolve));
    const connected = new Promise<void>((resolve) => client.once('connected', resolve));
    client.start();
    const [socket] = await Promise.all([socketPromise, connected]);

    const controls: object[] = [];
    socket.on('message', (data, isBinary) => {
      if (!isBinary) controls.push(JSON.parse(data.toString()));
    });
    client.capture('start');
    client.playback('flush');
    await vi.waitFor(() =>
      expect(controls.slice(-2)).toEqual([
        { type: 'capture', command: 'start' },
        { type: 'playback', command: 'flush' },
      ]),
    );

    const output = new Uint8Array([1, 2, 3, 4]).buffer;
    const outputPromise = new Promise<Buffer>((resolve) =>
      socket.once('message', (data, isBinary) => {
        if (isBinary) resolve(Buffer.from(data as Buffer));
      }),
    );
    client.sendAudio(output);
    await expect(outputPromise).resolves.toEqual(Buffer.from([1, 2, 3, 4]));

    const inputPromise = new Promise<ArrayBuffer>((resolve) => client.once('audio', resolve));
    socket.send(Buffer.from([5, 6, 7, 8]));
    await expect(inputPromise).resolves.toEqual(new Uint8Array([5, 6, 7, 8]).buffer);
  });
});

describe('phone browser playback timeline', () => {
  it('keeps every PCM chunk after the previous one even when buffered over two seconds', () => {
    const source = readFileSync(
      join(process.cwd(), 'tools', 'phone-audio-bridge', 'phone.js'),
      'utf8',
    );
    const element = () => ({
      textContent: '',
      className: '',
      hidden: false,
      value: '100',
      style: { width: '' },
      addEventListener: () => {},
    });
    const context = vm.createContext({
      URL,
      location: {
        href: 'https://127.0.0.1:3210/?token=12345678',
        protocol: 'https:',
        host: '127.0.0.1:3210',
      },
      document: { querySelector: element },
      window: { addEventListener: () => {}, isSecureContext: true },
      navigator: { mediaDevices: {} },
      WebSocket: class {
        static readonly OPEN = 1;
      },
      console,
    });
    vm.runInContext(source, context);

    const starts = Array.from(
      { length: 10 },
      (_, index) =>
        vm.runInContext(`schedulePlaybackSlot(${10 + index * 0.01}, 0.5)`, context) as number,
    );

    expect(starts[0]).toBeCloseTo(10.04);
    for (let index = 1; index < starts.length; index += 1) {
      expect(starts[index]).toBeCloseTo(starts[index - 1]! + 0.5);
    }
    // The old implementation reset at now+2 here, overlapping earlier nodes.
    expect(starts.at(-1)).toBeGreaterThan(14);
  });
});
