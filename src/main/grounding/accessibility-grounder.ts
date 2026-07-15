/**
 * One product contract over the two native accessibility systems. All points
 * and rectangles crossing this boundary are global DIP. Platform providers
 * own native coordinate conversion and enumeration; shared TS owns scoring,
 * cancellation/timeboxes, telemetry, and fallback semantics.
 */

import { screen } from 'electron';
import { Worker } from 'node:worker_threads';
import type { CaptureMeta } from '../../shared/types';
import { dipToPhysicalViaMeta, physicalToDipViaMeta } from './convert';
import type { Pt } from './convert';
import { selectCandidate, textSimilarity } from './scoring';
import type { SnapCandidate } from './scoring';
import { GroundingService } from './snapper';
import {
  getMacNativeBridgePath,
  parseMacAccessibilityResult,
} from '../windows/mac-screen-permission';
import type { MacAccessibilityResult } from '../windows/mac-screen-permission';

export type AccessibilityProvider = 'uia' | 'ax';

export interface ElementGroundingQuery {
  point: Pt;
  label: string;
  display: Pick<CaptureMeta, 'displayBounds' | 'scaleFactor'>;
  /** Search radius in global DIP. Provider defaults apply when absent. */
  radiusDip?: number;
}

export interface ElementGroundingDebugCandidate {
  name: string;
  ct?: string;
  rect: { x: number; y: number; w: number; h: number };
  textScore: number;
  windowRank?: number;
}

export interface ElementGroundingOutcome {
  provider: AccessibilityProvider;
  matched: boolean;
  /** Matched element center in global DIP. */
  point: Pt | null;
  name: string | null;
  score: number | null;
  elapsedMs: number;
  nativeMs: number | null;
  candidates: number;
  timedOut: boolean;
  error?: string;
  debug?: ElementGroundingDebugCandidate[];
}

export interface ElementGrounder {
  readonly provider: AccessibilityProvider;
  warmUp(): void;
  snap(
    query: ElementGroundingQuery,
    opts?: { debug?: boolean; timeboxMs?: number },
  ): Promise<ElementGroundingOutcome>;
  dispose(): void;
}

interface GrounderFactoryOptions {
  scriptDir: string;
  excludePid: number;
  platform?: NodeJS.Platform;
}

export function createElementGrounder(options: GrounderFactoryOptions): ElementGrounder {
  return (options.platform ?? process.platform) === 'darwin'
    ? new MacAxElementGrounder(options.excludePid)
    : new WindowsUiaElementGrounder(options.scriptDir, options.excludePid);
}

export class WindowsUiaElementGrounder implements ElementGrounder {
  readonly provider = 'uia' as const;
  private readonly service: GroundingService;

  constructor(scriptDir: string, excludePid: number, service?: GroundingService) {
    this.service = service ?? new GroundingService({ scriptDir, excludePid });
  }

  warmUp(): void {
    this.service.warmUp();
  }

  dispose(): void {
    this.service.dispose();
  }

  async snap(
    query: ElementGroundingQuery,
    opts: { debug?: boolean; timeboxMs?: number } = {},
  ): Promise<ElementGroundingOutcome> {
    const physical = dipToPhysical(query.point, query.display);
    const radiusPx =
      query.radiusDip === undefined
        ? undefined
        : Math.max(1, Math.round(query.radiusDip * query.display.scaleFactor));
    const outcome = await this.service.snap(
      {
        x: physical.x,
        y: physical.y,
        label: query.label,
        ...(radiusPx !== undefined ? { radiusPx } : {}),
      },
      opts,
    );
    const point = outcome.point === null ? null : physicalToDip(outcome.point, query.display);
    const debug = outcome.debug?.map((candidate) => {
      const topLeft = physicalToDip(
        { x: candidate.rect.x, y: candidate.rect.y },
        query.display,
      );
      const bottomRight = physicalToDip(
        {
          x: candidate.rect.x + candidate.rect.w,
          y: candidate.rect.y + candidate.rect.h,
        },
        query.display,
      );
      return {
        name: candidate.name,
        ...(candidate.ct !== undefined ? { ct: candidate.ct } : {}),
        rect: {
          x: topLeft.x,
          y: topLeft.y,
          w: bottomRight.x - topLeft.x,
          h: bottomRight.y - topLeft.y,
        },
        textScore: candidate.textScore,
        ...(candidate.windowRank !== undefined ? { windowRank: candidate.windowRank } : {}),
      };
    });
    return {
      provider: this.provider,
      matched: outcome.matched,
      point,
      name: outcome.name,
      score: outcome.score,
      elapsedMs: outcome.elapsedMs,
      nativeMs: outcome.daemonMs,
      candidates: outcome.candidates,
      timedOut: outcome.timedOut,
      ...(debug !== undefined ? { debug } : {}),
    };
  }
}

function dipToPhysical(
  point: Pt,
  display: Pick<CaptureMeta, 'displayBounds' | 'scaleFactor'>,
): Pt {
  try {
    const converted = screen.dipToScreenPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    if (Number.isFinite(converted.x) && Number.isFinite(converted.y)) return converted;
  } catch {
    // Windows API unavailable in focused tests; meta math is deterministic.
  }
  return dipToPhysicalViaMeta(point, display);
}

