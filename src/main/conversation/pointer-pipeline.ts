/**
 * M9/M10 layered grounding + pointer dispatch: ground the model's (already
 * §6-mapped) point, then fly the buddy. Layers, in order
 * (docs/ARCHITECTURE.md §6b):
 *
 *   1. UIA element snap (M9, 600ms timebox) — exact when the label matches
 *      a named element;
 *   2. REST grounding fallback (M10, gpt-5.4-mini, 2.5s timeout) — the
 *      model's own label re-grounded against the SAME screenshot JPEG the
 *      realtime model saw, ~10px median (COORD-STUDY §8-§9); the result is
 *      a point in that screenshot's pixel space, mapped like a model point;
 *   3. the raw model point — never worse than today.
 *
 * The tool output already went back (the model's answer is not gated on
 * grounding); a barge-in / superseding turn while grounding runs drops the
 * pointer via the turnToken check. The label chip always shows the MODEL's
 * label, not the element name.
 *
 * SHARED by the voice tool-call path AND the M18 text path. When
 * `primaryModelIsAccurate` is set (text mode: the point comes straight from
 * gpt-5.6-sol, which is 1px-median / 100% in-element per COORD-STUDY §11),
 * the redundant REST grounding call is SKIPPED — the UIA element-snap still
 * runs (it snaps to the true element center), otherwise the model's own
 * already-accurate point stands. Voice keeps the full layered pipeline
 * because its raw coordinates need it.
 *
 * Also owns the pointer debug surface: lastPointer / pointerHistory /
 * lastGrounding attribution and POST /grounding/query.
 */

import { resolveGroundingAuth } from '../auth/auth-source';
import type { AuthSource, CodexProvider } from '../auth/auth-source';
import type { CaptureResult } from '../capture';
import { clampToDisplay, mapModelPoint } from '../coords';
import type { MappedPoint } from '../coords';
import {
  dipToPhysicalPreferScreen,
  dipToPhysicalViaMeta,
  physicalToDipPreferScreen,
  physicalToDipViaMeta,
} from '../grounding/convert';
import type { Pt, ScreenPointApi } from '../grounding/convert';
import type { SnapDebugCandidate, SnapOutcome, SnapQuery } from '../grounding/snapper';
import type {
  CodexUsedPercent,
  GroundOutcome,
  GroundSource,
  RestGroundQuery,
} from '../grounding/rest-grounder';
import type { PointAtArgs } from '../realtime/protocol';
import type {
  GroundingAttribution,
  PointerCommand,
  PointerSnapInfo,
  TurnTimings,
} from '../../shared/types';
import { pushCapped } from '../util/guards';
import { POINTER_HISTORY_LIMIT } from './constants';
import type { OverlayPort, RecorderPort, SettingsPort } from './ports';
import type { TurnGuard } from './turn-guard';

/** The slice of GroundingService the pipeline drives (fakes in tests). */
export interface UiaSnapPort {
  warmUp(): void;
  dispose(): void;
  snap(query: SnapQuery, opts?: { debug?: boolean; timeboxMs?: number }): Promise<SnapOutcome>;
}

/** The slice of RestGrounder the pipeline drives (fakes in tests). */
export interface RestGroundPort {
  ground(query: RestGroundQuery, auth: AuthSource): Promise<GroundOutcome>;
}

/** Electron's `screen` slice the pipeline needs (point mapping + debug query). */
export interface ScreenApi extends ScreenPointApi {
  getDisplayNearestPoint(point: Pt): {
    bounds: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
  };
}

/** Typed result of POST /grounding/query (was Promise<unknown>). */
export interface GroundingDebugReport {
  query: { x: number; y: number; label: string; radiusPx?: number; physical: Pt };
  matched: boolean;
  snappedDip: Pt | null;
  name: string | null;
  score: number | null;
  elapsedMs: number;
  daemonMs: number | null;
  timedOut: boolean;
  candidates: SnapDebugCandidate[];
}

