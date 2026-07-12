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
 */

import { captureAllDisplays } from './capture';
import type { CaptureResult } from './capture';
import { mapModelPoint } from './coords';
import { getSessionInstructions, getToolDefinitions } from './persona';
import { RealtimeSession } from './realtime/session';
import type { ToolCall } from './realtime/session';
import type { PointAtArgs } from './realtime/protocol';
import type { SettingsStore } from './settings';
import type { OverlayManager } from './windows/overlay';
import type { PanelManager } from './windows/panel';
import type {
  AssistantState,
  CaptureMeta,
  PlaybackCommand,
  PointerCommand,
  SessionStatus,
  Settings,
  TranscriptEntry,
} from '../shared/types';

/** Holds shorter than this are treated as accidental taps (no turn). */
const MIN_HOLD_MS = 250;
/** Grace after response.done before dropping back to idle. */
const IDLE_GRACE_MS = 300;
/** Error state auto-recovers to idle after this long. */
const ERROR_RECOVERY_MS = 4_000;
/** Transcript ring buffer size (also what GET /transcript returns). */
const TRANSCRIPT_LIMIT = 50;
/** Pointer commands kept for the debug harness. */
const POINTER_HISTORY_LIMIT = 10;

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
  /** Mic chunks are appended to the session only while this is true. */
  private acceptingAudio = false;
  private pendingCaptures: Promise<CaptureResult[]> | null = null;

  /** Captures attached to the most recent committed turn (tool-call mapping). */
  private turnCaptures: CaptureResult[] = [];
  private lastCapture: CaptureMeta[] | null = null;

  /** response.create sent minus response.done received (>=0). */
  private pendingResponses = 0;
  /** Bumped on any turn/response activity; guards the idle-grace timer. */
  private epoch = 0;

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

  constructor(deps: ConversationDeps) {
    this.settings = deps.settings;
    this.overlays = deps.overlays;
    this.panel = deps.panel;
    const snapshot = this.settings.get();
    this.sessionModel = snapshot.model;
    this.sessionVoice = snapshot.voice;
    this.session = this.buildSession();
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
    this.panel.send('audio:playback', { command });
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
    this.holding = true;
    this.holdStartedAt = Date.now();
    this.chunksThisHold = 0;
    this.acceptingAudio = this.canReachServer();
    this.epoch += 1;
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
      this.setState('idle');
      return;
    }
    void this.finishVoiceTurn();
  }

  /** Mic PCM chunk from the panel renderer (ipcMain 'audio:chunk'). */
  handleAudioChunk(chunk: ArrayBuffer): void {
    this.chunksIn += 1;
    if (this.holding) this.chunksThisHold += 1;
    if (this.acceptingAudio) this.session.appendAudio(chunk);
  }

  /** Typed question from the panel ('panel:ask-text') — same pipeline as voice. */
  async askText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (this.closed || trimmed.length === 0) return;
    // Supersede: cancel the current response and drop its queued audio.
    if (this.pendingResponses > 0) this.cancelActiveResponse('flush');
    this.epoch += 1;
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
    this.lastCapture = captures.map((r) => r.meta);
    this.turnCaptures = captures;

    try {
      await this.session.askText(trimmed, captures, '');
      this.pendingResponses += 1;
    } catch (err) {
      this.failTurn(err);
    }
  }

  /** Settings changed: model/voice require a fresh session (key does not). */
  onSettingsChanged(next: Settings): void {
    if (next.model === this.sessionModel && next.voice === this.sessionVoice) return;
    this.sessionModel = next.model;
    this.sessionVoice = next.voice;
    this.session.close();
    this.session.removeAllListeners();
    this.pendingResponses = 0;
    this.session = this.buildSession();
    this.panel.send('panel:session-status', this.session.status());
  }

  /** App shutdown. */
  close(): void {
    this.closed = true;
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.errorTimer = null;
    this.idleTimer = null;
    this.session.close();
  }

  // ---------------------------------------------------------------------
  // Voice turn completion
  // ---------------------------------------------------------------------

  private async finishVoiceTurn(): Promise<void> {
    this.setState('thinking');
    const captures = (await (this.pendingCaptures ?? Promise.resolve([]))) ?? [];
    this.pendingCaptures = null;
    this.turnCaptures = captures;
    // Stop appending: everything after this belongs to the next turn.
    this.acceptingAudio = false;
    try {
      await this.session.commitAudioAndRespond(captures, '');
      this.pendingResponses += 1;
    } catch (err) {
      this.failTurn(err);
    }
  }

  /** A turn could not be started/committed: fail soft, never crash. */
  private failTurn(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[conversation] turn failed:', message);
    const noKey = message.includes('no API key');
    this.pushTranscript({
      id: `sys_${Date.now()}_${(this.entrySeq += 1)}`,
      role: 'system',
      text: noKey ? 'add your openai key in settings' : `something went wrong: ${message}`,
      streaming: false,
      timestamp: Date.now(),
    });
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
    this.session.cancelResponse();
    this.playback(playback);
    this.pendingResponses = 0;
    for (const entry of this.entries) {
      if (entry.streaming) this.pushTranscript({ ...entry, streaming: false });
    }
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

    session.on('user-transcript', ({ itemId, text }) => {
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
      this.panel.send('audio:output', { chunk, itemId });
    });

    session.on('tool-call', (call) => {
      this.noteResponseActivity();
      this.handleToolCall(call);
    });

    session.on('response-done', () => {
      this.pendingResponses = Math.max(0, this.pendingResponses - 1);
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
    if (!this.holding && (this.state === 'thinking' || this.state === 'speaking')) {
      this.setState('speaking');
    }
  }

  /** ~300ms after response.done with no new activity: back to idle. */
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
      this.continueAfterTool();
      return;
    }
    // Session pre-validated/clamped these (validatePointAtArgs).
    const args = call.args as PointAtArgs;
    const byIndex = this.turnCaptures.find((c) => c.meta.screenIndex === args.screen);
    // Unknown screen index: clamp to the active screen's capture.
    const capture = byIndex ?? this.turnCaptures.find((c) => c.meta.isActive) ?? this.turnCaptures[0];
    if (!capture) {
      this.session.sendToolOutput(call.callId, {
        error: 'no screenshot available for that screen',
      });
      this.continueAfterTool();
      return;
    }
    const mapped = mapModelPoint(
      { x: args.x, y: args.y, ...(args.label !== undefined ? { label: args.label } : {}) },
      capture.meta,
    );
    const cmd: PointerCommand = {
      type: 'animate',
      points: [
        {
          x: mapped.local.x,
          y: mapped.local.y,
          ...(mapped.label !== undefined ? { label: mapped.label } : {}),
        },
      ],
      screenIndex: capture.meta.screenIndex,
    };
    this.overlays.routePointer(cmd);
    this.lastPointer = cmd;
    this.pointerHistory.push(cmd);
    if (this.pointerHistory.length > POINTER_HISTORY_LIMIT) {
      this.pointerHistory = this.pointerHistory.slice(-POINTER_HISTORY_LIMIT);
    }
    this.session.sendToolOutput(call.callId, { ok: true, pointed_at: args.label ?? '' });
    this.continueAfterTool();
  }

  private continueAfterTool(): void {
    this.session.continueResponse();
    this.pendingResponses += 1;
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
