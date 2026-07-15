/**
 * RealtimeSession: owns the WebSocket to the OpenAI Realtime endpoint (GA v1)
 * — session.update handshake, push-to-talk audio append/commit, image input,
 * response streaming, tool-call dispatch, keep-warm idle close and reconnect
 * with backoff. Speaks exactly the protocol subset in ./protocol.ts, which is
 * also what tools/mock-realtime implements (point it there with
 * CLICKY_MOCK_URL or `urlOverride`).
 *
 * The session is the I/O adapter over three extracted, unit-tested units:
 * - ./connect.ts        — socket open + handshake settlement/rejection,
 * - ./response-tracker.ts — response-lifecycle accounting (M3/M4/M5 ordering,
 *                           cancelled-response isolation),
 * - ./send-queue.ts     — capped offline queue with audio-first shedding (M7).
 *
 * F1 fixes (review findings):
 * - M3: every response.create this session sends — external turn or internal
 *   tool-rejection continue — emits 'response-requested', the single source
 *   of truth for app-level response accounting.
 * - M4: continueResponse() DEFERS its response.create while a response is
 *   still streaming (the real API rejects concurrent responses with
 *   'conversation_already_has_active_response'); the deferred continue fires
 *   once, on response.done with status 'completed'.
 * - M6: if the socket drops mid-response, a synthetic failed 'response-done'
 *   is emitted so the app-level turn recovers instead of wedging.
 * - M7: clearAudio() also drops QUEUED input_audio_buffer.append frames; a
 *   failed connect drops queued appends; the send queue is capped.
 * - sleep/resume: notifySystemResume() terminates a possibly half-open
 *   socket; a per-response watchdog fails responses with no server activity
 *   for ~30s; a WS ping runs while a response is active.
 * - response isolation: direct response starts are exclusive and server
 *   events are accepted only for the active response id. Late audio from a
 *   cancelled response can no longer leak into the next playback epoch.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { normalizeOpenAiApiKey } from '../../shared/api-key';
import type { CaptureMeta, SessionStatus } from '../../shared/types';
import type {
  ClientEvent,
  PointAtArgs,
  RealtimeFunctionTool,
  ResponseStatus,
  ResponseUsage,
  ServerEvent,
  UserContentPart,
} from './protocol';
import { isKnownServerEvent, validatePointAtArgs } from './protocol';
import { resolveEndpoint } from './mockable';
import { connectRealtimeSocket } from './connect';
import { buildScreenshotFraming } from './framing';
import { ResponseTracker } from './response-tracker';
import { SendQueue } from './send-queue';
import { redactSensitiveErrorText, withErrorCode } from '../errors';

// ---------------------------------------------------------------------------
// Public event + option surfaces
// ---------------------------------------------------------------------------

/** A screenshot attached to a turn. */
export interface TurnImage {
  /** JPEG bytes, base64 (NOT a data URL — the session adds the prefix). */
  jpegBase64: string;
  meta: CaptureMeta;
}

/** A parsed + validated tool call from the model. */
export interface ToolCall {
  callId: string;
  name: string;
  /** Validated/clamped for `point_at`; raw parsed JSON object for others. */
  args: PointAtArgs | Record<string, unknown>;
}

export interface ResponseDoneInfo {
  responseId: string;
  status: ResponseStatus;
  usage?: ResponseUsage | undefined;
}

