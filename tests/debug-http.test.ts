/**
 * Tests for the debug server's HTTP plumbing (src/main/debug/debug-http.ts):
 * the size-capped JSON body reader, the JSON responder, and the composable
 * field validators route families share.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DEBUG_BODY_BYTES,
  asRecord,
  isFiniteNumber,
  isNonBlankString,
  readJsonBody,
  sendJson,
} from '../src/main/debug/debug-http';

/** A request body stream that quacks enough like an IncomingMessage. */
function fakeReq(): PassThrough & IncomingMessage {
  return new PassThrough() as PassThrough & IncomingMessage;
}

describe('readJsonBody', () => {
  it('parses a JSON object body', async () => {
    const req = fakeReq();
    const parsed = readJsonBody(req);
    req.end('{"text":"hello","n":2}');
    await expect(parsed).resolves.toEqual({ text: 'hello', n: 2 });
  });

  it('treats an empty body as {}', async () => {
    const req = fakeReq();
    const parsed = readJsonBody(req);
    req.end();
    await expect(parsed).resolves.toEqual({});
  });

  it('rejects malformed JSON', async () => {
    const req = fakeReq();
    const parsed = readJsonBody(req);
    req.end('{"broken":');
    await expect(parsed).rejects.toThrow('invalid JSON body');
  });

  it('rejects and destroys a body over the cap', async () => {
    const req = fakeReq();
    const destroy = vi.spyOn(req, 'destroy');
    const parsed = readJsonBody(req);
    req.write(Buffer.alloc(MAX_DEBUG_BODY_BYTES + 1, 0x61));
    await expect(parsed).rejects.toThrow('body too large');
    expect(destroy).toHaveBeenCalled();
  });
});

describe('sendJson', () => {
  it('writes status, JSON headers, and a pretty-printed body', () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const res = { writeHead, end } as unknown as ServerResponse;

    sendJson(res, 400, { error: 'expected {text: string}' });

    const body = JSON.stringify({ error: 'expected {text: string}' }, null, 2);
    expect(writeHead).toHaveBeenCalledWith(400, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    expect(end).toHaveBeenCalledWith(body);
  });
});

describe('field validators', () => {
  it('asRecord narrows plain objects only (arrays and null rejected)', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('x')).toBeNull();
  });

  it('isFiniteNumber rejects NaN, infinities, and non-numbers', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-12.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('3')).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });

  it('isNonBlankString requires visible characters', () => {
    expect(isNonBlankString('hey')).toBe(true);
    expect(isNonBlankString('  padded  ')).toBe(true);
    expect(isNonBlankString('')).toBe(false);
    expect(isNonBlankString('   ')).toBe(false);
    expect(isNonBlankString(42)).toBe(false);
  });
});
