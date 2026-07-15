/**
 * CodexTokenStore unit tests — driven entirely through the SafeStorageLike
 * seam (Electron safeStorage only exists in a running main process). Covers
 * the encrypt/decrypt round-trip, malformed/undecryptable files, the
 * refuse-to-persist-plaintext posture, and clear().
 */

import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexTokenStore } from '../src/main/auth/token-store';
import type { SafeStorageLike, StoredCodexTokens } from '../src/main/auth/token-store';

const TOKENS: StoredCodexTokens = {
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  accountId: 'acct-1',
  planType: 'pro',
  expiresAt: 1_800_000_000_000,
};

/** Reversible fake crypto: `enc:<plain>` in a Buffer. */
function fakeCrypto(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (blob) => {
      const text = blob.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('bad blob');
      return text.slice(4);
    },
    ...overrides,
  };
}

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'token-store-'));
  path = join(dir, 'codex-tokens.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(crypto: SafeStorageLike = fakeCrypto()): CodexTokenStore {
  return new CodexTokenStore({ filePath: path, safeStorageImpl: crypto });
}

describe('CodexTokenStore', () => {
  it('round-trips tokens through save/load without plaintext on disk', () => {
    const s = store();
    s.save(TOKENS);
    expect(s.load()).toEqual(TOKENS);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('access-secret');
    expect(raw).not.toContain('refresh-secret');
    // Non-secret metadata stays readable.
    expect(raw).toContain('"accountId": "acct-1"');
  });

  it('returns null when nothing is stored', () => {
    expect(store().load()).toBeNull();
  });

  it('returns null on a malformed file (bad JSON or missing fields)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(path, '{ not json', 'utf8');
    expect(store().load()).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, accountId: 'a' }), 'utf8');
    expect(store().load()).toBeNull();
    errorSpy.mockRestore();
  });

  it('returns null when the blob cannot be decrypted (DPAPI changed)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    store().save(TOKENS);
    const broken = store(
      fakeCrypto({
        decryptString: () => {
          throw new Error('decryption failed');
        },
      }),
    );
    expect(broken.load()).toBeNull();
    errorSpy.mockRestore();
  });

  it('refuses to persist plaintext when encryption is unavailable', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = store(fakeCrypto({ isEncryptionAvailable: () => false }));
    s.save(TOKENS);
    expect(existsSync(path)).toBe(false);
    expect(s.load()).toBeNull();
    warnSpy.mockRestore();
  });

  it('clear() removes the cache and is a no-op when nothing is stored', () => {
    const s = store();
    s.save(TOKENS);
    s.clear();
    expect(existsSync(path)).toBe(false);
    expect(s.load()).toBeNull();
    expect(() => s.clear()).not.toThrow();
  });
});
