/**
 * codex-auth (M13-core): read the ChatGPT-subscription credentials the Codex
 * CLI already stores, so Clicky can ground `point_at` through the user's
 * ChatGPT plan (gpt-5.6-sol over chatgpt.com/backend-api/codex/responses)
 * instead of a metered API key.
 *
 * Source of truth: `%USERPROFILE%/.codex/auth.json`, written by `codex login`.
 * Shape (verified live):
 *   { tokens: { id_token, access_token, refresh_token, account_id },
 *     last_refresh, OPENAI_API_KEY?, auth_mode }
 * The access_token is a JWT; its payload carries `exp` and, under the claim
 * `https://api.openai.com/auth`, `chatgpt_account_id` + `chatgpt_plan_type`.
 *
 * Contract:
 * - We read the file FRESH on every call (the Codex CLI may rotate it out from
 *   under us). Missing file / malformed JSON / missing fields => null ("not
 *   signed in"); callers fall back to the API-key path.
 * - We NEVER write back to `~/.codex/auth.json` — mutating the CLI's own file
 *   is not ours to do. A `refresh()` we perform is cached IN-MEMORY and in our
 *   own safeStorage-backed CodexTokenStore, and preferred over the file only
 *   while it is fresher.
 * - Tokens are used only as bearer credentials; they are never logged.
 *
 * INTEGRATION SEAM: this module exposes a renderer-safe *view* of sign-in
 * state via `codexSignInState()` (booleans + plan + expiry — never a token).
 * The integrator wires that into Settings/IPC (see the return notes / the
 * doc block on `CodexSignInState`).
 */

import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexTokenStore } from './token-store';
import type { StoredCodexTokens } from './token-store';

/** OAuth client id the Codex CLI registers as (public; not a secret). */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_SCOPE = 'openid profile email offline_access';
/** The auth-claim namespace inside the access-token JWT. */
const AUTH_CLAIM = 'https://api.openai.com/auth';

/** Refresh proactively once the token is within this window of expiry. */
const REFRESH_SKEW_MS = 5 * 60_000;
/** `isValid()` clock skew: a token must outlive now by at least this. */
const VALID_SKEW_MS = 60_000;
/** OAuth refresh network budget. */
const REFRESH_TIMEOUT_MS = 10_000;

/** Usable Codex-sub credentials for one grounding call. */
export interface CodexAuthInfo {
  accessToken: string;
  accountId: string;
  planType: string;
  /** Unix milliseconds — access-token expiry. */
  expiresAt: number;
}

/**
 * Renderer-safe sign-in snapshot (NEVER carries a token). This is the exact
 * shape the integrator should surface to the panel (see return notes).
 */
export interface CodexSignInState {
  /** A `~/.codex/auth.json` (or cached refresh) yielded a decodable token. */
  signedIn: boolean;
  /** The best-available token is still valid (exp > now + 60s). */
  valid: boolean;
  /** e.g. 'pro' | 'plus' | 'free' — '' when unknown. */
  planType: string;
  /** Unix ms expiry of the best-available token, or null when not signed in. */
  expiresAt: number | null;
}

/** Injectable dependencies (unit tests never touch the real filesystem/net). */
export interface CodexAuthOptions {
  /** Path to auth.json. Default: `<homedir>/.codex/auth.json`. */
  authFilePath?: string;
  /** Cache for refreshed tokens. Default: a real CodexTokenStore. */
  tokenStore?: Pick<CodexTokenStore, 'load' | 'save' | 'clear'>;
  /** fetch injection (refresh). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Clock injection (tests). Default: Date.now. */
  now?: () => number;
  /** Refresh network budget, ms. Default 10s. */
  refreshTimeoutMs?: number;
}

/** Raw `~/.codex/auth.json` shape (only the fields we consume). */
interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
}

/** Decoded pieces of an access-token JWT. */
interface DecodedToken {
  /** Unix ms. */
  expiresAt: number;
  /** From the auth claim; may be empty. */
  accountId: string;
  planType: string;
}

export class CodexAuth {
  private readonly authFilePath: string;
  private readonly tokenStore: Pick<CodexTokenStore, 'load' | 'save' | 'clear'>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly refreshTimeoutMs: number;

  /** In-memory copy of the most recent tokens WE obtained via refresh(). */
  private refreshed: StoredCodexTokens | null = null;
  /** De-dupes concurrent/background refreshes onto one network call. */
  private refreshInFlight: Promise<CodexAuthInfo | null> | null = null;

