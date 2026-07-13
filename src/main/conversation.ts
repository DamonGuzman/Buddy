/**
 * Conversation orchestrator (M6): the one place where hotkey, capture,
 * realtime session, overlays and panel meet. index.ts stays wiring-only —
 * it constructs this class and forwards events into it.
 *
 * Owns:
 * - the RealtimeSession (rebuilt when model/voice settings change; API-key
 *   changes are picked up live via the getApiKey callback),
 * - app-level assistant state (single setter, mirrored to overlays + panel),
 * - the voice turn state machine (hold-start/hold-end, short-hold guard,
 *   barge-in), the text turn, tool-call -> pointer dispatch,
 * - the transcript ring buffer (last 50 entries) and the debug counters
 *   surfaced through GET /state.
 *
 * F1 fixes (review findings) concentrated here:
 * - M1/m1: `turnToken` — every new turn (hold, ask, forced cancel) bumps it;
 *   async continuations bail after every await if superseded.
 * - M2: main-owned playback epoch — audio:output deltas carry the epoch of
 *   the response they belong to; cancel/supersede bumps the epoch and the
 *   renderer drops any older-epoch delta (a cancelled response's pre-cancel
 *   burst can no longer play over the next turn).
 * - M3/M5: pendingResponses counts ONLY from the session's
 *   'response-requested' / 'response-done' events; idle is scheduled only
 *   when the count settles at zero.
 * - C1: cancelHold() force-releases a hold as a cancel (watchdog / lock /
 *   suspend), clearing held audio, with no turn.
 * - m5: voice turns get a placeholder user bubble at commit time, filled
 *   in-place when the async ASR transcript arrives.
 */

import { app, screen } from 'electron';
import { AUDIO_SAMPLE_RATE, AUDIO_BYTES_PER_SAMPLE } from '../shared/constants';
import { captureAllDisplays } from './capture';
import type { CaptureResult } from './capture';
import { clampToDisplay, mapModelPoint } from './coords';
import type { MappedPoint } from './coords';
import { GroundingService } from './grounding/snapper';
import { RestGrounder } from './grounding/rest-grounder';
import type { CodexUsedPercent, GroundSource } from './grounding/rest-grounder';
import { dipToPhysicalViaMeta, physicalToDipViaMeta } from './grounding/convert';
import type { Pt } from './grounding/convert';
import { getCodexAuthProvider } from './auth/codex-auth';
import { resolveGroundingAuth } from './auth/auth-source';
import type { CodexProvider, ChatGptCodexAuthSource } from './auth/auth-source';
import { CodexResponsesSession } from './codex/responses-session';
import type {
  CodexFunctionCall,
  CodexResponsesCallbacks,
  CodexToolDef,
  CodexTurnResult,
  CodexUserTurn,
} from './codex/responses-session';
import { classifyError, describeKind } from './errors';
import type { ErrorKind, ErrorParams, ErrorPresentation } from './errors';
import {
  getSessionInstructions,
  getTextInstructions,
  getTextToolDefinitions,
  getToolDefinitions,
} from './persona';
import { RealtimeSession } from './realtime/session';
import type { ToolCall } from './realtime/session';
import type { PointAtArgs } from './realtime/protocol';
import { validatePointAtArgs } from './realtime/protocol';
import type { AgentManager } from './agents/manager';
import type { AgentBrief } from './agents/types';
import type { SettingsStore } from './settings';
import type { OverlayManager } from './windows/overlay';
import { showPanelOnce } from './windows/panel';
import type { PanelManager } from './windows/panel';
import type {
  AssistantState,
  AgentSummary,
  AudioDeviceError,
  CaptureMeta,
  GroundingAttribution,
  PlaybackCommand,
  PlaybackStatsUpdate,
  PointerCommand,
  PointerSnapInfo,
  SessionStatus,
  Settings,
  TranscriptEntry,
  TurnTimings,
} from '../shared/types';

/** Holds shorter than this are treated as accidental taps (no turn). */
const MIN_HOLD_MS = 250;
/**
 * M9 fix: minimum APPENDED mic audio for a commit. The live API rejects
 * commits under 100ms ("buffer too small") and the rejected turn used to
 * wedge the session. A hold can pass the 250ms guard yet carry almost no
 * audio (mic spin-up after a barge-in tap), so the commit itself is gated on
 * what was actually appended. 200ms = 2x the server minimum.
 */
export const MIN_COMMIT_AUDIO_MS = 200;
/** PCM16 mono bytes per millisecond (24kHz * 2 bytes / 1000). */
const AUDIO_BYTES_PER_MS = (AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE) / 1000;
/** Grace after response.done before dropping back to idle. */
const IDLE_GRACE_MS = 300;
/** Error state auto-recovers to idle after this long. */
const ERROR_RECOVERY_MS = 4_000;
/** Transcript ring buffer size (also what GET /transcript returns). */
const TRANSCRIPT_LIMIT = 50;
/** Pointer commands kept for the debug harness. */
const POINTER_HISTORY_LIMIT = 10;
// M8.5 additions (orchestrator-approved): audio-experience eval instrumentation.
/** Turn timings kept for GET /timings. */
const TIMINGS_HISTORY_LIMIT = 20;
/** Per-item playback stats kept for GET /audio/output-stats. */
const OUTPUT_STATS_LIMIT = 20;
// M11 additions: error-catalog surfacing.
/**
 * One failure often fires two surfacing paths within milliseconds (a server
 * `error` event followed by the synthesized failed response-done). Error
 * (pill-grade) transcript entries within this window collapse into the FIRST
 * one — which carries the more specific classification.
 */
const ERROR_DEDUPE_MS = 1_500;
/** Factual context sent with a turn whose screenshot capture failed. */
export const CAPTURE_FAILED_CONTEXT =
  'screen capture failed for this turn — you have NO screenshots. answer from the words ' +
  'alone, say you could not see the screen if it matters, and never call point_at.';

/**
 * M18: the narrow slice of `CodexResponsesSession` the conversation drives for
 * the TEXT panel path. Kept as an interface so tests can inject a fake without
 * the real transport (see `buildCodexSession`).
 */
export interface CodexTextSession {
  submit(turn: CodexUserTurn, cb: CodexResponsesCallbacks): Promise<CodexTurnResult>;
  continue(cb: CodexResponsesCallbacks): Promise<CodexTurnResult>;
  sendToolOutput(callId: string, output: object): void;
  hasPendingToolOutputs(): boolean;
  cancel(): void;
  lastUsedPercent(): CodexUsedPercent | null;
}

export interface ConversationDeps {
  settings: SettingsStore;
  overlays: OverlayManager;
  panel: PanelManager;
  /**
   * M13-core seam: the Codex ChatGPT-subscription auth provider. Optional —
   * defaults to the process-wide `getCodexAuthProvider()` (reads
   * `~/.codex/auth.json`). Injected in unit tests for determinism.
   */
  codexAuth?: CodexProvider;
  /**
   * M18 seam: build the TEXT-path Codex session for a resolved sub. Optional —
   * defaults to a real `CodexResponsesSession` with the text persona + tools.
   * Injected in unit tests to drive the text turn deterministically.
   */
  buildCodexSession?: (auth: ChatGptCodexAuthSource) => CodexTextSession;
  /** Background-agent runtime; omitted in focused conversation tests. */
  agents?: AgentManager;
}

/** Guard on the tool-output continue loop of a single text turn. */
const MAX_CODEX_CONTINUES = 8;

// M17 (integration): `GroundingAttribution` was promoted to the shared
// contract (src/shared/types.ts) so DebugState + the panel can read it; it is
// structurally identical to the M13-core local shape (backend: GroundSource,
// usedPercent: CodexUsedPercent | null). Imported from shared above.

/** Debug-surface snapshot merged into DebugState by index.ts. */
export interface ConversationDebugInfo {
  lastCapture: CaptureMeta[] | null;
  lastPointer: PointerCommand | null;
  pointerHistory: PointerCommand[];
  audio: { chunksIn: number; chunksOut: number };
  captureIndicatorActive: boolean;
  /**
   * M13-core: grounding-auth attribution for the last pointer (which transport
   * ran, and whether the Codex plan quota was hit → fail-closed). Null until a
   * grounding call has been attempted.
   */
  lastGrounding: GroundingAttribution | null;
}

export class Conversation {
  private readonly settings: SettingsStore;
  private readonly overlays: OverlayManager;
  private readonly panel: PanelManager;

  private session: RealtimeSession;
  private sessionModel: string;
  private sessionVoice: string;

  private state: AssistantState = 'idle';

  // Voice turn state.
  private holding = false;
  private holdStartedAt = 0;
  private chunksThisHold = 0;
  /** M9: milliseconds of mic audio actually APPENDED to the session this hold. */
  private holdAudioMs = 0;
  /** Mic chunks are appended to the session only while this is true. */
  private acceptingAudio = false;
  private pendingCaptures: Promise<CaptureResult[]> | null = null;

