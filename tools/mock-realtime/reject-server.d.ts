/**
 * Type declarations for tools/mock-realtime/reject-server.js so vitest suites
 * (TS) can embed the hostile Realtime endpoint with full typing
 * (tests/conversation-errors.test.ts).
 */

export interface RejectServerPreSettleError {
  code: string;
  message: string;
  /** Defaults to 'invalid_request_error'. */
  type?: string;
  /** Defaults to 1013 (the live quota-rejection close code). */
  closeCode?: number;
  closeReason?: string;
}

export interface RejectServerOptions {
  host?: string;
  /** 0 (the default) = ephemeral port. */
  port?: number;
  /** Reject the WebSocket upgrade with this HTTP status. */
  status?: number;
  /** Accept the upgrade, send one pre-settle error event, then close. */
  preSettleError?: RejectServerPreSettleError;
  log?: (line: string) => void;
}

export interface RejectServerHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function createRejectServer(options?: RejectServerOptions): Promise<RejectServerHandle>;
