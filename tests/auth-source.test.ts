/**
 * auth-source (M13-core) resolver precedence — pure, no Electron/network.
 *
 * Precedence: Codex-sub (signed in + valid) > API key (present) > null.
 * `preferApiKey` (CLICKY_NO_CODEX_SUB) demotes Codex-sub below the key.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveGroundingAuth } from '../src/main/auth/auth-source';
import type { CodexProvider } from '../src/main/auth/auth-source';

function codexProvider(
  info: { accessToken: string; accountId: string; planType: string; expiresAt: number } | null,
): CodexProvider {
  return {
    getCodexAuth: () => info,
    getBearer: async () => info?.accessToken ?? '',
  };
}

const VALID_INFO = {
  accessToken: 'bearer-x',
  accountId: 'acct-1',
  planType: 'pro',
  expiresAt: Date.now() + 3_600_000,
};

describe('resolveGroundingAuth', () => {
  it('prefers the Codex sub when signed in + valid', async () => {
    const auth = resolveGroundingAuth({
      getApiKey: () => 'sk-key',
      codex: codexProvider(VALID_INFO),
    });
    expect(auth?.kind).toBe('chatgptCodex');
    if (auth?.kind === 'chatgptCodex') {
      expect(auth.accountId).toBe('acct-1');
      expect(auth.planType).toBe('pro');
      await expect(auth.getBearer()).resolves.toBe('bearer-x');
    }
  });

  it('falls back to the API key when the sub is not usable', () => {
    const auth = resolveGroundingAuth({
      getApiKey: () => 'sk-key',
      codex: codexProvider(null), // getCodexAuth() already returns null when invalid
    });
    expect(auth?.kind).toBe('apiKey');
    if (auth?.kind === 'apiKey') expect(auth.getApiKey()).toBe('sk-key');
  });

  it('returns null when neither the sub nor a key is available', () => {
    expect(resolveGroundingAuth({ getApiKey: () => null, codex: codexProvider(null) })).toBeNull();
    expect(resolveGroundingAuth({ getApiKey: () => '', codex: codexProvider(null) })).toBeNull();
  });

  it('preferApiKey demotes the sub below the key (eval A/B)', () => {
    const getCodexAuth = vi.fn(() => VALID_INFO);
    const auth = resolveGroundingAuth({
      getApiKey: () => 'sk-key',
      codex: { getCodexAuth, getBearer: async () => 'bearer-x' },
      preferApiKey: true,
    });
    expect(auth?.kind).toBe('apiKey');
    // The sub is never even consulted when forced to the key.
    expect(getCodexAuth).not.toHaveBeenCalled();
  });

  it('preferApiKey with the sub but NO key still yields null', () => {
    const auth = resolveGroundingAuth({
      getApiKey: () => null,
      codex: codexProvider(VALID_INFO),
      preferApiKey: true,
    });
    expect(auth).toBeNull();
  });
});
