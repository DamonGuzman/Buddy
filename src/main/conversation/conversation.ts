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
 *   barge-in), and the wiring between the extracted collaborators:
 *   TranscriptStore (ring buffer + voice placeholder), TurnTelemetry
 *   (timings/playback stats), TurnGuard (turn tokens + playback epochs),
 *   ErrorSurfacer (M11 catalog surfacing), PointerPipeline (M9/M10 layered
 *   grounding), CodexTextTurnRunner (M18 text path), HelperBuddyContinuations
 *   (background-agent handoff), and the AudioTransport seam (panel vs the
 *   QA phone bridge).
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
 * - C1: cancelHold() force-releases a hold as a cancel (lock / suspend),
 *   clearing held audio, with no turn.
 * - m5: voice turns get a placeholder user bubble at commit time, filled
 *   in-place when the async ASR transcript arrives.
 */

import { app, screen } from 'electron';
import { createHash } from 'node:crypto';
import { AUDIO_SAMPLE_RATE } from '../../shared/constants';
import type {
  ActionableErrorIdentity,
  HelperBuddySummary,
  AssistantState,
  AudioDeviceError,
  CaptureMeta,
  GroundingAttribution,
  PlaybackCommand,
  PlaybackStatsUpdate,
  PointerCommand,
  SessionStatus,
  Settings,
  TranscriptEntry,
  TurnTimings,
} from '../../shared/types';
import { getCodexAuthProvider } from '../auth/codex-auth';
import { resolveGroundingAuth } from '../auth/auth-source';
import type { CodexProvider, ChatGptCodexAuthSource } from '../auth/auth-source';
import { captureAllDisplays } from '../capture';
import type { CaptureResult } from '../capture';
import { CodexResponsesSession } from '../codex/responses-session';
import type { CodexFunctionCall, CodexToolDef } from '../codex/responses-session';
import { classifyError, describeKind, redactSensitiveErrorText } from '../errors';
import type { ErrorKind, ErrorParams } from '../errors';
import { isCodexSubDisabled, isRestGroundDisabled, isSnapDisabled, mockRealtimeUrl } from '../env';
import { createElementGrounder } from '../grounding/accessibility-grounder';
import type { ElementGrounder } from '../grounding/accessibility-grounder';
import { RestGrounder } from '../grounding/rest-grounder';
import {
  getSessionInstructions,
  getTextInstructions,
  getTextToolDefinitions,
  getToolDefinitions,
} from '../persona';
import type { ResponseDoneInfo, ToolCall } from '../realtime/session';
import { RealtimeSession } from '../realtime/session';
import { errorMessage } from '../util/guards';
import type { PhoneAudioTransport } from '../phone-audio-bridge';
import type { HelperBuddyActionGatePort, HelperBuddyApprovalPort } from '../agents/types';
import type { LiveDesktopEvidencePort } from '../computer/live-desktop-evidence';
import { HelperBuddyContinuations } from './helper-buddy-continuations';
import { HelperBuddyTools } from './helper-buddy-tools';
import { AssistantStateMachine } from './assistant-state';
import type { AudioTransport } from './audio-transport';
import { panelAudioTransport, phoneAudioTransport } from './audio-transport';
import { CodexTextTurnRunner } from './codex-text-turn';
import type { CodexTextSession } from './codex-text-turn';
import { ComputerUseRunner } from './computer-use';
import {
  AUDIO_BYTES_PER_MS,
  CAPTURE_FAILED_CONTEXT,
  MIN_COMMIT_AUDIO_MS,
  MIN_HOLD_MS,
  TRANSCRIPT_LIMIT,
} from './constants';
import { ErrorSurfacer } from './error-surfacer';
import { PointerPipeline } from './pointer-pipeline';
import type { RestGroundPort } from './pointer-pipeline';
import type {
  HelperBuddiesPort,
  OverlayPort,
  PanelPort,
  RecorderPort,
  SettingsPort,
} from './ports';
import {
  NO_CAPTURE_ERROR,
  parseCodexToolCall,
  parseRealtimeToolCall,
  preparePointAt,
} from './tool-router';
import { TranscriptStore } from './transcript-store';
import { TurnGuard } from './turn-guard';
import { accumulateUsage, TurnTelemetry } from './turn-telemetry';

export interface ConversationDeps {
  settings: SettingsPort;
  overlays: OverlayPort;
  panel: PanelPort;
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
  /** Helper-buddy runtime; omitted in focused conversation tests. */
  helperBuddies?: HelperBuddiesPort;
  /** Every foreground-delegated helper is prepared with one staged folder workspace. */
  prepareHelperBuddyFilesystem?: (
    task: string,
    helperBuddyId: string,
  ) => Promise<{ taskId: string; rootName: string }>;
  failHelperBuddyFilesystem?: (taskId: string, reason: string) => Promise<void>;
  /** Disposable QA-only phone audio transport; absent in normal Buddy. */
  phoneAudio?: PhoneAudioTransport;
  /** Durable local journal + turn artifacts; omitted in focused tests. */
  sessionRecorder?: RecorderPort;
  /** Shared browser/live action gate and main-process approval parking queue. */
  computerUseSecurity?: {
    gate: HelperBuddyActionGatePort;
    approvals: HelperBuddyApprovalPort;
    evidence?: LiveDesktopEvidencePort;
  };
  /** Native accessibility seam (UIA on Windows, AX on macOS). */
  buildElementGrounder?: () => ElementGrounder;
  /** M10 seam: the REST grounder. Optional — defaults to the real transport. */
  buildRestGrounder?: () => RestGroundPort;
}

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

type HoldConnectResult = { ok: true } | { ok: false; error: unknown };

export class Conversation {
  private readonly settings: SettingsPort;
  private readonly overlays: OverlayPort;
  private readonly panel: PanelPort;
  private readonly audio: AudioTransport;
  private readonly recorder: RecorderPort | null;

  private session: RealtimeSession;
  private sessionModel: string;
  private sessionVoice: string;
  private sessionFullRealtimeMode: boolean;
  /** Secret-safe identity used to rebuild a socket when a stored key changes. */
  private apiKeyFingerprint: string | null | undefined;

  /**
   * The ONE owner of AssistantState. Call sites dispatch semantic events
   * (what happened); the machine's transition table decides what shows.
   * See src/main/conversation/assistant-state.ts.
   */
  private readonly machine: AssistantStateMachine;

  // Voice turn state.
  private holding = false;
  private holdStartedAt = 0;
  private chunksThisHold = 0;
  /** M9: milliseconds of mic audio actually APPENDED to the session this hold. */
  private holdAudioMs = 0;
  /**
   * M20 (the whisper): a hotkey TAP (release < MIN_HOLD_MS) opens the text
   * composer and must NOT interrupt a speaking buddy or supersede an
   * in-flight turn. Everything irreversible about hold-start (barge-in,
   * episode begin, session buffer clear) is deferred until the hold outlives
   * the tap window — this timer fires commitHoldAsTalk at MIN_HOLD_MS, and a
   * fast release forces it synchronously in holdEnd.
   */
  private holdCommitTimer: NodeJS.Timeout | null = null;
  private holdCommitted = false;
  /** Mic chunks parked until the hold commits (flushed then; dropped on tap). */
  private pendingHoldChunks: ArrayBuffer[] = [];
  /** The hold-scoped session warmup, retained so release can surface its real failure. */
  private holdConnectResult: Promise<HoldConnectResult> | null = null;
  /** Invalidates an async zero-audio release when a newer hold starts. */
  private holdSequence = 0;
  /** Mic chunks are appended to the session only while this is true. */
  private acceptingAudio = false;
  private pendingCaptures: Promise<CaptureResult[]> | null = null;
  /** Open-mic session state and the screenshot being captured for its current turn. */
  private fullRealtimeActive = false;
  private pendingFullRealtimeCapture: {
    token: number;
    itemId: string;
    promise: Promise<CaptureResult[]>;
    repairIdentity: ActionableErrorIdentity | null;
  } | null = null;