  // M9: element-snap grounding (docs/EVAL.md §9).
  private grounding: GroundingService | null = null;
  /** CLICKY_NO_SNAP=1 disables snapping (eval A/B attribution). */
  private readonly snapDisabled = process.env['CLICKY_NO_SNAP'] === '1';
  // M10: REST grounding fallback behind the UIA snap (docs/COORD-STUDY.md §9).
  private restGrounder: RestGrounder | null = null;
  /** CLICKY_NO_REST_GROUND=1 disables the REST fallback (eval A/B attribution). */
  private readonly restGroundDisabled = process.env['CLICKY_NO_REST_GROUND'] === '1';
  // M13-core: ChatGPT-subscription grounding (COORD-STUDY §11). The resolver
  // prefers the sub over the metered key when signed in + valid. Resolved
  // lazily (only when a grounding call runs) so tests that never ground don't
  // construct the real provider (which reads ~/.codex/auth.json).
  private readonly injectedCodexAuth: CodexProvider | null;
  /** CLICKY_NO_CODEX_SUB=1 forces the metered API key (eval A/B). */
  private readonly codexDisabled = process.env['CLICKY_NO_CODEX_SUB'] === '1';
  /** M13-core: attribution of the most recent grounding call. */
  private lastGrounding: GroundingAttribution | null = null;
  // M18: TEXT panel path — a typed question runs on gpt-5.6-sol over the Codex
  // sub (text in, text out) with the SAME tool harness, when a valid sub is
  // signed in; otherwise it falls back to the realtime voice model (below).
  private readonly injectedBuildCodex:
    | ((auth: ChatGptCodexAuthSource) => CodexTextSession)
    | null;
  /** Reused across text turns so the session's client-side history gives memory. */
  private codexTextSession: CodexTextSession | null = null;
  /** Plan-usage telemetry of the most recent text turn (debug surface). */
  private codexTextUsedPercent: CodexUsedPercent | null = null;
  private readonly agents: AgentManager | null;
  private agentModeAvailableSnapshot = false;
  private agentSeq = 0;
  private readonly pendingAgentRecaps = new Map<string, AgentSummary>();
  /**
   * M17: the turnToken (episode) for which the `codex_plan_limit` message has
   * already been surfaced — so a multi-point turn that repeatedly hits the
   * spent ChatGPT quota says it ONCE, not once per point.
   */
  private codexPlanLimitSurfacedToken: number | null = null;
  /** Serializes pointer dispatches so multi-point turns stay ordered. */
  private pointerChain: Promise<void> = Promise.resolve();

  /**
   * F1 fix (M1/m1): bumped whenever a new turn supersedes the current one
   * (hold-start, askText, forced cancel, settings rebuild). Every async
   * continuation captures it and bails after each await if it moved on.
   */
  private turnToken = 0;

  /** Captures attached to the most recent committed turn (tool-call mapping). */
  private turnCaptures: CaptureResult[] = [];
  private lastCapture: CaptureMeta[] | null = null;

  /** response.create sent minus response.done received (>=0). */
  private pendingResponses = 0;
  /** Bumped on any turn/response activity; guards the idle-grace timer. */
  private epoch = 0;

  /**
   * F1 fix (M2): main-owned playback epoch. `playbackEpoch` bumps on every
   * cancel/supersede/session-rebuild; `deltaEpoch` is the epoch stamped onto
   * forwarded audio deltas, locked in when a response is requested — so a
   * cancelled response's late deltas always carry a stale epoch.
   */
  private playbackEpoch = 0;
  private deltaEpoch = 0;

  /** F1 fix (m5): placeholder user entry awaiting the async ASR transcript. */
  private pendingVoiceEntryId: string | null = null;

  // Transcript + debug counters.
  private entries: TranscriptEntry[] = [];
  private entrySeq = 0;
  private lastPointer: PointerCommand | null = null;
  private pointerHistory: PointerCommand[] = [];
  private chunksIn = 0;
  private chunksOut = 0;
  private captureIndicatorActive = false;

  private errorTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  // M11: error-catalog surfacing state.
  /** Last pill-grade error transcript entry (dedupe window). */
  private lastPillErrorAt = 0;
  /** Renderer-reported mic capture failure for the CURRENT hold. */
  private micError: { name: string; message: string } | null = null;
  /** Playback is failed until the renderer reports actually-played samples. */
  private playbackFailed = false;
  /** settings_reset is surfaced at most once (on the first turn). */
  private settingsResetSurfaced = false;

  // M8.5 additions (orchestrator-approved): audio-experience eval.
  /** The turn currently accumulating timings (stays set until the next turn). */
  private activeTurn: TurnTimings | null = null;
  private turnSeq = 0;
  private timingsHistory: TurnTimings[] = [];
  /** Response item ids whose audio belongs to the active turn. */
  private turnAudioItems = new Set<string>();
  /** Barge-in in flight: cancel requested, waiting for playback to stop. */
  private bargeWatch: { t0: number; itemIds: Set<string>; turn: TurnTimings } | null = null;
  /** Latest per-item playback stats from the panel's playback tap. */
  private outputStatsList: PlaybackStatsUpdate[] = [];
  /** Last ~15s of PLAYED audio (Int16 PCM 24kHz mono) from the panel. */
  private outputRing: ArrayBuffer | null = null;

  constructor(deps: ConversationDeps) {
    this.settings = deps.settings;
    this.overlays = deps.overlays;
    this.panel = deps.panel;
    // M13-core: hold any injected Codex provider; otherwise the process-wide
    // one is resolved lazily at grounding time (codexProvider()).
    this.injectedCodexAuth = deps.codexAuth ?? null;
    // M18: hold any injected text-session factory (tests); else the default
    // builds a real CodexResponsesSession lazily on the first text turn.
    this.injectedBuildCodex = deps.buildCodexSession ?? null;
    this.agents = deps.agents ?? null;
    this.agentModeAvailableSnapshot = this.agents?.isReady() ?? false;
    const snapshot = this.settings.get();
    this.sessionModel = snapshot.model;
    this.sessionVoice = snapshot.voice;
    this.session = this.buildSession();
    // M9: front-load the snapper daemon's ~1s PowerShell/assembly load so
    // the very first point_at of a session can still snap within the timebox.
    if (!this.snapDisabled) this.getGrounding().warmUp();
  }

  /** M9: lazy grounding service (spawned once, killed in close()). */
  private getGrounding(): GroundingService {
    if (this.grounding === null) {
      this.grounding = new GroundingService({
        scriptDir: app.getPath('userData'),
        excludePid: process.pid, // never scope into our own overlay windows
      });
    }
    return this.grounding;
  }

  /**
   * M10: lazy REST grounder. Same key source as the realtime session
   * (settings, decrypted in main); the grounder never logs or exposes it.
   */
  private getRestGrounder(): RestGrounder {
    if (this.restGrounder === null) {
      this.restGrounder = new RestGrounder({ getApiKey: () => this.settings.getApiKey() });
    }
    return this.restGrounder;
  }

  /**
   * M13-core: the Codex ChatGPT-subscription provider — an injected fake in
   * tests, else the process-wide singleton (constructed on first use so tests
   * that never ground don't read ~/.codex/auth.json).
   */
  private codexProvider(): CodexProvider {
    return this.injectedCodexAuth ?? getCodexAuthProvider();
  }

  /**
   * M18: the TEXT-path Codex session (built once, reused so multi-turn memory
   * replays through its client-side history). The injected factory wins in
   * tests; otherwise a real CodexResponsesSession with the text persona.
   */
  private getCodexSession(auth: ChatGptCodexAuthSource): CodexTextSession {
    if (this.codexTextSession === null) {
      this.codexTextSession = this.injectedBuildCodex
        ? this.injectedBuildCodex(auth)
        : new CodexResponsesSession({
            auth,
            instructions: getTextInstructions(this.agentModeAvailableSnapshot),
            tools: getTextToolDefinitions(this.agentModeAvailableSnapshot) as CodexToolDef[],
          });
    }
    return this.codexTextSession;
  }

  // ---------------------------------------------------------------------
  // Public surface (called from index.ts wiring + debug routes)
  // ---------------------------------------------------------------------

  assistantState(): AssistantState {
    return this.state;
  }

  sessionStatus(): SessionStatus {
    return this.session.status();
  }

  transcript(): TranscriptEntry[] {
    return [...this.entries];
  }

  debugInfo(): ConversationDebugInfo {
    return {
      lastCapture: this.lastCapture,
      lastPointer: this.lastPointer,
      pointerHistory: [...this.pointerHistory],
      audio: { chunksIn: this.chunksIn, chunksOut: this.chunksOut },
      captureIndicatorActive: this.captureIndicatorActive,
      lastGrounding: this.lastGrounding,
    };
  }

  /** Playback passthrough (debug harness + barge-in share this path). */
  playback(command: PlaybackCommand): void {
    this.panel.send('audio:playback', { command, epoch: this.playbackEpoch });
  }