export interface PointerPipelineDeps {
  overlays: OverlayPort;
  settings: SettingsPort;
  recorder: RecorderPort | null;
  guard: TurnGuard;
  /** The turn record pointer timings are stamped onto (captured at dispatch). */
  activeTurn: () => TurnTimings | null;
  /** M13-core: the Codex ChatGPT-subscription auth provider (lazy). */
  codexProvider: () => CodexProvider;
  /** Plan-usage telemetry of the most recent TEXT turn (text-accurate mode). */
  codexTextUsedPercent: () => CodexUsedPercent | null;
  /** M17: fail-closed plan-limit copy, once per episode. */
  surfacePlanLimitOnce: (token: number) => void;
  /** Lazy constructors — injected fakes in tests, real services in the app. */
  buildUiaSnapper: () => UiaSnapPort;
  buildRestGrounder: () => RestGroundPort;
  screen: ScreenApi;
  /** CLICKY_NO_SNAP / CLICKY_NO_REST_GROUND / CLICKY_NO_CODEX_SUB (eval A/B). */
  snapDisabled: boolean;
  restGroundDisabled: boolean;
  codexDisabled: boolean;
}

export class PointerPipeline {
  // M9: element-snap grounding (docs/EVAL.md §9), spawned lazily.
  private uia: UiaSnapPort | null = null;
  // M10: REST grounding fallback behind the UIA snap (docs/COORD-STUDY.md §9).
  private rest: RestGroundPort | null = null;
  /** M13-core: attribution of the most recent grounding call. */
  private lastGroundingValue: GroundingAttribution | null = null;
  private lastPointerValue: PointerCommand | null = null;
  private pointerHistory: PointerCommand[] = [];
  /** Serializes pointer dispatches so multi-point turns stay ordered. */
  private pointerChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PointerPipelineDeps) {}

  /** M9: lazy snapper (spawned once, killed in dispose()). */
  private getUia(): UiaSnapPort {
    if (this.uia === null) this.uia = this.deps.buildUiaSnapper();
    return this.uia;
  }

  /** M10: lazy REST grounder (same key source as the realtime session). */
  private getRest(): RestGroundPort {
    if (this.rest === null) this.rest = this.deps.buildRestGrounder();
    return this.rest;
  }

  /**
   * M9: front-load the snapper daemon's ~1s PowerShell/assembly load so the
   * very first point_at of a session can still snap within the timebox.
   */
  warmUpIfEnabled(): void {
    if (!this.deps.snapDisabled) this.getUia().warmUp();
  }

  /** M9: kill the snapper daemon (app quit). */
  dispose(): void {
    this.uia?.dispose();
  }

  lastPointer(): PointerCommand | null {
    return this.lastPointerValue;
  }

  history(): PointerCommand[] {
    return [...this.pointerHistory];
  }

  lastGrounding(): GroundingAttribution | null {
    return this.lastGroundingValue;
  }

  /** Chain a dispatch so multi-point turns stay in call order. */
  enqueue(
    args: PointAtArgs,
    capture: CaptureResult,
    mapped: MappedPoint & { adjusted: boolean },
    opts: { primaryModelIsAccurate?: boolean } = {},
  ): void {
    this.pointerChain = this.pointerChain.then(() => this.dispatch(args, capture, mapped, opts));
  }

  private async dispatch(
    args: PointAtArgs,
    capture: CaptureResult,
    mapped: MappedPoint & { adjusted: boolean },
    opts: { primaryModelIsAccurate?: boolean },
  ): Promise<void> {
    const { deps } = this;
    const token = deps.guard.currentToken();
    const turn = deps.activeTurn();
    const meta = capture.meta;
    const textAccurate = opts.primaryModelIsAccurate === true;
    let local = mapped.local;
    let snap: PointerSnapInfo | undefined;
    let groundingSource: 'uia' | 'rest' | 'raw' = 'raw';
    if (!deps.snapDisabled && args.label !== undefined && args.label.length > 0) {
      const t0 = Date.now();
      const rawPoint = { x: Math.round(mapped.global.x), y: Math.round(mapped.global.y) };
      try {
        const phys = dipToPhysicalPreferScreen(mapped.global, meta, deps.screen);
        const outcome = await this.getUia().snap({ x: phys.x, y: phys.y, label: args.label });
        if (outcome.matched && outcome.point !== null) {
          const dip = physicalToDipPreferScreen(outcome.point, meta, deps.screen);
          local = clampToDisplay(
            { x: dip.x - meta.displayBounds.x, y: dip.y - meta.displayBounds.y },
            meta,
          );
          snap = {
            rawPoint,
            snappedPoint: {
              x: Math.round(meta.displayBounds.x + local.x),
              y: Math.round(meta.displayBounds.y + local.y),
            },
            snapScore: outcome.score,
            snapName: outcome.name,
            snapMs: Date.now() - t0,
            candidates: outcome.candidates,
          };
          groundingSource = 'uia';
        } else {
          if (outcome.timedOut) {
            console.warn('[grounding] snap timed out — using the raw model point');
          }
          snap = {
            rawPoint,
            snappedPoint: null,
            snapScore: null,
            snapName: null,
            snapMs: Date.now() - t0,
            candidates: outcome.candidates,
          };
        }
      } catch (err) {
        console.warn('[grounding] snap failed — using the raw model point:', err);
        snap = {
          rawPoint,
          snappedPoint: null,
          snapScore: null,
          snapName: null,
          snapMs: Date.now() - t0,
        };
      }
    }
    // M10: UIA snap found nothing (or was disabled) — REST grounding
    // fallback. The grounder re-locates the model's own label in the SAME
    // screenshot the model saw (capture is closure-retained here even after
    // the turn settles and releases turnCaptures), and its answer is a point
    // in that screenshot's pixel space — mapped to DIP exactly like a model
    // point. On null (no key / mock mode / timeout / error / out-of-bounds)
    // the raw model point stands, unchanged from today.
    let restMs: number | undefined;
    let restUsed = false;
    let groundingBackend: GroundSource = 'none';
    let quotaExhausted = false;
    let usedPercent: CodexUsedPercent | null = null;
    if (textAccurate) {
      // M18: text mode — the point came from gpt-5.6-sol itself (pixel-exact),
      // so no second grounding-model call is made. Attribute it to the codex
      // sub and carry the text turn's plan-usage telemetry for the debug
      // surface / the >40% live-validation stop.
      groundingBackend = 'codex';
      usedPercent = deps.codexTextUsedPercent();
    } else if (
      groundingSource !== 'uia' &&
      !deps.restGroundDisabled &&
      args.label !== undefined &&
      args.label.length > 0
    ) {
      // M13-core: resolve the grounding transport — the ChatGPT sub
      // (gpt-5.6-sol) when signed in + valid, else the metered API key
      // (gpt-5.4-mini). Pure/injectable resolver (auth/auth-source.ts).
      const auth = resolveGroundingAuth({
        getApiKey: () => deps.settings.getApiKey(),
        codex: deps.codexProvider(),
        preferApiKey: deps.codexDisabled || deps.settings.get().preferApiKeyGrounding,
      });
      if (auth !== null) {
        restUsed = true;
        const t0 = Date.now();
        const outcome = await this.getRest().ground(
          {
            jpegBase64: capture.jpegBase64,
            imageW: meta.imageW,
            imageH: meta.imageH,
            label: args.label,
          },
          auth,
        );
        restMs = Date.now() - t0;
        groundingBackend = outcome.source;
        quotaExhausted = outcome.quotaExhausted;
        usedPercent = outcome.usedPercent;
        if (outcome.point !== null && !deps.guard.isStale(token)) {
          const regrounded = mapModelPoint(
            {
              x: outcome.point.x,
              y: outcome.point.y,
              ...(args.label !== undefined ? { label: args.label } : {}),
            },
            meta,
          );
          local = regrounded.local;
          groundingSource = 'rest';
        } else if (outcome.quotaExhausted) {
          // FAIL CLOSED (turing_agents posture): the ChatGPT plan quota is
          // spent. Do NOT silently fall back to the metered API key for THIS
          // call — fly the RAW model point and flag it.
          console.warn(
            '[grounding] chatgpt plan quota reached — flying the raw model point (fail closed)',
          );
          // M17 (integration): surface the fail-closed "plan limit reached"
          // copy (transcript + caption + one-time panel) ONCE per episode
          // (turn), not once per point in a multi-point turn.
          deps.surfacePlanLimitOnce(token);
        }
      }
    }
    // M13-core: record grounding-auth attribution for the debug surface (kept
    // even when a later turn supersedes this one — fail-closed telemetry).
    this.lastGroundingValue = {
      backend: groundingBackend,
      source: groundingSource,
      quotaExhausted,
      usedPercent,
    };
    // A newer turn superseded this one while grounding ran: don't fly the buddy.
    if (deps.guard.isStale(token)) return;
    const cmd: PointerCommand = {
      type: 'animate',
      points: [
        {
          x: local.x,
          y: local.y,
          ...(mapped.label !== undefined ? { label: mapped.label } : {}),
        },
      ],
      screenIndex: meta.screenIndex,
      ...(snap !== undefined ? { snap } : {}),
      groundingSource,
      restUsed,
      ...(restMs !== undefined ? { restMs } : {}),
    };
    deps.overlays.routePointer(cmd);
    this.lastPointerValue = cmd;
    this.pointerHistory = pushCapped(this.pointerHistory, cmd, POINTER_HISTORY_LIMIT);
    deps.recorder?.record('pointer_dispatched', { turnId: turn?.turnId, command: cmd });
    if (turn !== null) {
      if (turn.tPointerDispatched === undefined) turn.tPointerDispatched = Date.now();
      if (snap !== undefined && turn.snapMs === undefined) turn.snapMs = snap.snapMs;
    }
  }

  /**
   * M9 debug surface (POST /grounding/query): drive the snapper directly
   * against whatever is on screen — no model, no cost. Coordinates in/out
   * are GLOBAL DIP (converted here); the full scored candidate list is
   * returned for diagnosis.
   */
  async debugGroundingQuery(q: {
    x: number;
    y: number;
    label: string;
    radiusPx?: number;
  }): Promise<GroundingDebugReport> {
    const { screen } = this.deps;
    const display = screen.getDisplayNearestPoint({ x: Math.round(q.x), y: Math.round(q.y) });
    const geom = { displayBounds: display.bounds, scaleFactor: display.scaleFactor };
    const phys = (() => {
      try {
        const p = screen.dipToScreenPoint({ x: Math.round(q.x), y: Math.round(q.y) });
        if (p && Number.isFinite(p.x)) return p;
      } catch {
        /* fall through */
      }
      return dipToPhysicalViaMeta({ x: q.x, y: q.y }, geom);
    })();
    const outcome = await this.getUia().snap(
      {
        x: phys.x,
        y: phys.y,
        label: q.label,
        ...(q.radiusPx !== undefined ? { radiusPx: q.radiusPx } : {}),
      },
      { debug: true, timeboxMs: 2_500 },
    );
    let snappedDip: Pt | null = null;
    if (outcome.matched && outcome.point !== null) {
      try {
        snappedDip = screen.screenToDipPoint({
          x: Math.round(outcome.point.x),
          y: Math.round(outcome.point.y),
        });
      } catch {
        snappedDip = physicalToDipViaMeta(outcome.point, geom);
      }
    }
    return {
      query: { ...q, physical: phys },
      matched: outcome.matched,
      snappedDip,
      name: outcome.name,
      score: outcome.score,
      elapsedMs: outcome.elapsedMs,
      daemonMs: outcome.daemonMs,
      timedOut: outcome.timedOut,
      candidates: outcome.debug ?? [],
    };
  }
}