function physicalToDip(
  point: Pt,
  display: Pick<CaptureMeta, 'displayBounds' | 'scaleFactor'>,
): Pt {
  try {
    const converted = screen.screenToDipPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    if (Number.isFinite(converted.x) && Number.isFinite(converted.y)) return converted;
  } catch {
    // Windows API unavailable in focused tests; meta math is deterministic.
  }
  return physicalToDipViaMeta(point, display);
}

const AX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const bridge = require(workerData.nativePath);
parentPort.on('message', ({ id, request }) => {
  try {
    const raw = bridge.queryAccessibility(JSON.stringify(request));
    parentPort.postMessage({ id, raw });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface AxWorkerResponse {
  id: number;
  raw?: unknown;
  error?: string;
}

interface PendingAxQuery {
  resolve: (result: MacAccessibilityResult) => void;
  timer: NodeJS.Timeout;
}

export class MacAxElementGrounder implements ElementGrounder {
  readonly provider = 'ax' as const;
  private readonly excludePid: number;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingAxQuery>();
  private disposed = false;
  private readonly queryOverride:
    | ((request: AxNativeRequest, timeboxMs: number) => Promise<MacAccessibilityResult>)
    | null;

  constructor(
    excludePid: number,
    queryOverride?: (request: AxNativeRequest, timeboxMs: number) => Promise<MacAccessibilityResult>,
  ) {
    this.excludePid = excludePid;
    this.queryOverride = queryOverride ?? null;
  }

  warmUp(): void {
    this.ensureWorker();
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker('disposed');
  }

  async snap(
    query: ElementGroundingQuery,
    opts: { debug?: boolean; timeboxMs?: number } = {},
  ): Promise<ElementGroundingOutcome> {
    const started = Date.now();
    const timeboxMs = Math.max(100, opts.timeboxMs ?? 650);
    const radius = Math.max(40, query.radiusDip ?? 420);
    const request: AxNativeRequest = {
      x: query.point.x,
      y: query.point.y,
      radius,
      budgetMs: Math.max(100, timeboxMs - 80),
      maxNodes: opts.debug ? 7000 : 3500,
      excludePid: this.excludePid,
    };
    const native = this.queryOverride === null
      ? await this.query(request, timeboxMs)
      : await this.queryOverride(request, timeboxMs);
    const candidates: SnapCandidate[] = native.candidates.map((candidate) => ({
      name: candidate.name,
      ...(candidate.ct !== undefined ? { ct: candidate.ct } : {}),
      x: candidate.x,
      y: candidate.y,
      w: candidate.w,
      h: candidate.h,
      windowRank: candidate.windowRank,
    }));
    const best = selectCandidate(query.label, query.point, candidates, radius);
    const elapsedMs = Date.now() - started;
    const debug = opts.debug
      ? candidates.map((candidate) => ({
          name: candidate.name,
          ...(candidate.ct !== undefined ? { ct: candidate.ct } : {}),
          rect: { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h },
          textScore: Math.round(textSimilarity(query.label, candidate.name) * 100) / 100,
          ...(candidate.windowRank !== undefined ? { windowRank: candidate.windowRank } : {}),
        }))
      : undefined;
    return {
      provider: this.provider,
      matched: best !== null,
      point: best === null ? null : { x: Math.round(best.cx), y: Math.round(best.cy) },
      name: best?.candidate.name ?? null,
      score: best === null ? null : Math.round(best.textScore * 100) / 100,
      elapsedMs,
      nativeMs: native.elapsedMs,
      candidates: candidates.length,
      timedOut: native.error === 'timeout',
      ...(native.error !== undefined ? { error: native.error } : {}),
      ...(debug !== undefined ? { debug } : {}),
    };
  }

  private query(
    request: AxNativeRequest,
    timeboxMs: number,
  ): Promise<MacAccessibilityResult> {
    const worker = this.ensureWorker();
    if (worker === null) return Promise.resolve(emptyMacResult('native_bridge_unavailable'));
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(emptyMacResult('timeout'));
        // A blocked AX request makes this worker untrustworthy. A later query
        // gets a fresh one while the pointer immediately takes its fallback.
        this.stopWorker('timeout');
      }, timeboxMs);
      this.pending.set(id, { resolve, timer });
      worker.postMessage({ id, request });
    });
  }

  private ensureWorker(): Worker | null {
    if (this.disposed) return null;
    if (this.worker !== null) return this.worker;
    const nativePath = getMacNativeBridgePath();
    if (nativePath === null) return null;
    const worker = new Worker(AX_WORKER_SOURCE, {
      eval: true,
      workerData: { nativePath },
      name: 'buddy-macos-ax',
    });
    worker.on('message', (message: AxWorkerResponse) => {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(
        message.error === undefined
          ? parseMacAccessibilityResult(message.raw)
          : emptyMacResult(message.error),
      );
    });
    worker.on('error', (error: unknown) =>
      this.stopWorker(error instanceof Error ? error.message : String(error)),
    );
    worker.on('exit', () => {
      if (this.worker === worker) this.stopWorker('worker_exited');
    });
    this.worker = worker;
    return worker;
  }

  private stopWorker(reason: string): void {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) void worker.terminate();
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(emptyMacResult(reason));
    }
  }
}

interface AxNativeRequest {
  x: number;
  y: number;
  radius: number;
  budgetMs: number;
  maxNodes: number;
  excludePid: number;
}

function emptyMacResult(error: string): MacAccessibilityResult {
  return {
    candidates: [],
    elapsedMs: 0,
    visited: 0,
    windows: 0,
    from: null,
    error,
  };
}