  // ---------------------------------------------------------------------
  // M8.5 (orchestrator-approved): audio-experience eval surface
  // ---------------------------------------------------------------------

  /** Timings of the most recent turn (may still be filling in). */
  lastTurnTimings(): TurnTimings | null {
    return this.activeTurn ? { ...this.activeTurn } : null;
  }

  /** Recent turn timings, oldest first (includes the active turn). */
  turnTimingsHistory(): TurnTimings[] {
    return this.timingsHistory.map((t) => ({ ...t }));
  }

  /** Latest per-item playback stats reported by the panel's playback tap. */
  outputStats(): PlaybackStatsUpdate[] {
    return this.outputStatsList.map((s) => ({ ...s }));
  }

  /** Last ~15s of played audio (Int16 PCM 24kHz mono), if reported yet. */
  lastOutputRing(): ArrayBuffer | null {
    return this.outputRing;
  }

  /** 'audio:playback-stats' from the panel renderer (ipcMain wiring). */
  handlePlaybackStats(stats: PlaybackStatsUpdate): void {
    // M11 (audio_output_failed): samples actually rendered — sound is back,
    // stop forcing captions and re-arm the one-time failure surfacing.
    if (stats.samplesPlayed > 0) this.playbackFailed = false;
    const idx = this.outputStatsList.findIndex((s) => s.itemId === stats.itemId);
    if (idx === -1) {
      this.outputStatsList.push(stats);
      if (this.outputStatsList.length > OUTPUT_STATS_LIMIT) {
        this.outputStatsList = this.outputStatsList.slice(-OUTPUT_STATS_LIMIT);
      }
    } else {
      this.outputStatsList[idx] = stats;
    }
    // First actually-played audio of the active turn.
    if (
      this.activeTurn &&
      this.activeTurn.tFirstAudioPlayed === undefined &&
      this.turnAudioItems.has(stats.itemId) &&
      stats.samplesPlayed > 0
    ) {
      this.activeTurn.tFirstAudioPlayed = stats.firstPlayedAt || Date.now();
    }
    // Barge-in: playback of the cancelled turn's item actually stopped.
    // Release-QA fix: derive the stop moment from the playback tap (wall time
    // of the last rendered sample) instead of Date.now() here — the hotkey
    // press also kicks the screenshot resize/JPEG crunch in main, which
    // delays THIS handler by 100-300ms on a 4K display and used to inflate
    // the metric with pure main-loop congestion (renderer stops in ~10-20ms).
    // firstPlayedAt + samples/rate is exact when underruns == 0 (barge-in
    // items in practice); with underruns it undercounts, so fall back.
    if (this.bargeWatch && stats.done && this.bargeWatch.itemIds.has(stats.itemId)) {
      const renderedStopAt =
        stats.firstPlayedAt + (stats.samplesPlayed / AUDIO_SAMPLE_RATE) * 1000;
      this.bargeWatch.turn.bargeInStopMs =
        stats.underruns === 0 && stats.firstPlayedAt > 0
          ? Math.max(0, Math.round(renderedStopAt - this.bargeWatch.t0))
          : Date.now() - this.bargeWatch.t0;
      this.bargeWatch = null;
    }
  }

  /** 'audio:playback-ring' from the panel renderer (ipcMain wiring). */
  handlePlaybackRing(ring: ArrayBuffer): void {
    this.outputRing = ring;
  }

  /** Start a new TurnTimings record and make it the active turn. */
  private beginTurn(kind: TurnTimings['kind']): TurnTimings {
    this.turnSeq += 1;
    const turn: TurnTimings = {
      turnId: `turn_${this.turnSeq}`,
      kind,
      chunksIn: 0,
      chunksOut: 0,
    };
    this.activeTurn = turn;
    this.turnAudioItems = new Set();
    this.timingsHistory.push(turn);
    if (this.timingsHistory.length > TIMINGS_HISTORY_LIMIT) {
      this.timingsHistory = this.timingsHistory.slice(-TIMINGS_HISTORY_LIMIT);
    }
    return turn;
  }

  /** Short/silent hold produced no turn: drop the record entirely. */
  private discardActiveTurn(): void {
    if (!this.activeTurn) return;
    const idx = this.timingsHistory.indexOf(this.activeTurn);
    if (idx !== -1) this.timingsHistory.splice(idx, 1);
    this.activeTurn = null;
    this.turnAudioItems = new Set();
  }

  /**
   * Hotkey went down: barge in on any playing response, flip to listening,
   * signpost capture, start the panel mic, warm the session, and kick the
   * multi-display capture (not awaited — resolved at hold-end).
   */
  holdStart(): void {
    if (this.closed || this.holding) return;
    // M18: a voice hold supersedes any in-flight TEXT turn (abort the Codex
    // request so its stream stops emitting into the transcript).
    this.codexTextSession?.cancel();
    // BARGE-IN: kill the in-flight response and its queued audio.
    if (this.pendingResponses > 0) this.cancelActiveResponse('stop');
    // Live-eval finding (M8.5): response.done arrives long before the queued
    // audio finishes PLAYING, so a hold can start while a COMPLETED response
    // is still audibly speaking (pendingResponses == 0 — the branch above
    // never runs) and the new turn's audio would queue behind the stale
    // tail. Silence residual playback exactly like a barge-in.
    else this.stopResidualPlayback('stop');
    this.holding = true;
    this.turnToken += 1; // F1 (M1): supersede any pending finishVoiceTurn/askText
    this.holdStartedAt = Date.now();
    this.chunksThisHold = 0;
    this.holdAudioMs = 0; // M9
    this.micError = null; // M11: mic failures are per-hold
    this.maybeSurfaceSettingsReset(); // M11: first turn after a settings reset
    this.acceptingAudio = this.canReachServer();
    this.epoch += 1;
    // F1 (M7): drop stale un-committed audio (a superseded hold's buffer,
    // queued appends from a failed turn) BEFORE this hold's chunks arrive.
    this.session.clearAudio();
    // M8.5: new voice turn timings (after barge-in, so the watch keeps the old turn).
    const turn = this.beginTurn('voice');
    turn.tHoldStart = this.holdStartedAt;
    this.setState('listening');
    this.setCaptureIndicator(true);
    this.panel.send('audio:capture', { command: 'start' });
    if (this.acceptingAudio) {
      // Warm the socket early; failures re-surface (fail-soft) at commit.
      void this.session.connect().catch(() => undefined);
    }
    this.pendingCaptures = captureAllDisplays()
      .then((results) => {
        this.lastCapture = results.map((r) => r.meta);
        // M8.5: capture completed (kicked off at hold-start).
        turn.tCaptureDone = Date.now();
        turn.captureMs = turn.tCaptureDone - this.holdStartedAt;
        return results;
      })
      .catch((err: unknown) => {
        console.warn('[conversation] capture failed, sending turn without images:', err);
        return [] as CaptureResult[];
      });
  }

  /**
   * Hotkey released: stop the mic + indicator. Short/silent holds cancel
   * gracefully; real holds commit the audio with the captured screenshots.
   */
  holdEnd(): void {
    if (this.closed || !this.holding) return;
    this.holding = false;
    this.panel.send('audio:capture', { command: 'stop' });
    this.setCaptureIndicator(false);

    const heldMs = Date.now() - this.holdStartedAt;
    if (heldMs < MIN_HOLD_MS || this.chunksThisHold === 0) {
      // Accidental tap (short hold): no turn, no error.
      this.acceptingAudio = false;
      this.session.clearAudio();
      this.pendingCaptures = null;
      this.discardActiveTurn(); // M8.5: no turn -> no timings record
      // M11 (mic_unavailable): a REAL hold that produced zero mic chunks is a
      // dead/blocked microphone, not a tap — until now this was a silent
      // nothing (the renderer swallowed the capture error and this branch
      // treated it as a tap). The renderer's capture-error report (if any)
      // selects the NotAllowedError privacy-toggle copy variant.
      if (heldMs >= MIN_HOLD_MS && this.chunksThisHold === 0) {
        this.surfaceError(
          describeKind(
            'mic_unavailable',
            this.micError !== null ? { micErrorName: this.micError.name } : {},
          ),
        );
      } else {
        this.setState('idle');
      }
      return;
    }
    if (this.activeTurn) this.activeTurn.tHoldEnd = Date.now(); // M8.5
    void this.finishVoiceTurn();
  }

  /**
   * F1 fix (C1): force-release the current hold as a CANCEL — max-hold
   * watchdog, screen lock, suspend, or a mid-hold settings rebuild. Stops the
   * mic, clears the held audio, produces NO turn, and returns to idle.
   */
  cancelHold(): void {
    if (this.closed || !this.holding) return;
    this.holding = false;
    this.turnToken += 1; // invalidate any in-flight continuation
    this.acceptingAudio = false;
    this.panel.send('audio:capture', { command: 'stop' });
    this.setCaptureIndicator(false);
    this.session.clearAudio();
    this.pendingCaptures = null;
    this.discardActiveTurn();
    this.setState('idle');
  }

