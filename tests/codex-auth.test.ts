/**
 * codex-auth (M13-core) unit tests — fully offline (no real ~/.codex/auth.json,
 * no real network). Covers:
 * - auth.json parse: valid / missing file / malformed / missing fields,
 * - JWT claim decode (exp -> ms, account id + plan from the auth claim),
 * - account_id precedence (tokens.account_id over the JWT claim),
 * - isValid() 60s skew,
 * - refresh() trigger logic (near-expiry) with a MOCKED fetch — never a real
 *   refresh; rotated tokens cached in-memory + the token store; the CLI file is
 *   never written.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAuth, decodeAccessToken } from '../src/main/auth/codex-auth';
import type { StoredCodexTokens } from '../src/main/auth/token-store';

// ---------------------------------------------------------------------------
// JWT helpers (unsigned; we only read claims)
// ---------------------------------------------------------------------------

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A fake access-token JWT with the given exp (unix seconds) + auth claim. */
function jwt(opts: {
  expSec: number;
  accountId?: string;
  planType?: string;
}): string {
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    exp: opts.expSec,
    'https://api.openai.com/auth': {
      chatgpt_account_id: opts.accountId ?? 'claim-acct',
      chatgpt_plan_type: opts.planType ?? 'pro',
    },
  });
  return `${header}.${payload}.sig`;
}

/** In-memory token store fake. */
function fakeStore(initial: StoredCodexTokens | null = null) {
  let held = initial;
  return {
    load: () => held,
    save: vi.fn((t: StoredCodexTokens) => {
      held = t;
    }),
    clear: () => {
      held = null;
    },
    get current() {
      return held;
    },
  };
}

// ---------------------------------------------------------------------------

describe('decodeAccessToken', () => {
  it('decodes exp (-> ms) and the auth-claim account id + plan', () => {
    const decoded = decodeAccessToken(
      jwt({ expSec: 1_800_000_000, accountId: 'acct-x', planType: 'plus' }),
    );
    expect(decoded).toEqual({
      expiresAt: 1_800_000_000_000,
      accountId: 'acct-x',
      planType: 'plus',
    });
  });

  it('returns null for a non-3-part token, bad payload, or missing exp', () => {
    expect(decodeAccessToken('not-a-jwt')).toBeNull();
    expect(decodeAccessToken('a.b')).toBeNull();
    expect(decodeAccessToken(`${b64url({})}.%%%.sig`)).toBeNull();
    expect(decodeAccessToken(`${b64url({})}.${b64url({ no: 'exp' })}.sig`)).toBeNull();
  });
});

describe('CodexAuth: auth.json parsing', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-auth-'));
    path = join(dir, 'auth.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(content: unknown): void {
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }

  it('returns null when the file is missing', () => {
    const auth = new CodexAuth({ authFilePath: join(dir, 'nope.json'), tokenStore: fakeStore() });
    expect(auth.getCodexAuth()).toBeNull();
    expect(auth.codexSignInState()).toEqual({
      signedIn: false,
      valid: false,
      planType: '',
      expiresAt: null,
    });
  });

  it('returns null on malformed JSON', () => {
    write('{ not json');
    const auth = new CodexAuth({ authFilePath: path, tokenStore: fakeStore() });
    expect(auth.getCodexAuth()).toBeNull();
  });

  it('returns null when tokens / access_token are missing', () => {
    write({ tokens: {} });
    const a1 = new CodexAuth({ authFilePath: path, tokenStore: fakeStore() });
    expect(a1.getCodexAuth()).toBeNull();
    write({ last_refresh: 'x' });
    const a2 = new CodexAuth({ authFilePath: path, tokenStore: fakeStore() });
    expect(a2.getCodexAuth()).toBeNull();
  });

  it('parses a valid file: token, account id (tokens field), plan, expiry', () => {
    const expSec = Math.floor(Date.now() / 1000) + 100 * 3600;
    write({
      tokens: {
        access_token: jwt({ expSec, accountId: 'claim-acct', planType: 'pro' }),
        refresh_token: 'refresh-1',
        account_id: 'tokens-acct',
      },
    });
    const auth = new CodexAuth({ authFilePath: path, tokenStore: fakeStore() });
    const info = auth.getCodexAuth();
    expect(info).not.toBeNull();
    // account_id PREFERS the tokens field over the JWT claim.
    expect(info!.accountId).toBe('tokens-acct');
    expect(info!.planType).toBe('pro');
    expect(info!.expiresAt).toBe(expSec * 1000);
    expect(auth.codexSignInState()).toMatchObject({ signedIn: true, valid: true, planType: 'pro' });
  });

  it('falls back to the JWT claim account id when tokens.account_id is absent', () => {
    const expSec = Math.floor(Date.now() / 1000) + 100 * 3600;
    write({
      tokens: { access_token: jwt({ expSec, accountId: 'claim-acct' }), refresh_token: 'r' },
    });
    const auth = new CodexAuth({ authFilePath: path, tokenStore: fakeStore() });
    expect(auth.getCodexAuth()!.accountId).toBe('claim-acct');
  });

  it('treats an expired token as not usable (isValid false) but still signed in', () => {
    const expSec = Math.floor(Date.now() / 1000) - 10; // already expired
    write({
      tokens: { access_token: jwt({ expSec }), refresh_token: 'r', account_id: 'a' },
    });
    // No fetch -> refresh cannot succeed; getCodexAuth returns null (unusable).
    const auth = new CodexAuth({
      authFilePath: path,
      tokenStore: fakeStore(),
      fetchImpl: (async () => ({ ok: false, status: 400 })) as unknown as typeof fetch,
    });
    expect(auth.getCodexAuth()).toBeNull();
    expect(auth.codexSignInState()).toMatchObject({ signedIn: true, valid: false });
  });
});

