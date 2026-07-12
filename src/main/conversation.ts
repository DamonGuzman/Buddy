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
import { dipToPhysicalViaMeta, physicalToDipViaMeta } from './grounding/convert';
import type { Pt } from './grounding/convert';
import { getSessionInstructions, getToolDefinitions } from './persona';
import { RealtimeSession } from './realtime/session';
import type { ToolCall } from './realtime/session';
import type { PointAtArgs } from './realtime/protocol';
import type { SettingsStore } from './settings';
import type { OverlayManager } from './windows/overlay';
import { showPanelOnce } from './windows/panel';
import type { PanelManager } from './windows/panel';
import type {
  AssistantState,
  CaptureMeta,
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

export interface ConversationDeps {
  settings: SettingsStore;
  overlays: OverlayManager;
  panel: PanelManager;
}

/** Debug-surface snapshot merged into DebugState by index.ts. */
export interface ConversationDebugInfo {
  lastCapture: CaptureMeta[] | null;
  lastPointer: PointerCommand | null;
  pointerHistory: PointerCommand[];
  audio: { chunksIn: number; chunksOut: number };
  captureIndicatorActive: boolean;
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
      // Accidental tap or dead mic: no turn, no error.
      this.acceptingAudio = false;
      this.session.clearAudio();
      this.pendingCaptures = null;
      this.discardActiveTurn(); // M8.5: no turn -> no timings record
      this.setState('idle');
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
    // A typed question while the hotkey is held supersedes the hold —
    // never two concurrent turns (m1) / response.creates.
    if (this.holding) this.cancelHold();
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

    try {
      await this.session.askText(trimmed, captures, '');
      turn.tCommitSent = Date.now(); // M8.5
      // pendingResponses counted via 'response-requested' (M3).
    } catch (err) {
      if (token === this.turnToken) this.failTurn(err);
    }
  }

  /** Settings changed: model/voice require a fresh session (key does not). */
  onSettingsChanged(next: Settings): void {
    if (next.model === this.sessionModel && next.voice === this.sessionVoice) return;
    this.sessionModel = next.model;
    this.sessionVoice = next.voice;
    // F1 fix (m3): a mid-turn rebuild must not leave debris.
    if (this.holding) this.cancelHold(); // graceful: mic released, no turn
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
    try {
      await this.session.commitAudioAndRespond(captures, '');
      if (this.activeTurn) this.activeTurn.tCommitSent = Date.now(); // M8.5
      // pendingResponses counted via 'response-requested' (M3).
    } catch (err) {
      if (token === this.turnToken) this.failTurn(err);
    }
  }

  /** A turn could not be started/committed: fail soft, never crash. */
  private failTurn(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[conversation] turn failed:', message);
    // F1 (M7): the failed turn's audio must never leak into the next turn.
    this.session.clearAudio();
    this.resolveVoicePlaceholder('(voice message)');
    const noKey = message.includes('no API key');
    this.pushTranscript({
      id: `sys_${Date.now()}_${(this.entrySeq += 1)}`,
      role: 'system',
      text: noKey ? 'add your openai key in settings' : `something went wrong: ${message}`,
      streaming: false,
      timestamp: Date.now(),
    });
    // No key = almost certainly a first-time user talking to a hidden panel.
    // Surface it (at most once per run, focus-less) so the "add your openai
    // key" message is actually seen instead of dying behind the tray icon.
    if (noKey) showPanelOnce();
    this.setState('error');
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
      instructions: getSessionInstructions(),
      tools: getToolDefinitions(),
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
      if (this.settings.get().captionsEnabled) {
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
      if (status === 'failed' && this.state !== 'error' && !this.closed) {
        // F1 fix (M6): a response failed without a server error event
        // (socket drop, watchdog) — run the normal turn-failure recovery.
        this.failTurn(new Error('the response was interrupted'));
        return;
      }
      this.scheduleIdle();
    });

    session.on('error', (err) => {
      console.error('[conversation] session error:', err.message);
      this.epoch += 1;
      // Panel session-status was already pushed by the 'status' listener.
      this.setState('error');
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
   */
  private async dispatchPointer(
    args: PointAtArgs,
    capture: CaptureResult,
    mapped: MappedPoint & { adjusted: boolean },
  ): Promise<void> {
    const token = this.turnToken;
    const turn = this.activeTurn;
    const meta = capture.meta;
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
    if (
      groundingSource !== 'uia' &&
      !this.restGroundDisabled &&
      args.label !== undefined &&
      args.label.length > 0
    ) {
      restUsed = true;
      const t0 = Date.now();
      const grounded = await this.getRestGrounder().groundWithModel({
        jpegBase64: capture.jpegBase64,
        imageW: meta.imageW,
        imageH: meta.imageH,
        label: args.label,
      });
      restMs = Date.now() - t0;
      if (grounded !== null && !this.closed && token === this.turnToken) {
        const regrounded = mapModelPoint(
          { x: grounded.x, y: grounded.y, ...(args.label !== undefined ? { label: args.label } : {}) },
          meta,
        );
        local = regrounded.local;
        groundingSource = 'rest';
      }
    }
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
