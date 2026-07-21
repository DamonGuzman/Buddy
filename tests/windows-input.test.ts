/**
 * WindowsInputController unit tests — a fake spawn stands in for the
 * PowerShell input daemon, so these cover the JSON-line protocol framing and
 * lifecycle edges (timeouts, daemon death, dispose) fully offline.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WindowsInputController } from '../src/main/computer/windows-input';
import type { SpawnImpl } from '../src/main/computer/windows-input';

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

  constructor(onWrite: (line: string) => void, writeError: Error | null = null) {
    super();
    this.stdin = {
      write: (line: string) => {
        if (writeError) throw writeError;
        onWrite(line);
        return true;
      },
    };
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Harness {
  controller: WindowsInputController;
  lines: string[];
  children: FakeChild[];
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'win-input-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function harness(opts: { writeError?: Error; timeoutMs?: number } = {}): Harness {
  const lines: string[] = [];
  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = () => {
    const child = new FakeChild((line) => lines.push(line), opts.writeError ?? null);
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const controller = new WindowsInputController(dir, {
    spawnImpl,
    platform: 'win32',
    requestTimeoutMs: opts.timeoutMs ?? 1_000,
  });
  return { controller, lines, children };
}

describe('WindowsInputController', () => {
  it('writes one framed JSON request line and materializes the daemon script', async () => {
    const { controller, lines, children } = harness();
    const done = controller.click(10.4, 20.6);
    expect(lines).toEqual(['{"id":1,"action":"click","x":10,"y":21,"button":"left","count":1}\n']);
    expect(existsSync(join(dir, 'windows-input.ps1'))).toBe(true);
    children[0]!.stdout.emit('data', '{"id":1,"ok":true}\n');
    await expect(done).resolves.toBeUndefined();
  });

  it('reassembles responses split across chunk boundaries', async () => {
    const { controller, children } = harness();
    const done = controller.typeText('hi');
    children[0]!.stdout.emit('data', '{"id"');
    children[0]!.stdout.emit('data', ':1,"ok"');
    children[0]!.stdout.emit('data', ':true}\n');
    await expect(done).resolves.toBeUndefined();
  });

  it('settles multiple responses arriving in one chunk, including failures', async () => {
    const { controller, children } = harness();
    const first = controller.pressKeys(['ENTER']);
    const second = controller.pressKeys(['CTRL', 'L']);
    children[0]!.stdout.emit('data', '{"id":1,"ok":true}\n{"id":2,"ok":false,"error":"blocked"}\n');
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow('blocked');
  });

  it('ignores unknown-id and non-protocol lines, then settles on the real reply', async () => {
    const { controller, children } = harness();
    const done = controller.click(1, 2);
    children[0]!.stdout.emit('data', '{"id":99,"ok":true}\nnot json\n\n');
    children[0]!.stdout.emit('data', '{"id":1,"ok":true}\n');
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects after the request timeout when the daemon never replies', async () => {
    const { controller } = harness({ timeoutMs: 20 });
    await expect(controller.click(1, 2)).rejects.toThrow('windows input timed out');
  });

  it('fails all in-flight requests when the daemon exits, then respawns on the next request', async () => {
    const { controller, children } = harness();
    const done = controller.click(1, 2);
    children[0]!.exitCode = 1;
    children[0]!.emit('exit', 1);
    await expect(done).rejects.toThrow('input controller exited');

    const next = controller.click(3, 4);
    expect(children).toHaveLength(2);
    children[1]!.stdout.emit('data', '{"id":2,"ok":true}\n');
    await expect(next).resolves.toBeUndefined();
  });

  it('fails in-flight requests with the spawn error message on child error', async () => {
    const { controller, children } = harness();
    const done = controller.click(1, 2);
    children[0]!.emit('error', new Error('spawn broke'));
    await expect(done).rejects.toThrow('spawn broke');
  });

  it('dispose rejects in-flight requests and kills the daemon', async () => {
    const { controller, children } = harness();
    const done = controller.typeText('bye');
    controller.dispose();
    await expect(done).rejects.toThrow('input controller stopped');
    expect(children[0]!.killed).toBe(true);
  });

  it('rejects and cleans up when the stdin write throws', async () => {
    const { controller } = harness({ writeError: new Error('stdin broke') });
    await expect(controller.click(1, 2)).rejects.toThrow('stdin broke');
    // The pending slot was removed: dispose has nothing left to settle.
    controller.dispose();
  });

  it('refuses to run off-windows without spawning anything', async () => {
    const children: FakeChild[] = [];
    const spawnImpl: SpawnImpl = () => {
      const child = new FakeChild(() => undefined);
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    };
    const controller = new WindowsInputController(dir, { spawnImpl, platform: 'darwin' });
    await expect(controller.click(1, 2)).rejects.toThrow(
      'the Windows input controller is only available on Windows',
    );
    expect(children).toHaveLength(0);
  });
});
