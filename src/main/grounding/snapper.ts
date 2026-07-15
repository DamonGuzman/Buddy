/**
 * GroundingService (M9): Windows UIA provider internals. The cross-platform
 * global-DIP facade lives in accessibility-grounder.ts; this class owns only
 * the persistent PowerShell daemon and native-physical scoring contract.
 *
 * Contract with the conversation layer:
 * - `snap()` takes the model's point in GLOBAL PHYSICAL px + its spoken
 *   label, and answers within TIMEBOX_MS (default 600ms) — on timeout or any
 *   daemon trouble it reports no match, so the caller falls back to the raw
 *   model point. Snapping can never make pointing WORSE than today.
 * - The daemon is spawned lazily (warmUp() front-loads PowerShell assembly
 *   setup), restarted after a crash or repeated timeouts, and killed on
 *   dispose() (app quit).
 * - One retry at a wider radius (350 -> 700 physical px) when nothing near
 *   the point clears the text threshold, budget permitting.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import snapperScript from './snapper.ps1?raw';
import { selectCandidate, textSimilarity } from './scoring';
import type { SnapCandidate } from './scoring';

/** Overall answer budget per snap (raw-point fallback afterwards). */
const TIMEBOX_MS = 600;
/** Initial + retry search radii, physical px. */
const RADIUS_PX = 350;
const RETRY_RADIUS_PX = 700;
/** Consecutive request timeouts before the daemon is presumed wedged. */
const MAX_CONSECUTIVE_TIMEOUTS = 2;
export interface GroundingOptions {
  /** Directory the Windows snapper script is materialized into (userData). */
  scriptDir: string;
  /** Process id whose windows are never used as the search scope (our overlays). */
  excludePid?: number;
  /** Overall per-snap budget override (tests). */
  timeboxMs?: number;
  /** Test override: run this command instead of powershell.exe + script. */
  command?: string;
  args?: string[];
}

export interface SnapQuery {
  /** GLOBAL PHYSICAL px (platform accessibility space) — caller converts DIP. */
  x: number;
  y: number;
  /** The model's spoken label for the element ("the save button"). */
  label: string;
  radiusPx?: number;
}

/** A scored candidate surfaced for diagnosis (debug route). */
export interface SnapDebugCandidate {
  name: string;
  ct?: string | undefined;
  rect: { x: number; y: number; w: number; h: number };
  textScore: number;
  windowRank?: number;
}

export interface SnapOutcome {
  matched: boolean;
  /** Center of the matched element, GLOBAL PHYSICAL px (null when unmatched). */
  point: { x: number; y: number } | null;
  name: string | null;
  score: number | null;
  /** Total wall time of the snap (incl. retry / timeout), ms. */
  elapsedMs: number;
  /** Elapsed inside the daemon for the answering query, ms. */
  daemonMs: number | null;
  /** Candidates enumerated by the answering query. */
  candidates: number;
  timedOut: boolean;
  /** All candidates with scores, newest query — only when requested. */
  debug?: SnapDebugCandidate[];
}

interface DaemonResponse {
  id: number;
  elapsedMs?: number;
  from?: string | null;
  visited?: number;
  error?: string;
  candidates?: unknown;
}

interface Pending {
  resolve: (resp: DaemonResponse | null) => void;
  timer: NodeJS.Timeout;
}

/** PS 5.1 ConvertTo-Json can scalar-ize single-element arrays: normalize. */
function normalizeCandidates(raw: unknown): SnapCandidate[] {
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
        ...(typeof c['windowRank'] === 'number' ? { windowRank: c['windowRank'] } : {}),
      });
    }
  }
  return out;
}

export class GroundingService {
  private readonly options: GroundingOptions;
  private readonly timeboxMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private consecutiveTimeouts = 0;
  private disposed = false;

  constructor(options: GroundingOptions) {
    this.options = options;
    this.timeboxMs = options.timeboxMs ?? TIMEBOX_MS;
  }

  /** Spawn the daemon ahead of the first snap (assembly load takes ~1s). */
  warmUp(): void {
    try {
      this.ensureChild();
    } catch (err) {
      console.warn('[grounding] warm-up failed:', err);
    }
  }

