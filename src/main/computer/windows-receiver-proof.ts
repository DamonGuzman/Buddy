import { app } from 'electron';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import proofScript from './windows-receiver-proof.ps1?raw';
import type { ReceiverIdentity } from './native-receiver';

const PREPARE_TIMEOUT_MS = 2_000;
const VERIFY_TIMEOUT_MS = 250;

export interface WindowsReceiverProofPort {
  prepare(identity: ReceiverIdentity, text: string): Promise<string | null>;
  verify(proofToken: string): Promise<boolean>;
  dispose?(): void;
}

type ProofRequest =
  | { action: 'prepare'; identity: ReceiverIdentity; text: string }
  | { action: 'verify'; proofToken: string };

interface ProofReply {
  ok: boolean;
  proofToken?: string;
}

type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean },
) => ChildProcessWithoutNullStreams;

export interface WindowsReceiverProofDaemonOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: SpawnImpl;
  scriptDir?: string;
  prepareTimeoutMs?: number;
  verifyTimeoutMs?: number;
  onBeforeQuit?: (listener: () => void) => void;
}

interface Pending {
  resolve(reply: ProofReply): void;
  timer: NodeJS.Timeout;
}

/**
 * Persistent UIA proof process. Control values and selections live only in
 * this child's private memory; TypeScript receives one expiring opaque UUID.
 */
export class WindowsReceiverProofDaemon implements WindowsReceiverProofPort {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly platform: NodeJS.Platform;
  private readonly spawnImpl: SpawnImpl;
  private readonly prepareTimeoutMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly scriptDir: string | null;
  private readonly onBeforeQuit: (listener: () => void) => void;
  private nextId = 1;
  private buffer = '';
  private quitHookRegistered = false;

  constructor(options: WindowsReceiverProofDaemonOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
    this.scriptDir = options.scriptDir ?? null;
    this.onBeforeQuit = options.onBeforeQuit ?? ((listener) => app.once('before-quit', listener));
  }

  async prepare(identity: ReceiverIdentity, text: string): Promise<string | null> {
    const reply = await this.request({ action: 'prepare', identity, text }, this.prepareTimeoutMs);
    return reply.ok && typeof reply.proofToken === 'string' ? reply.proofToken : null;
  }

  async verify(proofToken: string): Promise<boolean> {
    return (await this.request({ action: 'verify', proofToken }, this.verifyTimeoutMs)).ok;
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.failPending();
    try {
      child?.kill();
    } catch {
      // The child may already have exited after its stdin closed.
    }
  }

  private request(payload: ProofRequest, timeoutMs: number): Promise<ProofReply> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensureChild();
      } catch {
        resolve({ ok: false });
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false });
      }
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.platform !== 'win32') throw new Error('UIA proof is only available on Windows');
    if (this.child !== null && this.child.exitCode === null) return this.child;
    const directory = this.scriptDir ?? join(app.getPath('userData'), 'native');
    mkdirSync(directory, { recursive: true });
    const scriptPath = join(directory, 'windows-receiver-proof.ps1');
    writeFileSync(scriptPath, proofScript, 'utf8');
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
    if (!this.quitHookRegistered) {
      this.quitHookRegistered = true;
      this.onBeforeQuit(() => this.dispose());
    }
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) console.warn('[computer-use] UIA proof daemon:', line.slice(0, 300));
    });
    child.on('exit', () => this.onChildFailure(child));
    child.on('error', () => this.onChildFailure(child));
    return child;
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
        const reply = JSON.parse(line) as Record<string, unknown>;
        const id = reply['id'];
        if (typeof id !== 'number') continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve({
          ok: reply['ok'] === true,
          ...(typeof reply['proofToken'] === 'string' ? { proofToken: reply['proofToken'] } : {}),
        });
      } catch {
        // PowerShell startup noise is not protocol output.
      }
    }
  }

  private failPending(): void {
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false });
    }
    this.pending.clear();
  }

  private onChildFailure(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.failPending();
  }
}
