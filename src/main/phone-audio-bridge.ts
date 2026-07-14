/**
 * Disposable phone-audio QA bridge client.
 *
 * This is deliberately isolated behind CLICKY_PHONE_AUDIO_URL. The companion
 * process in tools/phone-audio-bridge owns LAN/TLS/browser concerns; Clicky
 * only speaks a tiny loopback WebSocket protocol:
 *
 * - binary server -> Clicky: PCM16 24 kHz mono microphone chunks
 * - binary Clicky -> server: PCM16 24 kHz mono response chunks
 * - JSON Clicky -> server: capture/playback control
 *
 * Delete this file, the ConversationDeps seam, and the tools directory when
 * the native iPhone client replaces the throwaway harness.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type PhoneCaptureCommand = 'start' | 'stop';
export type PhonePlaybackCommand = 'stop' | 'flush';

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

export class PhoneAudioBridgeClient
  extends EventEmitter<PhoneAudioBridgeEvents>
  implements PhoneAudioTransport
{
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectMs = RECONNECT_MIN_MS;
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
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
      this.reconnectMs = RECONNECT_MIN_MS;
      console.log(`[phone-audio] connected to ${this.url}`);
      this.sendJson({ type: 'capture', command: this.captureState });
      this.emit('connected');
    });

    socket.on('message', (data, isBinary) => {
      if (!isBinary || this.socket !== socket || this.closed) return;
      const bytes = Buffer.isBuffer(data)
        ? data
        : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
      const chunk = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      this.emit('audio', chunk);
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
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(RECONNECT_MAX_MS, this.reconnectMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private sendJson(payload: object): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }
}