  /** CLICKY_NO_SNAP=1 disables snapping (eval A/B attribution). */
  private readonly snapDisabled = isSnapDisabled();
  // M13-core: ChatGPT-subscription grounding (COORD-STUDY §11). The resolver
  // prefers the sub over the metered key when signed in + valid. Resolved
  // lazily (only when a grounding call runs) so tests that never ground don't
  // construct the real provider (which reads ~/.codex/auth.json).
  private readonly injectedCodexAuth: CodexProvider | null;
  /** CLICKY_NO_CODEX_SUB=1 forces the metered API key (eval A/B). */
  private readonly codexDisabled = isCodexSubDisabled();
  // M18: typed whisper path — a typed question runs on gpt-5.6-sol over the Codex
  // sub (text in, text out) with the SAME tool harness, when a valid sub is
  // signed in; otherwise it falls back to the realtime voice model.
  private readonly injectedBuildCodex: ((auth: ChatGptCodexAuthSource) => CodexTextSession) | null;
  private readonly helperBuddies: HelperBuddiesPort | null;
  private helperBuddyModeAvailableSnapshot = false;
  private computerUseEnabledSnapshot = false;

  /** F1 (M1/m1) + M2 epochs: turn-supersede bookkeeping (see TurnGuard). */
  private readonly guard = new TurnGuard();

  /** Captures attached to the most recent committed turn (tool-call mapping). */
  private turnCaptures: CaptureResult[] = [];
  private lastCapture: CaptureMeta[] | null = null;

  /** response.create sent minus response.done received (>=0). */
  private pendingResponses = 0;

  // Extracted collaborators.
  private readonly transcriptStore: TranscriptStore;
  private readonly telemetry: TurnTelemetry;
  private readonly errors: ErrorSurfacer;
  private readonly pointer: PointerPipeline;
  private readonly codexText: CodexTextTurnRunner;
  private readonly continuations: HelperBuddyContinuations;
  private readonly helperBuddyTools: HelperBuddyTools;
  private readonly computerUse: ComputerUseRunner;

  // Debug counters.
  private chunksIn = 0;
  private chunksOut = 0;
  private captureIndicatorActive = false;

  constructor(deps: ConversationDeps) {
    this.settings = deps.settings;
    this.overlays = deps.overlays;
    this.panel = deps.panel;
    this.audio = deps.phoneAudio
      ? phoneAudioTransport(deps.phoneAudio)
      : panelAudioTransport(deps.panel);
    this.recorder = deps.sessionRecorder ?? null;
    // M13-core: hold any injected Codex provider; otherwise the process-wide
    // one is resolved lazily at grounding time (codexProvider()).
    this.injectedCodexAuth = deps.codexAuth ?? null;
    // M18: hold any injected text-session factory (tests); else the default
    // builds a real CodexResponsesSession lazily on the first text turn.
    this.injectedBuildCodex = deps.buildCodexSession ?? null;
    this.helperBuddies = deps.helperBuddies ?? null;
    this.helperBuddyModeAvailableSnapshot = this.helperBuddies?.isReady() ?? false;
    const snapshot = this.settings.get();
    this.computerUseEnabledSnapshot = snapshot.computerUseEnabled;
    this.sessionModel = snapshot.model;
    this.sessionVoice = snapshot.voice;
    this.sessionFullRealtimeMode = snapshot.fullRealtimeMode;
    // safeStorage is unavailable until Electron app.ready. createServices()
    // constructs the conversation earlier, so resolve credential identity
    // lazily on the first turn/settings update instead.
    this.apiKeyFingerprint = undefined;

    this.transcriptStore = new TranscriptStore(TRANSCRIPT_LIMIT, (entry) => {
      this.recorder?.record('transcript_upsert', {
        turnId: this.telemetry.active()?.turnId,
        entry,
      });
      if (!entry.streaming) this.recorder?.flush();
      this.panel.send('panel:transcript', entry);
    });
    this.telemetry = new TurnTelemetry(this.recorder);
    this.machine = new AssistantStateMachine({
      onChange: (previous, next) => {
        this.recorder?.record('assistant_state_changed', { previous, next });
        this.overlays.broadcast('overlay:assistant-state', next);
        this.panel.send('panel:assistant-state', next);
        // `listening` is the no-work base state while full realtime is open.
        // A helper completion queued during the person's speech must drain as
        // soon as that turn settles back to the open-mic base, just as it does
        // when push-to-talk settles to `idle`.
        if (next === 'idle' || next === 'listening') {
          queueMicrotask(() => this.continuations.drain());
        }
      },
      pendingResponses: () => this.pendingResponses,
      hasForegroundWork: () => this.holding || this.codexText.isRunning(),
      onWatchdogRecovery: (stuck) => {
        console.warn(
          `[conversation] state watchdog: '${stuck}' held with no open response — forcing base`,
        );
        this.recorder?.record('assistant_state_watchdog', { stuck });
      },
    });
    this.errors = new ErrorSurfacer({
      recorder: this.recorder,
      transcript: this.transcriptStore,
      overlays: this.overlays,
      settings: this.settings,
      setErrorState: () => this.machine.dispatch('error'),
    });
    this.codexText = new CodexTextTurnRunner({
      guard: this.guard,
      transcript: this.transcriptStore,
      telemetry: this.telemetry,
      recorder: this.recorder,
      buildSession: (auth) => this.buildCodexTextSession(auth),
      captionsEnabled: () => this.settings.get().captionsEnabled,
      broadcastCaption: (update) => this.overlays.broadcast('overlay:caption', update),
      onFunctionCall: (call, captures, token) => this.onCodexFunctionCall(call, captures, token),
      surfacePlanLimitOnce: (token) => this.errors.surfacePlanLimitOnce(token),
      codexPlanRepairIdentity: () => this.errors.codexPlanRepairIdentity(),
      noteCodexSucceeded: (expected) => this.errors.noteCodexSucceeded(expected),
      failTurn: (err) => this.failTurn(err),
      // 'turn_settled' is ignored while an error flash shows; a clean finish
      // starts the normal idle grace.
      setIdleUnlessError: () => this.machine.dispatch('turn_settled'),
    });
    this.pointer = new PointerPipeline({
      overlays: this.overlays,
      settings: this.settings,
      recorder: this.recorder,
      guard: this.guard,
      activeTurn: () => this.telemetry.active(),
      codexProvider: () => this.codexProvider(),
      codexTextUsedPercent: () => this.codexText.lastUsedPercent(),
      surfacePlanLimitOnce: (token) => this.errors.surfacePlanLimitOnce(token),
      codexPlanRepairIdentity: () => this.errors.codexPlanRepairIdentity(),
      noteCodexSucceeded: (expected) => this.errors.noteCodexSucceeded(expected),
      buildElementGrounder:
        deps.buildElementGrounder ??
        (() =>
          createElementGrounder({
            scriptDir: app.getPath('userData'),
            excludePid: process.pid, // never scope into our own overlay windows
          })),
      buildRestGrounder:
        deps.buildRestGrounder ??
        (() => new RestGrounder({ getApiKey: () => this.settings.getApiKey() })),
      screen,
      snapDisabled: this.snapDisabled,
      restGroundDisabled: isRestGroundDisabled(),
      codexDisabled: this.codexDisabled,
    });
    this.continuations = new HelperBuddyContinuations({
      closed: () => this.guard.closed,
      pendingResponses: () => this.pendingResponses,
      foregroundReady: () => this.foregroundReadyForHelperBuddyContinuation(),
      voiceStartReady: () =>
        !this.holding && this.pendingResponses === 0 && this.pendingFullRealtimeCapture === null,
      setThinking: () => this.machine.dispatch('turn_committed'),
      injectVoiceReminder: (text, stillReady) =>
        this.session.injectUserAndRespond(text, stillReady),
      markSpoken: (id) => this.helperBuddies?.markSpoken(id),
      failTurn: (err) => this.failTurn(err),
      resolveCodexAuth: () => {
        const auth = resolveGroundingAuth({
          getApiKey: () => null,
          codex: this.codexProvider(),
          preferApiKey: false,
        });
        return auth !== null && auth.kind === 'chatgptCodex' ? auth : null;
      },
      beginTextEpisode: () => {
        const token = this.guard.beginEpisode();
        this.guard.bumpEpoch();
        this.turnCaptures = [];
        const turn = this.telemetry.beginTurn('text');
        turn.tAsk = Date.now();
        this.machine.dispatch('turn_committed');
        return { token, turn };
      },
      runCodexTextTurn: (text, token, turn, auth) =>
        this.codexText.run(text, [], '', token, turn, auth),
    });
    this.helperBuddyTools = new HelperBuddyTools({
      helperBuddies: this.helperBuddies,
      transcript: this.transcriptStore,
      turnCaptures: () => this.turnCaptures,
      noteOrigin: (helperBuddyId, mode) => this.continuations.noteOrigin(helperBuddyId, mode),
      surfaceError: (kind) => this.errors.surface(describeKind(kind)),
      prepareFilesystem:
        deps.prepareHelperBuddyFilesystem ??
        (() => Promise.reject(new Error('choose a folder for helper buddies first'))),
      failFilesystem: deps.failHelperBuddyFilesystem ?? (() => Promise.resolve()),
    });
    this.computerUse = new ComputerUseRunner({
      settings: this.settings,
      guard: this.guard,
      ...(deps.computerUseSecurity ?? {}),
      userRequest: () => {
        const latestUser = [...this.transcriptStore.list()]
          .reverse()
          .find((entry) => entry.role === 'user');
        // Never fall back to an older request while the current voice
        // transcript is still a placeholder: that would grant authority from
        // a different turn. The runner fails closed until exact ASR is ready.
        return latestUser && !latestUser.streaming ? latestUser.text : '';
      },
      codexProvider: () => this.codexProvider(),
      enabledSnapshot: () => this.computerUseEnabledSnapshot,
      surfacePlanLimitOnce: (token) => this.errors.surfacePlanLimitOnce(token),
      codexPlanRepairIdentity: () => this.errors.codexPlanRepairIdentity(),
      noteCodexSucceeded: (expected) => this.errors.noteCodexSucceeded(expected),
      userDataDir: () => app.getPath('userData'),
    });

    this.session = this.buildSession();
    // M9: front-load the platform provider so the first point_at can ground
    // within its timebox.
    this.pointer.warmUpIfEnabled();
  }