  /** Mic PCM chunk from the panel renderer (ipcMain 'audio:chunk'). */
  handleAudioChunk(chunk: ArrayBuffer): void {
    this.chunksIn += 1;
    if (this.holding) {
      this.chunksThisHold += 1;
      if (this.activeTurn?.kind === 'voice') this.activeTurn.chunksIn += 1; // M8.5
    }
    if (this.acceptingAudio) {
      this.session.appendAudio(chunk);
      // M9: track what will actually be committed (see MIN_COMMIT_AUDIO_MS).
      this.holdAudioMs += chunk.byteLength / AUDIO_BYTES_PER_MS;
    }
  }

  /** Typed question from the panel ('panel:ask-text') — same pipeline as voice. */
  async askText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (this.closed || trimmed.length === 0) return;
    this.maybeSurfaceSettingsReset(); // M11: first turn after a settings reset
    // A typed question while the hotkey is held supersedes the hold —
    // never two concurrent turns (m1) / response.creates.
    if (this.holding) this.cancelHold();
    // M18: a new ask supersedes any in-flight TEXT turn (abort the Codex
    // request; its stream stops emitting).
    this.codexTextSession?.cancel();
    // Supersede: cancel the current response and drop its queued audio.
    if (this.pendingResponses > 0) this.cancelActiveResponse('flush');
    // Same live-eval finding as holdStart: a completed response's audio may
    // still be draining — the superseding text turn must silence it.
    else this.stopResidualPlayback('flush');
    this.turnToken += 1; // F1 (m1): supersede any pre-commit turn
    const token = this.turnToken;
    this.epoch += 1;
    // M8.5: new text turn timings.
    const turn = this.beginTurn('text');
    const tAsk = Date.now();
    turn.tAsk = tAsk;
    // The renderer does NOT optimistically echo — main owns the user entry.
    this.pushTranscript({
      id: `user_${Date.now()}_${(this.entrySeq += 1)}`,
      role: 'user',
      text: trimmed,
      streaming: false,
      timestamp: Date.now(),
    });
    this.setState('thinking');

    this.setCaptureIndicator(true);
    let captures: CaptureResult[] = [];
    try {
      captures = await captureAllDisplays();
    } catch (err) {
      console.warn('[conversation] capture failed, asking without images:', err);
    } finally {
      this.setCaptureIndicator(false);
    }
    // F1 (m1): a newer ask/hold superseded this one while it was capturing —
    // do not create a second concurrent response, do not stomp its state.
    if (this.closed || token !== this.turnToken) return;
    // M8.5: capture completed.
    turn.tCaptureDone = Date.now();
    turn.captureMs = turn.tCaptureDone - tAsk;
    this.lastCapture = captures.map((r) => r.meta);
    this.turnCaptures = captures;

    // M11 (capture_failed): the turn is going ahead with ZERO screenshots —
    // tell the user (transcript + caption) and tell the MODEL via the factual
    // context part so it doesn't pretend to see the screen.
    let contextText = '';
    if (captures.length === 0) {
      this.surfaceError(describeKind('capture_failed'));
      contextText = CAPTURE_FAILED_CONTEXT;
    }

    // M18: route the typed question. When a valid ChatGPT (Codex) sub is
    // signed in, the answer runs text-in/text-out on gpt-5.6-sol (sub-billed —
    // works even with the metered key out of credit), with the SAME tool
    // harness + screenshots. Otherwise fall back to the realtime voice model
    // so text still works for non-signed-in users.
    const auth = resolveGroundingAuth({
      getApiKey: () => this.settings.getApiKey(),
      codex: this.codexProvider(),
      preferApiKey: this.codexDisabled || this.settings.get().preferApiKeyGrounding,
    });
    // The mock-realtime harness must remain deterministic even on a developer
    // machine that happens to be signed in to Codex. Focused Codex tests opt in
    // by injecting buildCodexSession; production has no CLICKY_MOCK_URL.
    const codexTextAllowed = !process.env['CLICKY_MOCK_URL'] || this.injectedBuildCodex !== null;
    if (codexTextAllowed && auth !== null && auth.kind === 'chatgptCodex') {
      await this.runCodexTextTurn(trimmed, captures, contextText, token, turn, auth);
      return;
    }

