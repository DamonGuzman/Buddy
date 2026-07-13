import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_PHONE_AUDIO_URL = 'ws://127.0.0.1:3211/clicky';
export const DEFAULT_PHONE_AUDIO_HEALTH_URL = 'http://127.0.0.1:3211/health';

export type PhoneAudioBridgeState =
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'exited'
  | 'stopped';

export interface PhoneAudioBridgeStatus {
  state: PhoneAudioBridgeState;
  owned: boolean;
  detail?: string;
}

export interface PhoneAudioBridgeSupervisorOptions {
  entryPath: string;
  executablePath: string;
  logPath: string;
  healthUrl?: string;
  env?: NodeJS.ProcessEnv;
  onStatus?: (status: PhoneAudioBridgeStatus) => void;
  checkHealth?: () => Promise<boolean>;
  spawnProcess?: () => ChildProcess;
  monitorMs?: number;
  startupPollMs?: number;
  startupGraceMs?: number;
  restartMinMs?: number;
  restartMaxMs?: number;
}

const HEALTH_TIMEOUT_MS = 1_500;
const MONITOR_MS = 5_000;
const STARTUP_POLL_MS = 500;
const STARTUP_GRACE_MS = 30_000;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;

/**
 * Owns the bundled iPhone audio bridge for the lifetime of Buddy.
 *
 * A healthy bridge left by a previous/crashed Buddy instance is reused. When
 * no healthy listener exists, the bundled bridge is spawned with Electron's
 * Node mode and supervised with health polling plus bounded restart backoff.
 */
export class PhoneAudioBridgeSupervisor {
  private readonly healthUrl: string;
  private readonly monitorMs: number;
  private readonly startupPollMs: number;
  private readonly startupGraceMs: number;
  private readonly restartMinMs: number;
  private readonly restartMaxMs: number;
  private restartMs: number;
  private child: ChildProcess | null = null;
  private childStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking = false;
  private started = false;
  private closed = false;
  private lastStatusKey = '';

  constructor(private readonly options: PhoneAudioBridgeSupervisorOptions) {
    this.healthUrl = options.healthUrl ?? DEFAULT_PHONE_AUDIO_HEALTH_URL;
    this.monitorMs = options.monitorMs ?? MONITOR_MS;
    this.startupPollMs = options.startupPollMs ?? STARTUP_POLL_MS;
    this.startupGraceMs = options.startupGraceMs ?? STARTUP_GRACE_MS;
    this.restartMinMs = options.restartMinMs ?? RESTART_MIN_MS;
    this.restartMaxMs = options.restartMaxMs ?? RESTART_MAX_MS;
    this.restartMs = this.restartMinMs;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.inspect();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    this.report({ state: 'stopped', owned: child !== null });
  }

  private async inspect(): Promise<void> {
    if (this.closed || this.checking) return;
    this.checking = true;
    let healthy = false;
    try {
      healthy = await (this.options.checkHealth?.() ?? this.defaultHealthCheck());
    } catch (err) {
      this.log(`health check failed: ${errorMessage(err)}`);
    } finally {
      this.checking = false;
    }
    if (this.closed) return;

    if (healthy) {
      this.restartMs = this.restartMinMs;
      this.report({ state: 'healthy', owned: this.child !== null });
      this.scheduleInspect(this.monitorMs);
      return;
    }

    if (this.child !== null) {
      if (Date.now() - this.childStartedAt < this.startupGraceMs) {
        this.report({ state: 'starting', owned: true });
        this.scheduleInspect(this.startupPollMs);
        return;
      }
      this.report({
        state: 'unhealthy',
        owned: true,
        detail: `health endpoint did not become ready within ${this.startupGraceMs}ms`,
      });
      const child = this.child;
      this.child = null;
      if (!child.killed) child.kill();
      this.scheduleRestart();
      return;
    }

    this.spawnOwnedBridge();
  }

  private spawnOwnedBridge(): void {
    if (this.closed || this.child !== null) return;
    try {
      const child = this.options.spawnProcess?.() ?? this.defaultSpawn();
      this.child = child;
      this.childStartedAt = Date.now();
      this.pipeLogs(child);
      this.report({ state: 'starting', owned: true });
      child.once('error', (err) => {
        if (this.child !== child || this.closed) return;
        this.log(`bridge process error: ${errorMessage(err)}`);
      });
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        if (this.closed) return;
        const detail = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        this.report({ state: 'exited', owned: true, detail });
        this.scheduleRestart();
      });
      this.scheduleInspect(this.startupPollMs);
    } catch (err) {
      const detail = errorMessage(err);
      this.report({ state: 'exited', owned: false, detail });
      this.log(`could not start bundled bridge: ${detail}`);
      this.scheduleRestart();
    }
  }

  private defaultSpawn(): ChildProcess {
    if (!existsSync(this.options.entryPath)) {
      throw new Error(`bundled bridge entry missing: ${this.options.entryPath}`);
    }
    mkdirSync(dirname(this.options.logPath), { recursive: true });
    return spawn(this.options.executablePath, [this.options.entryPath, '--no-launch'], {
      env: {
        ...process.env,
        ...this.options.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private async defaultHealthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(this.healthUrl, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { ok?: unknown };
      return body.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private pipeLogs(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer | string) => this.log(`stdout: ${String(chunk).trim()}`));
    child.stderr?.on('data', (chunk: Buffer | string) => this.log(`stderr: ${String(chunk).trim()}`));
  }

  private scheduleInspect(delay: number): void {
    if (this.closed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.inspect();
    }, delay);
    this.timer.unref?.();
  }

  private scheduleRestart(): void {
    if (this.closed) return;
    this.clearTimer();
    const delay = this.restartMs;
    this.restartMs = Math.min(this.restartMaxMs, this.restartMs * 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.spawnOwnedBridge();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private report(status: PhoneAudioBridgeStatus): void {
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.log(
      `${status.state} (${status.owned ? 'owned' : 'external'})` +
        (status.detail ? `: ${status.detail}` : ''),
    );
    this.options.onStatus?.(status);
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(`[phone-audio-supervisor] ${message}`);
    try {
      mkdirSync(dirname(this.options.logPath), { recursive: true });
      appendFileSync(this.options.logPath, `${line}\n`, { encoding: 'utf8' });
    } catch {
      /* logging must never take down Buddy */
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
