/**
 * GroundingService (M9): the policy half of the grounding stack. It owns the
 * per-snap budget bookkeeping and the two-radius retry, materializes the
 * embedded PowerShell daemon script (snapper.ps1, bundled at build time), and
 * does the label->element SELECTION in TS (scoring.ts, pure). The child
 * process / JSON-lines transport lives in daemon-client.ts.
 *
 * Contract with the conversation layer:
 * - `snap()` takes the model's point in GLOBAL PHYSICAL px + its spoken
 *   label, and answers within TIMEBOX_MS (default 600ms) — on timeout or any
 *   daemon trouble it reports no match, so the caller falls back to the raw
 *   model point. Snapping can never make pointing WORSE than today.
 * - The daemon is spawned lazily (warmUp() front-loads the ~1s PowerShell +
 *   assembly load), restarted after a crash or repeated timeouts, and killed
 *   on dispose() (app quit).
 * - One retry at a wider radius (350 -> 700 physical px) when nothing near
 *   the point clears the text threshold, budget permitting.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import snapperScript from './snapper.ps1?raw';
import { JsonLinesDaemonClient, normalizeCandidates } from './daemon-client';
import type { DaemonRequester, DaemonSpawnSpec } from './daemon-client';
import { selectCandidate, textSimilarity } from './scoring';

/** Overall answer budget per snap (raw-point fallback afterwards). */
const TIMEBOX_MS = 600;
/** Initial + retry search radii, physical px. */
const RADIUS_PX = 350;
const RETRY_RADIUS_PX = 700;
/** Below this remaining budget another daemon round-trip isn't worth it. */
const MIN_ATTEMPT_BUDGET_MS = 120;
/** The daemon's own per-query budget: clamped, minus a transport reserve. */
const DAEMON_BUDGET_MIN_MS = 100;
const DAEMON_BUDGET_MAX_MS = 450;
const DAEMON_TRANSPORT_RESERVE_MS = 60;
/** UIA DFS node cap per query (rect-pruned walk; see snapper.ps1). */
const DAEMON_MAX_NODES = 3000;

export interface GroundingOptions {
  /** Directory the snapper script is materialized into (userData). */
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
  /** GLOBAL PHYSICAL px (UIA space) — convert from DIP in the caller. */
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

export class GroundingService {
  private readonly options: GroundingOptions;
  private readonly timeboxMs: number;
  private readonly client: DaemonRequester;
  private disposed = false;

  constructor(options: GroundingOptions, client?: DaemonRequester) {
    this.options = options;
    this.timeboxMs = options.timeboxMs ?? TIMEBOX_MS;
    this.client =
      client ?? new JsonLinesDaemonClient({ resolveCommand: () => this.resolveCommand() });
  }

  /** Spawn the daemon ahead of the first snap (assembly load takes ~1s). */
  warmUp(): void {
    try {
      this.client.ensureSpawned();
    } catch (err) {
      console.warn('[grounding] warm-up failed:', err);
    }
  }

  /** Kill the daemon (app quit / settings rebuild). Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.client.dispose();
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
      if (remaining < MIN_ATTEMPT_BUDGET_MS)
        return {
          ...none(true, lastCount, lastDaemonMs),
          ...(debugList ? { debug: debugList } : {}),
        };
      const resp = await this.client.request(
        {
          x: Math.round(query.x),
          y: Math.round(query.y),
          radiusPx: radius,
          budgetMs: Math.max(
            DAEMON_BUDGET_MIN_MS,
            Math.min(DAEMON_BUDGET_MAX_MS, remaining - DAEMON_TRANSPORT_RESERVE_MS),
          ),
          maxNodes: DAEMON_MAX_NODES,
          ...(this.options.excludePid !== undefined ? { excludePid: this.options.excludePid } : {}),
        },
        remaining,
      );
      if (resp === null)
        return {
          ...none(true, lastCount, lastDaemonMs),
          ...(debugList ? { debug: debugList } : {}),
        };
      const candidates = normalizeCandidates(resp.candidates);
      lastCount = candidates.length;
      lastDaemonMs = typeof resp.elapsedMs === 'number' ? resp.elapsedMs : null;
      if (opts.debug) {
        debugList = candidates.map((c) => ({
          name: c.name,
          ct: c.ct,
          rect: { x: c.x, y: c.y, w: c.w, h: c.h },
          textScore: Math.round(textSimilarity(query.label, c.name) * 100) / 100,
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

  /**
   * Resolve the daemon launch command. Called on EVERY (re)spawn so the
   * embedded script is re-materialized too (survives packaging: no loose
   * files; survives userData cleanup between crashes).
   */
  private resolveCommand(): DaemonSpawnSpec {
    if (this.options.command !== undefined) {
      return { command: this.options.command, args: this.options.args ?? [] };
    }
    mkdirSync(this.options.scriptDir, { recursive: true });
    const scriptPath = join(this.options.scriptDir, 'snapper.ps1');
    writeFileSync(scriptPath, snapperScript, 'utf8');
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
    };
  }
}
