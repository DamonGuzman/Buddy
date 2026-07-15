/**
 * JSON-lines daemon client (M9): the transport half of the grounding stack.
 *
 * Owns the snapper child process — spawn (lazily, via an injected command
 * resolver so the embedded-script materialization stays with the service),
 * newline-delimited JSON framing, the pending-request map + id counter, and
 * the wedged-daemon watchdog (consecutive request timeouts kill the child so
 * the next request respawns a fresh one).
 *
 * Every failure mode resolves the affected request(s) with `null` — callers
 * treat `null` as "no answer" and fall back; the client never throws from
 * `request()`.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SnapCandidate } from './scoring';

// ---------------------------------------------------------------------------
// Wire codec (newline-delimited JSON, one object per line)
// ---------------------------------------------------------------------------

/** One enumeration query, as the daemon expects it (sans the client's id). */
export interface DaemonQuery {
  /** Query point, GLOBAL PHYSICAL px (UIA space). */
  x: number;
  y: number;
  /** Search radius around the point, physical px. */
  radiusPx: number;
  /** The daemon's own time budget for this query, ms. */
  budgetMs: number;
  /** UIA DFS node cap. */
  maxNodes: number;
  /** Process whose windows are never used as the search scope. */
  excludePid?: number;
}

export interface DaemonRequest extends DaemonQuery {
  id: number;
}

export interface DaemonResponse {
  id: number;
  /** Elapsed inside the daemon, ms. */
  elapsedMs?: number;
  /** Top-level window the point resolved to (diagnosis only). */
  from?: string | null;
  /** UIA nodes visited (diagnosis only). */
  visited?: number;
  error?: string;
  /**
   * Raw candidate payload — PS 5.1 ConvertTo-Json can scalar-ize
   * single-element arrays, so this stays `unknown` until decoded via
   * `normalizeCandidates`.
   */
  candidates?: unknown;
}

/** One request as a JSON line (id first, matching the daemon's logs). */
export function encodeDaemonRequest(req: DaemonRequest): string {
  return `${JSON.stringify(req)}\n`;
}

/** Parse one stdout line; null for stray non-JSON output. */
export function decodeDaemonResponse(line: string): DaemonResponse | null {
  try {
    return JSON.parse(line) as DaemonResponse;
  } catch {
    return null;
  }
}

/** PS 5.1 ConvertTo-Json can scalar-ize single-element arrays: normalize. */
export function normalizeCandidates(raw: unknown): SnapCandidate[] {
  const arr = Array.isArray(raw) ? raw : raw !== null && raw !== undefined ? [raw] : [];
  const out: SnapCandidate[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const c = item as Record<string, unknown>;
    if (
      typeof c['name'] === 'string' &&
      typeof c['x'] === 'number' &&
      typeof c['y'] === 'number' &&
      typeof c['w'] === 'number' &&
      typeof c['h'] === 'number'
    ) {
      out.push({
        name: c['name'],
        x: c['x'],
        y: c['y'],
        w: c['w'],
        h: c['h'],
        ...(typeof c['ct'] === 'string' ? { ct: c['ct'] } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Consecutive request timeouts before the daemon is presumed wedged. */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;

/** How the daemon child is launched (resolved fresh on every spawn). */
export interface DaemonSpawnSpec {
  command: string;
  args: string[];
}

export interface DaemonClientOptions {
  /**
   * Called on every (re)spawn — side effects like materializing the embedded
   * script belong here, so a respawn after a crash re-materializes too.
   */
  resolveCommand: () => DaemonSpawnSpec;
  /** Override for tests. */
  maxConsecutiveTimeouts?: number;
}

/** The request surface GroundingService needs (stubbable in tests). */
export interface DaemonRequester {
  ensureSpawned(): void;
  dispose(): void;
  request(query: DaemonQuery, timeoutMs: number): Promise<DaemonResponse | null>;
}

interface Pending {
  resolve: (resp: DaemonResponse | null) => void;
  timer: NodeJS.Timeout;
}

export class JsonLinesDaemonClient implements DaemonRequester {
  private readonly resolveCommand: () => DaemonSpawnSpec;
  private readonly maxConsecutiveTimeouts: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private consecutiveTimeouts = 0;
  private disposed = false;

  constructor(options: DaemonClientOptions) {
    this.resolveCommand = options.resolveCommand;
    this.maxConsecutiveTimeouts = options.maxConsecutiveTimeouts ?? MAX_CONSECUTIVE_TIMEOUTS;
  }

  /** Spawn the daemon ahead of the first request. Throws on spawn trouble. */
  ensureSpawned(): void {
    this.ensureChild();
  }

  /** Kill the daemon and fail all in-flight requests. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.killChild();
  }

  /**
   * Send one query; resolves with the daemon's answer, or null on timeout,
   * spawn failure, write failure, or daemon death. Never throws.
   */
  request(query: DaemonQuery, timeoutMs: number): Promise<DaemonResponse | null> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensureChild();
      } catch {
        resolve(null);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.consecutiveTimeouts += 1;
          // A wedged UIA walk blocks the single-threaded daemon for every
          // later request too — restart it after repeated timeouts.
          if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts && !this.disposed) {
            console.warn('[grounding] daemon unresponsive; restarting');
            this.consecutiveTimeouts = 0;
            this.killChild();
          }
          resolve(null);
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(encodeDaemonRequest({ id, ...query }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  // -------------------------------------------------------------------------

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error('grounding service disposed');
    if (this.child !== null && this.child.exitCode === null) return this.child;

    const spec = this.resolveCommand();
    const child = spawn(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line.length > 0) console.warn('[grounding] daemon stderr:', line.slice(0, 300));
    });
    child.on('error', (err) => {
      console.warn('[grounding] daemon spawn error:', err.message);
      if (this.child === child) this.child = null;
      this.flushPending();
    });
    child.on('exit', (code) => {
      if (this.child === child) {
        this.child = null;
        if (!this.disposed)
          console.warn(`[grounding] daemon exited (code ${code}); will respawn on demand`);
      }
      this.flushPending();
    });
    return child;
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    this.flushPending();
    if (child !== null) {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    }
  }

  /** Resolve every in-flight request as failed (daemon gone). */
  private flushPending(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      const resp = decodeDaemonResponse(line);
      if (resp === null) continue; // stray non-JSON output
      const p = this.pending.get(resp.id);
      if (p === undefined) continue; // late answer to a timed-out request
      this.pending.delete(resp.id);
      clearTimeout(p.timer);
      this.consecutiveTimeouts = 0;
      p.resolve(resp);
    }
  }
}