  constructor(options: CodexAuthOptions = {}) {
    this.authFilePath =
      options.authFilePath ?? join(homedir(), '.codex', 'auth.json');
    this.tokenStore = options.tokenStore ?? new CodexTokenStore();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    // Seed the in-memory cache from any persisted refresh (survives restart —
    // the CLI file may still hold a now-stale token we already rotated past).
    this.refreshed = this.tokenStore.load();
  }

  /**
   * Best current Codex-sub credentials, or null when not signed in / expired.
   * SYNCHRONOUS — returns whatever token is currently valid; when that token
   * is within 5 min of expiry it kicks a BACKGROUND refresh (fire-and-forget)
   * so the *next* call has a fresh token, but never blocks. Use `getBearer()`
   * when you need a guaranteed-usable token (it awaits the refresh).
   */
  getCodexAuth(): CodexAuthInfo | null {
    const best = this.bestInfo();
    if (best === null) return null;
    if (this.needsRefresh(best)) void this.refresh().catch(() => undefined);
    return this.isValid(best) ? best : null;
  }

  /** Renderer-safe sign-in snapshot (never a token). */
  codexSignInState(): CodexSignInState {
    const best = this.bestInfo();
    if (best === null) {
      return { signedIn: false, valid: false, planType: '', expiresAt: null };
    }
    return {
      signedIn: true,
      valid: this.isValid(best),
      planType: best.planType,
      expiresAt: best.expiresAt,
    };
  }

  /**
   * Guaranteed-usable bearer token for a grounding call. Awaits a refresh when
   * the current token is expired or within the 5-min skew. Throws when the
   * user is not signed in or a needed refresh failed — callers treat that as
   * "Codex path unavailable" and fall back.
   */
  async getBearer(): Promise<string> {
    const best = this.bestInfo();
    if (best !== null && !this.needsRefresh(best)) return best.accessToken;
    const refreshed = await this.refresh();
    if (refreshed !== null) return refreshed.accessToken;
    // Refresh failed but the file token may still be within its 60s validity —
    // use it rather than failing the call outright.
    if (best !== null && this.isValid(best)) return best.accessToken;
    throw new Error('codex sub not signed in');
  }

  /** exp > now + 60s. */
  isValid(info: CodexAuthInfo): boolean {
    return info.expiresAt > this.now() + VALID_SKEW_MS;
  }

  /**
   * Rotate the access token via the OAuth refresh grant. Does NOT touch
   * `~/.codex/auth.json`; caches the result in memory + the token store.
   * Returns null on any failure (never throws). Concurrent callers share one
   * in-flight request.
   */
  refresh(): Promise<CodexAuthInfo | null> {
    if (this.refreshInFlight !== null) return this.refreshInFlight;
    const attempt = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = attempt;
    return attempt;
  }

  // -------------------------------------------------------------------------

