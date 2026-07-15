/**
 * Security tests for the debug server's auth pieces (src/main/debug/debug-auth.ts):
 * token comparison, mandatory token checks (header + query), CSRF Origin
 * rejection, DNS-rebinding Host allowlist, packaged-build refusal, and
 * per-launch token resolution. Everything is pure node — no Electron.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkDebugToken,
  checkHost,
  checkOrigin,
  refusesPackagedStart,
  resolveToken,
  tokenEquals,
} from '../src/main/debug/debug-auth';

/** Just enough of an IncomingMessage for the auth checks. */
function fakeReq(headers: Record<string, string>, url = '/state'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

describe('tokenEquals', () => {
  it('accepts an exact match', () => {
    expect(tokenEquals('secret-token', 'secret-token')).toBe(true);
  });

  it('rejects a same-length mismatch', () => {
    expect(tokenEquals('secret-token', 'secret-tokeN')).toBe(false);
  });

  it('rejects a different-length candidate (no timingSafeEqual throw)', () => {
    expect(tokenEquals('short', 'a-much-longer-expected-token')).toBe(false);
    expect(tokenEquals('', 'expected')).toBe(false);
  });
});

describe('checkDebugToken', () => {
  const TOKEN = 'launch-token-1234';

  it('accepts the token in the X-Debug-Token header', () => {
    expect(checkDebugToken(fakeReq({ 'x-debug-token': TOKEN }), TOKEN)).toBe(true);
  });

  it('rejects a wrong header token', () => {
    expect(checkDebugToken(fakeReq({ 'x-debug-token': 'wrong' }), TOKEN)).toBe(false);
  });

  it('rejects when no token is supplied at all', () => {
    expect(checkDebugToken(fakeReq({}), TOKEN)).toBe(false);
  });

  it('accepts a ?token= query param (file:// eval scene pages)', () => {
    expect(checkDebugToken(fakeReq({}, `/eval/ground-truth?token=${TOKEN}`), TOKEN)).toBe(true);
  });

  it('rejects a wrong query token', () => {
    expect(checkDebugToken(fakeReq({}, '/state?token=wrong'), TOKEN)).toBe(false);
  });

  it('falls through a bad header token to a good query token', () => {
    expect(checkDebugToken(fakeReq({ 'x-debug-token': 'nope' }, `/x?token=${TOKEN}`), TOKEN)).toBe(
      true,
    );
  });

  it('NEVER authorizes against an empty expected token', () => {
    expect(checkDebugToken(fakeReq({ 'x-debug-token': '' }), '')).toBe(false);
    expect(checkDebugToken(fakeReq({}, '/state?token='), '')).toBe(false);
  });
});

describe('checkOrigin (CSRF defense)', () => {
  it('accepts a request without an Origin header (curl / node fetch)', () => {
    expect(checkOrigin(fakeReq({}))).toBe(true);
  });

  it('accepts the literal "null" Origin a file:// page sends', () => {
    expect(checkOrigin(fakeReq({ origin: 'null' }))).toBe(true);
  });

  it('rejects any cross-site web Origin', () => {
    expect(checkOrigin(fakeReq({ origin: 'https://evil.example' }))).toBe(false);
    expect(checkOrigin(fakeReq({ origin: 'http://127.0.0.1:8199' }))).toBe(false);
  });
});

describe('checkHost (DNS-rebinding defense)', () => {
  const PORT = 8199;

  it('accepts loopback hosts with the served port', () => {
    expect(checkHost(fakeReq({ host: '127.0.0.1:8199' }), PORT)).toBe(true);
    expect(checkHost(fakeReq({ host: 'localhost:8199' }), PORT)).toBe(true);
  });

  it('accepts bare loopback hosts (no port)', () => {
    expect(checkHost(fakeReq({ host: '127.0.0.1' }), PORT)).toBe(true);
    expect(checkHost(fakeReq({ host: 'localhost' }), PORT)).toBe(true);
  });

  it('rejects a rebound hostname pointing at 127.0.0.1', () => {
    expect(checkHost(fakeReq({ host: 'attacker.example:8199' }), PORT)).toBe(false);
    expect(checkHost(fakeReq({ host: 'attacker.example' }), PORT)).toBe(false);
  });

  it('rejects the wrong port and a missing Host header', () => {
    expect(checkHost(fakeReq({ host: '127.0.0.1:9999' }), PORT)).toBe(false);
    expect(checkHost(fakeReq({}), PORT)).toBe(false);
  });
});

describe('refusesPackagedStart', () => {
  it('refuses a packaged build without an explicit token', () => {
    expect(refusesPackagedStart(true, {})).toBe(true);
    expect(refusesPackagedStart(true, { CLICKY_DEBUG_TOKEN: '' })).toBe(true);
  });

  it('allows a packaged build with an explicit token', () => {
    expect(refusesPackagedStart(true, { CLICKY_DEBUG_TOKEN: 'explicit' })).toBe(false);
  });

  it('never refuses an unpackaged (dev) build', () => {
    expect(refusesPackagedStart(false, {})).toBe(false);
  });
});

describe('resolveToken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clicky-debug-auth-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the explicit CLICKY_DEBUG_TOKEN without touching disk', () => {
    const scratch = join(dir, 'explicit');
    expect(resolveToken(scratch, { CLICKY_DEBUG_TOKEN: 'explicit-token' })).toBe('explicit-token');
    expect(existsSync(join(scratch, 'debug-token.txt'))).toBe(false);
  });

  it('generates a random per-launch token and persists it for local tooling', () => {
    const token = resolveToken(dir, {});
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(readFileSync(join(dir, 'debug-token.txt'), 'utf8')).toBe(token);
    // A fresh launch gets a fresh token.
    expect(resolveToken(dir, {})).not.toBe(token);
  });

  it('still returns a usable token when the file cannot be written', () => {
    const token = resolveToken(join(dir, 'missing-parent', 'nested'), {});
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });
});
