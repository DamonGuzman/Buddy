import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { systemPreferences } from 'electron';
import type { ComputerInputController, MouseButton } from './input-controller';
import { MAC_INPUT_SCRIPT } from './mac-input-script';

type InputChild = ChildProcessByStdio<null, Readable, Readable>;
type SpawnInputProcess = (executable: string, args: string[]) => InputChild;

export interface MacInputControllerOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
  spawnProcess?: SpawnInputProcess;
}

/** Global input backed only by macOS's built-in CoreGraphics/JXA facilities. */
export class MacInputController implements ComputerInputController {
  private readonly children = new Set<InputChild>();
  private readonly stopChild = new Map<InputChild, (error: Error) => void>();
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly isTrusted: (prompt: boolean) => boolean;
  private readonly spawnProcess: SpawnInputProcess;
  private disposed = false;

  constructor(options: MacInputControllerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.platform = options.platform ?? process.platform;
    this.isTrusted = options.isTrustedAccessibilityClient
      ?? ((prompt) => systemPreferences.isTrustedAccessibilityClient(prompt));
    this.spawnProcess = options.spawnProcess
      ?? ((executable, args) => spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  }

  move(x: number, y: number): Promise<void> {
    requireCoordinate(x, 'x');
    requireCoordinate(y, 'y');
    return this.request({ action: 'move', x: Math.round(x), y: Math.round(y) });
  }

  click(x: number, y: number, button: MouseButton = 'left', count = 1): Promise<void> {
    requireCoordinate(x, 'x');
    requireCoordinate(y, 'y');
    if (count !== 1 && count !== 2) throw new Error('click count must be one or two');
    return this.request({
      action: 'click',
      x: Math.round(x),
      y: Math.round(y),
      button,
      count,
    });
  }

  scroll(deltaX: number, deltaY: number): Promise<void> {
    requireCoordinate(deltaX, 'deltaX');
    requireCoordinate(deltaY, 'deltaY');
    return this.request({
      action: 'scroll',
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY),
    });
  }

  typeText(text: string): Promise<void> {
    if (typeof text !== 'string' || text.length > 10_000) {
      throw new Error('text must be at most 10000 characters');
    }
    return this.request({ action: 'type_text', text });
  }

  pressKeys(keys: string[]): Promise<void> {
    if (
      !Array.isArray(keys)
      || keys.length < 1
      || keys.length > 8
      || !keys.every((key) => typeof key === 'string' && key.trim().length > 0)
    ) {
      throw new Error('keys must be an array of one to eight non-empty strings');
    }
    return this.request({ action: 'press_keys', keys });
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) {
      try { child.kill(); } catch { /* already gone */ }
      this.stopChild.get(child)?.(new Error('input controller stopped'));
    }
    this.children.clear();
    this.stopChild.clear();
  }

  private request(payload: Record<string, unknown>): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('input controller stopped'));
    if (this.platform !== 'darwin') {
      return Promise.reject(new Error('macOS input is only available on macOS'));
    }
    if (!this.isTrusted(true)) {
      return Promise.reject(new Error(
        'macOS Accessibility permission is required; enable Buddy in System Settings > Privacy & Security > Accessibility',
      ));
    }

    return new Promise((resolve, reject) => {
      let child: InputChild;
      try {
        child = this.spawnProcess('/usr/bin/osascript', [
          '-l',
          'JavaScript',
          '-e',
          MAC_INPUT_SCRIPT,
          JSON.stringify(payload),
        ]);
      } catch (error) {
        reject(asError(error));
        return;
      }
      this.children.add(child);
      let stderr = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        this.stopChild.delete(child);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(new Error('macOS input timed out'));
      }, this.timeoutMs);
      this.stopChild.set(child, finish);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 2_000) stderr += chunk.slice(0, 2_000 - stderr.length);
      });
      child.on('error', (error) => finish(error));
      child.on('exit', (code, signal) => {
        if (code === 0) finish();
        else {
          const detail = sanitizeError(stderr) || (signal ? `terminated by ${signal}` : `exited with code ${code}`);
          finish(new Error(`macOS input failed: ${detail}`));
        }
      });
    });
  }
}

function requireCoordinate(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

function sanitizeError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