export interface RealtimeSessionEvents {
  /** Connection status changed (onStateChange). */
  status: [SessionStatus];
  /** Async ASR transcript of the user's committed audio (onUserTranscript). */
  'user-transcript': [{ itemId: string; text: string }];
  /** Server VAD detected that the user started speaking. */
  'speech-started': [{ itemId: string }];
  /** Server VAD detected the end of the user's utterance. */
  'speech-stopped': [{ itemId: string }];
  /** Server VAD committed the user's completed audio item to the conversation. */
  'audio-committed': [{ itemId: string }];
  /**
   * Assistant spoken-transcript update: `text` is the FULL text so far for
   * this item (CaptionUpdate semantics), `done` marks the final update.
   */
  'assistant-transcript': [{ itemId: string; text: string; done: boolean }];
  /** Raw PCM16 (24kHz mono) output audio chunk (onAudioDelta). */
  'audio-delta': [{ itemId: string; chunk: ArrayBuffer }];
  /** All audio for this item has been sent (onAudioDone). */
  'audio-done': [{ itemId: string }];
  /** Complete tool call, arguments parsed and (for point_at) validated. */
  'tool-call': [ToolCall];
  /**
   * F1 fix (M3): a response.create was sent — EVERY one, whether requested by
   * the app (askText / commit / continueResponse) or internally (tool-arg
   * rejection continue). Response accounting must count from this event only.
   */
  'response-requested': [];
  /** Response finished streaming (onResponseDone). */
  'response-done': [ResponseDoneInfo];
  /** Transport or protocol error (onError). Never thrown across WS callbacks. */
  error: [Error];
}

export interface RealtimeSessionOptions {
  model: string;
  voice: string;
  instructions: string;
  /** Static API key (tests / simple callers). Ignored in mock mode. */
  apiKey?: string;
  /** Lazy key resolution (preferred in the app; wins over `apiKey`). */
  getApiKey?: () => string | null;
  /** Tools for session.update (persona.getToolDefinitions()). Default: []. */
  tools?: RealtimeFunctionTool[];
  /** Manual commit (default) or continuous server-VAD turn detection. */
  turnDetection?: 'manual' | 'server_vad';
  /** Explicit ws:// endpoint (mock mode). Wins over CLICKY_MOCK_URL. */
  urlOverride?: string;
  /** Keep-warm idle window before a graceful close. Default 5 minutes. */
  idleTimeoutMs?: number;
  /** Handshake timeout waiting for session.created. Default 10s. */
  connectTimeoutMs?: number;
  /** Per-response watchdog: fail after this long with no server activity. */
  responseWatchdogMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** F1 (M7): hard cap on frames queued while disconnected. */
const MAX_SEND_QUEUE = 256;
/** F1 (churn): min gap between auto-connect attempts from appendAudio. */
const CONNECT_RETRY_COOLDOWN_MS = 1_500;
/** F1 (sleep/resume): fail a response after this long with zero activity. */
const DEFAULT_RESPONSE_WATCHDOG_MS = 30_000;
/** F1 (sleep/resume): WS ping cadence while a response is active. */
const RESPONSE_PING_INTERVAL_MS = 15_000;

const PCM_FORMAT = { type: 'audio/pcm', rate: 24000 } as const;
/** Async input-transcription model (captions for the user's committed audio). */
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
/** Server-VAD tuning for full realtime mode (speech threshold + windows). */
const SERVER_VAD_TUNING = {
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
} as const;

/** Prefix for the factual context part of an image turn (the mock keys on it). */
export const CONTEXT_PREFIX = 'context:';

// ---------------------------------------------------------------------------

export class RealtimeSession extends EventEmitter<RealtimeSessionEvents> {
  private readonly options: RealtimeSessionOptions;
  private readonly idleTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly responseWatchdogMs: number;

  private ws: WebSocket | null = null;
  private statusValue: SessionStatus;
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;
  private idleClosing = false;
  /** Next socket close is deliberate (watchdog/resume): skip auto-reconnect. */
  private suppressReconnectOnce = false;

  /** Outbound events queued while (re)connecting; flushed on ready (M7 cap). */
  private readonly sendQueue = new SendQueue(MAX_SEND_QUEUE);
  /** Response-lifecycle accounting; timers react via onResponseActiveChange. */
  private readonly tracker = new ResponseTracker((active) => this.onResponseActiveChange(active));

  private idleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffAttempt = 0;
  /** F1 (churn): last failed connect attempt (cooldown for appendAudio). */
  private lastConnectFailAt = 0;

