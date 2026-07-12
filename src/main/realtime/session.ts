/**
 * RealtimeSession (M1 stub): owns the WebSocket to the Realtime endpoint,
 * session.update, audio append/commit, image input, response streaming,
 * tool-call events, and reconnect with backoff.
 *
 * M1 wires the shape (events, state machine, endpoint resolution) without
 * opening a socket. The realtime milestone fills in `connect()`.
 */

import { EventEmitter } from 'node:events';
import type { SessionStatus } from '../../shared/types';
import type { PointAtArgs, ServerEvent } from './protocol';
import { resolveEndpoint } from './mockable';

export interface RealtimeSessionEvents {
  /** Connection status changed. */
  status: [SessionStatus];
  /** base64 PCM16 output audio delta. */
  'audio-delta': [{ itemId: string; deltaBase64: string }];
  /** Output transcript delta (spoken words). */
  'transcript-delta': [{ itemId: string; delta: string }];
  /** point_at tool call ready for dispatch. */
  'point-at': [{ callId: string; args: PointAtArgs }];
  /** Response finished. */
  done: [{ responseId: string }];
  /** Protocol or transport error. */
  error: [Error];
}

export interface RealtimeSessionOptions {
  model: string;
  voice: string;
  /** Resolves the API key lazily (never cached here). */
  getApiKey: () => string | null;
  instructions: string;
}

export class RealtimeSession extends EventEmitter<RealtimeSessionEvents> {
  private statusValue: SessionStatus;

  constructor(private readonly options: RealtimeSessionOptions) {
    super();
    const endpoint = resolveEndpoint(options.model);
    this.statusValue = {
      state: 'disconnected',
      model: options.model,
      usingMockServer: endpoint.isMock,
    };
  }

  status(): SessionStatus {
    return { ...this.statusValue };
  }

  /**
   * Lazily connect (called on first hotkey press / text question).
   * TODO(realtime milestone): open WS, send session.update, keep warm ~5min,
   * reconnect with backoff.
   */
  async connect(): Promise<void> {
    this.setStatus({ state: 'disconnected' });
    throw new Error('RealtimeSession.connect not implemented (realtime milestone)');
  }

  /** Append a PCM16 chunk to the input audio buffer. */
  appendAudio(_chunk: ArrayBuffer): void {
    // TODO(realtime milestone): input_audio_buffer.append (base64)
  }

  /** Commit audio + screenshots and request a response (hotkey release). */
  async commitTurn(_screenshotsJpegBase64: string[]): Promise<void> {
    // TODO(realtime milestone): commit + conversation.item.create + response.create
  }

  /** Text fallback: typed question + screenshots -> response.create. */
  async askText(_text: string, _screenshotsJpegBase64: string[]): Promise<void> {
    // TODO(realtime milestone)
  }

  /** Send a function_call_output back and continue the response. */
  sendToolResult(_callId: string, _output: string): void {
    // TODO(realtime milestone)
  }

  close(): void {
    this.setStatus({ state: 'disconnected' });
  }

  // -------------------------------------------------------------------------

  /** Central dispatch for inbound frames (used by tests + the milestone impl). */
  protected handleServerEvent(evt: ServerEvent): void {
    switch (evt.type) {
      case 'response.output_audio.delta':
        this.emit('audio-delta', { itemId: evt.item_id, deltaBase64: evt.delta });
        break;
      case 'response.output_audio_transcript.delta':
        this.emit('transcript-delta', { itemId: evt.item_id, delta: evt.delta });
        break;
      case 'response.function_call_arguments.done': {
        if (evt.name === 'point_at') {
          try {
            const args = JSON.parse(evt.arguments) as PointAtArgs;
            this.emit('point-at', { callId: evt.call_id, args });
          } catch (err) {
            this.emit('error', new Error(`bad point_at arguments: ${String(err)}`));
          }
        }
        break;
      }
      case 'response.done':
        this.emit('done', { responseId: evt.response.id });
        break;
      case 'error':
        this.setStatus({ state: 'error', error: evt.error.message });
        this.emit('error', new Error(evt.error.message));
        break;
      case 'session.created':
      case 'session.updated':
        break;
    }
  }

  private setStatus(patch: Partial<SessionStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emit('status', this.status());
  }
}