  /** Kill the daemon (app quit / settings rebuild). Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.killChild();
  }

  /**
   * Ground the model's point to the on-screen element matching `label`.
   * Never throws; never exceeds the timebox by more than scheduling jitter.
   */
  async snap(
    query: SnapQuery,
    opts: { debug?: boolean; timeboxMs?: number } = {},
  ): Promise<SnapOutcome> {
    const t0 = Date.now();
    const deadline = t0 + (opts.timeboxMs ?? this.timeboxMs);
    const none = (timedOut: boolean, count = 0, daemonMs: number | null = null): SnapOutcome => ({
      matched: false,
      point: null,
      name: null,
      score: null,
      elapsedMs: Date.now() - t0,
      daemonMs,
      candidates: count,
      timedOut,
    });
    if (this.disposed) return none(false);
    let lastCount = 0;
    let lastDaemonMs: number | null = null;
    let debugList: SnapDebugCandidate[] | undefined;
    for (const radius of [query.radiusPx ?? RADIUS_PX, RETRY_RADIUS_PX]) {
      const remaining = deadline - Date.now();
      if (remaining < 120) return { ...none(true, lastCount, lastDaemonMs), ...(debugList ? { debug: debugList } : {}) };
      const resp = await this.request(
        {
          x: Math.round(query.x),
          y: Math.round(query.y),
          radiusPx: radius,
          budgetMs: Math.max(100, Math.min(450, remaining - 60)),
          maxNodes: 3000,
          ...(this.options.excludePid !== undefined ? { excludePid: this.options.excludePid } : {}),
        },
        remaining,
      );
      if (resp === null) return { ...none(true, lastCount, lastDaemonMs), ...(debugList ? { debug: debugList } : {}) };
      const candidates = normalizeCandidates(resp.candidates);
      lastCount = candidates.length;
      lastDaemonMs = typeof resp.elapsedMs === 'number' ? resp.elapsedMs : null;
      if (opts.debug) {
        debugList = candidates.map((c) => ({
          name: c.name,
          ct: c.ct,
          rect: { x: c.x, y: c.y, w: c.w, h: c.h },
          textScore: Math.round(textSimilarity(query.label, c.name) * 100) / 100,
          ...(c.windowRank !== undefined ? { windowRank: c.windowRank } : {}),
        }));
      }
      const best = selectCandidate(query.label, { x: query.x, y: query.y }, candidates, radius);
      if (best !== null) {
        return {
          matched: true,
          point: { x: Math.round(best.cx), y: Math.round(best.cy) },
          name: best.candidate.name,
          score: Math.round(best.textScore * 100) / 100,
          elapsedMs: Date.now() - t0,
          daemonMs: lastDaemonMs,
          candidates: candidates.length,
          timedOut: false,
          ...(debugList ? { debug: debugList } : {}),
        };
      }
      if (radius >= RETRY_RADIUS_PX) break; // widest radius already tried
    }
    return { ...none(false, lastCount, lastDaemonMs), ...(debugList ? { debug: debugList } : {}) };
  }

  // -------------------------------------------------------------------------

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.disposed) throw new Error('grounding service disposed');
    if (this.child !== null && this.child.exitCode === null) return this.child;

    let command: string;
    let args: string[];
    if (this.options.command !== undefined) {
      command = this.options.command;
      args = this.options.args ?? [];
    } else {
      // Materialize the embedded script (survives packaging: no loose files).
      mkdirSync(this.options.scriptDir, { recursive: true });
      const scriptPath = join(this.options.scriptDir, 'snapper.ps1');
      writeFileSync(scriptPath, snapperScript, 'utf8');
      command = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    }

    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
        if (!this.disposed) console.warn(`[grounding] daemon exited (code ${code}); will respawn on demand`);
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
      let resp: DaemonResponse;
      try {
        resp = JSON.parse(line) as DaemonResponse;
      } catch {
        continue; // stray non-JSON output
      }
      const p = this.pending.get(resp.id);
      if (p === undefined) continue; // late answer to a timed-out request
      this.pending.delete(resp.id);
      clearTimeout(p.timer);
      this.consecutiveTimeouts = 0;
      p.resolve(resp);
    }
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<DaemonResponse | null> {
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
          if (this.consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS && !this.disposed) {
            console.warn('[grounding] daemon unresponsive; restarting');
            this.consecutiveTimeouts = 0;
            this.killChild();
          }
          resolve(null);
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }
}
