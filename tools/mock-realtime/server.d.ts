/**
 * Type declarations for tools/mock-realtime/server.js so vitest suites (TS)
 * can embed the mock server with full typing.
 */

import type { WebSocketServer } from 'ws';

export interface MockServerOptions {
  /** 0 = ephemeral port (tests). Default 8123. */
  port?: number;
  host?: string;
  /** Delay between transcript word deltas. Default 40ms. */
  wordDelayMs?: number;
  /** Delay between audio chunk deltas. Default 30ms. */
  audioChunkDelayMs?: number;
  log?: (line: string) => void;
}

export interface MockServer {
  wss: WebSocketServer;
  host: string;
  port: number;
  url: string;
  /** Every session.update received, newest last (test hook). */
  sessionUpdates: Array<{ type: 'session.update'; session: Record<string, unknown> }>;
  /** Every parsed client event received, across connections (test hook). */
  clientEvents: Array<{ type: string; [k: string]: unknown }>;
  connectionCount: number;
  /** Hard-kill all live sockets (reconnect testing). */
  dropAllConnections(): void;
  close(): Promise<void>;
}

export function createMockServer(options?: MockServerOptions): Promise<MockServer>;
/** The exact PCM16LE (24kHz mono) tone buffer streamed by every spoken response. */
export function synthesizeMelodyPcm16(options?: { amplitude?: number }): Buffer;
export const DEFAULT_PORT: number;
