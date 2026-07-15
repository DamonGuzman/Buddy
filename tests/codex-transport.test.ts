/**
 * codex/transport.ts — the shared Codex Responses wire transport extracted
 * from responses-session.ts / agents/backend.ts / rest-grounder.ts. These
 * tests pin the pieces the backend gates on (URL, impersonation headers) and
 * the SSE reader mechanics (newline buffering, decoder flush, whole-body
 * fallback, cooperative stop). Fully offline.
 */

import { describe, expect, it } from 'vitest';
import {
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_URL,
  CODEX_USER_AGENT,
  buildCodexHeaders,
  forEachSseEvent,
  isQuotaErrorEvent,
  isQuotaStatus,
  parseSseEventLine,
  parseUsedPercent,
  readSseLines,
} from '../src/main/codex/transport';

// ---------------------------------------------------------------------------
// Constants + headers (the backend gates on these exact values)
// ---------------------------------------------------------------------------

describe('codex transport: constants + headers', () => {
  it('pins the proven endpoint and codex_cli_rs impersonation values', () => {
    expect(CODEX_RESPONSES_URL).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(CODEX_ORIGINATOR).toBe('codex_cli_rs');
    expect(CODEX_USER_AGENT).toBe('codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown');
  });

  it('buildCodexHeaders produces the exact proven header set', () => {
    expect(buildCodexHeaders('tok-123', 'acct-9')).toEqual({
      Authorization: 'Bearer tok-123',
      'ChatGPT-Account-Id': 'acct-9',
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown',
      'Content-Type': 'application/json',
    });
  });
});

// ---------------------------------------------------------------------------
// Quota classification
// ---------------------------------------------------------------------------

describe('codex transport: quota classification', () => {
  it('isQuotaStatus flags exactly 402/403/429', () => {
    expect(isQuotaStatus(402)).toBe(true);
    expect(isQuotaStatus(403)).toBe(true);
    expect(isQuotaStatus(429)).toBe(true);
    for (const status of [200, 400, 401, 404, 500, 503]) {
      expect(isQuotaStatus(status)).toBe(false);
    }
  });

  it('isQuotaErrorEvent matches code/type/message of the nested error record', () => {
    expect(isQuotaErrorEvent({ error: { code: 'usage_limit_reached' } })).toBe(true);
    expect(isQuotaErrorEvent({ error: { type: 'rate_limit_error' } })).toBe(true);
    expect(isQuotaErrorEvent({ error: { message: 'Too many requests' } })).toBe(true);
    expect(isQuotaErrorEvent({ error: { message: 'insufficient quota' } })).toBe(true);
    expect(isQuotaErrorEvent({ error: { message: 'server exploded' } })).toBe(false);
  });

  it('isQuotaErrorEvent falls back to the event itself when error is absent', () => {
    expect(isQuotaErrorEvent({ type: 'error', message: 'plan quota hit' })).toBe(true);
    expect(isQuotaErrorEvent({ type: 'response.failed' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseUsedPercent
// ---------------------------------------------------------------------------

describe('parseUsedPercent', () => {
  it('reads both used-percent headers', () => {
    const headers = new Headers({
      'x-codex-primary-used-percent': '12.5',
      'x-codex-secondary-used-percent': '4',
    });
    expect(parseUsedPercent(headers)).toEqual({ primary: 12.5, secondary: 4 });
  });

  it('yields null per field when absent or unparsable', () => {
    expect(parseUsedPercent(new Headers())).toEqual({ primary: null, secondary: null });
    expect(parseUsedPercent(new Headers({ 'x-codex-secondary-used-percent': 'nope' }))).toEqual({
      primary: null,
      secondary: null,
    });
  });
});

// ---------------------------------------------------------------------------
// SSE line parsing
// ---------------------------------------------------------------------------

describe('parseSseEventLine', () => {
  it('parses a data line into an event object (leading whitespace + \\r ok)', () => {
    expect(parseSseEventLine('data: {"type":"x"}')).toEqual({ type: 'x' });
    expect(parseSseEventLine('  data:{"type":"x"}')).toEqual({ type: 'x' });
    expect(parseSseEventLine('data: {"type":"x"}\r')).toEqual({ type: 'x' });
  });

  it('strips a leading BOM (U+FEFF is JS whitespace)', () => {
    expect(parseSseEventLine('﻿data: {"type":"x"}')).toEqual({ type: 'x' });
  });

  it('returns null for non-data lines, [DONE], blanks, malformed JSON, primitives', () => {
    expect(parseSseEventLine('event: message')).toBeNull();
    expect(parseSseEventLine('data: [DONE]')).toBeNull();
    expect(parseSseEventLine('data:')).toBeNull();
    expect(parseSseEventLine('')).toBeNull();
    expect(parseSseEventLine('data: {broken')).toBeNull();
    expect(parseSseEventLine('data: 42')).toBeNull();
    expect(parseSseEventLine('data: "just a string"')).toBeNull();
    expect(parseSseEventLine('data: null')).toBeNull();
  });
});

describe('forEachSseEvent', () => {
  it('delivers only well-formed events, in stream order', () => {
    const body =
      'event: message\n' +
      'data: {"type":"a"}\n' +
      '\n' +
      'data: not json\n' +
      'data: {"type":"b"}\r\n' +
      'data: [DONE]\n';
    const types: string[] = [];
    forEachSseEvent(body, (evt) => types.push(String(evt['type'])));
    expect(types).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// readSseLines
// ---------------------------------------------------------------------------

/** A Response-like object whose body streams the given chunks. */
function streamResponse(chunks: Uint8Array[], text = ''): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return { body: stream, text: async () => text } as unknown as Response;
}

function chunksOf(body: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(body);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

describe('readSseLines', () => {
  it('reassembles lines split across chunks and flushes a trailing partial line', async () => {
    const body = 'data: {"type":"a"}\ndata: {"type":"b"}\ndata: {"type":"tail"}';
    const lines: string[] = [];
    await readSseLines(streamResponse(chunksOf(body, 7)), (line) => lines.push(line));
    expect(lines).toEqual(['data: {"type":"a"}', 'data: {"type":"b"}', 'data: {"type":"tail"}']);
  });

  it('survives a multi-byte character split across chunk boundaries', async () => {
    const body = 'data: {"type":"héllo — ünïcode"}\n';
    const bytes = new TextEncoder().encode(body);
    // Split inside the multi-byte em dash to force the decoder to buffer.
    const cut = body.indexOf('—') + 1;
    const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
    const lines: string[] = [];
    await readSseLines(streamResponse(chunks), (line) => lines.push(line));
    expect(lines).toEqual(['data: {"type":"héllo — ünïcode"}']);
  });

  it('falls back to a whole-body read when the response has no streamable body', async () => {
    const res = {
      body: null,
      text: async () => 'data: {"type":"a"}\r\ndata: {"type":"b"}',
    } as unknown as Response;
    const lines: string[] = [];
    await readSseLines(res, (line) => lines.push(line));
    expect(lines).toEqual(['data: {"type":"a"}', 'data: {"type":"b"}']);
  });

  it('stops reading (and cancels the reader) once shouldStop returns true', async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(`data: {"n":${pulls}}\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = { body: stream, text: async () => '' } as unknown as Response;
    const lines: string[] = [];
    await readSseLines(
      res,
      (line) => lines.push(line),
      () => lines.length >= 2,
    );
    expect(lines.length).toBe(2);
    expect(cancelled).toBe(true);
  });
});