  private async doRefresh(): Promise<CodexAuthInfo | null> {
    // Prefer the freshest refresh_token we hold: our own rotated one, else the
    // CLI file's current one.
    const fileRefresh = this.readFile()?.refresh_token;
    const refreshToken =
      this.refreshed?.refreshToken ??
      (typeof fileRefresh === 'string' ? fileRefresh : null);
    if (refreshToken === null || refreshToken.length === 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.refreshTimeoutMs);
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
        scope: OAUTH_SCOPE,
      });
      const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[codex-auth] refresh failed: http ${res.status}`);
        return null;
      }
      const payload = (await res.json()) as {
        access_token?: unknown;
        refresh_token?: unknown;
      };
      const accessToken =
        typeof payload.access_token === 'string' ? payload.access_token : '';
      if (accessToken.length === 0) return null;
      const decoded = decodeAccessToken(accessToken);
      if (decoded === null) return null;
      // Rotated refresh token when the server sends one; else keep the current.
      const nextRefresh =
        typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
          ? payload.refresh_token
          : refreshToken;
      const accountId = decoded.accountId.length > 0
        ? decoded.accountId
        : (this.refreshed?.accountId ?? this.fileAccountId() ?? '');
      const stored: StoredCodexTokens = {
        accessToken,
        refreshToken: nextRefresh,
        accountId,
        planType: decoded.planType,
        expiresAt: decoded.expiresAt,
      };
      this.refreshed = stored;
      this.tokenStore.save(stored);
      return toInfo(stored);
    } catch (err) {
      // AbortError (timeout) + network failures land here.
      console.warn(`[codex-auth] refresh error: ${err instanceof Error ? err.name : 'unknown'}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The best credentials we can offer right now: the fresher of our in-memory
   * refreshed tokens and the on-disk CLI file. account_id prefers the tokens
   * field, falling back to the JWT claim.
   */
  private bestInfo(): CodexAuthInfo | null {
    const fromFile = this.fileInfo();
    const fromCache = this.refreshed !== null ? toInfo(this.refreshed) : null;
    if (fromFile === null) return fromCache;
    if (fromCache === null) return fromFile;
    // Whichever expires later is the newer token.
    return fromCache.expiresAt >= fromFile.expiresAt ? fromCache : fromFile;
  }

  private needsRefresh(info: CodexAuthInfo): boolean {
    return info.expiresAt <= this.now() + REFRESH_SKEW_MS;
  }

  /** Decode the CLI file's access token into usable info, or null. */
  private fileInfo(): CodexAuthInfo | null {
    const tokens = this.readFile();
    const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
    if (accessToken.length === 0) return null;
    const decoded = decodeAccessToken(accessToken);
    if (decoded === null) return null;
    const accountIdFromField =
      typeof tokens?.account_id === 'string' && tokens.account_id.length > 0
        ? tokens.account_id
        : '';
    return {
      accessToken,
      // Prefer the tokens.account_id field; fall back to the JWT claim.
      accountId: accountIdFromField.length > 0 ? accountIdFromField : decoded.accountId,
      planType: decoded.planType,
      expiresAt: decoded.expiresAt,
    };
  }

  private fileAccountId(): string | null {
    const tokens = this.readFile();
    return typeof tokens?.account_id === 'string' && tokens.account_id.length > 0
      ? tokens.account_id
      : null;
  }

  /** Fresh read + parse of the CLI auth.json `tokens` object, or null. */
  private readFile(): CodexAuthFile['tokens'] | null {
    try {
      if (!existsSync(this.authFilePath)) return null;
      const parsed = JSON.parse(readFileSync(this.authFilePath, 'utf8')) as CodexAuthFile;
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.tokens !== 'object') {
        return null;
      }
      return parsed.tokens ?? null;
    } catch {
      // Missing / malformed / mid-write: treat as not signed in.
      return null;
    }
  }
}

function toInfo(t: StoredCodexTokens): CodexAuthInfo {
  return {
    accessToken: t.accessToken,
    accountId: t.accountId,
    planType: t.planType,
    expiresAt: t.expiresAt,
  };
}

/**
 * Decode a JWT access token's payload for `exp` (-> ms) and the
 * ChatGPT auth-claim account id + plan type. Exported for tests. Returns null
 * on any structural surprise (not a 3-part JWT, unparsable payload, no `exp`).
 * Signature is NOT verified — we only read claims we already trust the CLI to
 * have obtained; the token is validated server-side on every request.
 */
export function decodeAccessToken(token: string): DecodedToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    const json = Buffer.from(base64UrlToBase64(parts[1] ?? ''), 'base64').toString('utf8');
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const rec = payload as Record<string, unknown>;
  const exp = rec['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  let accountId = '';
  let planType = '';
  const claim = rec[AUTH_CLAIM];
  if (claim !== null && typeof claim === 'object') {
    const c = claim as Record<string, unknown>;
    if (typeof c['chatgpt_account_id'] === 'string') accountId = c['chatgpt_account_id'];
    if (typeof c['chatgpt_plan_type'] === 'string') planType = c['chatgpt_plan_type'];
  }
  return { expiresAt: exp * 1000, accountId, planType };
}

/** base64url -> base64 (padding restored) for Buffer decoding. */
function base64UrlToBase64(input: string): string {
  const replaced = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = replaced.length % 4;
  return pad === 0 ? replaced : replaced + '='.repeat(4 - pad);
}

// ---------------------------------------------------------------------------
// Process-wide singleton (the app wires ONE instance; tests construct their own)
// ---------------------------------------------------------------------------

let singleton: CodexAuth | null = null;

/** Lazily-constructed shared instance for app wiring. */
export function getCodexAuthProvider(): CodexAuth {
  if (singleton === null) singleton = new CodexAuth();
  return singleton;
}