  /**
   * M13-core: the Codex ChatGPT-subscription provider — an injected fake in
   * tests, else the process-wide singleton (constructed on first use so tests
   * that never ground don't read ~/.codex/auth.json).
   */
  private codexProvider(): CodexProvider {
    return this.injectedCodexAuth ?? getCodexAuthProvider();
  }

  /** M18: the injected factory wins in tests; else a real CodexResponsesSession. */
  private buildCodexTextSession(auth: ChatGptCodexAuthSource): CodexTextSession {
    return this.injectedBuildCodex
      ? this.injectedBuildCodex(auth)
      : new CodexResponsesSession({
          auth,
          instructions: getTextInstructions(
            this.helperBuddyModeAvailableSnapshot,
            this.computerUse.available(),
          ),
          tools: getTextToolDefinitions(
            this.helperBuddyModeAvailableSnapshot,
            this.computerUse.available(),
          ) as CodexToolDef[],
        });
  }

  // ---------------------------------------------------------------------
  // Public surface (called from index.ts wiring + debug routes)
  // ---------------------------------------------------------------------

  assistantState(): AssistantState {
    return this.machine.current();
  }

  sessionStatus(): SessionStatus {
    return this.session.status();
  }

  transcript(): TranscriptEntry[] {
    return this.transcriptStore.list();
  }

  debugInfo(): ConversationDebugInfo {
    return {
      lastCapture: this.lastCapture,
      lastPointer: this.pointer.lastPointer(),
      pointerHistory: this.pointer.history(),
      audio: { chunksIn: this.chunksIn, chunksOut: this.chunksOut },
      captureIndicatorActive: this.captureIndicatorActive,
      lastGrounding: this.pointer.lastGrounding(),
    };
  }

  /** Playback passthrough (debug harness + barge-in share this path). */
  playback(command: PlaybackCommand): void {
    this.sendPlaybackCommand(command);
  }

  // ---------------------------------------------------------------------
  // M8.5 (orchestrator-approved): audio-experience eval surface
  // ---------------------------------------------------------------------

  /** Timings of the most recent turn (may still be filling in). */
  lastTurnTimings(): TurnTimings | null {
    return this.telemetry.lastTurnTimings();
  }

  /** Recent turn timings, oldest first (includes the active turn). */
  turnTimingsHistory(): TurnTimings[] {
    return this.telemetry.history();
  }

  /** Latest per-item playback stats reported by the panel's playback tap. */
  outputStats(): PlaybackStatsUpdate[] {
    return this.telemetry.outputStats();
  }

  /** Last ~15s of played audio (Int16 PCM 24kHz mono), if reported yet. */
  lastOutputRing(): ArrayBuffer | null {
    return this.telemetry.lastOutputRing();
  }

  /** 'audio:playback-stats' from the panel renderer (ipcMain wiring). */
  handlePlaybackStats(stats: PlaybackStatsUpdate): void {
    // M11 (audio_output_failed): samples actually rendered — sound is back,
    // stop forcing captions and re-arm the one-time failure surfacing.
    this.errors.noteSamplesPlayed(stats.samplesPlayed);
    this.telemetry.recordPlaybackStats(stats);
  }

  /** 'audio:playback-ring' from the panel renderer (ipcMain wiring). */
  handlePlaybackRing(ring: ArrayBuffer): void {
    this.telemetry.setOutputRing(ring);
  }

  /** Toggle the opt-in, server-VAD open-mic conversation. */
  async toggleFullRealtime(): Promise<void> {
    if (this.guard.closed || !this.settings.get().fullRealtimeMode) return;
    if (this.fullRealtimeActive) {
      this.deactivateFullRealtime();
      return;
    }

    this.continuations.preemptVoice();
    this.supersedeActiveOutput('flush');

    const token = this.guard.beginEpisode();
    this.fullRealtimeActive = true;
    this.acceptingAudio = false;
    this.pendingFullRealtimeCapture = null;
    this.turnCaptures = [];
    this.errors.maybeSurfaceSettingsReset();
    this.machine.dispatch('open_mic_on');

    try {
      // Mock sessions do not need authentication, so RealtimeSession will not
      // invoke its getApiKey callback. Still establish the key baseline once
      // a real user action begins; otherwise the next unrelated settings
      // notification looks like a credential change and tears open-mic down.
      this.getApiKeyAndInitializeFingerprint();
      await this.session.connect();
      if (this.guard.closed || !this.fullRealtimeActive || !this.guard.isCurrent(token)) return;
      this.acceptingAudio = true;
      this.audio.capture('start');
      this.machine.dispatch('open_mic_ready');
    } catch (err) {
      if (!this.guard.isCurrent(token)) return;
      this.deactivateFullRealtime();
      this.failTurn(err);
    }
  }

  /** Stop an open-mic session immediately. Safe to call on lock/suspend. */
  deactivateFullRealtime(): void {
    if (!this.fullRealtimeActive) return;
    this.fullRealtimeActive = false;
    this.guard.beginEpisode();
    this.acceptingAudio = false;
    this.audio.capture('stop');
    this.setCaptureIndicator(false);
    this.session.clearAudio();
    this.pendingFullRealtimeCapture = null;
    this.turnCaptures = [];
    if (this.pendingResponses > 0) this.cancelActiveResponse('flush');
    else this.stopResidualPlayback('flush');
    this.machine.dispatch('open_mic_off');
  }

