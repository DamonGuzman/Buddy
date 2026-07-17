/**
 * Disposable phone-audio QA bridge client.
 *
 * This is deliberately isolated behind CLICKY_PHONE_AUDIO_URL. The companion
 * process in tools/phone-audio-bridge owns LAN/TLS/browser concerns; Buddy
 * only speaks a tiny loopback WebSocket protocol:
 *
 * - binary server -> Buddy: PCM16 24 kHz mono microphone chunks
 * - binary Buddy -> server: PCM16 24 kHz mono response chunks
 * - JSON Buddy -> server: capture/playback control
 *
 * Delete this file, the ConversationDeps seam, and the tools directory when
 * the native iPhone client replaces the throwaway harness.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { Backoff, RetryTimer } from './util/backoff';

export type PhoneCaptureCommand = 'start' | 'stop';
export type PhonePlaybackCommand = 'stop' | 'flush';

/** Every JSON control message Buddy sends to the bridge (the full wire vocabulary). */
type PhoneControlMessage =
  | { type: 'capture'; command: PhoneCaptureCommand }
  | { type: 'playback'; command: PhonePlaybackCommand };

export interface PhoneAudioTransport {
  capture(command: PhoneCaptureCommand): void;
  playback(command: PhonePlaybackCommand): void;
  sendAudio(chunk: ArrayBuffer): void;
}

interface PhoneAudioBridgeEvents {
  audio: [chunk: ArrayBuffer];
  connected: [];
  disconnected: [];
}

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 4_000;

/**
 * Copy a ws 'message' payload into a standalone ArrayBuffer (never a view
 * into a shared pool buffer). Handles all three RawData cases: Buffer,
 * Buffer[], and ArrayBuffer.
 */
export function toArrayBuffer(data: Buffer | ArrayBuffer | Buffer[]): ArrayBuffer {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class PhoneAudioBridgeClient
  extends EventEmitter<PhoneAudioBridgeEvents>
  implements PhoneAudioTransport
{
  private socket: WebSocket | null = null;
  private readonly reconnectTimer = new RetryTimer();
  private readonly reconnectBackoff = new Backoff({
    minMs: RECONNECT_MIN_MS,
    maxMs: RECONNECT_MAX_MS,
  });
  private closed = false;
  private captureState: PhoneCaptureCommand = 'stop';

  constructor(private readonly url: string) {
    super();
  }

  start(): void {
    if (this.closed || this.socket !== null) return;
    this.connect();
  }

  capture(command: PhoneCaptureCommand): void {
    this.captureState = command;
    this.sendJson({ type: 'capture', command });
  }

  playback(command: PhonePlaybackCommand): void {
    this.sendJson({ type: 'playback', command });
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(Buffer.from(chunk));
  }

  close(): void {
    this.closed = true;
    this.reconnectTimer.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'clicky shutting down');
    this.removeAllListeners();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url, { perMessageDeflate: false });
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.on('open', () => {
      if (this.socket !== socket || this.closed) return;
      this.reconnectBackoff.reset();
      console.log(`[phone-audio] connected to ${this.url}`);
      this.sendJson({ type: 'capture', command: this.captureState });
      this.emit('connected');
    });

    socket.on('message', (data, isBinary) => {
      if (!isBinary || this.socket !== socket || this.closed) return;
      this.emit('audio', toArrayBuffer(data));
    });

    socket.on('error', (error) => {
      if (this.socket === socket && !this.closed) {
        console.warn('[phone-audio] bridge connection failed:', error.message);
      }
    });

    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
      this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    // Skip-if-pending: never stack reconnect attempts (see util/backoff.ts).
    if (this.closed || this.reconnectTimer.isPending()) return;
    this.reconnectTimer.schedule(this.reconnectBackoff.next(), () => this.connect());
  }

  private sendJson(payload: PhoneControlMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}
