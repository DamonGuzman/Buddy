/**
 * RealtimeSession: owns the WebSocket to the OpenAI Realtime endpoint (GA v1)
 * — session.update handshake, push-to-talk audio append/commit, image input,
 * response streaming, tool-call dispatch, keep-warm idle close and reconnect
 * with backoff. Speaks exactly the protocol subset in ./protocol.ts, which is
 * also what tools/mock-realtime implements (point it there with
 * CLICKY_MOCK_URL or `urlOverride`).
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
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
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
import { parseServerEvent, validatePointAtArgs } from './protocol';
import { resolveEndpoint } from './mockable';
import { withErrorCode } from '../errors';

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

  /** Outbound events queued while (re)connecting; flushed on ready. */
  private sendQueue: ClientEvent[] = [];

  private idleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffAttempt = 0;
  /** F1 (churn): last failed connect attempt (cooldown for appendAudio). */
  private lastConnectFailAt = 0;

  /** True between response.create and response.done/error. */
  private responseActive = false;
  /** F1 (M4): a continue was requested mid-response; fire it after done. */
  private continuePending = false;
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
    this.dropQueuedAppends();
    if (!this.isSocketOpen()) return;
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Hotkey release: commit the buffered audio, attach the screenshots +
   * factual context as one user message item, and request a response.
   */
  async commitAudioAndRespond(images: TurnImage[], contextText: string): Promise<void> {
    await this.connect();
    this.send({ type: 'input_audio_buffer.commit' });
    if (images.length > 0 || contextText.length > 0) {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: this.buildImageContent(images, contextText) },
      });
    }
    this.createResponse();
  }

  /** Text fallback: typed question (+ optional screenshots/context). */
  async askText(text: string, images: TurnImage[] = [], contextText = ''): Promise<void> {
    await this.connect();
    const content: UserContentPart[] = this.buildImageContent(images, contextText);
    content.push({ type: 'input_text', text });
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content },
    });
    this.createResponse();
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
    if (this.responseActive) {
      this.continuePending = true;
      return;
    }
    this.createResponse();
  }

  /** Cancel the in-progress response (no-op when disconnected). */
  cancelResponse(): void {
    this.continuePending = false; // a cancelled turn must not auto-continue
    if (!this.isSocketOpen()) return;
    this.send({ type: 'response.cancel' });
    this.setResponseActive(false);
  }

  /**
   * F1 fix (sleep/resume): the machine woke from sleep — the socket may be
   * half-open (writes vanish into a dead pipe, no FIN ever arrives).
   * Terminate it and reset; the next turn reconnects lazily. If a response
   * was mid-flight, synthesize a failed response-done so the app recovers.
   */
  notifySystemResume(): void {
    if (this.closedByUser) return;
    this.dropQueuedAppends();
    this.failActiveResponse('system resumed from sleep');
    this.backoffAttempt = 0;
    const ws = this.ws;
    if (ws !== null) {
      this.suppressReconnectOnce = true;
      try {
        ws.terminate();
      } catch {
        /* already dead */
      }
    }
  }

  /** Clean shutdown (app quit). No reconnect after this. */
  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.setResponseActive(false);
    this.continuePending = false;
    this.sendQueue = [];
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
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
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
      // Codex AuthSource into this session.
      const key = this.options.getApiKey ? this.options.getApiKey() : (this.options.apiKey ?? null);
      if (key === null || key.length === 0) {
        const err = new Error('no API key configured');
        this.lastConnectFailAt = Date.now();
        this.dropQueuedAppends(); // F1 (M7): stale mic audio must not linger
        this.setStatus({ state: 'error', error: err.message });
        return Promise.reject(err);
      }
      headers['Authorization'] = `Bearer ${key}`;
    }

    return new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(endpoint.url, { headers });
      this.ws = ws;
      let settled = false;
      // Server `error` event received before session.created (e.g. the
      // account is out of credit: the server accepts the handshake, sends
      // {type:'error',code:'insufficient_quota'}, then closes 1013). Captured
      // so the connect rejection carries the REAL reason instead of a generic
      // "connection closed during handshake".
      let preSettleError: { message: string; code: string } | null = null;

      const timeout = setTimeout(() => {
        fail(
          preSettleError !== null
            ? // M11: the server's error code rides on the Error so the
              // catalog classifier (src/main/errors.ts) can map it.
              withErrorCode(
                new Error(describeHandshakeRejection(preSettleError, null)),
                preSettleError.code,
              )
            : new Error(`realtime handshake timed out after ${this.connectTimeoutMs}ms`),
        );
        ws.terminate();
      }, this.connectTimeoutMs);

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        // F1 (M7): a failed connect drops queued mic audio — it belongs to a
        // turn that can no longer succeed and must not leak into the next.
        this.lastConnectFailAt = Date.now();
        this.dropQueuedAppends();
        if (this.ws === ws) {
          this.ws = null;
          this.setStatus({ state: 'error', error: err.message });
        }
        rejectPromise(err);
      };

      ws.on('message', (data: WebSocket.RawData) => {
        this.guard(() => {
          const evt = parseServerEvent(rawDataToString(data));
          if (evt === null) return;
          if (!settled && evt.type === 'session.created') {
            settled = true;
            clearTimeout(timeout);
            this.sendNow(ws, this.buildSessionUpdate());
            this.backoffAttempt = 0;
            this.setStatus({ state: 'ready' });
            this.flushQueue();
            this.resetIdleTimer();
            resolvePromise();
            return;
          }
          if (!settled && evt.type === 'error') {
            // Pre-session rejection (quota, auth, ...): hold the reason for
            // the close/timeout that follows — do NOT route it through
            // handleServerEvent, whose status churn the connect failure
            // would immediately overwrite anyway.
            preSettleError = { message: evt.error.message, code: evt.error.code ?? '' };
            return;
          }
          this.resetIdleTimer();
          // F1 (sleep/resume): any server activity feeds the response watchdog.
          if (this.responseActive) this.armResponseWatchdog();
          this.handleServerEvent(evt);
        });
      });

      ws.on('error', (err: Error) => {
        this.guard(() => {
          if (!settled) {
            fail(err);
          } else if (this.ws === ws) {
            this.emitError(err);
          }
        });
      });

      ws.on('close', (code: number, reason: Buffer) => {
        this.guard(() => {
          if (!settled) {
            const closeInfo = { code, reason: reason.toString('utf8') };
            // M11: keep the classification data (server error code) flowing.
            const rejectionCode =
              preSettleError?.code ??
              (closeInfo.reason.includes('insufficient_quota') ? 'insufficient_quota' : undefined);
            fail(
              withErrorCode(
                new Error(describeHandshakeRejection(preSettleError, closeInfo)),
                rejectionCode,
              ),
            );
            return;
          }
          if (this.ws !== ws) return; // superseded socket
          this.ws = null;
          const wasIdleClose = this.idleClosing;
          this.idleClosing = false;
          const suppress = this.suppressReconnectOnce;
          this.suppressReconnectOnce = false;
          const hadActiveResponse = this.responseActive;
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
        });
      });
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
        if (this.responseActive || this.sendQueue.length > 0) this.scheduleReconnect();
      });
    }, delay);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.responseActive || !this.isSocketOpen()) return;
      this.idleClosing = true;
      this.ws?.close(1000, 'idle');
    }, this.idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.idleTimer = null;
    this.reconnectTimer = null;
  }

  // -------------------------------------------------------------------------
  // Response lifecycle (watchdog + ping while active)
  // -------------------------------------------------------------------------

  private setResponseActive(active: boolean): void {
    this.responseActive = active;
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
      if (this.responseWatchdog !== null) clearTimeout(this.responseWatchdog);
      this.responseWatchdog = null;
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private armResponseWatchdog(): void {
    if (this.responseWatchdog !== null) clearTimeout(this.responseWatchdog);
    this.responseWatchdog = setTimeout(() => {
      this.responseWatchdog = null;
      if (!this.responseActive) return;
      // F1 fix (sleep/resume): zero server activity for the whole window —
      // classic half-open pipe (commit written into a dead socket). Fail the
      // response so the app recovers, and terminate so the next turn starts
      // from a clean reconnect.
      this.failActiveResponse(
        `response timed out (no server activity for ${this.responseWatchdogMs}ms)`,
      );
      if (this.ws !== null) {
        this.suppressReconnectOnce = true;
        try {
          this.ws.terminate();
        } catch {
          /* already dead */
        }
      }
    }, this.responseWatchdogMs);
  }

  /** Synthesize a failed response-done so app-level turn recovery runs. */
  private failActiveResponse(reason: string): void {
    if (!this.responseActive) return;
    console.warn(`[realtime] failing active response: ${reason}`);
    this.setResponseActive(false);
    this.continuePending = false;
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
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: null,
          },
          output: { format: PCM_FORMAT, voice: this.options.voice },
        },
        tools: this.options.tools ?? [],
      },
    };
  }

  /**
   * One user message item: a short factual input_text part (which screen is
   * active, each screenshot's index + pixel dims, coordinate rules) followed
   * by one input_image data-URL part per screen. Persona lives in the
   * session instructions, not here.
   */
  private buildImageContent(images: TurnImage[], contextText: string): UserContentPart[] {
    const content: UserContentPart[] = [];
    if (images.length > 0) {
      this.lastTurnCapture = images.map((img) => img.meta);
      const screens = images
        .map(
          (img) =>
            `screen${img.meta.screenIndex} is ${img.meta.imageW}x${img.meta.imageH} pixels` +
            (img.meta.isActive ? ' (active screen, the cursor is here)' : ''),
        )
        .join('; ');
      // M8.6 (pointing accuracy): explicit coordinate anchors + a worked
      // fraction→pixel example. Live evals showed the model reads the scene
      // correctly but localizes in a mis-scaled coordinate frame; anchoring
      // the convention with landmarks tightens point_at coordinates.
      const anchors = images
        .map(
          (img) =>
            `screen${img.meta.screenIndex}: top-left corner (0,0), ` +
            `bottom-right corner (${img.meta.imageW},${img.meta.imageH})`,
        )
        .join('; ');
      const first = images[0]!.meta;
      const framing =
        `${CONTEXT_PREFIX} ${images.length} screenshot(s) attached. ${screens}. ` +
        `point_at coordinates must be pixel coordinates within the named screenshot. ` +
        `coordinate anchors — ${anchors}. ` +
        `to point accurately: judge how far across and down the target sits as a fraction ` +
        `of the full screenshot, then multiply by that screenshot's pixel size ` +
        `(e.g. a target 1/3 across and 1/4 down screen${first.screenIndex} is at ` +
        `(${Math.round(first.imageW / 3)},${Math.round(first.imageH / 4)})); ` +
        `commit to the target's actual offset — never default to the middle of the screen.` +
        (contextText.length > 0 ? ` ${contextText}` : '');
      content.push({ type: 'input_text', text: framing });
      for (const img of images) {
        content.push({
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${img.jpegBase64}`,
        });
      }
    } else if (contextText.length > 0) {
      content.push({ type: 'input_text', text: `${CONTEXT_PREFIX} ${contextText}` });
    }
    return content;
  }

  private createResponse(): void {
    this.send({ type: 'response.create' });
    this.setResponseActive(true);
    this.emit('response-requested'); // F1 (M3): single source of truth
  }

  /** Serialize + send, queueing while not ready (flushed on session.created). */
  private send(evt: ClientEvent): void {
    if (this.isReady() && this.ws !== null) {
      this.sendNow(this.ws, evt);
      return;
    }
    // F1 (M7): cap the queue. Shed audio first — 60ms mic chunks dominate
    // any backlog and are worthless once this stale — then the oldest frame.
    if (this.sendQueue.length >= MAX_SEND_QUEUE) {
      const appendIdx = this.sendQueue.findIndex((e) => e.type === 'input_audio_buffer.append');
      if (appendIdx === -1 && evt.type === 'input_audio_buffer.append') return; // drop the newcomer
      this.sendQueue.splice(appendIdx !== -1 ? appendIdx : 0, 1);
    }
    this.sendQueue.push(evt);
  }

  /** F1 (M7): drop queued mic-audio frames (stale-turn hygiene). */
  private dropQueuedAppends(): void {
    if (this.sendQueue.length === 0) return;
    this.sendQueue = this.sendQueue.filter((evt) => evt.type !== 'input_audio_buffer.append');
  }

  private sendNow(ws: WebSocket, evt: ClientEvent): void {
    this.sendNowRaw(ws, JSON.stringify(evt));
  }

  private sendNowRaw(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
      this.resetIdleTimer();
    } catch (err) {
      this.emitError(err);
    }
  }

  private flushQueue(): void {
    if (this.ws === null) return;
    const queue = this.sendQueue;
    this.sendQueue = [];
    for (const evt of queue) this.sendNow(this.ws, evt);
  }

  // -------------------------------------------------------------------------
  // Inbound dispatch
  // -------------------------------------------------------------------------

  private handleServerEvent(evt: ServerEvent): void {
    switch (evt.type) {
      case 'session.created':
      case 'session.updated':
      case 'response.created':
      case 'rate_limits.updated':
      case 'response.output_item.added':
        break;

      case 'conversation.item.input_audio_transcription.completed':
        this.emit('user-transcript', { itemId: evt.item_id, text: evt.transcript });
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        const text = (this.transcripts.get(evt.item_id) ?? '') + evt.delta;
        this.transcripts.set(evt.item_id, text);
        this.emit('assistant-transcript', { itemId: evt.item_id, text, done: false });
        break;
      }

      case 'response.output_audio_transcript.done': {
        const text = evt.transcript ?? this.transcripts.get(evt.item_id) ?? '';
        this.transcripts.set(evt.item_id, text);
        this.emit('assistant-transcript', { itemId: evt.item_id, text, done: true });
        break;
      }

      case 'response.output_audio.delta': {
        const buf = Buffer.from(evt.delta, 'base64');
        const chunk = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        this.emit('audio-delta', { itemId: evt.item_id, chunk });
        break;
      }

      case 'response.output_audio.done':
        this.emit('audio-done', { itemId: evt.item_id });
        break;

      case 'response.function_call_arguments.delta': {
        this.toolArgs.set(evt.call_id, (this.toolArgs.get(evt.call_id) ?? '') + evt.delta);
        break;
      }

      case 'response.function_call_arguments.done':
        this.handleToolCallDone(evt.call_id, evt.name, evt.arguments);
        break;

      case 'response.done': {
        this.setResponseActive(false);
        this.transcripts.clear();
        this.toolArgs.clear();
        const status = evt.response.status ?? 'completed';
        const wantContinue = this.continuePending && status === 'completed';
        this.continuePending = false;
        // F1 fix (M4): the deferred tool-output continue fires HERE — and
        // BEFORE emitting response-done, so app-level response accounting
        // never dips to zero in the middle of a multi-response turn (M5).
        if (wantContinue) this.createResponse();
        this.emit('response-done', {
          responseId: evt.response.id ?? '',
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
        this.setStatus({ state: 'error', error: evt.error.message });
        // M11: the server error code (falling back to the coarse error type,
        // e.g. 'server_error') rides on the Error so the catalog classifier
        // can turn a mid-session error event into friendly transcript copy.
        this.emitError(
          withErrorCode(new Error(evt.error.message), evt.error.code ?? evt.error.type),
        );
        break;
      }

      default:
        this.logUnknown((evt as { type: string }).type);
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
 * User-readable, single-line reason for a handshake the server rejected.
 * Prefers the server's pre-session `error` event; falls back to the WS close
 * code + reason. Shown verbatim in the panel (header "session: …" pill and
 * the "something went wrong: …" transcript entry) — keep the tone lowercase.
 */
function describeHandshakeRejection(
  err: { message: string; code: string } | null,
  close: { code: number; reason: string } | null,
): string {
  if (err?.code === 'insufficient_quota' || close?.reason.includes('insufficient_quota') === true) {
    return 'openai says your account is out of credit — add credits at platform.openai.com/billing';
  }
  if (err !== null) {
    const msg = singleLine(err.message);
    return err.code.length > 0 ? `openai error: ${msg} (${err.code})` : `openai error: ${msg}`;
  }
  const reason = close !== null ? singleLine(close.reason) : '';
  const detail =
    close !== null ? ` (code ${close.code}${reason.length > 0 ? `: ${reason}` : ''})` : '';
  return `connection closed during handshake${detail}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
