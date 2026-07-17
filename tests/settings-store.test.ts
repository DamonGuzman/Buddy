/**
 * M11: SettingsStore behavior tests — DPAPI decrypt-failure flagging
 * (api_key_unreadable) and corrupt-file reset detection (settings_reset).
 * Electron's safeStorage is mocked with a controllable fake; files go to a
 * per-run temp dir.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ decryptFails: false }));

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('tests must pass an explicit filePath');
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      if (control.decryptFails) {
        throw new Error('DPAPI: The data is invalid (windows credentials changed)');
      }
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad blob');
      return s.slice(4);
    },
  },
}));

const { SettingsStore } = await import('../src/main/settings');

const dir = mkdtempSync(join(tmpdir(), 'clicky-settings-'));
let fileSeq = 0;
const freshPath = (): string => join(dir, `settings-${(fileSeq += 1)}.json`);
const VALID_KEY = 'sk-test-credential-1234567890';

beforeEach(() => {
  control.decryptFails = false;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SettingsStore: api key round trip', () => {
  it('stores, reports present, decrypts back, and never flags a healthy blob', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: VALID_KEY });
    expect(store.get().apiKeyPresent).toBe(true);
    expect(store.get().apiKeyUnreadable).toBe(false);
    expect(store.getApiKey()).toBe(VALID_KEY);
    expect(store.get().apiKeyUnreadable).toBe(false);
  });

  it('normalizes surrounding whitespace before encryption', () => {
    const store = new SettingsStore(freshPath());
    store.set({ apiKey: `  ${VALID_KEY}\n` });
    expect(store.getApiKey()).toBe(VALID_KEY);
  });

  it('rejects clearly malformed prose without replacing or exposing the previous key', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: VALID_KEY });
    const malformed = 'this is not a key and must never appear in an error';

    let thrown: Error | null = null;
    try {
      store.set({ apiKey: malformed });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown?.message).toContain('full key beginning with sk-');
    expect(thrown?.message).not.toContain(malformed);
    expect(store.getApiKey()).toBe(VALID_KEY);
    expect(readFileSync(path, 'utf8')).not.toContain(malformed);
  });

  it('fails the save when persistence cannot commit and leaves memory unchanged', () => {
    const path = freshPath();
    mkdirSync(path);
    const store = new SettingsStore(path);
    expect(() => store.set({ apiKey: VALID_KEY })).toThrow('previous API key is unchanged');
    expect(store.get().apiKeyPresent).toBe(false);
  });

  it('re-encrypts an environment key into the active Electron DPAPI context', () => {
    const path = freshPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        apiKeyEncrypted: Buffer.from('enc:stale-key', 'utf8').toString('base64'),
        keyUnreadable: true,
      }),
      'utf8',
    );
    const previousImport = process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'];
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'] = '1';
    process.env['OPENAI_API_KEY'] = 'sk-local-environment-key';

    try {
      const store = new SettingsStore(path);
      expect(store.importApiKeyFromEnvironment()).toBe(true);
      expect(store.getApiKey()).toBe('sk-local-environment-key');
      expect(store.get().apiKeyUnreadable).toBe(false);
      expect(process.env['OPENAI_API_KEY']).toBeUndefined();
      const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
        apiKeyEncrypted: string;
        keyUnreadable: boolean;
      };
      expect(Buffer.from(persisted.apiKeyEncrypted, 'base64').toString('utf8')).toBe(
        'enc:sk-local-environment-key',
      );
      expect(persisted.keyUnreadable).toBe(false);
    } finally {
      if (previousImport === undefined) delete process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'];
      else process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'] = previousImport;
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
    }
  });

  it('rejects a malformed environment key and removes it from the process', () => {
    const previousImport = process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'];
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'] = '1';
    process.env['OPENAI_API_KEY'] = 'copied prose instead of a credential';
    try {
      const store = new SettingsStore(freshPath());
      expect(store.importApiKeyFromEnvironment()).toBe(false);
      expect(store.get().apiKeyPresent).toBe(false);
      expect(process.env['OPENAI_API_KEY']).toBeUndefined();
    } finally {
      if (previousImport === undefined) delete process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'];
      else process.env['CLICKY_IMPORT_API_KEY_FROM_ENV'] = previousImport;
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
    }
  });
});

describe('SettingsStore: Firecrawl key round trip', () => {
  const FIRECRAWL_KEY = 'fc-test-credential-1234567890';

  it('stores, decrypts, replaces, and clears Firecrawl independently', () => {
    const store = new SettingsStore(freshPath());
    store.set({ apiKey: VALID_KEY, firecrawlApiKey: FIRECRAWL_KEY });
    expect(store.get().firecrawlApiKeyPresent).toBe(true);
    expect(store.get().firecrawlApiKeyUnreadable).toBe(false);
    expect(store.getFirecrawlApiKey()).toBe(FIRECRAWL_KEY);
    expect(store.getApiKey()).toBe(VALID_KEY);

    store.set({ firecrawlApiKey: null });
    expect(store.get().firecrawlApiKeyPresent).toBe(false);
    expect(store.getFirecrawlApiKey()).toBeNull();
    expect(store.getApiKey()).toBe(VALID_KEY);
  });

  it('rejects malformed Firecrawl keys without replacing the previous one', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ firecrawlApiKey: FIRECRAWL_KEY });
    expect(() => store.set({ firecrawlApiKey: 'not a firecrawl key' })).toThrow(
      'full key beginning with fc-',
    );
    expect(store.getFirecrawlApiKey()).toBe(FIRECRAWL_KEY);
    expect(readFileSync(path, 'utf8')).not.toContain(FIRECRAWL_KEY);
  });

  it('flags an unreadable Firecrawl blob without changing the OpenAI flag', () => {
    const store = new SettingsStore(freshPath());
    store.set({ apiKey: VALID_KEY, firecrawlApiKey: FIRECRAWL_KEY });
    control.decryptFails = true;
    expect(store.getFirecrawlApiKey()).toBeNull();
    expect(store.get().firecrawlApiKeyUnreadable).toBe(true);
    expect(store.get().apiKeyUnreadable).toBe(false);
  });
});

describe('SettingsStore: DPAPI decrypt failure (M11 api_key_unreadable)', () => {
  it('flags the dead blob, persists the flag, and notifies listeners', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: VALID_KEY });

    control.decryptFails = true;
    const notified: boolean[] = [];
    store.onChange((s) => notified.push(s.apiKeyUnreadable));

    // The contradictory state the audit found: present=true, key=null —
    // now the unreadable flag tells the UI what actually happened.
    expect(store.getApiKey()).toBeNull();
    expect(store.get().apiKeyPresent).toBe(true);
    expect(store.get().apiKeyUnreadable).toBe(true);
    expect(notified).toContain(true);

    // Persisted: a fresh store on the same file still knows.
    const reloaded = new SettingsStore(path);
    expect(reloaded.get().apiKeyUnreadable).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).keyUnreadable).toBe(true);
  });

  it('flags only once (no persist/notify churn per failing call)', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: VALID_KEY });
    control.decryptFails = true;
    const notified: number[] = [];
    store.onChange(() => notified.push(1));
    store.getApiKey();
    store.getApiKey();
    store.getApiKey();
    expect(notified.length).toBe(1);
  });

  it('returns null even when the unreadable diagnostic flag cannot be persisted', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: VALID_KEY });
    rmSync(path);
    mkdirSync(path);
    control.decryptFails = true;

    expect(store.getApiKey()).toBeNull();
    expect(store.get().apiKeyUnreadable).toBe(true);
  });

  it('pasting a new key clears the flag', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: 'sk-old-credential-1234567890' });
    control.decryptFails = true;
    store.getApiKey();
    expect(store.get().apiKeyUnreadable).toBe(true);

    control.decryptFails = false;
    store.set({ apiKey: 'sk-new-credential-1234567890' });
    expect(store.get().apiKeyUnreadable).toBe(false);
    expect(store.getApiKey()).toBe('sk-new-credential-1234567890');
  });

  it('heals the flag if the blob decrypts again', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: VALID_KEY });
    control.decryptFails = true;
    store.getApiKey();
    expect(store.get().apiKeyUnreadable).toBe(true);
    control.decryptFails = false;
    expect(store.getApiKey()).toBe(VALID_KEY);
    expect(store.get().apiKeyUnreadable).toBe(false);
  });
});

describe('SettingsStore: codex sign-in fields (M17)', () => {
  it('populates codex* from the injected sign-in resolver', () => {
    const store = new SettingsStore(freshPath(), () => ({
      signedIn: true,
      valid: true,
      planType: 'pro',
      expiresAt: Date.now() + 3_600_000,
    }));
    const s = store.get();
    expect(s.codexSignedIn).toBe(true);
    expect(s.codexValid).toBe(true);
    expect(s.codexPlanType).toBe('pro');
  });

  it('reflects a signed-out resolver as all-false / empty plan', () => {
    const store = new SettingsStore(freshPath(), () => ({
      signedIn: false,
      valid: false,
      planType: '',
      expiresAt: null,
    }));
    const s = store.get();
    expect(s.codexSignedIn).toBe(false);
    expect(s.codexValid).toBe(false);
    expect(s.codexPlanType).toBe('');
  });

  it('reads the resolver FRESH each get (auth.json can rotate under us)', () => {
    let signedIn = false;
    const store = new SettingsStore(freshPath(), () => ({
      signedIn,
      valid: signedIn,
      planType: signedIn ? 'plus' : '',
      expiresAt: signedIn ? Date.now() + 1_000 : null,
    }));
    expect(store.get().codexSignedIn).toBe(false);
    signedIn = true;
    expect(store.get().codexSignedIn).toBe(true);
    expect(store.get().codexPlanType).toBe('plus');
  });

  it('degrades to signed-out when the resolver throws (never sinks get())', () => {
    const store = new SettingsStore(freshPath(), () => {
      throw new Error('codex provider blew up');
    });
    const s = store.get();
    expect(s.codexSignedIn).toBe(false);
    expect(s.codexValid).toBe(false);
    expect(s.codexPlanType).toBe('');
    // The rest of the snapshot is unaffected.
    expect(s.model).toBe('gpt-realtime-2.1');
  });
});

describe('SettingsStore: corrupt settings.json (M11 settings_reset)', () => {
  it('migrates a healthy schema-v1 file to v4 without losing preferences', () => {
    const path = freshPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        apiKeyEncrypted: null,
        model: 'gpt-realtime-2.1-mini',
        voice: 'cedar',
        captionsEnabled: false,
        micDeviceId: 'mic-old',
        buddyRest: null,
      }),
      'utf8',
    );
    const store = new SettingsStore(path);
    expect(store.get().voice).toBe('cedar');
    expect(store.get().preferApiKeyGrounding).toBe(false);
    expect(store.get().fullRealtimeMode).toBe(false);
    expect(store.get().computerUseEnabled).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(4);
    expect(store.get().firecrawlApiKeyPresent).toBe(false);
  });

  it('persists the full realtime mode toggle', () => {
    const path = freshPath();
    const first = new SettingsStore(path);
    first.set({ fullRealtimeMode: true });
    const second = new SettingsStore(path);
    expect(second.get().fullRealtimeMode).toBe(true);
  });

  it('persists the opt-in computer use toggle', () => {
    const path = freshPath();
    const first = new SettingsStore(path);
    first.set({ computerUseEnabled: true });
    const second = new SettingsStore(path);
    expect(second.get().computerUseEnabled).toBe(true);
  });

  it('heals invalid persisted preference values field-by-field (no reset)', () => {
    const path = freshPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 3,
        apiKeyEncrypted: null,
        model: 'not-a-model',
        voice: 42,
        captionsEnabled: 'yes',
        micDeviceId: 'mic-kept',
        fullRealtimeMode: 1,
        buddyRest: { screenIndex: -1, xFrac: 0.5, yFrac: 0.5 },
        preferApiKeyGrounding: 'nope',
        computerUseEnabled: [],
      }),
      'utf8',
    );
    const store = new SettingsStore(path);
    expect(store.settingsWereReset()).toBe(false);
    const s = store.get();
    expect(s.model).toBe('gpt-realtime-2.1');
    expect(s.voice).toBe('marin');
    expect(s.captionsEnabled).toBe(true);
    expect(s.micDeviceId).toBe('mic-kept'); // valid values survive healing
    expect(s.fullRealtimeMode).toBe(false);
    expect(s.buddyRest).toBeNull();
    expect(s.preferApiKeyGrounding).toBe(false);
    expect(s.computerUseEnabled).toBe(false);
  });

  it('resets to defaults and reports settingsWereReset', () => {
    const path = freshPath();
    writeFileSync(path, '{"version":1, THIS IS NOT JSON', 'utf8');
    const store = new SettingsStore(path);
    expect(store.settingsWereReset()).toBe(true);
    expect(store.get().apiKeyPresent).toBe(false);
    expect(store.get().model).toBe('gpt-realtime-2.1');
  });

  it('does NOT report a reset for a missing file (first run)', () => {
    const store = new SettingsStore(freshPath());
    expect(store.settingsWereReset()).toBe(false);
  });

  it('does NOT report a reset for a healthy file', () => {
    const path = freshPath();
    const first = new SettingsStore(path);
    first.set({ voice: 'cedar' });
    const second = new SettingsStore(path);
    expect(second.settingsWereReset()).toBe(false);
    expect(second.get().voice).toBe('cedar');
  });
});
