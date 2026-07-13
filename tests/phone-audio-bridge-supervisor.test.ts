import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoneAudioBridgeSupervisor } from '../src/main/phone-audio-bridge-supervisor';

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  let killed = false;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      killed = true;
      return true;
    }),
  });
  Object.defineProperty(child, 'killed', { get: () => killed });
  return child;
}

function makeSupervisor(options: {
  health: () => Promise<boolean>;
  spawn?: () => ChildProcess;
  onStatus?: (state: string) => void;
}) {
  return new PhoneAudioBridgeSupervisor({
    entryPath: 'bridge.mjs',
    executablePath: 'Buddy.exe',
    logPath: 'NUL',
    checkHealth: options.health,
    ...(options.spawn ? { spawnProcess: options.spawn } : {}),
    ...(options.onStatus
      ? { onStatus: (status) => options.onStatus?.(status.state) }
      : {}),
    monitorMs: 50,
    startupPollMs: 10,
    startupGraceMs: 100,
    restartMinMs: 20,
    restartMaxMs: 40,
  });
}

describe('PhoneAudioBridgeSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses an already healthy bridge without spawning another server', async () => {
    vi.useFakeTimers();
    const spawn = vi.fn(() => fakeChild());
    const states: string[] = [];
    const supervisor = makeSupervisor({
      health: async () => true,
      spawn,
      onStatus: (state) => states.push(state),
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(spawn).not.toHaveBeenCalled();
    expect(states).toContain('healthy');
    supervisor.close();
  });

  it('starts the bundled bridge when health is absent and reports healthy after boot', async () => {
    vi.useFakeTimers();
    let healthy = false;
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const states: string[] = [];
    const supervisor = makeSupervisor({
      health: async () => healthy,
      spawn,
      onStatus: (state) => states.push(state),
    });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(states).toContain('starting');

    healthy = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toContain('healthy');
    supervisor.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('restarts an owned bridge after an unexpected exit', async () => {
    vi.useFakeTimers();
    const first = fakeChild();
    const second = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const supervisor = makeSupervisor({ health: async () => false, spawn });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn).toHaveBeenCalledTimes(1);

    first.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(20);
    expect(spawn).toHaveBeenCalledTimes(2);
    supervisor.close();
  });

  it('does not restart after Buddy closes the supervisor', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const supervisor = makeSupervisor({ health: async () => false, spawn });

    supervisor.start();
    await vi.advanceTimersByTimeAsync(1);
    supervisor.close();
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
