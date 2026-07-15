import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReceiverIdentity } from '../src/main/computer/native-receiver';
import { WindowsReceiverProofDaemon } from '../src/main/computer/windows-receiver-proof';

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly stdin: { write(line: string): boolean };
  exitCode: number | null = null;
  killed = false;

  constructor(onWrite: (line: string) => void) {
    super();
    this.stdin = { write: (line) => (onWrite(line), true) };
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const IDENTITY: ReceiverIdentity = {
  platform: 'win32',
  pid: 12,
  window: {
    handle: '100',
    identifier: '',
    title: 'Draft',
    rect: { x: 0, y: 0, w: 800, h: 600 },
  },
  focus: {
    pid: 12,
    role: 'ControlType.Edit',
    identifier: 'Body',
    nativeHandle: '101',
    runtimeId: [42, 12, 7],
    rect: { x: 10, y: 20, w: 500, h: 300 },
  },
};

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'buddy-uia-proof-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('WindowsReceiverProofDaemon', () => {
  it('keeps large Unicode text on the daemon stdin protocol and returns only an opaque proof', async () => {
    const lines: string[] = [];
    const children: FakeChild[] = [];
    const daemon = new WindowsReceiverProofDaemon({
      platform: 'win32',
      scriptDir: directory,
      onBeforeQuit: () => undefined,
      spawnImpl: () => {
        const child = new FakeChild((line) => lines.push(line));
        children.push(child);
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });

    const prepared = daemon.prepare(IDENTITY, 'hé😊');
    expect(existsSync(join(directory, 'windows-receiver-proof.ps1'))).toBe(true);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      id: 1,
      action: 'prepare',
      identity: { focus: { runtimeId: [42, 12, 7] } },
      text: 'hé😊',
    });
    children[0]?.stdout.emit('data', '{"id":1,"ok":true,"proofToken":"opaque-uuid"}\n');
    await expect(prepared).resolves.toBe('opaque-uuid');

    const verified = daemon.verify('opaque-uuid');
    expect(JSON.parse(lines[1] ?? '{}')).toEqual({
      id: 2,
      action: 'verify',
      proofToken: 'opaque-uuid',
    });
    children[0]?.stdout.emit('data', '{"id":2,"ok":true}\n');
    await expect(verified).resolves.toBe(true);

    daemon.dispose();
    expect(children[0]?.killed).toBe(true);
  });

  it('fails closed without spawning off Windows', async () => {
    let spawned = false;
    const daemon = new WindowsReceiverProofDaemon({
      platform: 'darwin',
      scriptDir: directory,
      spawnImpl: () => {
        spawned = true;
        return new FakeChild(() => undefined) as unknown as ChildProcessWithoutNullStreams;
      },
    });

    await expect(daemon.prepare(IDENTITY, 'hello')).resolves.toBeNull();
    await expect(daemon.verify('proof')).resolves.toBe(false);
    expect(spawned).toBe(false);
  });
});