  private responseWatchdog: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  /** Full-text-so-far accumulation per output item (transcript semantics). */
  private transcripts = new Map<string, string>();
  /** Accumulated function-call argument deltas per call_id (fallback path). */
  private toolArgs = new Map<string, string>();
  /** Metadata of the screenshots attached to the most recent turn (clamping). */
  private lastTurnCapture: CaptureMeta[] | null = null;
  /** Unknown server event types we already logged (log once per type). */
  private unknownTypesLogged = new Set<string>();

  constructor(options: RealtimeSessionOptions) {
    super();
    this.options = options;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.responseWatchdogMs = options.responseWatchdogMs ?? DEFAULT_RESPONSE_WATCHDOG_MS;
    const endpoint = this.resolve();
    this.statusValue = {
      state: 'disconnected',
      model: options.model,
      usingMockServer: endpoint.isMock,
    };
  }

  /** True when urlOverride / CLICKY_MOCK_URL is in effect. */
  get usingMock(): boolean {
    return this.resolve().isMock;
  }

  status(): SessionStatus {
    return { ...this.statusValue };
  }

  // -------------------------------------------------------------------------
  // Outbound API
  // -------------------------------------------------------------------------

  /**
   * Lazily connect and complete the session.update handshake. Idempotent;
   * safe to call before every turn.
   */
  async connect(): Promise<void> {
    if (this.closedByUser) throw new Error('session closed');
    if (this.connectPromise) return this.connectPromise;
    if (this.isSocketOpen()) {
      // Socket survived (e.g. a recoverable `error` server event): back to ready.
      if (this.statusValue.state !== 'ready') this.setStatus({ state: 'ready' });
      return;
    }
    const attempt = this.doConnect();
    this.connectPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = null;
    }
  }