    try {
      await this.session.askText(trimmed, captures, contextText);
      turn.tCommitSent = Date.now(); // M8.5
      // pendingResponses counted via 'response-requested' (M3).
    } catch (err) {
      if (token === this.turnToken) this.failTurn(err);
    }
  }

  // ---------------------------------------------------------------------
  // M18: text turn on the Codex subscription (gpt-5.6-sol, text in/out)
  // ---------------------------------------------------------------------

  /**
   * Run one typed turn on the Codex Responses backend: stream text to the
   * transcript (+ caption), dispatch point_at through the shared dispatcher in
   * TEXT-ACCURATE mode (skips the redundant REST grounding — sol is already
   * pixel-exact per COORD-STUDY §11), and round-trip tool outputs like voice.
   * Fails closed on plan quota (codex_plan_limit) instead of spending the key.
   */
  private async runCodexTextTurn(
    text: string,
    captures: CaptureResult[],
    contextText: string,
    token: number,
    turn: TurnTimings,
    auth: ChatGptCodexAuthSource,
  ): Promise<void> {
    const session = this.getCodexSession(auth);
    const framing = buildCodexFraming(
      captures.map((c) => c.meta),
      contextText,
    );
    const input: CodexUserTurn = {
      text,
      ...(framing.length > 0 ? { context: framing } : {}),
      images: captures.map((c) => ({ jpegBase64: c.jpegBase64 })),
    };
    const cb: CodexResponsesCallbacks = {
      onTextDelta: (itemId, full) => this.onCodexTextDelta(itemId, full, token),
      onTextDone: (itemId, done) => this.onCodexTextDone(itemId, done, token),
      onFunctionCall: (call) => this.onCodexFunctionCall(call, captures, token),
      onCompleted: (info) => {
        this.codexTextUsedPercent = info.usedPercent;
      },
      // Transport/protocol errors surface via the returned result below.
      onError: () => undefined,
    };

    let result: CodexTurnResult;
    try {
      result = await session.submit(input, cb);
    } catch (err) {
      if (token === this.turnToken) this.failTurn(err);
      return;
    }
    turn.tCommitSent ??= Date.now();
    this.codexTextUsedPercent = result.usedPercent ?? this.codexTextUsedPercent;
    if (this.closed || token !== this.turnToken) return;
    if (result.quotaExhausted) {
      this.surfaceCodexPlanLimit(token);
      return;
    }
    if (result.aborted) return; // superseded mid-stream
    if (result.error !== null) {
      this.failTurn(result.error);
      return;
    }

    // Tool round-trip: buffered function_call_output(s) -> continue, like voice.
    let guard = 0;
    while (
      session.hasPendingToolOutputs() &&
      !this.closed &&
      token === this.turnToken &&
      guard < MAX_CODEX_CONTINUES
    ) {
      guard += 1;
      let next: CodexTurnResult;
      try {
        next = await session.continue(cb);
      } catch (err) {
        if (token === this.turnToken) this.failTurn(err);
        return;
      }
      this.codexTextUsedPercent = next.usedPercent ?? this.codexTextUsedPercent;
      if (this.closed || token !== this.turnToken) return;
      if (next.quotaExhausted) {
        this.surfaceCodexPlanLimit(token);
        return;
      }
      if (next.aborted) return;
      if (next.error !== null) {
        this.failTurn(next.error);
        return;
      }
    }

    this.finishCodexTextTurn(token);
  }

  /** Streamed assistant text (full-so-far) -> transcript + caption (streaming). */
  private onCodexTextDelta(itemId: string, full: string, token: number): void {
    if (this.closed || token !== this.turnToken) return;
    if (this.activeTurn && this.activeTurn.tFirstAssistantTranscript === undefined) {
      this.activeTurn.tFirstAssistantTranscript = Date.now();
    }
    if (this.settings.get().captionsEnabled) {
      this.overlays.broadcast('overlay:caption', { itemId, text: full, done: false });
    }
    const existing = this.entries.find((e) => e.id === itemId);
    this.pushTranscript({
      id: itemId,
      role: 'assistant',
      text: full,
      streaming: true,
      timestamp: existing?.timestamp ?? Date.now(),
    });
  }

  /** A text item finished -> finalize transcript + caption. */
  private onCodexTextDone(itemId: string, done: string, token: number): void {
    if (this.closed || token !== this.turnToken) return;
    if (this.settings.get().captionsEnabled) {
      this.overlays.broadcast('overlay:caption', { itemId, text: done, done: true });
    }
    const existing = this.entries.find((e) => e.id === itemId);
    this.pushTranscript({
      id: itemId,
      role: 'assistant',
      text: done,
      streaming: false,
      timestamp: existing?.timestamp ?? Date.now(),
    });
  }

  /**
   * A complete tool call from the text model. point_at buffers its tool output
   * immediately (the answer is never gated on grounding) and kicks the async
   * pointer dispatch through the SHARED dispatcher in text-accurate mode.
   */
  private onCodexFunctionCall(
    call: CodexFunctionCall,
    captures: CaptureResult[],
    token: number,
  ): void {
    if (this.closed || token !== this.turnToken) return;
    const session = this.codexTextSession;
    if (session === null) return;
    if (this.activeTurn && this.activeTurn.tFirstToolCall === undefined) {
      this.activeTurn.tFirstToolCall = Date.now();
    }
    if (call.name === 'spawn_agent') {
      let parsed: unknown;
      try { parsed = JSON.parse(call.argsJson); } catch { parsed = {}; }
      session.sendToolOutput(call.callId, this.spawnAgent(parsed));
      return;
    }
    if (call.name !== 'point_at') {
      session.sendToolOutput(call.callId, { error: `unknown tool: ${call.name}` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.argsJson);
    } catch {
      session.sendToolOutput(call.callId, { error: 'arguments were not valid JSON' });
      return;
    }
    const metas = captures.map((c) => c.meta);
    const args = validatePointAtArgs(parsed, metas);
    if (args === null) {
      session.sendToolOutput(call.callId, { error: 'x, y and screen must be numbers' });
      return;
    }
    const byIndex = captures.find((c) => c.meta.screenIndex === args.screen);
    const capture = byIndex ?? captures.find((c) => c.meta.isActive) ?? captures[0];
    if (!capture) {
      session.sendToolOutput(call.callId, { error: 'no screenshot available for that screen' });
      return;
    }
    const mapped = mapModelPoint(
      { x: args.x, y: args.y, ...(args.label !== undefined ? { label: args.label } : {}) },
      capture.meta,
    );
    session.sendToolOutput(call.callId, { ok: true, pointed_at: args.label ?? '' });
    this.pointerChain = this.pointerChain.then(() =>
      this.dispatchPointer(args, capture, mapped, { primaryModelIsAccurate: true }),
    );
  }

  /** codex_plan_limit copy, once per text turn (matches the grounding path). */
  private surfaceCodexPlanLimit(token: number): void {
    if (this.codexPlanLimitSurfacedToken === token) return;
    this.codexPlanLimitSurfacedToken = token;
    this.surfaceError(describeKind('codex_plan_limit'));
  }

  /** Settle a completed text turn: finalize any streaming entry, back to idle. */
  private finishCodexTextTurn(token: number): void {
    if (this.closed || token !== this.turnToken) return;
    for (const entry of this.entries) {
      if (entry.streaming && entry.role === 'assistant') {
        this.pushTranscript({ ...entry, streaming: false });
      }
    }
    if (this.activeTurn) this.activeTurn.tResponseDone = Date.now();
    if (this.state !== 'error') this.setState('idle');
  }

  /** Settings changed: model/voice require a fresh session (key does not). */
  onSettingsChanged(next: Settings): void {
    if (next.model === this.sessionModel && next.voice === this.sessionVoice) return;
    this.sessionModel = next.model;
    this.sessionVoice = next.voice;
    this.rebuildRealtimeSession();
  }

  /** Rebuild tool/persona availability when the Codex sign-in changes. */
  onAgentAvailabilityChanged(): void {
    const available = this.agents?.isReady() ?? false;
    if (available === this.agentModeAvailableSnapshot) return;
    this.agentModeAvailableSnapshot = available;
    this.codexTextSession?.cancel();
    this.codexTextSession = null;
    this.rebuildRealtimeSession();
  }

  /** AgentManager completion hook: panel is already updated; deliver by voice when possible. */
  deliverAgentResult(summary: AgentSummary): void {
    if (this.closed) return;
    this.pendingAgentRecaps.set(summary.id, summary);
    if (this.session.status().state !== 'ready' || this.holding || this.pendingResponses > 0) return;
    const context = this.agentRecapContext([summary]);
    this.pendingAgentRecaps.delete(summary.id);
    this.agents?.markSpoken(summary.id);
    this.setState('thinking');
    void this.session.injectSystemAndRespond(context).catch((error) => {
      this.pendingAgentRecaps.set(summary.id, summary);
      this.failTurn(error);
    });
  }

  private rebuildRealtimeSession(): void {
    // F1 fix (m3): a mid-turn rebuild must not leave debris.
    if (this.holding) this.cancelHold(); // graceful: mic released, no turn
    // M18: abort any in-flight text turn too (its stream stops emitting).
    this.codexTextSession?.cancel();
    this.turnToken += 1;
    // Flush playback under the new epoch so queued/in-flight audio of the
    // dying session can never play into the rebuilt one.
    this.playbackEpoch += 1;
    this.panel.send('audio:playback', { command: 'flush', epoch: this.playbackEpoch });
    // Finalize any transcript entries left mid-stream by the dying session.
    for (const entry of this.entries) {
      if (entry.streaming) this.pushTranscript({ ...entry, streaming: false });
    }
    this.resolveVoicePlaceholder('(voice message)');
    this.session.close();
    this.session.removeAllListeners();
    this.pendingResponses = 0;
    this.session = this.buildSession();
    this.panel.send('panel:session-status', this.session.status());
    if (this.state !== 'idle' && this.state !== 'error') this.setState('idle');
  }

  /**
   * F1 fix (sleep/resume): powerMonitor 'resume' — the socket may be
   * half-open. Reset it; the next turn reconnects lazily. If a response was
   * mid-flight the session synthesizes a failed response-done and the normal
   * recovery path (failTurn -> error -> auto-recover) runs.
   */
  onSystemResume(): void {
    if (this.closed) return;
    this.session.notifySystemResume();
  }

  /** App shutdown. */
  close(): void {
    this.closed = true;
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.errorTimer = null;
    this.idleTimer = null;
    this.grounding?.dispose(); // M9: kill the snapper daemon
    this.codexTextSession?.cancel(); // M18: abort any in-flight text turn
    this.session.close();
  }

  // ---------------------------------------------------------------------
  // Voice turn completion
  // ---------------------------------------------------------------------

  private async finishVoiceTurn(): Promise<void> {
    const token = this.turnToken; // F1 (M1)
    this.setState('thinking');
    const captures = (await (this.pendingCaptures ?? Promise.resolve([]))) ?? [];
    // F1 fix (M1): a new hold/ask started while captureAllDisplays() was
    // pending — this turn is superseded. Do NOT stomp the new turn's
    // acceptingAudio/turnCaptures, do NOT commit its early chunks into this
    // turn, do NOT commit an empty buffer.
    if (this.closed || this.holding || token !== this.turnToken) return;
    this.pendingCaptures = null;
    this.turnCaptures = captures;
    // Stop appending: everything after this belongs to the next turn.
    this.acceptingAudio = false;
    // M9 fix: the hold passed the 250ms guard but almost no audio was
    // actually appended (mic spin-up after a barge-in tap delivers the first
    // chunk late). The live API rejects commits under 100ms of audio
    // ("buffer too small") and the turn used to error-wedge — treat it like
    // a short hold instead: clear, no commit, back to idle. holdAudioMs == 0
    // means audio was never accepted (no key / unreachable): fall through so
    // the commit path surfaces the real error ("add your openai key").
    if (this.holdAudioMs > 0 && this.holdAudioMs < MIN_COMMIT_AUDIO_MS) {
      console.warn(
        `[conversation] hold carried only ${Math.round(this.holdAudioMs)}ms of audio ` +
          `(< ${MIN_COMMIT_AUDIO_MS}ms) — cancelling instead of committing`,
      );
      this.session.clearAudio();
      this.discardActiveTurn();
      this.setState('idle');
      return;
    }
    // F1 fix (m5): placeholder user bubble NOW, so the user's question can
    // never appear below the assistant's answer (async ASR). Filled in-place
    // by 'user-transcript'; falls back to "(voice message)" at turn end.
    const placeholderId = `user_voice_${Date.now()}_${(this.entrySeq += 1)}`;
    this.pendingVoiceEntryId = placeholderId;
    this.pushTranscript({
      id: placeholderId,
      role: 'user',
      text: '…',
      streaming: true,
      timestamp: Date.now(),
    });
    // M11 (capture_failed): committing with ZERO screenshots — tell the user
    // (transcript + caption) and tell the MODEL via the factual context part.
    let contextText = '';
    if (captures.length === 0) {
      this.surfaceError(describeKind('capture_failed'));
      contextText = CAPTURE_FAILED_CONTEXT;
    }
    const recap = this.consumePendingAgentRecaps();
    if (recap) contextText = contextText ? `${contextText}\n\n${recap}` : recap;
    try {
      await this.session.commitAudioAndRespond(captures, contextText);
      if (this.activeTurn) this.activeTurn.tCommitSent = Date.now(); // M8.5
      // pendingResponses counted via 'response-requested' (M3).
    } catch (err) {
      if (token === this.turnToken) this.failTurn(err);
    }
  }

  /**
   * A turn could not be started/committed (or died mid-flight): fail soft,
   * never crash. M11: the string-matching is gone — the error catalog
   * (src/main/errors.ts) classifies the failure and owns the copy.
   */
  private failTurn(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[conversation] turn failed:', message);
    // F1 (M7): the failed turn's audio must never leak into the next turn.
    this.session.clearAudio();
    this.resolveVoicePlaceholder('(voice message)');
    let pres = classifyError(err, { model: this.sessionModel });
    // M11 (api_key_unreadable): "no key" while an (undecryptable) blob IS
    // stored means DPAPI lost the key — the fix is a re-paste, not an add.
    if (pres.kind === 'no_api_key' && this.settings.get().apiKeyUnreadable) {
      pres = describeKind('api_key_unreadable');
    }
    this.surfaceError(pres);
  }

  // ---------------------------------------------------------------------
  // M11: error-catalog surfacing
  // ---------------------------------------------------------------------

  /**
   * Surface a catalog kind directly — index.ts wiring uses this for failures
   * the conversation cannot observe itself (hotkey_dead, hold_too_long).
   */
  reportError(kind: ErrorKind, params?: ErrorParams): void {
    if (this.closed) return;
    this.surfaceError(describeKind(kind, params));
  }

  /**
   * 'audio:capture-error' from the panel renderer (ipcMain wiring):
   * mic capture failed to start, or the playback pipeline failed to init.
   */
  handleAudioDeviceError(payload: AudioDeviceError): void {
    if (this.closed) return;
    if (payload.source === 'mic') {
      console.warn(`[conversation] mic capture error: ${payload.name}: ${payload.message}`);
      // Remembered for the hold in progress; surfaced at hold end when the
      // hold really produced zero audio (real-hold-with-zero-chunks branch).
      this.micError = { name: payload.name, message: payload.message };
      return;
    }
    console.warn(`[conversation] playback init error: ${payload.name}: ${payload.message}`);
    if (!this.playbackFailed) {
      this.playbackFailed = true;
      // Captions are forced on while playback is down (see the
      // assistant-transcript listener) so the answer still reaches the user.
      this.surfaceError(describeKind('audio_output_failed'));
    }
  }

  /**
   * Route one classified failure to its surfaces: transcript system entry,
   * assistant error state ('pill'), overlay caption, and the once-per-kind
   * panel auto-show. The single place the policy is enforced.
   */
  private surfaceError(pres: ErrorPresentation): void {
    const now = Date.now();
    const isPill = pres.surfaces.includes('pill');
    // Dedupe: one failure, two paths (server error event + synthesized failed
    // response-done) — the FIRST entry (more specific classification) wins.
    const suppressed = isPill && now - this.lastPillErrorAt < ERROR_DEDUPE_MS;
    if (pres.surfaces.includes('transcript') && !suppressed) {
      this.pushTranscript({
        id: `sys_${now}_${(this.entrySeq += 1)}`,
        role: 'system',
        text: pres.message,
        streaming: false,
        timestamp: now,
      });
    }
    if (pres.surfaces.includes('caption') && !suppressed) {
      this.overlays.broadcast('overlay:caption', {
        itemId: `sys_err_${now}_${this.entrySeq}`,
        text: pres.message,
        done: true,
      });
    }
    // Actionable kinds surface the panel — at most once per KIND per run
    // (first-run discoverability no longer consumes this budget).
    if (pres.autoShowPanel && pres.kind !== 'unknown') showPanelOnce(pres.kind);
    if (isPill) {
      this.lastPillErrorAt = now;
      this.setState('error');
    }
  }

  /** M11 (settings_reset): one transcript entry + auto-show, on the first turn. */
  private maybeSurfaceSettingsReset(): void {
    if (this.settingsResetSurfaced) return;
    if (typeof this.settings.settingsWereReset !== 'function') return; // test fakes
    if (!this.settings.settingsWereReset()) return;
    this.settingsResetSurfaced = true;
    this.surfaceError(describeKind('settings_reset'));
  }

  /**
   * M11: re-send the transcript ring + status snapshots to a (re)loaded panel
   * renderer — entries pushed before the renderer existed (boot-time errors)
   * or before a crash-recreate were otherwise lost. Upsert semantics make the
   * replay idempotent.
   */
  replayToPanel(): void {
    for (const entry of this.entries) this.panel.send('panel:transcript', entry);
    this.panel.send('panel:session-status', this.session.status());
    this.panel.send('panel:assistant-state', this.state);
  }

  private canReachServer(): boolean {
    return this.session.usingMock || this.settings.getApiKey() !== null;
  }

  /**
   * Cancel the in-flight response (barge-in uses 'stop', a superseding text
   * turn uses 'flush') and finalize any transcript entries the cancelled
   * response left mid-stream, so the panel never shows a stuck typing state.
   */
  private cancelActiveResponse(playback: PlaybackCommand): void {
    // M8.5: measure cancel -> playback-actually-stopped on the cancelled turn.
    if (this.activeTurn && this.turnAudioItems.size > 0) {
      this.bargeWatch = {
        t0: Date.now(),
        itemIds: new Set(this.turnAudioItems),
        turn: this.activeTurn,
      };
    }
    this.session.cancelResponse();
    // F1 fix (M2): bump the playback epoch and flush under it. The renderer
    // drops any audio delta tagged with an older epoch, so the cancelled
    // response's pre-cancel burst (whose first chunk may not have reached
    // the renderer yet — nothing to mark stale by itemId) stays silent.
    this.playbackEpoch += 1;
    this.panel.send('audio:playback', { command: playback, epoch: this.playbackEpoch });
    // NOTE (M3): pendingResponses is NOT zeroed here — the cancelled
    // response's own response.done (status 'cancelled') decrements it, so
    // the count stays a pure request/done ledger.
    for (const entry of this.entries) {
      if (entry.streaming) this.pushTranscript({ ...entry, streaming: false });
    }
  }

  /**
   * Live-eval fix (M8.5): silence audio still draining from a COMPLETED
   * response (pendingResponses == 0, so cancelActiveResponse never runs).
   * When the old turn's audio was genuinely mid-play, arm the same bargeWatch
   * so bargeInStopMs is measured for this path too.
   */
  private stopResidualPlayback(command: PlaybackCommand): void {
    const stillPlaying = this.outputStatsList.some(
      (s) => this.turnAudioItems.has(s.itemId) && !s.done,
    );
    if (stillPlaying && this.activeTurn) {
      this.bargeWatch = {
        t0: Date.now(),
        itemIds: new Set(this.turnAudioItems),
        turn: this.activeTurn,
      };
    }
    this.playbackEpoch += 1;
    this.panel.send('audio:playback', { command, epoch: this.playbackEpoch });
  }

  /** F1 (m5): finalize the placeholder voice bubble in place. */
  private resolveVoicePlaceholder(text: string): void {
    if (this.pendingVoiceEntryId === null) return;
    const id = this.pendingVoiceEntryId;
    this.pendingVoiceEntryId = null;
    const existing = this.entries.find((e) => e.id === id);
    if (!existing) return;
    this.pushTranscript({ ...existing, text, streaming: false });
  }

  // ---------------------------------------------------------------------
  // Session events
  // ---------------------------------------------------------------------

  private buildSession(): RealtimeSession {
    const session = new RealtimeSession({
      model: this.sessionModel,
      voice: this.sessionVoice,
      instructions: getSessionInstructions(this.agentModeAvailableSnapshot),
      tools: getToolDefinitions(this.agentModeAvailableSnapshot),
      getApiKey: () => this.settings.getApiKey(),
    });
    this.wireSession(session);
    return session;
  }

  private wireSession(session: RealtimeSession): void {
    session.on('status', (status) => this.panel.send('panel:session-status', status));

    // F1 fix (M3): the ONLY place pendingResponses increments — fired for
    // every response.create the session sends (turns, tool continues,
    // internal tool-arg rejections alike).
    session.on('response-requested', () => {
      this.pendingResponses += 1;
      this.epoch += 1;
      // F1 (M2): deltas of the response being requested belong to the
      // playback epoch that is current NOW.
      this.deltaEpoch = this.playbackEpoch;
      if (this.idleTimer !== null) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    });

    session.on('user-transcript', ({ itemId, text }) => {
      if (this.activeTurn && this.activeTurn.tFirstUserTranscript === undefined) {
        this.activeTurn.tFirstUserTranscript = Date.now(); // M8.5
      }
      // F1 (m5): fill the placeholder bubble in place (keeps its position
      // above the assistant's answer).
      if (this.pendingVoiceEntryId !== null) {
        const id = this.pendingVoiceEntryId;
        this.pendingVoiceEntryId = null;
        const existing = this.entries.find((e) => e.id === id);
        if (existing) {
          this.pushTranscript({ ...existing, text, streaming: false });
          return;
        }
      }
      this.pushTranscript({
        id: itemId,
        role: 'user',
        text,
        streaming: false,
        timestamp: Date.now(),
      });
    });

    session.on('assistant-transcript', ({ itemId, text, done }) => {
      this.noteResponseActivity();
      if (this.activeTurn && this.activeTurn.tFirstAssistantTranscript === undefined) {
        this.activeTurn.tFirstAssistantTranscript = Date.now(); // M8.5
      }
      // M11 (audio_output_failed): captions are FORCED on while playback is
      // failed — the spoken answer would otherwise be lost entirely.
      if (this.settings.get().captionsEnabled || this.playbackFailed) {
        this.overlays.broadcast('overlay:caption', { itemId, text, done });
      }
      const existing = this.entries.find((e) => e.id === itemId);
      this.pushTranscript({
        id: itemId,
        role: 'assistant',
        text,
        streaming: !done,
        timestamp: existing?.timestamp ?? Date.now(),
      });
    });

    session.on('audio-delta', ({ itemId, chunk }) => {
      this.noteResponseActivity();
      this.chunksOut += 1;
      // M8.5: first audio delta + per-turn chunk count + item ownership.
      if (this.activeTurn) {
        if (this.activeTurn.tFirstAudioDelta === undefined) {
          this.activeTurn.tFirstAudioDelta = Date.now();
        }
        this.activeTurn.chunksOut += 1;
        this.turnAudioItems.add(itemId);
      }
      // F1 (M2): tag the delta with its response's playback epoch.
      this.panel.send('audio:output', { chunk, itemId, epoch: this.deltaEpoch });
    });

    session.on('tool-call', (call) => {
      this.noteResponseActivity();
      if (this.activeTurn && this.activeTurn.tFirstToolCall === undefined) {
        this.activeTurn.tFirstToolCall = Date.now(); // M8.5
      }
      this.handleToolCall(call);
    });

    session.on('response-done', ({ status, usage }) => {
      this.pendingResponses = Math.max(0, this.pendingResponses - 1);
      // M8.5 live eval: accumulate token usage across the turn's responses.
      if (usage && this.activeTurn) {
        const u = (this.activeTurn.usage ??= {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputTextTokens: 0,
          inputAudioTokens: 0,
          inputImageTokens: 0,
          cachedTokens: 0,
          outputTextTokens: 0,
          outputAudioTokens: 0,
          responses: 0,
        });
        u.inputTokens += usage.input_tokens ?? 0;
        u.outputTokens += usage.output_tokens ?? 0;
        u.totalTokens += usage.total_tokens ?? 0;
        u.inputTextTokens += usage.input_token_details?.text_tokens ?? 0;
        u.inputAudioTokens += usage.input_token_details?.audio_tokens ?? 0;
        u.inputImageTokens += usage.input_token_details?.image_tokens ?? 0;
        u.cachedTokens += usage.input_token_details?.cached_tokens ?? 0;
        u.outputTextTokens += usage.output_token_details?.text_tokens ?? 0;
        u.outputAudioTokens += usage.output_token_details?.audio_tokens ?? 0;
        u.responses += 1;
      }
      // A cancelled response was superseded — the superseding turn owns the
      // assistant state from here; nothing to settle.
      if (status === 'cancelled') return;
      // F1 fix (M5): only settle the turn when NO responses remain
      // outstanding (a tool-call follow-up keeps the buddy speaking).
      if (this.pendingResponses > 0) return;
      // M8.5: the LAST response.done of the turn (after tool continuations).
      if (this.activeTurn) this.activeTurn.tResponseDone = Date.now();
      // F1 (m5): ASR never arrived for this voice turn.
      this.resolveVoicePlaceholder('(voice message)');
      // F1 (retention): the turn settled — release the capture buffers now
      // instead of holding multi-MB screenshots until the next turn.
      this.turnCaptures = [];
      if (status === 'failed' && !this.closed) {
        // F1 fix (M6): a response failed (socket drop, watchdog, server
        // error event) — run the normal turn-failure recovery. M11: the old
        // `state !== 'error'` gate is gone — the response_interrupted copy
        // must still land after a server error event flipped the state
        // (surfaceError's dedupe window keeps it to one entry per failure).
        this.failTurn(new Error('the response was interrupted'));
        return;
      }
      // M11 (response_incomplete): status 'incomplete' used to be treated as
      // success — the answer just stopped mid-sentence with no
      // acknowledgement. Not an error state; one system entry.
      if (status === 'incomplete' && !this.closed) {
        this.surfaceError(describeKind('response_incomplete'));
      }
      this.scheduleIdle();
    });

    session.on('error', (err) => {
      console.error('[conversation] session error:', err.message);
      this.epoch += 1;
      if (this.closed) return;
      // M11: mid-hold connect failures (the fire-and-forget connect kicked by
      // appendAudio) must not flip the listening indicator to a red flash
      // while the user is still talking — the commit at hold end resolves the
      // turn through failTurn with the same classification.
      if (this.holding) return;
      // Panel session-status was already pushed by the 'status' listener.
      // M11: a mid-session server error is no longer a WORDLESS red flash —
      // classified catalog copy (rate_limited, server_error, ...) reaches the
      // transcript; unclassified errors keep `something went wrong: <detail>`.
      this.surfaceError(classifyError(err, { model: this.sessionModel }));
    });
  }

  /** First transcript/audio activity of a response flips thinking -> speaking. */
  private noteResponseActivity(): void {
    this.epoch += 1;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.holding) return;
    if (this.state === 'thinking' || this.state === 'speaking') {
      this.setState('speaking');
    } else if (this.state === 'idle' && this.pendingResponses > 0) {
      // F1 fix (M5): a follow-up response can start streaming after the
      // buddy already dropped to idle — promote back to speaking.
      this.setState('speaking');
    }
  }

  /** ~300ms after the turn settles with no new activity: back to idle. */
  private scheduleIdle(): void {
    const epochAtDone = this.epoch;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.closed || this.holding || this.epoch !== epochAtDone) return;
      if (this.state === 'speaking' || this.state === 'thinking') {
        // Overlay pointer auto-homes; no 'idle' pointer command needed.
        this.setState('idle');
      }
    }, IDLE_GRACE_MS);
  }

  // ---------------------------------------------------------------------
  // Tool calls -> pointer
  // ---------------------------------------------------------------------

  private handleToolCall(call: ToolCall): void {
    if (call.name === 'spawn_agent') {
      this.session.sendToolOutput(call.callId, this.spawnAgent(call.args));
      this.session.continueResponse();
      return;
    }
    if (call.name !== 'point_at') {
      this.session.sendToolOutput(call.callId, { error: `unknown tool: ${call.name}` });
      this.session.continueResponse(); // deferred until response.done (M4)
      return;
    }
    // Session pre-validated/clamped these (validatePointAtArgs).
    const args = call.args as PointAtArgs;
    const byIndex = this.turnCaptures.find((c) => c.meta.screenIndex === args.screen);
    // Unknown screen index: fall back to the ACTIVE screen's capture (m2).
    const capture = byIndex ?? this.turnCaptures.find((c) => c.meta.isActive) ?? this.turnCaptures[0];
    if (!capture) {
      this.session.sendToolOutput(call.callId, {
        error: 'no screenshot available for that screen',
      });
      this.session.continueResponse();
      return;
    }
    const mapped = mapModelPoint(
      { x: args.x, y: args.y, ...(args.label !== undefined ? { label: args.label } : {}) },
      capture.meta,
    );
    // M9: tool output + continue go back IMMEDIATELY (the model's answer is
    // not gated on grounding); the pointer itself is dispatched async, after
    // the element-snap query (<= its timebox). The chain keeps multi-point
    // turns in call order.
    this.session.sendToolOutput(call.callId, { ok: true, pointed_at: args.label ?? '' });
    // F1 fix (M4): the continue is deferred inside the session until the
    // current response completes; accounting flows via 'response-requested'.
    this.session.continueResponse();
    this.pointerChain = this.pointerChain.then(() => this.dispatchPointer(args, capture, mapped));
  }

  private spawnAgent(value: unknown): object {
    if (this.agents === null) return { error: 'agent mode is unavailable' };
    const args = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    const task = typeof args['task'] === 'string' ? args['task'].trim().slice(0, 2_000) : '';
    if (!task) return { error: 'task is required' };
    const why = typeof args['why'] === 'string' ? args['why'].trim().slice(0, 1_000) : '';
    const capture = this.turnCaptures.find((item) => item.meta.isActive) ?? this.turnCaptures[0];
    const id = `agent_${(this.agentSeq += 1)}_${Date.now()}`;
    const brief: AgentBrief = {
      id,
      task,
      ...(why ? { why } : {}),
      ...(capture ? { screenshot: { jpegBase64: capture.jpegBase64, meta: capture.meta } } : {}),
      recentTranscript: this.entries
        .slice(-6)
        .map((entry) => `${entry.role === 'assistant' ? 'clicky' : entry.role}: ${entry.text}`)
        .join('\n')
        .slice(-1_500),
      createdAt: Date.now(),
    };
    const result = this.agents.spawn(brief);
    if (result.ok) return { ok: true, agent_id: result.agentId };
    if (result.reason === 'at_capacity') return { error: 'at capacity — three agents are already running' };
    showPanelOnce('agent_not_signed_in');
    return { error: 'agent mode needs chatgpt sign-in' };
  }

  private consumePendingAgentRecaps(): string {
    if (this.pendingAgentRecaps.size === 0) return '';
    const summaries = [...this.pendingAgentRecaps.values()];
    this.pendingAgentRecaps.clear();
    for (const summary of summaries) this.agents?.markSpoken(summary.id);
    return this.agentRecapContext(summaries);
  }

  private agentRecapContext(summaries: AgentSummary[]): string {
    const details = summaries.map((summary) => {
      const result = summary.summary || summary.error || 'the agent stopped without a result';
      return `task: ${summary.task}\nstatus: ${summary.status}\nresult: ${result}`;
    }).join('\n\n');
    return `background agent result(s) are ready. briefly tell the person the useful conclusion in your natural voice; do not read urls aloud.\n\n${details}`;
  }

  /**
   * M9/M10 layered grounding: ground the model's (already §6-mapped) point,
   * then fly the buddy. Layers, in order (docs/ARCHITECTURE.md §6b):
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
   */
  private async dispatchPointer(
    args: PointAtArgs,
    capture: CaptureResult,
    mapped: MappedPoint & { adjusted: boolean },
    opts: { primaryModelIsAccurate?: boolean } = {},
  ): Promise<void> {
    const token = this.turnToken;
    const turn = this.activeTurn;
    const meta = capture.meta;
    const textAccurate = opts.primaryModelIsAccurate === true;
    let local = mapped.local;
    let snap: PointerSnapInfo | undefined;
    let groundingSource: 'uia' | 'rest' | 'raw' = 'raw';
    if (!this.snapDisabled && args.label !== undefined && args.label.length > 0) {
      const t0 = Date.now();
      const rawPoint = { x: Math.round(mapped.global.x), y: Math.round(mapped.global.y) };
      try {
        const phys = this.dipToPhysical(mapped.global, meta);
        const outcome = await this.getGrounding().snap({ x: phys.x, y: phys.y, label: args.label });
        if (outcome.matched && outcome.point !== null) {
          const dip = this.physicalToDip(outcome.point, meta);
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
      usedPercent = this.codexTextUsedPercent;
    } else if (
      groundingSource !== 'uia' &&
      !this.restGroundDisabled &&
      args.label !== undefined &&
      args.label.length > 0
    ) {
      // M13-core: resolve the grounding transport — the ChatGPT sub
      // (gpt-5.6-sol) when signed in + valid, else the metered API key
      // (gpt-5.4-mini). Pure/injectable resolver (auth/auth-source.ts).
      const auth = resolveGroundingAuth({
        getApiKey: () => this.settings.getApiKey(),
        codex: this.codexProvider(),
            preferApiKey: this.codexDisabled || this.settings.get().preferApiKeyGrounding,
      });
      if (auth !== null) {
        restUsed = true;
        const t0 = Date.now();
        const outcome = await this.getRestGrounder().ground(
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
        if (outcome.point !== null && !this.closed && token === this.turnToken) {
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
          if (this.codexPlanLimitSurfacedToken !== token) {
            this.codexPlanLimitSurfacedToken = token;
            this.surfaceError(describeKind('codex_plan_limit'));
          }
        }
      }
    }
    // M13-core: record grounding-auth attribution for the debug surface (kept
    // even when a later turn supersedes this one — fail-closed telemetry).
    this.lastGrounding = {
      backend: groundingBackend,
      source: groundingSource,
      quotaExhausted,
      usedPercent,
    };
    // A newer turn superseded this one while grounding ran: don't fly the buddy.
    if (this.closed || token !== this.turnToken) return;
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
    this.overlays.routePointer(cmd);
    this.lastPointer = cmd;
    this.pointerHistory.push(cmd);
    if (this.pointerHistory.length > POINTER_HISTORY_LIMIT) {
      this.pointerHistory = this.pointerHistory.slice(-POINTER_HISTORY_LIMIT);
    }
    if (turn !== null) {
      if (turn.tPointerDispatched === undefined) turn.tPointerDispatched = Date.now();
      if (snap !== undefined && turn.snapMs === undefined) turn.snapMs = snap.snapMs;
    }
  }

  /**
   * M9: global DIP -> global physical px. Electron's screen module knows the
   * true physical layout (mixed-DPI multi-monitor); the meta-derived math is
   * the fallback (exact on single/origin displays).
   */
  private dipToPhysical(p: Pt, meta: CaptureMeta): Pt {
    try {
      const converted = screen.dipToScreenPoint({ x: Math.round(p.x), y: Math.round(p.y) });
      if (converted && Number.isFinite(converted.x) && Number.isFinite(converted.y)) {
        return converted;
      }
    } catch {
      /* non-Windows or API unavailable */
    }
    return dipToPhysicalViaMeta(p, meta);
  }

  /** M9: global physical px -> global DIP (see dipToPhysical). */
  private physicalToDip(p: Pt, meta: CaptureMeta): Pt {
    try {
      const converted = screen.screenToDipPoint({ x: Math.round(p.x), y: Math.round(p.y) });
      if (converted && Number.isFinite(converted.x) && Number.isFinite(converted.y)) {
        return converted;
      }
    } catch {
      /* non-Windows or API unavailable */
    }
    return physicalToDipViaMeta(p, meta);
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
  }): Promise<unknown> {
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
    const outcome = await this.getGrounding().snap(
      { x: phys.x, y: phys.y, label: q.label, ...(q.radiusPx !== undefined ? { radiusPx: q.radiusPx } : {}) },
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

  // ---------------------------------------------------------------------
  // State + transcript plumbing
  // ---------------------------------------------------------------------

  private setState(next: AssistantState): void {
    if (this.errorTimer !== null) {
      clearTimeout(this.errorTimer);
      this.errorTimer = null;
    }
    if (this.state !== next) {
      this.state = next;
      this.overlays.broadcast('overlay:assistant-state', next);
      this.panel.send('panel:assistant-state', next);
    }
    if (next === 'error') {
      this.errorTimer = setTimeout(() => {
        this.errorTimer = null;
        if (!this.closed && this.state === 'error') this.setState('idle');
      }, ERROR_RECOVERY_MS);
    }
  }

  private setCaptureIndicator(active: boolean): void {
    this.captureIndicatorActive = active;
    this.overlays.broadcast('overlay:capture-indicator', { active });
  }

  /** Ring-buffer upsert + mirror to the panel transcript. */
  private pushTranscript(entry: TranscriptEntry): void {
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx === -1) {
      this.entries.push(entry);
      if (this.entries.length > TRANSCRIPT_LIMIT) {
        this.entries = this.entries.slice(-TRANSCRIPT_LIMIT);
      }
    } else {
      this.entries[idx] = entry;
    }
    this.panel.send('panel:transcript', entry);
  }
}

/**
 * M18: the factual framing text sent with a text turn — the same convention
 * the realtime session uses (screen dims, coordinate anchors, a worked
 * fraction→pixel example) so point_at coordinates land in the right frame,
 * minus the audio-specific wording. Prefixed `context:` to match the app-wide
 * CONTEXT_PREFIX convention. Returns '' when there is nothing to frame.
 */
function buildCodexFraming(metas: CaptureMeta[], contextText: string): string {
  if (metas.length === 0) {
    return contextText.length > 0 ? `context: ${contextText}` : '';
  }
  const screens = metas
    .map(
      (m) =>
        `screen${m.screenIndex} is ${m.imageW}x${m.imageH} pixels` +
        (m.isActive ? ' (active screen, the cursor is here)' : ''),
    )
    .join('; ');
  const anchors = metas
    .map(
      (m) =>
        `screen${m.screenIndex}: top-left corner (0,0), ` +
        `bottom-right corner (${m.imageW},${m.imageH})`,
    )
    .join('; ');
  const first = metas[0]!;
  return (
    `context: ${metas.length} screenshot(s) attached. ${screens}. ` +
    `point_at coordinates must be pixel coordinates within the named screenshot. ` +
    `coordinate anchors — ${anchors}. ` +
    `to point accurately: judge how far across and down the target sits as a fraction ` +
    `of the full screenshot, then multiply by that screenshot's pixel size ` +
    `(e.g. a target 1/3 across and 1/4 down screen${first.screenIndex} is at ` +
    `(${Math.round(first.imageW / 3)},${Math.round(first.imageH / 4)})); ` +
    `commit to the target's actual offset — never default to the middle of the screen.` +
    (contextText.length > 0 ? ` ${contextText}` : '')
  );
}