  /**
   * Hotkey went down: barge in on any playing response, flip to listening,
   * signpost capture, start the panel mic, warm the session, and kick the
   * multi-display capture (not awaited — resolved at hold-end).
   */
  holdStart(): void {
    if (this.guard.closed || this.holding) return;
    this.holding = true;
    this.holdStartedAt = Date.now();
    this.chunksThisHold = 0;
    this.holdAudioMs = 0; // M9
    this.holdCommitted = false;
    this.pendingHoldChunks = [];
    this.holdConnectResult = null;
    this.holdSequence += 1;
    this.errors.clearMicError(); // M11: mic failures are per-hold
    // M8.5: new voice turn timings. M20 note: begun BEFORE the (deferred)
    // barge-in, so a barge stop is measured against THIS turn's bargeWatch
    // rather than the cancelled one — a deliberate attribution tradeoff.
    const turn = this.telemetry.beginTurn('voice');
    turn.tHoldStart = this.holdStartedAt;
    this.machine.dispatch('hold_start');
    this.setCaptureIndicator(true);
    this.audio.capture('start');
    if (this.canReachServer()) {
      // Warm the socket early. Retain the outcome: a real zero-audio release
      // must not misreport an authentication failure as a microphone failure.
      this.holdConnectResult = this.connectForHold();
    }
    // M20 (the whisper): a tap must leave whatever buddy is doing untouched,
    // so the irreversible half of hold-start — barge-in, episode begin,
    // session buffer clear — waits out the tap window. Mic chunks arriving
    // meanwhile are parked and flushed on commit, so no speech is lost.
    this.holdCommitTimer = setTimeout(() => this.commitHoldAsTalk(), MIN_HOLD_MS);
    const captureRepairIdentity = this.errors.captureRepairIdentity();
    this.pendingCaptures = captureAllDisplays()
      .then((results) => {
        this.noteCaptureSucceeded(results, captureRepairIdentity);
        this.lastCapture = results.map((r) => r.meta);
        // M8.5: capture completed (kicked off at hold-start).
        turn.tCaptureDone = Date.now();
        turn.captureMs = turn.tCaptureDone - this.holdStartedAt;
        this.recorder?.recordCaptures(turn.turnId, results);
        return results;
      })
      .catch((err: unknown) => {
        console.warn('[conversation] capture failed, sending turn without images:', err);
        this.recorder?.record('capture_failed', { turnId: turn.turnId, error: err });
        return [] as CaptureResult[];
      });
  }

  /**
   * M20: the point of no return for a hold — it outlived the tap window (or
   * the release proved it a real talk), so NOW barge in on any playing
   * response, supersede pending turns, and hand the parked mic audio to the
   * session. Until this runs a hold is reversible: a tap (whisper summon)
   * leaves whatever buddy was doing untouched.
   */
  private commitHoldAsTalk(): void {
    this.clearHoldCommitTimer();
    if (this.guard.closed || this.holdCommitted) return;
    this.holdCommitted = true;
    this.continuations.preemptVoice();
    // BARGE-IN: kill the in-flight response and its queued audio.
    this.supersedeActiveOutput('stop');
    this.guard.beginEpisode(); // F1 (M1): supersede any pending finishVoiceTurn/askText
    this.errors.maybeSurfaceSettingsReset(); // M11: first turn after a settings reset
    this.acceptingAudio = this.canReachServer();
    this.guard.bumpEpoch();
    // F1 (M7): drop stale un-committed audio (a superseded hold's buffer,
    // queued appends from a failed turn) BEFORE this hold's chunks land.
    this.session.clearAudio();
    if (this.acceptingAudio) {
      for (const chunk of this.pendingHoldChunks) {
        this.session.appendAudio(chunk);
        this.holdAudioMs += chunk.byteLength / AUDIO_BYTES_PER_MS; // M9
      }
    }
    this.pendingHoldChunks = [];
  }

  private clearHoldCommitTimer(): void {
    if (this.holdCommitTimer !== null) clearTimeout(this.holdCommitTimer);
    this.holdCommitTimer = null;
  }

