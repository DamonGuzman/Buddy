/**
 * RealtimeSession: owns the WebSocket to the OpenAI Realtime endpoint (GA v1)
 * — session.update handshake, push-to-talk audio append/commit, image input,
 * response streaming, tool-call dispatch, keep-warm idle close and reconnect
 * with backoff. Speaks exactly the protocol subset in ./protocol.ts, which is
 * also what tools/mock-realtime implements (point it there with
 * CLICKY_MOCK_URL or `urlOverride`).
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
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

const PCM_FORMAT = { type: 'audio/pcm', rate: 24000 } as const;

/** Prefix for the factual context part of an image turn (the mock keys on it). */
export const CONTEXT_PREFIX = 'context:';

// ---------------------------------------------------------------------------

export class RealtimeSession extends EventEmitter<RealtimeSessionEvents> {
  private readonly options: RealtimeSessionOptions;
  private readonly idleTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  private ws: WebSocket | null = null;
  private statusValue: SessionStatus;
  private connectPromise: Promise<void> | null = null;
  private closedByUser = false;
  private idleClosing = false;

  /** Outbound events queued while (re)connecting; flushed on ready. */
  private sendQueue: string[] = [];

  private idleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffAttempt = 0;

  /** True between response.create and response.done/error. */
  private responseActive = false;

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
    void this.connect().catch((err: unknown) => this.emitError(err));
  }

  /** Drop any un-committed audio in the input buffer. */
  clearAudio(): void {
    if (!this.isSocketOpen()) return; // nothing buffered server-side if we're not connected
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

  /** Ask the model to continue after tool output(s) were sent. */
  continueResponse(): void {
    this.createResponse();
  }

  /** Cancel the in-progress response (no-op when disconnected). */
  cancelResponse(): void {
    if (!this.isSocketOpen()) return;
    this.send({ type: 'response.cancel' });
    this.responseActive = false;
  }

  /** Clean shutdown (app quit). No reconnect after this. */
  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.sendQueue = [];
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
      const key = this.options.getApiKey ? this.options.getApiKey() : (this.options.apiKey ?? null);
      if (key === null || key.length === 0) {
        const err = new Error('no API key configured');
        this.setStatus({ state: 'error', error: err.message });
        return Promise.reject(err);
      }
      headers['Authorization'] = `Bearer ${key}`;
    }

    return new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(endpoint.url, { headers });
      this.ws = ws;
      let settled = false;

      const timeout = setTimeout(() => {
        fail(new Error(`realtime handshake timed out after ${this.connectTimeoutMs}ms`));
        ws.terminate();
      }, this.connectTimeoutMs);

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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
          this.resetIdleTimer();
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

      ws.on('close', () => {
        this.guard(() => {
          if (!settled) {
            fail(new Error('connection closed during handshake'));
            return;
          }
          if (this.ws !== ws) return; // superseded socket
          this.ws = null;
          const wasIdleClose = this.idleClosing;
          this.idleClosing = false;
          this.setStatus({ state: 'disconnected' });
          // Reconnect with backoff ONLY when the session was mid-use.
          if (!this.closedByUser && !wasIdleClose && (this.responseActive || this.sendQueue.length > 0)) {
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
      const framing =
        `${CONTEXT_PREFIX} ${images.length} screenshot(s) attached. ${screens}. ` +
        `point_at coordinates must be pixel coordinates within the named screenshot.` +
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
    this.responseActive = true;
  }

  /** Serialize + send, queueing while not ready (flushed on session.created). */
  private send(evt: ClientEvent): void {
    const frame = JSON.stringify(evt);
    if (this.isReady() && this.ws !== null) {
      this.sendNowRaw(this.ws, frame);
    } else {
      this.sendQueue.push(frame);
    }
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
    for (const frame of queue) this.sendNowRaw(this.ws, frame);
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
        this.responseActive = false;
        this.transcripts.clear();
        this.toolArgs.clear();
        this.emit('response-done', {
          responseId: evt.response.id ?? '',
          status: evt.response.status ?? 'completed',
          usage: evt.response.usage,
        });
        break;
      }

      case 'error':
        this.setStatus({ state: 'error', error: evt.error.message });
        this.emitError(new Error(evt.error.message));
        break;

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

  /** Garbage tool args: tell the model instead of pointing at nonsense. */
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

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
