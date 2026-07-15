/**
 * WebSocket handshake for the Realtime endpoint, extracted from
 * RealtimeSession.doConnect: open the socket, wait for `session.created`
 * within the timeout, and turn every pre-settle failure (timeout, socket
 * error, server `error` event followed by a close) into one Error carrying
 * the REAL rejection reason plus the server's error code for the M11
 * catalog classifier (src/main/errors.ts).
 *
 * M13-core INVARIANT: the realtime WS is ALWAYS authenticated with the
 * metered OpenAI *platform* API key — never the ChatGPT-subscription (Codex)
 * bearer. The subscription only exposes the batch
 * chatgpt.com/backend-api/codex/responses endpoint (used for grounding); it
 * CANNOT open a realtime WebSocket, so `headers` is plain HTTP headers by
 * design and this function must never grow an AuthSource parameter. The
 * sub/key split lives entirely in the grounding path (auth/auth-source.ts +
 * grounding/rest-grounder.ts).
 */

import WebSocket from 'ws';
import type { ServerEvent, UnknownServerEvent } from './protocol';
import { isKnownServerEvent, parseServerEvent } from './protocol';
import { redactSensitiveErrorText, withErrorCode } from '../errors';

export interface ConnectParams {
  url: string;
  /** WS upgrade headers — `Authorization: Bearer <platform key>` or empty (mock). */
  headers: Record<string, string>;
  /** Handshake timeout waiting for session.created. */
  timeoutMs: number;
}

/** How the session reacts to socket lifecycle; every hook runs inside `guard`. */
export interface ConnectHooks {
  /** Wrap every WS callback: errors must never throw across the boundary. */
  guard(fn: () => void): void;
  /** session.created arrived — the connect attempt succeeded. */
  onSettled(ws: WebSocket): void;
  /** The connect attempt failed (timeout / socket error / close before settle). */
  onFailed(ws: WebSocket, err: Error): void;
  /** Any parsed server event outside the handshake bookkeeping. */
  onServerEvent(ws: WebSocket, evt: ServerEvent | UnknownServerEvent): void;
  /** Socket 'error' after settle. */
  onSocketError(ws: WebSocket, err: Error): void;
  /** Socket 'close' after settle. */
  onSocketClose(ws: WebSocket): void;
}

/**
 * Open the socket and drive the handshake. Exactly one of onSettled/onFailed
 * fires; onServerEvent / onSocketError / onSocketClose route everything else
 * back to the session.
 */
export function connectRealtimeSocket(params: ConnectParams, hooks: ConnectHooks): WebSocket {
  const ws = new WebSocket(params.url, { headers: params.headers });
  let settled = false;
  // Server `error` event received before session.created (e.g. the account
  // is out of credit: the server accepts the handshake, sends
  // {type:'error',code:'insufficient_quota'}, then closes 1013). Captured so
  // the connect rejection carries the REAL reason instead of a generic
  // "connection closed during handshake".
  let preSettleError: { message: string; code: string } | null = null;

  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    hooks.onFailed(ws, err);
  };

  const timeout = setTimeout(() => {
    fail(
      preSettleError !== null
        ? // M11: the server's error code rides on the Error so the
          // catalog classifier (src/main/errors.ts) can map it.
          withErrorCode(
            new Error(describeHandshakeRejection(preSettleError, null)),
            preSettleError.code,
          )
        : new Error(`realtime handshake timed out after ${params.timeoutMs}ms`),
    );
    ws.terminate();
  }, params.timeoutMs);

  ws.on('message', (data: WebSocket.RawData) => {
    hooks.guard(() => {
      const evt = parseServerEvent(rawDataToString(data));
      if (evt === null) return;
      if (!settled && isKnownServerEvent(evt)) {
        if (evt.type === 'session.created') {
          settled = true;
          clearTimeout(timeout);
          hooks.onSettled(ws);
          return;
        }
        if (evt.type === 'error') {
          // Pre-session rejection (quota, auth, ...): hold the reason for
          // the close/timeout that follows — do NOT route it onward, whose
          // status churn the connect failure would immediately overwrite
          // anyway.
          preSettleError = {
            message: evt.error.message,
            code: normalizeServerErrorCode(evt.error.code ?? ''),
          };
          return;
        }
      }
      hooks.onServerEvent(ws, evt);
    });
  });

  ws.on('error', (err: Error) => {
    hooks.guard(() => {
      if (!settled) {
        fail(err);
      } else {
        hooks.onSocketError(ws, err);
      }
    });
  });

  ws.on('close', (code: number, reason: Buffer) => {
    hooks.guard(() => {
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
      hooks.onSocketClose(ws);
    });
  });

  return ws;
}

/**
 * User-readable, single-line reason for a handshake the server rejected.
 * Prefers the server's pre-session `error` event; falls back to the WS close
 * code + reason. Shown verbatim in the panel (header "session: …" pill and
 * the "something went wrong: …" transcript entry) — keep the tone lowercase.
 */
export function describeHandshakeRejection(
  err: { message: string; code: string } | null,
  close: { code: number; reason: string } | null,
): string {
  if (err?.code === 'insufficient_quota' || close?.reason.includes('insufficient_quota') === true) {
    return 'openai says your account is out of credit — add credits at platform.openai.com/billing';
  }
  if (err !== null) {
    const msg = redactSensitiveErrorText(singleLine(err.message));
    const code = normalizeServerErrorCode(err.code);
    return code.length > 0 ? `openai error: ${msg} (${code})` : `openai error: ${msg}`;
  }
  const reason = close !== null ? redactSensitiveErrorText(singleLine(close.reason)) : '';
  const detail =
    close !== null ? ` (code ${close.code}${reason.length > 0 ? `: ${reason}` : ''})` : '';
  return `connection closed during handshake${detail}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Codes are server-controlled and renderer-visible. Preserve only the small
 * set that Buddy's error catalog actually classifies; a shape check alone is
 * insufficient because credentials such as `sk-...` are syntactically valid
 * machine tokens too.
 */
const DISPLAYABLE_SERVER_ERROR_CODES = new Set([
  'access_denied',
  'authentication_error',
  'billing_hard_limit_reached',
  'insufficient_quota',
  'internal_server_error',
  'invalid_api_key',
  'model_not_available',
  'model_not_found',
  'permission_denied',
  'rate_limit_error',
  'rate_limit_exceeded',
  'server_error',
  'usage_limit_reached',
]);

function normalizeServerErrorCode(code: string): string {
  const normalized = code.trim().toLowerCase();
  return DISPLAYABLE_SERVER_ERROR_CODES.has(normalized) ? normalized : '';
}

function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
