/**
 * Shared wire transport for the ChatGPT-subscription Codex Responses backend
 * (`chatgpt.com/backend-api/codex/responses`). Three consumers speak this
 * protocol — `codex/responses-session.ts` (the conversational text brain),
 * `agents/helper-buddy-backend.ts` (the helper-buddy research loop), and
 * `grounding/rest-grounder.ts` (the Codex grounding arm) — and their requests
 * MUST stay wire-identical: the backend gates on the exact originator /
 * User-Agent pair the Codex CLI sends.
 *
 * This module owns the pieces those consumers proved live and must not
 * drift apart: the endpoint URL, the impersonation headers, quota-status
 * classification, the `x-codex-*-used-percent` telemetry parse, and the SSE
 * data-line reader (newline buffering + decoder flush + whole-body fallback).
 *
 * Everything here is transport-mechanical: no request-body building, no
 * event semantics — those stay with each consumer, whose serialized shapes
 * are pinned byte-for-byte by their tests.
 */

import type { CodexUsedPercent } from '../../shared/types';

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
/**
 * The exact originator/UA the Codex CLI uses — the backend gates on these.
 * Version-pinned to the shape proven live; NOT a secret.
 */
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_USER_AGENT = 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown';

/**
 * The proven Codex request headers. The bearer token is used ONLY here —
 * callers must never log it or place it in a request body.
 */
export function buildCodexHeaders(bearer: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    'ChatGPT-Account-Id': accountId,
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: CODEX_ORIGINATOR,
    'User-Agent': CODEX_USER_AGENT,
    'Content-Type': 'application/json',
  };
}

/**
 * 429 / 402 / 403 usage rejections = plan quota. Callers FAIL CLOSED on it
 * (never silently fall through to spending the metered API key).
 */
export function isQuotaStatus(status: number): boolean {
  return status === 402 || status === 403 || status === 429;
}

/**
 * Parse the ChatGPT-plan rate-limit headers into used-% telemetry. Header
 * names are lowercased by fetch; a missing or unparsable value yields null
 * for that field.
 */
export function parseUsedPercent(headers: Headers): CodexUsedPercent {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    primary: num('x-codex-primary-used-percent'),
    secondary: num('x-codex-secondary-used-percent'),
  };
}

/**
 * True when a streamed error event (`response.failed` / `error`) is a plan
 * usage / rate-limit rejection. Matches on the nested `error` record's
 * code/type/message when present, else the event's own fields.
 *
 * NOTE: `agents/helper-buddy-backend.ts` keeps its OWN, intentionally different classifier
 * (`/quota|usage.?limit|rate.?limit/i` over the JSON-serialized error
 * record). That matcher scans nested fields this one ignores but does NOT
 * treat "too many requests" / "insufficient..." as quota — and the agent
 * loop's retry semantics were tuned against exactly that behavior, so the
 * two are deliberately not merged.
 */
export function isQuotaErrorEvent(evt: Record<string, unknown>): boolean {
  const err = evt['error'];
  const rec = err !== null && typeof err === 'object' ? (err as Record<string, unknown>) : evt;
  const hay = [
    typeof rec['code'] === 'string' ? rec['code'] : '',
    typeof rec['type'] === 'string' ? rec['type'] : '',
    typeof rec['message'] === 'string' ? rec['message'] : '',
  ]
    .join(' ')
    .toLowerCase();
  return /quota|rate.?limit|usage.?limit|too many requests|insufficient/.test(hay);
}

/**
 * Parse one SSE line into a Responses event object. Returns null for
 * non-`data:` lines, empty payloads, the `[DONE]` sentinel, malformed JSON,
 * and non-object payloads. (`trimStart()` already strips a leading BOM —
 * U+FEFF is JavaScript whitespace — so no separate BOM handling is needed.)
 */
export function parseSseEventLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice('data:'.length).trim();
  if (data.length === 0 || data === '[DONE]') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Feed every event of a whole SSE body (a one-shot `res.text()` read) through
 * `parseSseEventLine`, in stream order. For incremental reads use
 * `readSseLines`.
 */
export function forEachSseEvent(
  body: string,
  onEvent: (evt: Record<string, unknown>) => void,
): void {
  for (const line of body.split(/\r?\n/)) {
    const evt = parseSseEventLine(line);
    if (evt !== null) onEvent(evt);
  }
}

/**
 * Incrementally read a Response body line-by-line: newline buffering, a
 * decoder flush for a trailing partial line (multi-byte chunks split safely),
 * and a whole-body `res.text()` fallback when the body is not a readable
 * stream (test fakes). `shouldStop` is consulted after each chunk's lines are
 * delivered; when it returns true the reader is cancelled and reading stops.
 * `idleTimeoutMs` is reset by every received byte chunk, so long healthy
 * streams are allowed while genuinely stalled streams fail deterministically.
 */
export interface ReadSseLinesOptions {
  shouldStop?: () => boolean;
  idleTimeoutMs?: number;
}

export class SseIdleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`backend stream was idle for ${timeoutMs}ms`);
    this.name = 'SseIdleTimeoutError';
  }
}

export async function readSseLines(
  res: Response,
  onLine: (line: string) => void,
  options: ReadSseLinesOptions = {},
): Promise<void> {
  const { shouldStop, idleTimeoutMs } = options;
  if (idleTimeoutMs !== undefined && (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0))
    throw new Error('SSE idle timeout must be a positive finite number');
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        let stopped = false;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          onLine(line);
          if (shouldStop?.()) {
            stopped = true;
            break;
          }
        }
        if (!stopped && !shouldStop?.()) continue;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return;
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        /* preserve the read/timeout error */
      }
      throw error;
    }
    buf += decoder.decode();
    if (buf.length > 0) onLine(buf);
  } else {
    const text = await withIdleTimeout(res.text(), idleTimeoutMs);
    for (const line of text.split(/\r?\n/)) {
      onLine(line);
      if (shouldStop?.()) break;
    }
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return withIdleTimeout(reader.read(), timeoutMs);
}

function withIdleTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return operation;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SseIdleTimeoutError(timeoutMs)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
