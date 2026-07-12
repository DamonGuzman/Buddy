/**
 * Settings store: JSON file in `userData`, API key encrypted via safeStorage.
 *
 * The raw API key never leaves this module except through `getApiKey()`
 * (main-process consumers only). Renderers only ever see `Settings`
 * (renderer-safe view with `apiKeyPresent`).
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS, applySettingsPatch } from '../shared/types';
import type { Settings, SettingsPatch } from '../shared/types';

/** On-disk shape. `apiKeyEncrypted` is a base64 safeStorage blob. */
interface SettingsFile {
  version: 1;
  apiKeyEncrypted: string | null;
  model: Settings['model'];
  voice: string;
  captionsEnabled: boolean;
  micDeviceId: string;
}

const FILE_NAME = 'settings.json';

export class SettingsStore {
  private file: SettingsFile;
  private readonly path: string;
  private listeners = new Set<(settings: Settings) => void>();

  constructor(filePath?: string) {
    this.path = filePath ?? join(app.getPath('userData'), FILE_NAME);
    this.file = this.load();
  }

  /** Renderer-safe snapshot (never the raw key). */
  get(): Settings {
    return {
      apiKeyPresent: this.file.apiKeyEncrypted !== null,
      model: this.file.model,
      voice: this.file.voice,
      captionsEnabled: this.file.captionsEnabled,
      micDeviceId: this.file.micDeviceId,
      hotkeyLabel: DEFAULT_SETTINGS.hotkeyLabel,
    };
  }

  /** Apply a patch (encrypting apiKey if present), persist, notify, return snapshot. */
  set(patch: SettingsPatch): Settings {
    if (patch.apiKey !== undefined) {
      this.file.apiKeyEncrypted =
        patch.apiKey === null || patch.apiKey === '' ? null : this.encrypt(patch.apiKey);
    }
    const merged = applySettingsPatch(this.get(), patch);
    this.file.model = merged.model;
    this.file.voice = merged.voice;
    this.file.captionsEnabled = merged.captionsEnabled;
    this.file.micDeviceId = merged.micDeviceId;
    this.persist();
    const snapshot = this.get();
    for (const cb of this.listeners) cb(snapshot);
    return snapshot;
  }

  /** Decrypted API key — MAIN PROCESS ONLY. Never send over IPC. */
  getApiKey(): string | null {
    if (this.file.apiKeyEncrypted === null) return null;
    try {
      return safeStorage.decryptString(Buffer.from(this.file.apiKeyEncrypted, 'base64'));
    } catch (err) {
      console.error('[settings] failed to decrypt api key:', err);
      return null;
    }
  }

  onChange(cb: (settings: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // -------------------------------------------------------------------------

  private encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Extremely rare on Windows (DPAPI); refuse to store plaintext.
      throw new Error('safeStorage encryption unavailable; cannot store API key');
    }
    return safeStorage.encryptString(plain).toString('base64');
  }

  private load(): SettingsFile {
    const fallback: SettingsFile = {
      version: 1,
      apiKeyEncrypted: null,
      model: DEFAULT_SETTINGS.model,
      voice: DEFAULT_SETTINGS.voice,
      captionsEnabled: DEFAULT_SETTINGS.captionsEnabled,
      micDeviceId: DEFAULT_SETTINGS.micDeviceId,
    };
    try {
      if (!existsSync(this.path)) return fallback;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SettingsFile>;
      return {
        version: 1,
        apiKeyEncrypted: typeof parsed.apiKeyEncrypted === 'string' ? parsed.apiKeyEncrypted : null,
        model: parsed.model === 'gpt-realtime-2.1' ? 'gpt-realtime-2.1' : fallback.model,
        voice: typeof parsed.voice === 'string' ? parsed.voice : fallback.voice,
        captionsEnabled:
          typeof parsed.captionsEnabled === 'boolean'
            ? parsed.captionsEnabled
            : fallback.captionsEnabled,
        micDeviceId: typeof parsed.micDeviceId === 'string' ? parsed.micDeviceId : fallback.micDeviceId,
      };
    } catch (err) {
      console.error('[settings] failed to load, using defaults:', err);
      return fallback;
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.file, null, 2), 'utf8');
    } catch (err) {
      console.error('[settings] failed to persist:', err);
    }
  }
}