  /** Append a PCM16 (24kHz mono) mic chunk to the input audio buffer. */
  appendAudio(chunk: ArrayBuffer): void {
    if (this.closedByUser) return;
    this.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(chunk).toString('base64'),
    });
    // Fire-and-forget connect; failures surface via the 'error' event.
    // F1 (churn): after a failed attempt, back off — never one fresh socket
    // per 60ms mic chunk against a dead endpoint.
    if (Date.now() - this.lastConnectFailAt >= CONNECT_RETRY_COOLDOWN_MS) {
      void this.connect().catch((err: unknown) => this.emitError(err));
    }
  }

  /**
   * Drop any un-committed audio — QUEUED append frames as well as the
   * server-side input buffer (F1, M7). A fresh WebSocket connection is a
   * fresh server session (empty buffer), so no deferred clear is needed for
   * the disconnected case once the queued appends are gone.
   */
  clearAudio(): void {
    this.sendQueue.dropAudioAppends();
    if (!this.isSocketOpen()) return;
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Hotkey release: commit the buffered audio, attach the screenshots +
   * factual context as one user message item, and request a response.
   */
  async commitAudioAndRespond(images: TurnImage[], contextText: string): Promise<void> {
    await this.connect();
    this.assertResponseIdle();
    this.send({ type: 'input_audio_buffer.commit' });
    this.sendUserContext(images, contextText);
    this.createResponse();
  }

  /** Text fallback: typed question (+ optional screenshots/context). */
  async askText(text: string, images: TurnImage[] = [], contextText = ''): Promise<void> {
    await this.connect();
    this.assertResponseIdle();
    this.sendUserContext(images, contextText, text);
    this.createResponse();
  }

  /**
   * Add screen context without starting a response.
   */
  async addContext(images: TurnImage[], contextText = ''): Promise<void> {
    await this.connect();
    this.sendUserContext(images, contextText);
  }

  /**
   * Respond to a server-VAD audio item after adding the screenshots captured
   * for that turn. The caller waits for input_audio_buffer.committed first,
   * so this context is ordered after the user's audio and before the response.
   */
  async respondToVadTurn(images: TurnImage[], contextText = ''): Promise<void> {
    await this.connect();
    this.assertResponseIdle();
    this.sendUserContext(images, contextText);
    this.createResponse();
  }

  /**
   * Inject an automated user-role turn and ask the voice model to respond.
   * `shouldStart` is checked after connection so a real user turn can preempt
   * a background completion that was still waiting on the handshake.
   */
  async injectUserAndRespond(
    text: string,
    shouldStart: () => boolean = () => true,
  ): Promise<boolean> {
    await this.connect();
    if (!shouldStart()) return false;
    this.assertResponseIdle();
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.createResponse();
    return true;
  }

  /** Send a function_call_output back for a tool call. */
  sendToolOutput(callId: string, output: object): void {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
  }

  /**
   * Ask the model to continue after tool output(s) were sent.
   *
   * F1 fix (M4): function_call_arguments.done arrives while the response is
   * still in_progress, and the real API rejects response.create while one is
   * active. The continue is therefore DEFERRED until response.done arrives
   * with status 'completed'; multiple requests (multi-point turns) coalesce
   * into a single deferred response.create.
   */
  continueResponse(): void {
    if (this.tracker.deferContinueIfActive()) return;
    this.createResponse();
  }

  /** Cancel the in-progress response (no-op when disconnected). */
  cancelResponse(): void {
    const { cancelled, responseId } = this.tracker.cancel();
    if (!cancelled) return;
    if (this.isSocketOpen()) {
      this.send({
        type: 'response.cancel',
        ...(responseId !== null ? { response_id: responseId } : {}),
      });
    }
  }

  /** Remove model audio the user never heard after a WebSocket VAD interruption. */
  truncateAudio(itemId: string, audioEndMs: number): void {
    if (!this.isSocketOpen() || itemId.length === 0) return;
    this.send({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioEndMs)),
    });
  }

  /**
   * F1 fix (sleep/resume): the machine woke from sleep — the socket may be
   * half-open (writes vanish into a dead pipe, no FIN ever arrives).
   * Terminate it and reset; the next turn reconnects lazily. If a response
   * was mid-flight, synthesize a failed response-done so the app recovers.
   */
  notifySystemResume(): void {
    if (this.closedByUser) return;
    this.sendQueue.dropAudioAppends();
    this.failActiveResponse('system resumed from sleep');
    this.backoffAttempt = 0;
    const ws = this.ws;
    if (ws !== null) {
      this.suppressReconnectOnce = true;
      this.terminateSilently(ws);
    }
  }

  /** Clean shutdown (app quit). No reconnect after this. */
  close(): void {
    this.closedByUser = true;
    this.clearAllTimers();
    this.tracker.reset();
    this.sendQueue.clear();
    // F1 (retention): release per-turn accumulation.
    this.transcripts.clear();
    this.toolArgs.clear();
    this.lastTurnCapture = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'client shutdown');
      } catch {
        /* already dead */
      }
    }
    this.setStatus({ state: 'disconnected' });
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private resolve(): { url: string; isMock: boolean } {
    return resolveEndpoint(this.options.model, process.env, this.options.urlOverride);
  }

  private isSocketOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private isReady(): boolean {
    return this.isSocketOpen() && this.statusValue.state === 'ready';
  }

  private doConnect(): Promise<void> {
    if (this.ws !== null) {
      // Defensive: never leak a half-dead socket.
      this.terminateSilently(this.ws);
      this.ws = null;
    }
    const endpoint = this.resolve();
    this.setStatus({ state: 'connecting', usingMockServer: endpoint.isMock });

    const headers: Record<string, string> = {};
    if (!endpoint.isMock) {
      // M13-core INVARIANT: the realtime WS is ALWAYS authenticated with the
      // metered OpenAI *platform* API key — never the ChatGPT-subscription
      // (Codex) bearer. The subscription only exposes the batch
      // chatgpt.com/backend-api/codex/responses endpoint (used for grounding);
      // it CANNOT open a realtime WebSocket, so there is no `chatgptCodex` arm
      // here by design. The sub/key split lives entirely in the grounding path
      // (auth/auth-source.ts + grounding/rest-grounder.ts). Do NOT wire the
      // Codex AuthSource into this session (connect.ts must never grow an
      // AuthSource parameter).
      const key = this.options.getApiKey ? this.options.getApiKey() : (this.options.apiKey ?? null);
      if (key === null || key.length === 0) {
        const err = new Error('no API key configured');
        this.lastConnectFailAt = Date.now();
        this.sendQueue.dropAudioAppends(); // F1 (M7): stale mic audio must not linger
        this.setStatus({ state: 'error', error: err.message });
        return Promise.reject(err);
      }
      const normalizedKey = normalizeOpenAiApiKey(key);
      if (normalizedKey === null) {
        const err = withErrorCode(
          new Error('the stored OpenAI API key is malformed (invalid_api_key)'),
          'invalid_api_key',
        );
        this.lastConnectFailAt = Date.now();
        this.sendQueue.dropAudioAppends();
        this.setStatus({ state: 'error', error: err.message });
        return Promise.reject(err);
      }
      headers['Authorization'] = `Bearer ${normalizedKey}`;
    }

    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.ws = connectRealtimeSocket(
        { url: endpoint.url, headers, timeoutMs: this.connectTimeoutMs },
        {
          guard: (fn) => this.guard(fn),
          onSettled: (ws) => {
            this.sendNow(ws, this.buildSessionUpdate());
            this.backoffAttempt = 0;
            this.setStatus({ state: 'ready' });
            this.flushQueue();
            this.resetIdleTimer();
            resolvePromise();
          },
          onFailed: (ws, err) => {
            // F1 (M7): a failed connect drops queued mic audio — it belongs
            // to a turn that can no longer succeed and must not leak into
            // the next.
            this.lastConnectFailAt = Date.now();
            this.sendQueue.dropAudioAppends();
            if (this.ws === ws) {
              this.ws = null;
              this.setStatus({ state: 'error', error: err.message });
            }
            rejectPromise(err);
          },
          onServerEvent: (_ws, evt) => {
            this.resetIdleTimer();
            // F1 (sleep/resume): any server activity feeds the response watchdog.
            if (this.tracker.active) this.armResponseWatchdog();
            if (!isKnownServerEvent(evt)) {
              this.logUnknown(evt.type);
              return;
            }
            this.handleServerEvent(evt);
          },
          onSocketError: (ws, err) => {
            if (this.ws === ws) this.emitError(err);
          },
          onSocketClose: (ws) => {
            if (this.ws !== ws) return; // superseded socket
            this.ws = null;
            const wasIdleClose = this.idleClosing;
            this.idleClosing = false;
            const suppress = this.suppressReconnectOnce;
            this.suppressReconnectOnce = false;
            const hadActiveResponse = this.tracker.active;
            this.setStatus({ state: 'disconnected' });
            // F1 fix (M6): a response died with the socket. Clear the active
            // flag (it gated keep-warm + reconnect forever) and synthesize a
            // failed response-done so the app-level turn recovers.
            if (hadActiveResponse) this.failActiveResponse('connection dropped mid-response');
            // F1 (retention): per-item accumulation dies with the connection.
            this.transcripts.clear();
            this.toolArgs.clear();
            // Reconnect with backoff ONLY when the session was mid-use.
            if (
              !this.closedByUser &&
              !wasIdleClose &&
              !suppress &&
              (hadActiveResponse || this.sendQueue.length > 0)
            ) {
              this.scheduleReconnect();
            }
          },
        },
      );
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.closedByUser) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.backoffAttempt, BACKOFF_CAP_MS);
    this.backoffAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // Handshake failed again — back off further while still mid-use.
        if (this.tracker.active || this.sendQueue.length > 0) this.scheduleReconnect();
      });
    }, delay);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.tracker.active || !this.isSocketOpen()) return;
      this.idleClosing = true;
      this.ws?.close(1000, 'idle');
    }, this.idleTimeoutMs);
  }

  /** Every session timer: idle, reconnect, response watchdog, ping. */
  private clearAllTimers(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.disarmResponseTimers();
  }

  /** Terminate a socket that may already be dead (never throws). */
  private terminateSilently(ws: WebSocket): void {
    try {
      ws.terminate();
    } catch {
      /* already dead */
    }
  }

  // -------------------------------------------------------------------------
  // Response lifecycle (watchdog + ping while active)
  // -------------------------------------------------------------------------

  /** ResponseTracker active-flag transitions drive the response timers. */
  private onResponseActiveChange(active: boolean): void {
    if (active) {
      this.armResponseWatchdog();
      if (this.pingTimer === null) {
        this.pingTimer = setInterval(() => {
          if (this.isSocketOpen()) {
            try {
              this.ws?.ping();
            } catch {
              /* a dead socket surfaces via its close event */
            }
          }
        }, RESPONSE_PING_INTERVAL_MS);
      }
    } else {
      this.disarmResponseTimers();
    }
  }

  private disarmResponseTimers(): void {
    if (this.responseWatchdog !== null) clearTimeout(this.responseWatchdog);
    this.responseWatchdog = null;
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private armResponseWatchdog(): void {
    if (this.responseWatchdog !== null) clearTimeout(this.responseWatchdog);
    this.responseWatchdog = setTimeout(() => {
      this.responseWatchdog = null;
      if (!this.tracker.active) return;
      // F1 fix (sleep/resume): zero server activity for the whole window —
      // classic half-open pipe (commit written into a dead socket). Fail the
      // response so the app recovers, and terminate so the next turn starts
      // from a clean reconnect.
      this.failActiveResponse(
        `response timed out (no server activity for ${this.responseWatchdogMs}ms)`,
      );
      if (this.ws !== null) {
        this.suppressReconnectOnce = true;
        this.terminateSilently(this.ws);
      }
    }, this.responseWatchdogMs);
  }

  /** Synthesize a failed response-done so app-level turn recovery runs. */
  private failActiveResponse(reason: string): void {
    if (!this.tracker.active) return;
    console.warn(`[realtime] failing active response: ${reason}`);
    this.tracker.fail();
    this.transcripts.clear();
    this.toolArgs.clear();
    this.emit('response-done', { responseId: '', status: 'failed' });
  }

  // -------------------------------------------------------------------------
  // Outbound plumbing
  // -------------------------------------------------------------------------

  private buildSessionUpdate(): ClientEvent {
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.options.instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: PCM_FORMAT,
            transcription: { model: TRANSCRIPTION_MODEL },
            turn_detection:
              this.options.turnDetection === 'server_vad'
                ? {
                    type: 'server_vad',
                    ...SERVER_VAD_TUNING,
                    // Let VAD commit the audio, then attach that turn's fresh
                    // screenshots before the client requests the response.
                    create_response: false,
                    interrupt_response: true,
                  }
                : null,
          },
          output: { format: PCM_FORMAT, voice: this.options.voice },
        },
        tools: this.options.tools ?? [],
      },
    };
  }

  /**
   * Send the turn's user message item (screenshots + factual context, plus
   * the typed question for the text path). Records the capture metadata
   * FIRST — the explicit turn-start baseline that point_at validation clamps
   * against — then sends. No-op when there is nothing to send.
   */
  private sendUserContext(images: TurnImage[], contextText: string, userText?: string): void {
    if (userText === undefined && images.length === 0 && contextText.length === 0) return;
    if (images.length > 0) this.lastTurnCapture = images.map((img) => img.meta);
    const content = buildImageContent(images, contextText);
    if (userText !== undefined) content.push({ type: 'input_text', text: userText });
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content },
    });
  }

  private assertResponseIdle(): void {
    this.tracker.assertIdle();
  }

  private createResponse(): void {
    this.tracker.begin();
    this.send({ type: 'response.create' });
    this.emit('response-requested'); // F1 (M3): single source of truth
  }

  /** Serialize + send, queueing while not ready (flushed on session.created). */
  private send(evt: ClientEvent): void {
    if (this.isReady() && this.ws !== null) {
      this.sendNow(this.ws, evt);
      return;
    }
    this.sendQueue.push(evt);
  }

  private sendNow(ws: WebSocket, evt: ClientEvent): void {
    try {
      ws.send(JSON.stringify(evt));
      this.resetIdleTimer();
    } catch (err) {
      this.emitError(err);
    }
  }

  private flushQueue(): void {
    if (this.ws === null) return;
    for (const evt of this.sendQueue.drain()) this.sendNow(this.ws, evt);
  }

  // -------------------------------------------------------------------------
  // Inbound dispatch
  // -------------------------------------------------------------------------

  private handleServerEvent(evt: ServerEvent): void {
    switch (evt.type) {
      case 'session.created':
      case 'session.updated':
      case 'rate_limits.updated':
      case 'response.output_item.added':
        break;

      case 'input_audio_buffer.committed':
        this.emit('audio-committed', { itemId: evt.item_id });
        break;

      case 'input_audio_buffer.speech_started': {
        // With interrupt_response=true the server cancels the active model
        // response. Mark it stale immediately so late WebSocket audio cannot
        // leak while the app stops local playback.
        if (this.options.turnDetection === 'server_vad') {
          this.tracker.markActiveResponseStale();
        }
        this.emit('speech-started', { itemId: evt.item_id });
        break;
      }

      case 'input_audio_buffer.speech_stopped':
        this.emit('speech-stopped', { itemId: evt.item_id });
        break;

      case 'response.created': {
        const responseId = evt.response?.id;
        if (!responseId) break;
        const decision = this.tracker.onResponseCreated(responseId);
        if (decision === 'cancel-unexpected') {
          console.warn(`[realtime] ignoring unexpected response ${responseId}`);
          this.send({ type: 'response.cancel', response_id: responseId });
        } else if (decision === 'cancel-parallel') {
          console.warn(
            `[realtime] cancelling parallel response ${responseId}; active is ${this.tracker.activeResponseId}`,
          );
          this.send({ type: 'response.cancel', response_id: responseId });
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed':
        this.emit('user-transcript', { itemId: evt.item_id, text: evt.transcript });
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        if (!this.tracker.acceptsEvent(evt.response_id)) break;
        const text = (this.transcripts.get(evt.item_id) ?? '') + evt.delta;
        this.transcripts.set(evt.item_id, text);
        this.emit('assistant-transcript', { itemId: evt.item_id, text, done: false });
        break;
      }

      case 'response.output_audio_transcript.done': {
        if (!this.tracker.acceptsEvent(evt.response_id)) break;
        const text = evt.transcript ?? this.transcripts.get(evt.item_id) ?? '';
        this.transcripts.set(evt.item_id, text);
        this.emit('assistant-transcript', { itemId: evt.item_id, text, done: true });
        break;
      }

      case 'response.output_audio.delta': {
        if (!this.tracker.acceptsEvent(evt.response_id)) break;
        const buf = Buffer.from(evt.delta, 'base64');
        const chunk = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        this.emit('audio-delta', { itemId: evt.item_id, chunk });
        break;
      }

      case 'response.output_audio.done':
        if (!this.tracker.acceptsEvent(evt.response_id)) break;
        this.emit('audio-done', { itemId: evt.item_id });
        break;

      case 'response.function_call_arguments.delta': {
        if (!this.tracker.acceptsEvent(evt.response_id)) break;
        this.toolArgs.set(evt.call_id, (this.toolArgs.get(evt.call_id) ?? '') + evt.delta);
        break;
      }

      case 'response.function_call_arguments.done':
        if (!this.tracker.acceptsEvent(evt.response_id)) break;
        this.handleToolCallDone(evt.call_id, evt.name, evt.arguments);
        break;

      case 'response.done': {
        const status = evt.response.status ?? 'completed';
        const responseId = evt.response.id ?? '';
        const decision = this.tracker.onResponseDone(responseId, status);
        if (decision.kind === 'non-active') {
          console.warn(
            `[realtime] ignoring completion for non-active response ${responseId}; ` +
              `active is ${this.tracker.activeResponseId}`,
          );
        } else if (decision.kind === 'active') {
          this.transcripts.clear();
          this.toolArgs.clear();
          // F1 fix (M4): the deferred tool-output continue fires HERE — and
          // BEFORE emitting response-done, so app-level response accounting
          // never dips to zero in the middle of a multi-response turn (M5).
          if (decision.continueAfter) this.createResponse();
        }
        this.emit('response-done', {
          responseId,
          status,
          usage: evt.response.usage,
        });
        break;
      }

      case 'error': {
        // M9 fix: a rejected audio commit ("buffer too small" / "buffer is
        // empty") means the requested response will never stream — without
        // this, responseActive stayed true and app-level accounting wedged
        // (pendingResponses stuck > 0, next turn cancelled a non-existent
        // response). Synthesize a failed response-done FIRST so the normal
        // turn-failure recovery (failTurn -> error -> idle) runs.
        const code = evt.error.code ?? '';
        const commitRejected =
          code === 'input_audio_buffer_commit_empty' ||
          /buffer (is )?(too small|empty)/i.test(evt.error.message);
        if (commitRejected) {
          this.failActiveResponse(`audio commit rejected: ${evt.error.message}`);
        }
        const safeMessage = redactSensitiveErrorText(evt.error.message);
        this.setStatus({ state: 'error', error: safeMessage });
        // M11: the server error code (falling back to the coarse error type,
        // e.g. 'server_error') rides on the Error so the catalog classifier
        // can turn a mid-session error event into friendly transcript copy.
        this.emitError(withErrorCode(new Error(safeMessage), evt.error.code ?? evt.error.type));
        break;
      }
    }
  }

  private handleToolCallDone(callId: string, name: string, finalArgs: string): void {
    const raw = finalArgs.length > 0 ? finalArgs : (this.toolArgs.get(callId) ?? '');
    this.toolArgs.delete(callId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.rejectToolCall(callId, name, 'arguments were not valid JSON');
      return;
    }
    if (name === 'point_at') {
      const args = validatePointAtArgs(parsed, this.lastTurnCapture ?? undefined);
      if (args === null) {
        this.rejectToolCall(callId, name, 'x, y and screen must be numbers');
        return;
      }
      this.emit('tool-call', { callId, name, args });
      return;
    }
    const args =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    this.emit('tool-call', { callId, name, args });
  }

  /**
   * Garbage tool args: tell the model instead of pointing at nonsense.
   * The continue defers like any other (M4) and is counted by the app via
   * 'response-requested' when it eventually fires (M3).
   */
  private rejectToolCall(callId: string, name: string, reason: string): void {
    console.warn(`[realtime] rejected ${name} call ${callId}: ${reason}`);
    this.sendToolOutput(callId, { error: `invalid ${name} arguments: ${reason}` });
    this.continueResponse();
  }

  private logUnknown(type: string): void {
    if (this.unknownTypesLogged.has(type)) return;
    this.unknownTypesLogged.add(type);
    console.log(`[realtime] ignoring unknown server event type: ${type}`);
  }

  /** Never throw across the WS callback boundary. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.emitError(err);
    }
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      console.error('[realtime] error:', error.message);
    }
  }

  private setStatus(patch: Partial<SessionStatus>): void {
    const next: SessionStatus = { ...this.statusValue, ...patch };
    if (next.state !== 'error') delete next.error;
    this.statusValue = next;
    this.emit('status', this.status());
  }
}

/**
 * Content parts of an image turn's user message: the shared framing prose
 * (framing.ts — starts with CONTEXT_PREFIX, which the mock keys on) followed
 * by one input_image data-URL part per screen. Persona lives in the session
 * instructions, not here.
 */
function buildImageContent(images: TurnImage[], contextText: string): UserContentPart[] {
  const content: UserContentPart[] = [];
  const framing = buildScreenshotFraming(
    images.map((img) => img.meta),
    contextText,
  );
  if (framing.length > 0) content.push({ type: 'input_text', text: framing });
  for (const img of images) {
    content.push({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${img.jpegBase64}`,
    });
  }
  return content;
}