describe('CodexAuth: isValid', () => {
  it('requires exp > now + 60s', () => {
    const auth = new CodexAuth({ tokenStore: fakeStore(), now: () => 1_000_000 });
    expect(auth.isValid({ accessToken: 't', accountId: 'a', planType: 'p', expiresAt: 1_000_000 + 61_000 })).toBe(true);
    expect(auth.isValid({ accessToken: 't', accountId: 'a', planType: 'p', expiresAt: 1_000_000 + 59_000 })).toBe(false);
  });
});

describe('CodexAuth: refresh', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-auth-'));
    path = join(dir, 'auth.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeFile(expSec: number, refresh = 'refresh-old'): void {
    writeFileSync(
      path,
      JSON.stringify({
        tokens: { access_token: jwt({ expSec }), refresh_token: refresh, account_id: 'acct' },
      }),
      'utf8',
    );
  }

  it('does NOT refresh when the token is comfortably valid (> 5 min out)', async () => {
    writeFile(Math.floor(Date.now() / 1000) + 100 * 3600);
    const fetchImpl = vi.fn();
    const auth = new CodexAuth({
      authFilePath: path,
      tokenStore: fakeStore(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const bearer = await auth.getBearer();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(bearer).toBeTypeOf('string');
  });

  it('refreshes via the OAuth grant when within 5 min of expiry; caches, no file write', async () => {
    const soonSec = Math.floor(Date.now() / 1000) + 120; // 2 min -> needs refresh
    writeFile(soonSec, 'refresh-old');
    const before = readRaw(path);

    const newExpSec = Math.floor(Date.now() / 1000) + 100 * 3600;
    const captured: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({
        url,
        body: String(init.body),
        headers: init.headers as Record<string, string>,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: jwt({ expSec: newExpSec, accountId: 'acct', planType: 'pro' }),
          refresh_token: 'refresh-rotated',
        }),
      } as unknown as Response;
    });
    const store = fakeStore();
    const auth = new CodexAuth({
      authFilePath: path,
      tokenStore: store,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const bearer = await auth.getBearer();

    // Hit the OAuth token endpoint with the refresh grant + Codex client id.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://auth.openai.com/oauth/token');
    expect(captured[0]!.body).toContain('grant_type=refresh_token');
    expect(captured[0]!.body).toContain('refresh_token=refresh-old');
    expect(captured[0]!.body).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(captured[0]!.body).toContain('scope=openid');
    // The rotated token is returned + cached; the CLI file is untouched.
    expect(bearer).toBe(
      jwt({ expSec: newExpSec, accountId: 'acct', planType: 'pro' }),
    );
    expect(store.save).toHaveBeenCalledOnce();
    expect(store.current?.refreshToken).toBe('refresh-rotated');
    expect(store.current?.expiresAt).toBe(newExpSec * 1000);
    expect(readRaw(path)).toBe(before); // ~/.codex/auth.json NOT mutated
  });

  it('getBearer falls back to the still-valid file token when refresh fails', async () => {
    // 4 min out -> within skew (triggers refresh) but still > 60s valid.
    writeFile(Math.floor(Date.now() / 1000) + 240);
    const auth = new CodexAuth({
      authFilePath: path,
      tokenStore: fakeStore(),
      fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch,
    });
    // Refresh fails (500) but the file token is valid for ~4 min -> usable.
    await expect(auth.getBearer()).resolves.toBeTypeOf('string');
  });

  it('getBearer throws when not signed in', async () => {
    const auth = new CodexAuth({ authFilePath: join(dir, 'nope.json'), tokenStore: fakeStore() });
    await expect(auth.getBearer()).rejects.toThrow(/not signed in/);
  });
});

import { readFileSync } from 'node:fs';
function readRaw(p: string): string {
  return readFileSync(p, 'utf8');
}
