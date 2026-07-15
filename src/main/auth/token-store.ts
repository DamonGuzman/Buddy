/**
 * CodexTokenStore (M13-core): safeStorage-encrypted persistence for OAuth
 * tokens the app itself obtained — the refreshed Codex-subscription tokens
 * cached after a `refresh()` (we deliberately do NOT write back to the user's
 * `~/.codex/auth.json`, so the rotated refresh_token would otherwise be lost
 * on quit), and, later, tokens from an in-app OAuth sign-in flow.
 *
 * OWNERSHIP NOTE (M13-core / M16 concurrency): this is a NEW, self-contained
 * store on its own file (`codex-tokens.json` in userData). It does NOT route
 * through `src/main/settings.ts` (frozen by the M16 integration) — it talks to
 * Electron `safeStorage` directly, exactly as settings.ts does for the API
 * key. The integrator does not need to touch settings for this to work.
 *
 * The plaintext tokens never leave this module except through `load()`
 * (main-process callers only). Nothing here is logged.
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Decrypted token set, as held in memory / returned to callers. */
export interface StoredCodexTokens {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  planType: string;
  /** Unix milliseconds — access-token expiry (decoded from the JWT at save time). */
  expiresAt: number;
}

/** On-disk shape: token strings are individually safeStorage base64 blobs. */
interface TokenFile {
  version: 1;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accountId: string;
  planType: string;
  expiresAt: number;
}

/**
 * The subset of Electron `safeStorage` this store needs. Broken out so unit
 * tests can inject a trivial (or absent) implementation — safeStorage is
 * unavailable outside a running Electron main process.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

export interface CodexTokenStoreOptions {
  /** Override the file path (tests). Default: `<userData>/codex-tokens.json`. */
  filePath?: string;
  /** Override the crypto backend (tests). Default: Electron safeStorage. */
  safeStorageImpl?: SafeStorageLike;
}

const FILE_NAME = 'codex-tokens.json';

export class CodexTokenStore {
  private readonly path: string;
  private readonly injectedCrypto: SafeStorageLike | undefined;

  constructor(options: CodexTokenStoreOptions = {}) {
    this.path = options.filePath ?? join(app.getPath('userData'), FILE_NAME);
    this.injectedCrypto = options.safeStorageImpl;
  }

  /**
   * Resolve the crypto backend lazily. Electron `safeStorage` is only real
   * inside a running main process; accessing the binding under a partial test
   * mock (or outside Electron) can throw, so we guard and degrade to "no
   * crypto" (load -> null, save -> no-op) rather than crashing callers.
   */
  private getCrypto(): SafeStorageLike | null {
    if (this.injectedCrypto !== undefined) return this.injectedCrypto;
    try {
      return (safeStorage as SafeStorageLike | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Decrypt and return the persisted tokens, or null when nothing is stored,
   * the file is malformed, or the blob cannot be decrypted (DPAPI credentials
   * changed). Never throws.
   */
  load(): StoredCodexTokens | null {
    try {
      if (!existsSync(this.path)) return null;
      const crypto = this.getCrypto();
      if (crypto === null) return null;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<TokenFile>;
      if (
        typeof parsed.accessTokenEncrypted !== 'string' ||
        typeof parsed.refreshTokenEncrypted !== 'string' ||
        typeof parsed.accountId !== 'string' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        return null;
      }
      const accessToken = crypto.decryptString(Buffer.from(parsed.accessTokenEncrypted, 'base64'));
      const refreshToken = crypto.decryptString(
        Buffer.from(parsed.refreshTokenEncrypted, 'base64'),
      );
      return {
        accessToken,
        refreshToken,
        accountId: parsed.accountId,
        planType: typeof parsed.planType === 'string' ? parsed.planType : '',
        expiresAt: parsed.expiresAt,
      };
    } catch (err) {
      console.error('[codex-token-store] failed to load cached tokens:', errName(err));
      return null;
    }
  }

  /** Encrypt and persist the tokens. Never throws (logs + gives up on error). */
  save(tokens: StoredCodexTokens): void {
    try {
      const crypto = this.getCrypto();
      if (crypto === null || !crypto.isEncryptionAvailable()) {
        // Refuse to write plaintext tokens — better to lose the cache than
        // to leave bearer tokens readable on disk.
        console.warn('[codex-token-store] safeStorage unavailable; not persisting tokens');
        return;
      }
      const file: TokenFile = {
        version: 1,
        accessTokenEncrypted: crypto.encryptString(tokens.accessToken).toString('base64'),
        refreshTokenEncrypted: crypto.encryptString(tokens.refreshToken).toString('base64'),
        accountId: tokens.accountId,
        planType: tokens.planType,
        expiresAt: tokens.expiresAt,
      };
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(file, null, 2), 'utf8');
    } catch (err) {
      console.error('[codex-token-store] failed to persist tokens:', errName(err));
    }
  }

  /** Remove the cache (sign-out / corruption recovery). Never throws. */
  clear(): void {
    try {
      if (existsSync(this.path)) rmSync(this.path);
    } catch (err) {
      console.error('[codex-token-store] failed to clear tokens:', errName(err));
    }
  }
}

/** Error class/name only — never the message (tokens must not reach logs). */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}