  private connectForHold(): Promise<HoldConnectResult> {
    return this.session.connect().then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error }),
    );
  }

  private async surfaceZeroAudioRelease(
    sequence: number,
    attempt: Promise<HoldConnectResult>,
  ): Promise<void> {
    const result = await attempt;
    if (
      this.guard.closed ||
      this.holding ||
      this.holdSequence !== sequence ||
      this.holdConnectResult !== attempt
    ) {
      return;
    }
    this.holdConnectResult = null;
    if (result.ok) {
      this.errors.surface(describeKind('mic_unavailable', this.errors.micErrorParams()));
    } else {
      this.failTurn(result.error);
    }
  }

  /**
   * Hotkey released: stop the mic + indicator. Short/silent holds cancel
   * gracefully; real holds commit the audio with the captured screenshots.
   */
  holdEnd(): void {
    if (this.guard.closed || !this.holding) return;
    this.holding = false;
    this.clearHoldCommitTimer(); // M20: the deferral race is decided HERE
    this.audio.capture('stop');
    this.setCaptureIndicator(false);

    const heldMs = Date.now() - this.holdStartedAt;
    if (heldMs < MIN_HOLD_MS || this.chunksThisHold === 0) {
      // Accidental tap (short hold): no turn, no error — and (M20) since the
      // barge-in was deferred, buddy was never interrupted.
      this.pendingHoldChunks = [];
      this.acceptingAudio = false;
      this.session.clearAudio();
      this.pendingCaptures = null;
      this.telemetry.discardActiveTurn(); // M8.5: no turn -> no timings record
      if (heldMs < MIN_HOLD_MS) {
        this.holdConnectResult = null;
        this.machine.dispatch('hold_cancelled');
      } else {
        // A real zero-audio hold can coincide with a failed warm connection.
        // Resolve that exact attempt first so auth/network/model failures win;
        // only a healthy session proves this is actually a microphone issue.
        const sequence = this.holdSequence;
        const attempt = this.holdConnectResult ?? this.connectForHold();
        this.holdConnectResult = attempt;
        void this.surfaceZeroAudioRelease(sequence, attempt);
      }
      return;
    }
    // M20: a fast-but-real release can beat the deferral timer (setTimeout
    // jitter) — the commit must have happened before the turn is finished.
    if (!this.holdCommitted) this.commitHoldAsTalk();
    this.holdConnectResult = null;
    const turn = this.telemetry.active();
    if (turn) turn.tHoldEnd = Date.now(); // M8.5
    void this.finishVoiceTurn();
  }

  /**
   * F1 fix (C1): force-release the current hold as a CANCEL — screen lock,
   * suspend, or a mid-hold settings rebuild. Stops the
   * mic, clears the held audio, produces NO turn, and returns to idle.
   */
  cancelHold(): void {
    if (this.guard.closed || !this.holding) return;
    this.holding = false;
    this.clearHoldCommitTimer(); // M20
    this.pendingHoldChunks = [];
    this.holdConnectResult = null;
    this.holdSequence += 1;
    this.guard.beginEpisode(); // invalidate any in-flight continuation
    this.acceptingAudio = false;
    this.audio.capture('stop');
    this.setCaptureIndicator(false);
    this.session.clearAudio();
    this.pendingCaptures = null;
    this.telemetry.discardActiveTurn();
    this.machine.dispatch('hold_cancelled');
  }

  /** Mic PCM chunk from the panel renderer (ipcMain 'audio:chunk'). */
  handleAudioChunk(chunk: ArrayBuffer): void {
    this.chunksIn += 1;
    if (this.holding || this.fullRealtimeActive) {
      if (this.holding) this.chunksThisHold += 1;
      const turn = this.telemetry.active();
      if (turn?.kind === 'voice') turn.chunksIn += 1; // M8.5
      // Preserve what the mic actually delivered even when the transport is
      // unavailable (for example, a missing key). That failure episode is
      // precisely when a complete local diagnostic artifact is most useful.
      this.recorder?.appendAudio('input', turn?.turnId ?? 'unattributed', chunk);
    }
    // M20: the hold hasn't outlived the tap window yet — park the audio
    // locally (commitHoldAsTalk flushes it; a tap/cancel drops it).
    if (this.holding && !this.holdCommitted) {
      this.pendingHoldChunks.push(chunk);
      return;
    }
    if (this.acceptingAudio) {
      this.session.appendAudio(chunk);
      // M9: track what will actually be committed (see MIN_COMMIT_AUDIO_MS).
      if (this.holding) this.holdAudioMs += chunk.byteLength / AUDIO_BYTES_PER_MS;
    }
  }

  /** Typed question from the panel ('panel:ask-text') — same pipeline as voice. */
  async askText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (this.guard.closed || trimmed.length === 0) return;
    this.continuations.preemptVoice();
    this.errors.maybeSurfaceSettingsReset(); // M11: first turn after a settings reset
    // Text input is an explicit foreground turn; leave an open mic first so
    // VAD cannot start a competing voice response while screenshots resolve.
    if (this.fullRealtimeActive) this.deactivateFullRealtime();
    // A typed question while the hotkey is held supersedes the hold —
    // never two concurrent turns (m1) / response.creates.
    if (this.holding) this.cancelHold();
    // Supersede: cancel the current response and drop its queued audio.
    this.supersedeActiveOutput('flush');
    const token = this.guard.beginEpisode(); // F1 (m1): supersede any pre-commit turn
    this.guard.bumpEpoch();
    // M8.5: new text turn timings.
    const turn = this.telemetry.beginTurn('text');
    const tAsk = Date.now();
    turn.tAsk = tAsk;
    // The renderer does NOT optimistically echo — main owns the user entry.
    this.transcriptStore.upsert({
      id: this.transcriptStore.mintId('user'),
      role: 'user',
      text: trimmed,
      streaming: false,
      timestamp: Date.now(),
    });
    this.machine.dispatch('turn_committed');

    this.setCaptureIndicator(true);
    let captures: CaptureResult[] = [];
    const captureRepairIdentity = this.errors.captureRepairIdentity();
    try {
      captures = await captureAllDisplays();
    } catch (err) {
      console.warn('[conversation] capture failed, asking without images:', err);
      this.recorder?.record('capture_failed', { turnId: turn.turnId, error: err });
    } finally {
      this.setCaptureIndicator(false);
    }
    // F1 (m1): a newer ask/hold superseded this one while it was capturing —
    // do not create a second concurrent response, do not stomp its state.
    if (this.guard.isStale(token)) return;
    // M8.5: capture completed.
    turn.tCaptureDone = Date.now();
    turn.captureMs = turn.tCaptureDone - tAsk;
    this.lastCapture = captures.map((r) => r.meta);
    this.turnCaptures = captures;
    this.noteCaptureSucceeded(captures, captureRepairIdentity);
    this.recorder?.recordCaptures(turn.turnId, captures);

    // M11 (capture_failed): the turn is going ahead with ZERO screenshots —
    // tell the user (transcript + caption) and tell the MODEL via the factual
    // context part so it doesn't pretend to see the screen.
    const contextText = captures.length === 0 ? this.noteCaptureFailed() : '';

    // M18: route the typed question. When a valid ChatGPT (Codex) sub is
    // signed in, the answer runs text-in/text-out on gpt-5.6-sol (sub-billed —
    // works even with the metered key out of credit), with the SAME tool
    // harness + screenshots. Otherwise fall back to the realtime voice model
    // so text still works for non-signed-in users.
    const auth = resolveGroundingAuth({
      getApiKey: () => this.getApiKeyAndInitializeFingerprint(),
      codex: this.codexProvider(),
      preferApiKey: this.codexDisabled || this.settings.get().preferApiKeyGrounding,
    });
    // The mock-realtime harness must remain deterministic even on a developer
    // machine that happens to be signed in to Codex. Focused Codex tests opt in
    // by injecting buildCodexSession; production has no CLICKY_MOCK_URL.
    const codexTextAllowed = mockRealtimeUrl() === null || this.injectedBuildCodex !== null;
    if (codexTextAllowed && auth !== null && auth.kind === 'chatgptCodex') {
      await this.codexText.run(trimmed, captures, contextText, token, turn, auth);
      return;
    }

    try {
      await this.session.askText(trimmed, captures, contextText);
      turn.tCommitSent = Date.now(); // M8.5
      // pendingResponses counted via 'response-requested' (M3).
    } catch (err) {
      if (this.guard.isCurrent(token)) this.failTurn(err);
    }
  }

  /**
   * A complete tool call from the text model. point_at buffers its tool output
   * immediately (the answer is never gated on grounding) and kicks the async
   * pointer dispatch through the SHARED dispatcher in TEXT-ACCURATE mode
   * (skips the redundant REST grounding — sol is already pixel-exact per
   * COORD-STUDY §11).
   */
  private onCodexFunctionCall(
    call: CodexFunctionCall,
    captures: CaptureResult[],
    token: number,
  ): void {
    if (this.guard.isStale(token)) return;
    this.recorder?.record('tool_call', {
      transport: 'codex',
      turnId: this.telemetry.active()?.turnId,
      call,
    });
    const session = this.codexText.currentSession();
    if (session === null) return;
    const turn = this.telemetry.active();
    if (turn && turn.tFirstToolCall === undefined) {
      turn.tFirstToolCall = Date.now();
    }
    const invocation = parseCodexToolCall(
      call.name,
      call.argsJson,
      captures.map((c) => c.meta),
    );
    switch (invocation.kind) {
      case 'spawn_helper_buddy':
        this.codexText.trackToolPromise(
          this.helperBuddyTools.spawnHelperBuddy(invocation.args, 'text').then((output) => {
            if (!this.guard.isStale(token) && this.codexText.currentSession() === session) {
              session.sendToolOutput(call.callId, output);
            }
          }),
        );
        return;
      case 'check_helper_buddies':
        session.sendToolOutput(
          call.callId,
          this.helperBuddyTools.checkHelperBuddies(invocation.args),
        );
        return;
      case 'use_computer': {
        const pending = this.computerUse.run(invocation.args, captures, token).then((output) => {
          if (!this.guard.isStale(token) && this.codexText.currentSession() === session) {
            session.sendToolOutput(call.callId, output);
          }
        });
        this.codexText.trackToolPromise(pending);
        return;
      }
      case 'reject':
        session.sendToolOutput(call.callId, { error: invocation.error });
        return;
      case 'point_at': {
        const target = preparePointAt(invocation.args, captures);
        if (target === null) {
          session.sendToolOutput(call.callId, { error: NO_CAPTURE_ERROR });
          return;
        }
        session.sendToolOutput(call.callId, { ok: true, pointed_at: invocation.args.label ?? '' });
        this.pointer.enqueue(invocation.args, target.capture, target.mapped, {
          primaryModelIsAccurate: true,
        });
        return;
      }
    }
  }

  /** Credential, model, voice, and VAD changes require a fresh session. */
  onSettingsChanged(next: Settings): void {
    this.recorder?.recordSettings(next);
    const nextApiKeyFingerprint = fingerprintApiKey(this.settings.getApiKey());
    const apiKeyChanged =
      this.apiKeyFingerprint === undefined || nextApiKeyFingerprint !== this.apiKeyFingerprint;
    if (
      !apiKeyChanged &&
      next.model === this.sessionModel &&
      next.voice === this.sessionVoice &&
      next.fullRealtimeMode === this.sessionFullRealtimeMode &&
      next.computerUseEnabled === this.computerUseEnabledSnapshot
    ) {
      return;
    }
    this.apiKeyFingerprint = nextApiKeyFingerprint;
    this.sessionModel = next.model;
    this.sessionVoice = next.voice;
    this.sessionFullRealtimeMode = next.fullRealtimeMode;
    this.computerUseEnabledSnapshot = next.computerUseEnabled;
    this.codexText.reset();
    this.rebuildRealtimeSession();
  }

  /** Rebuild tool/persona availability when the Codex sign-in changes. */
  onHelperBuddyAvailabilityChanged(): void {
    const available = this.helperBuddies?.isReady() ?? false;
    if (available === this.helperBuddyModeAvailableSnapshot) return;
    this.helperBuddyModeAvailableSnapshot = available;
    this.codexText.reset();
    this.rebuildRealtimeSession();
  }

  /** HelperBuddyManager completion hook: enqueue a normal automated foreground turn. */
  deliverHelperBuddyResult(summary: HelperBuddySummary): void {
    if (summary.status === 'done') {
      this.errors.noteAgentSucceeded();
    } else if (summary.status === 'failed') {
      for (const kind of ['helper_buddy_not_signed_in', 'helper_buddy_quota'] as const) {
        if (summary.error === describeKind(kind).message) {
          this.errors.surface(describeKind(kind));
          break;
        }
      }
    }
    this.continuations.deliver(summary);
  }

  /**
   * An automated helper result may use either resting foreground state:
   * push-to-talk rests in `idle`; an open-mic conversation rests in
   * `listening`. During actual VAD speech the pending capture is non-null, so
   * the person still wins and the helper waits for that turn to settle.
   */
  private foregroundReadyForHelperBuddyContinuation(): boolean {
    if (this.holding || this.pendingResponses > 0) return false;
    const state = this.machine.current();
    if (state === 'idle') return true;
    return (
      this.fullRealtimeActive && state === 'listening' && this.pendingFullRealtimeCapture === null
    );
  }

  private rebuildRealtimeSession(): void {
    // F1 fix (m3): a mid-turn rebuild must not leave debris.
    if (this.holding) this.cancelHold(); // graceful: mic released, no turn
    // A released zero-audio hold may still be awaiting its warm connection.
    // Invalidate it before closing the old session so its rejection cannot
    // fail or clear the newly rebuilt session/turn.
    this.holdConnectResult = null;
    this.holdSequence += 1;
    if (this.fullRealtimeActive) this.deactivateFullRealtime();
    // M18: abort any in-flight text turn too (its stream stops emitting).
    this.codexText.cancelActive();
    this.guard.beginEpisode();
    // Flush playback under the new epoch so queued/in-flight audio of the
    // dying session can never play into the rebuilt one.
    this.guard.bumpPlaybackEpoch();
    this.sendPlaybackCommand('flush');
    // Finalize any transcript entries left mid-stream by the dying session.
    this.transcriptStore.finalizeStreaming();
    this.transcriptStore.resolvePendingVoice('(voice message)');
    this.session.close();
    this.session.removeAllListeners();
    this.pendingResponses = 0;
    this.session = this.buildSession();
    this.panel.send('panel:session-status', this.session.status());
    this.machine.dispatch('reset');
  }

  /**
   * F1 fix (sleep/resume): powerMonitor 'resume' — the socket may be
   * half-open. Reset it; the next turn reconnects lazily. If a response was
   * mid-flight the session synthesizes a failed response-done and the normal
   * recovery path (failTurn -> error -> auto-recover) runs.
   */
  onSystemResume(): void {
    if (this.guard.closed) return;
    this.session.notifySystemResume();
  }

  /** App shutdown. */
  close(): void {
    this.guard.close();
    this.machine.dispose();
    this.pointer.dispose(); // M9: dispose native accessibility resources
    this.computerUse.dispose();
    this.codexText.cancelActive(); // M18: abort any in-flight text turn
    if (this.fullRealtimeActive) {
      this.fullRealtimeActive = false;
      this.acceptingAudio = false;
      this.pendingFullRealtimeCapture = null;
      this.setCaptureIndicator(false);
      this.audio.capture('stop');
    }
    this.session.close();
    this.recorder?.record('conversation_closed', {
      state: this.machine.current(),
      activeTurn: this.telemetry.active(),
      transcriptEntriesInMemory: this.transcriptStore.list().length,
    });
    this.recorder?.flush();
  }

  // ---------------------------------------------------------------------
  // Voice turn completion
  // ---------------------------------------------------------------------

  /** Attach the fresh open-mic screenshot after VAD commits this audio item. */
  private async finishFullRealtimeTurn(itemId: string): Promise<void> {
    const pending = this.pendingFullRealtimeCapture;
    if (pending === null || pending.itemId !== itemId) return;

    const captures = await pending.promise;
    if (
      this.guard.closed ||
      !this.fullRealtimeActive ||
      !this.guard.isCurrent(pending.token) ||
      this.pendingFullRealtimeCapture !== pending
    ) {
      return;
    }

    this.pendingFullRealtimeCapture = null;
    this.setCaptureIndicator(false);
    this.lastCapture = captures.map((capture) => capture.meta);
    this.turnCaptures = captures;
    this.noteCaptureSucceeded(captures, pending.repairIdentity);
    this.recorder?.recordCaptures(this.telemetry.active()?.turnId ?? `vad_${itemId}`, captures);

    let contextText = '';
    if (captures.length === 0) {
      contextText = this.noteCaptureFailed();
      // Capture failure is recoverable: keep the open-mic conversation live
      // and let the model answer this audio-only turn with explicit context.
      this.machine.dispatch('turn_committed');
    }

    try {
      await this.session.respondToVadTurn(captures, contextText);
      const turn = this.telemetry.active();
      if (this.guard.isCurrent(pending.token) && turn) {
        turn.tCommitSent = Date.now();
      }
    } catch (err) {
      if (this.guard.isCurrent(pending.token)) this.failTurn(err);
    }
  }

  private async finishVoiceTurn(): Promise<void> {
    const token = this.guard.currentToken(); // F1 (M1)
    this.machine.dispatch('turn_committed');
    const captures = (await (this.pendingCaptures ?? Promise.resolve([]))) ?? [];
    // F1 fix (M1): a new hold/ask started while captureAllDisplays() was
    // pending — this turn is superseded. Do NOT stomp the new turn's
    // acceptingAudio/turnCaptures, do NOT commit its early chunks into this
    // turn, do NOT commit an empty buffer.
    if (this.guard.closed || this.holding || !this.guard.isCurrent(token)) return;
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
      this.telemetry.discardActiveTurn();
      this.machine.dispatch('hold_cancelled');
      return;
    }
    // F1 fix (m5): placeholder user bubble NOW, so the user's question can
    // never appear below the assistant's answer (async ASR). Filled in-place
    // by 'user-transcript'; falls back to "(voice message)" at turn end.
    this.transcriptStore.beginVoicePlaceholder();
    // M11 (capture_failed): committing with ZERO screenshots — tell the user
    // (transcript + caption) and tell the MODEL via the factual context part.
    const contextText = captures.length === 0 ? this.noteCaptureFailed() : '';
    try {
      await this.session.commitAudioAndRespond(captures, contextText);
      const turn = this.telemetry.active();
      if (turn) turn.tCommitSent = Date.now(); // M8.5
      // pendingResponses counted via 'response-requested' (M3).
    } catch (err) {
      if (this.guard.isCurrent(token)) this.failTurn(err);
    }
  }

  /**
   * A turn could not be started/committed (or died mid-flight): fail soft,
   * never crash. M11: the string-matching is gone — the error catalog
   * (src/main/errors.ts) classifies the failure and owns the copy.
   */
  private failTurn(err: unknown): void {
    console.error('[conversation] turn failed:', redactSensitiveErrorText(errorMessage(err)));
    // F1 (M7): the failed turn's audio must never leak into the next turn.
    this.session.clearAudio();
    this.transcriptStore.resolvePendingVoice('(voice message)');
    let pres = classifyError(err, { model: this.sessionModel });
    // M11 (api_key_unreadable): "no key" while an (undecryptable) blob IS
    // stored means DPAPI lost the key — the fix is a re-paste, not an add.
    if (pres.kind === 'no_api_key' && this.settings.get().apiKeyUnreadable) {
      pres = describeKind('api_key_unreadable');
    }
    this.errors.surface(pres);
  }

  // ---------------------------------------------------------------------
  // M11: error-catalog surfacing
  // ---------------------------------------------------------------------

  /**
   * Surface a catalog kind directly — index.ts wiring uses this for failures
   * the conversation cannot observe itself (for example, hotkey_dead).
   */
  reportError(kind: ErrorKind, params?: ErrorParams): void {
    if (this.guard.closed) return;
    this.errors.surface(describeKind(kind, params));
  }

  /**
   * 'audio:capture-error' from the panel renderer (ipcMain wiring):
   * mic capture failed to start, or the playback pipeline failed to init.
   */
  handleAudioDeviceError(payload: AudioDeviceError): void {
    if (this.guard.closed) return;
    this.errors.handleDeviceError(payload);
  }

  /**
   * M11 (capture_failed): ONE owner for the three zero-capture sites — the
   * turn goes ahead with no screenshots, the user is told (transcript +
   * caption), and the model gets the factual context part.
   */
  private noteCaptureFailed(): string {
    this.errors.surface(describeKind('capture_failed'));
    return CAPTURE_FAILED_CONTEXT;
  }

  /** Resolve capture repair UI only after a real non-empty capture succeeds. */
  private noteCaptureSucceeded(
    captures: readonly CaptureResult[],
    expected: ActionableErrorIdentity | null,
  ): void {
    if (captures.length > 0) this.errors.noteCaptureSucceeded(expected);
  }

  /**
   * M11: re-send the transcript ring + status snapshots to a (re)loaded panel
   * renderer — entries pushed before the renderer existed (boot-time errors)
   * or before a crash-recreate were otherwise lost. Upsert semantics make the
   * replay idempotent.
   */
  replayToPanel(): void {
    for (const entry of this.transcriptStore.list()) this.panel.send('panel:transcript', entry);
    this.panel.send('panel:session-status', this.session.status());
    this.panel.send('panel:assistant-state', this.machine.current());
  }

  private canReachServer(): boolean {
    const apiKey = this.getApiKeyAndInitializeFingerprint();
    return this.session.usingMock || apiKey !== null;
  }

  /**
   * Credential reads must stay lazy because safeStorage is unavailable until
   * Electron is ready. Once a real turn reads the credential, capture its
   * identity as the current session baseline so an unrelated later settings
   * update does not look like a key replacement and tear down that session.
   * Do not overwrite an existing baseline here: onSettingsChanged owns real
   * key transitions and must compare the new key against the previous one.
   */
  private getApiKeyAndInitializeFingerprint(): string | null {
    const apiKey = this.settings.getApiKey();
    if (this.apiKeyFingerprint === undefined) {
      this.apiKeyFingerprint = fingerprintApiKey(apiKey);
    }
    return apiKey;
  }

  /**
   * Cancel the in-flight response (barge-in uses 'stop', a superseding text
   * turn uses 'flush') and finalize any transcript entries the cancelled
   * response left mid-stream, so the panel never shows a stuck typing state.
   */
  private cancelActiveResponse(playback: PlaybackCommand): void {
    // M8.5: measure cancel -> playback-actually-stopped on the cancelled turn.
    this.telemetry.armBargeWatch();
    this.session.cancelResponse();
    // F1 fix (M2): bump the playback epoch and flush under it. The renderer
    // drops any audio delta tagged with an older epoch, so the cancelled
    // response's pre-cancel burst (whose first chunk may not have reached
    // the renderer yet — nothing to mark stale by itemId) stays silent.
    this.guard.bumpPlaybackEpoch();
    this.sendPlaybackCommand(playback);
    // NOTE (M3): pendingResponses is NOT zeroed here — the cancelled
    // response's own response.done (status 'cancelled') decrements it, so
    // the count stays a pure request/done ledger.
    this.transcriptStore.finalizeStreaming();
  }

  /**
   * Live-eval fix (M8.5): silence audio still draining from a COMPLETED
   * response (pendingResponses == 0, so cancelActiveResponse never runs).
   * When the old turn's audio was genuinely mid-play, arm the same bargeWatch
   * so bargeInStopMs is measured for this path too.
   */
  private stopResidualPlayback(command: PlaybackCommand): void {
    this.telemetry.armBargeWatchIfStillPlaying();
    this.guard.bumpPlaybackEpoch();
    this.sendPlaybackCommand(command);
  }

  /**
   * The shared supersede preamble of toggleFullRealtime / holdStart / askText:
   * abort any in-flight TEXT turn (M18 — its stream stops emitting into the
   * transcript), then silence the audible response. Barge-in uses 'stop', a
   * superseding text/open-mic turn uses 'flush'. Live-eval finding (M8.5):
   * response.done arrives long before the queued audio finishes PLAYING, so a
   * new turn can start while a COMPLETED response is still audibly speaking
   * (pendingResponses == 0 — cancelActiveResponse never runs) and the new
   * turn's audio would queue behind the stale tail; residual playback is
   * silenced exactly like a barge-in.
   */
  private supersedeActiveOutput(playback: PlaybackCommand): void {
    this.codexText.cancelActive();
    if (this.pendingResponses > 0) this.cancelActiveResponse(playback);
    else this.stopResidualPlayback(playback);
  }

  // ---------------------------------------------------------------------
  // Session events
  // ---------------------------------------------------------------------

  private buildSession(): RealtimeSession {
    const computerUseAvailable = this.computerUse.available();
    const session = new RealtimeSession({
      model: this.sessionModel,
      voice: this.sessionVoice,
      instructions: getSessionInstructions(
        this.helperBuddyModeAvailableSnapshot,
        computerUseAvailable,
      ),
      tools: getToolDefinitions(this.helperBuddyModeAvailableSnapshot, computerUseAvailable),
      getApiKey: () => this.getApiKeyAndInitializeFingerprint(),
      turnDetection: this.sessionFullRealtimeMode ? 'server_vad' : 'manual',
    });
    this.wireSession(session);
    return session;
  }

  private wireSession(session: RealtimeSession): void {
    session.on('status', (status) => this.onSessionStatus(status));
    session.on('speech-started', ({ itemId }) => this.onSpeechStarted(session, itemId));
    session.on('speech-stopped', () => this.onSpeechStopped());
    session.on('audio-committed', ({ itemId }) => this.onAudioCommitted(itemId));
    session.on('response-requested', () => this.onResponseRequested());
    session.on('user-transcript', ({ itemId, text }) => this.onUserTranscript(itemId, text));
    session.on('assistant-transcript', ({ itemId, text, done }) =>
      this.onAssistantTranscript(itemId, text, done),
    );
    session.on('audio-delta', ({ itemId, chunk }) => this.onAudioDelta(itemId, chunk));
    session.on('tool-call', (call) => this.onToolCall(call));
    session.on('response-done', (info) => this.onResponseDone(info));
    session.on('error', (err) => this.onSessionError(err));
  }

  private onSessionStatus(status: SessionStatus): void {
    this.recorder?.record('realtime_status', status);
    this.panel.send('panel:session-status', status);
  }

  /** Server VAD: the user started speaking — barge in and re-capture. */
  private onSpeechStarted(session: RealtimeSession, itemId: string): void {
    if (!this.fullRealtimeActive) return;
    // If a helper result is still connecting, live speech preempts it and
    // leaves the completion queued to run after this human turn.
    this.continuations.preemptVoice();
    const token = this.guard.beginEpisode();

    // WebSocket clients own playback. Stop it immediately and truncate the
    // model item at the last sample the user actually heard.
    const interrupted = this.telemetry.findInterruptedPlayback();
    if (interrupted && interrupted.samplesPlayed > 0) {
      session.truncateAudio(
        interrupted.itemId,
        (interrupted.samplesPlayed / AUDIO_SAMPLE_RATE) * 1000,
      );
    }
    this.stopResidualPlayback('stop');

    this.turnCaptures = [];
    const turn = this.telemetry.beginTurn('voice');
    turn.tHoldStart = Date.now();
    this.setCaptureIndicator(true);
    const repairIdentity = this.errors.captureRepairIdentity();
    const promise = captureAllDisplays()
      .catch((err: unknown) => {
        console.warn('[conversation] full realtime turn capture failed:', err);
        this.recorder?.record('capture_failed', { turnId: turn.turnId, error: err });
        return [] as CaptureResult[];
      })
      .then((captures) => {
        if (
          this.fullRealtimeActive &&
          this.guard.isCurrent(token) &&
          this.telemetry.active() === turn
        ) {
          const holdStart = turn.tHoldStart;
          if (holdStart === undefined) {
            throw new Error('full realtime capture completed without a turn start timestamp');
          }
          turn.tCaptureDone = Date.now();
          turn.captureMs = turn.tCaptureDone - holdStart;
        }
        return captures;
      });
    this.pendingFullRealtimeCapture = { token, itemId, promise, repairIdentity };
    this.machine.dispatch('open_mic_ready');
  }

  private onSpeechStopped(): void {
    if (!this.fullRealtimeActive) return;
    const turn = this.telemetry.active();
    if (turn?.kind === 'voice') turn.tHoldEnd = Date.now();
    this.machine.dispatch('turn_committed');
  }

  private onAudioCommitted(itemId: string): void {
    if (!this.fullRealtimeActive) return;
    void this.finishFullRealtimeTurn(itemId);
  }

  /**
   * F1 fix (M3): the ONLY place pendingResponses increments — fired for
   * every response.create the session sends (turns, tool continues,
   * internal tool-arg rejections alike).
   */
  private onResponseRequested(): void {
    this.pendingResponses += 1;
    this.guard.bumpEpoch();
    // F1 (M2): deltas of the response being requested belong to the
    // playback epoch that is current NOW.
    this.guard.lockDeltaEpoch();
    this.recorder?.record('response_requested', {
      turnId: this.telemetry.active()?.turnId,
      pendingResponses: this.pendingResponses,
    });
    // Keeps a pending idle grace from dropping the state mid-continuation.
    this.machine.dispatch('response_pending');
  }

  private onUserTranscript(itemId: string, text: string): void {
    const turn = this.telemetry.active();
    if (turn && turn.tFirstUserTranscript === undefined) {
      turn.tFirstUserTranscript = Date.now(); // M8.5
    }
    // F1 (m5): fill the placeholder bubble in place (keeps its position
    // above the assistant's answer).
    if (this.transcriptStore.resolvePendingVoice(text)) return;
    this.transcriptStore.upsert({
      id: itemId,
      role: 'user',
      text,
      streaming: false,
      timestamp: Date.now(),
    });
  }

  private onAssistantTranscript(itemId: string, text: string, done: boolean): void {
    this.noteResponseActivity();
    const turn = this.telemetry.active();
    if (turn && turn.tFirstAssistantTranscript === undefined) {
      turn.tFirstAssistantTranscript = Date.now(); // M8.5
    }
    // M11 (audio_output_failed): captions are FORCED on while playback is
    // failed — the spoken answer would otherwise be lost entirely.
    // M20 (whisper quiet mode): same forcing while voiceMuted — audio is
    // deliberately not played, so the text is the only channel.
    const s = this.settings.get();
    if (s.captionsEnabled || s.voiceMuted || this.errors.playbackFailed) {
      this.overlays.broadcast('overlay:caption', { itemId, text, done });
    }
    this.transcriptStore.upsertAssistantText(itemId, text, !done);
  }

  private onAudioDelta(itemId: string, chunk: ArrayBuffer): void {
    this.noteResponseActivity();
    this.chunksOut += 1;
    // M8.5: first audio delta + per-turn chunk count + item ownership.
    this.telemetry.noteAudioDelta(itemId);
    this.recorder?.appendAudio(
      'output',
      this.telemetry.active()?.turnId ?? 'unattributed',
      chunk,
      itemId,
    );
    // F1 (M2): tag the delta with its response's playback epoch.
    // M20 (whisper quiet mode): while voiceMuted the model still streams
    // audio (its transcript drives the captions), but none of it is played —
    // the deltas simply never reach the renderer's playback queue.
    if (!this.settings.get().voiceMuted) {
      this.audio.output(chunk, itemId, this.guard.deltaEpoch());
    }
  }

  private onToolCall(call: ToolCall): void {
    this.noteResponseActivity();
    const turn = this.telemetry.active();
    if (turn && turn.tFirstToolCall === undefined) {
      turn.tFirstToolCall = Date.now(); // M8.5
    }
    this.recorder?.record('tool_call', {
      transport: 'realtime',
      turnId: turn?.turnId,
      call,
    });
    this.handleToolCall(call);
  }

  private onResponseDone({ status, usage }: ResponseDoneInfo): void {
    this.pendingResponses = Math.max(0, this.pendingResponses - 1);
    this.recorder?.record('response_done', {
      turnId: this.telemetry.active()?.turnId,
      status,
      usage,
      pendingResponses: this.pendingResponses,
    });
    // M8.5 live eval: accumulate token usage across the turn's responses.
    const turn = this.telemetry.active();
    if (usage && turn) accumulateUsage(turn, usage);
    // A cancelled response was superseded — the superseding turn owns the
    // assistant state from here; nothing to settle.
    this.continuations.onResponsesSettled();
    if (status === 'cancelled') return;
    // F1 fix (M5): only settle the turn when NO responses remain
    // outstanding (a tool-call follow-up keeps the buddy speaking).
    if (this.pendingResponses > 0) return;
    // M8.5: the LAST response.done of the turn (after tool continuations).
    if (turn) {
      turn.tResponseDone = Date.now();
      this.recorder?.record('turn_finished', turn);
      this.recorder?.flush();
    }
    // F1 (m5): ASR never arrived for this voice turn.
    this.transcriptStore.resolvePendingVoice('(voice message)');
    // F1 (retention): the turn settled — release the capture buffers now
    // instead of holding multi-MB screenshots until the next turn.
    this.turnCaptures = [];
    if (status === 'failed' && !this.guard.closed) {
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
    if (status === 'incomplete' && !this.guard.closed) {
      this.errors.surface(describeKind('response_incomplete'));
    }
    this.machine.dispatch('turn_settled');
  }

  private onSessionError(err: Error): void {
    console.error('[conversation] session error:', redactSensitiveErrorText(err.message));
    this.recorder?.record('realtime_error', err);
    this.recorder?.flush();
    this.guard.bumpEpoch();
    if (this.guard.closed) return;
    if (this.fullRealtimeActive) this.deactivateFullRealtime();
    // M11: mid-hold connect failures (the fire-and-forget connect kicked by
    // appendAudio) must not flip the listening indicator to a red flash
    // while the user is still talking — the commit at hold end resolves the
    // turn through failTurn with the same classification.
    if (this.holding) return;
    // Panel session-status was already pushed by the 'status' listener.
    // M11: a mid-session server error is no longer a WORDLESS red flash —
    // classified catalog copy (rate_limited, server_error, ...) reaches the
    // transcript; unclassified errors keep `something went wrong: <detail>`.
    this.errors.surface(classifyError(err, { model: this.sessionModel }));
  }

  /**
   * First transcript/audio activity of a response flips thinking -> speaking
   * (the machine's table guards everything else: no promotion while the user
   * holds/talks, idle promotes back only while a response is truly open —
   * F1 M5 — and stray post-settle activity re-arms the idle grace instead of
   * stranding 'speaking').
   */
  private noteResponseActivity(): void {
    this.guard.bumpEpoch();
    this.machine.dispatch('response_activity');
  }

  // ---------------------------------------------------------------------
  // Tool calls -> pointer
  // ---------------------------------------------------------------------

  private handleToolCall(call: ToolCall): void {
    const invocation = parseRealtimeToolCall(call);
    switch (invocation.kind) {
      case 'spawn_helper_buddy':
        {
          const origin = this.session;
          const token = this.guard.currentToken();
          void this.helperBuddyTools.spawnHelperBuddy(invocation.args, 'voice').then((output) => {
            if (this.guard.isStale(token) || this.session !== origin) return;
            origin.sendToolOutput(call.callId, output);
            origin.continueResponse();
          });
        }
        return;
      case 'check_helper_buddies':
        this.session.sendToolOutput(
          call.callId,
          this.helperBuddyTools.checkHelperBuddies(invocation.args),
        );
        this.session.continueResponse();
        return;
      case 'use_computer': {
        const origin = this.session;
        const token = this.guard.currentToken();
        void this.computerUse.run(invocation.args, this.turnCaptures, token).then((output) => {
          if (this.guard.isStale(token) || this.session !== origin) return;
          origin.sendToolOutput(call.callId, output);
          origin.continueResponse();
        });
        return;
      }
      case 'reject':
        this.session.sendToolOutput(call.callId, { error: invocation.error });
        this.session.continueResponse(); // deferred until response.done (M4)
        return;
      case 'point_at': {
        const target = preparePointAt(invocation.args, this.turnCaptures);
        if (target === null) {
          this.session.sendToolOutput(call.callId, { error: NO_CAPTURE_ERROR });
          this.session.continueResponse();
          return;
        }
        // M9: tool output + continue go back IMMEDIATELY (the model's answer is
        // not gated on grounding); the pointer itself is dispatched async, after
        // the element-snap query (<= its timebox). The chain keeps multi-point
        // turns in call order.
        this.session.sendToolOutput(call.callId, {
          ok: true,
          pointed_at: invocation.args.label ?? '',
        });
        // F1 fix (M4): the continue is deferred inside the session until the
        // current response completes; accounting flows via 'response-requested'.
        this.session.continueResponse();
        this.pointer.enqueue(invocation.args, target.capture, target.mapped);
        return;
      }
    }
  }

  /**
   * M9 debug surface (POST /grounding/query): drive native accessibility directly.
   * Delegates to the pointer pipeline (typed result).
   */
  debugGroundingQuery(q: {
    x: number;
    y: number;
    label: string;
    radiusDip?: number;
  }): ReturnType<PointerPipeline['debugGroundingQuery']> {
    return this.pointer.debugGroundingQuery(q);
  }

  // ---------------------------------------------------------------------
  // State + transcript plumbing
  // ---------------------------------------------------------------------

  private setCaptureIndicator(active: boolean): void {
    this.captureIndicatorActive = active;
    this.overlays.broadcast('overlay:capture-indicator', { active });
  }

  private sendPlaybackCommand(command: PlaybackCommand): void {
    this.audio.playback(command, this.guard.playbackEpoch());
  }
}

/** Compare key changes without retaining a second plaintext credential. */
function fingerprintApiKey(apiKey: string | null): string | null {
  return apiKey === null ? null : createHash('sha256').update(apiKey, 'utf8').digest('hex');
}
