/**
 * M11: SettingsStore behavior tests — DPAPI decrypt-failure flagging
 * (api_key_unreadable) and corrupt-file reset detection (settings_reset).
 * Electron's safeStorage is mocked with a controllable fake; files go to a
 * per-run temp dir.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    store.set({ apiKey: 'sk-test-123' });
    expect(store.get().apiKeyPresent).toBe(true);
    expect(store.get().apiKeyUnreadable).toBe(false);
    expect(store.getApiKey()).toBe('sk-test-123');
    expect(store.get().apiKeyUnreadable).toBe(false);
  });
});

describe('SettingsStore: DPAPI decrypt failure (M11 api_key_unreadable)', () => {
  it('flags the dead blob, persists the flag, and notifies listeners', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: 'sk-test-123' });

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
    store.set({ apiKey: 'sk-x' });
    control.decryptFails = true;
    const notified: number[] = [];
    store.onChange(() => notified.push(1));
    store.getApiKey();
    store.getApiKey();
    store.getApiKey();
    expect(notified.length).toBe(1);
  });

  it('pasting a new key clears the flag', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: 'sk-old' });
    control.decryptFails = true;
    store.getApiKey();
    expect(store.get().apiKeyUnreadable).toBe(true);

    control.decryptFails = false;
    store.set({ apiKey: 'sk-new' });
    expect(store.get().apiKeyUnreadable).toBe(false);
    expect(store.getApiKey()).toBe('sk-new');
  });

  it('heals the flag if the blob decrypts again', () => {
    const path = freshPath();
    const store = new SettingsStore(path);
    store.set({ apiKey: 'sk-x' });
    control.decryptFails = true;
    store.getApiKey();
    expect(store.get().apiKeyUnreadable).toBe(true);
    control.decryptFails = false;
    expect(store.getApiKey()).toBe('sk-x');
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
