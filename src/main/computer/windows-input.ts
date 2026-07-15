import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerInputController, MouseButton } from './input-controller';
import inputScript from './windows-input.ps1?raw';

export type { MouseButton } from './input-controller';

/**
 * One request line to the PowerShell input daemon (windows-input.ps1). A
 * numeric `id` is stamped on at write time; the daemon replies with one JSON
 * line `{id, ok, error?}` per request.
 */
export type InputRequest =
  | { action: 'move'; x: number; y: number }
  | { action: 'click'; x: number; y: number; button: MouseButton; count: number }
  | { action: 'scroll'; deltaX: number; deltaY: number }
  | { action: 'type_text'; text: string }
  | { action: 'press_keys'; keys: string[] };

/** Per-request reply budget from the daemon. */
const REQUEST_TIMEOUT_MS = 5_000;

/** The `child_process.spawn` surface this controller uses (tests inject a fake). */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildProcessWithoutNullStreams;

export interface WindowsInputControllerOptions {
  /** Process spawner. Default: node:child_process spawn. */
  spawnImpl?: SpawnImpl;
  /** Platform gate override (tests). Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Per-request reply budget, ms (tests shrink it). Default 5s. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve(value: { ok: boolean; error?: string }): void;
  timer: NodeJS.Timeout;
}

export class WindowsInputController implements ComputerInputController {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private readonly spawnImpl: SpawnImpl;
  private readonly platform: NodeJS.Platform;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly scriptDir: string,
    options: WindowsInputControllerOptions = {},
  ) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  move(x: number, y: number): Promise<void> {
    return this.request({ action: 'move', x: Math.round(x), y: Math.round(y) });
  }

  click(x: number, y: number, button: MouseButton = 'left', count = 1): Promise<void> {
    return this.request({ action: 'click', x: Math.round(x), y: Math.round(y), button, count });
  }

  scroll(deltaX: number, deltaY: number): Promise<void> {
    return this.request({
      action: 'scroll',
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
    });
  }

  typeText(text: string): Promise<void> {
    return this.request({ action: 'type_text', text });
  }

  pressKeys(keys: string[]): Promise<void> {
    return this.request({ action: 'press_keys', keys });
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    for (const [, value] of this.pending) {
      clearTimeout(value.timer);
      value.resolve({ ok: false, error: 'input controller stopped' });
    }
    this.pending.clear();
    try {
      child?.kill();
    } catch {
      /* already gone */
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.platform !== 'win32') throw new Error('computer use is only available on windows');
    if (this.child !== null && this.child.exitCode === null) return this.child;
    mkdirSync(this.scriptDir, { recursive: true });
    const scriptPath = join(this.scriptDir, 'windows-input.ps1');
    writeFileSync(scriptPath, inputScript, 'utf8');
    const child = this.spawnImpl(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) console.warn('[computer-use] input daemon:', line.slice(0, 300));
    });
    child.on('exit', () => this.failPending('input controller exited'));
    child.on('error', (error) => this.failPending(error.message));
    return child;
  }

  private request(payload: InputRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensureChild();
      } catch (error) {
        reject(error);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('windows input timed out'));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (result) =>
          result.ok ? resolve() : reject(new Error(result.error || 'windows input failed')),
      });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as { id?: unknown; ok?: unknown; error?: unknown };
        if (typeof response.id !== 'number') continue;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: response.ok === true,
          ...(typeof response.error === 'string' ? { error: response.error } : {}),
        });
      } catch {
        /* ignore non-protocol output */
      }
    }
  }

  private failPending(message: string): void {
    this.child = null;
    for (const [, value] of this.pending) {
      clearTimeout(value.timer);
      value.resolve({ ok: false, error: message });
    }
    this.pending.clear();
  }
}
