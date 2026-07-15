/**
 * Settings store: JSON file in `userData`, API key encrypted via safeStorage.
 *
 * The raw API key never leaves this module except through `getApiKey()`
 * (main-process consumers only). Renderers only ever see `Settings`
 * (renderer-safe view with `apiKeyPresent`).
 *
 * Every persisted user preference is declared ONCE in `PREF_FIELDS`
 * (default + on-disk validation); defaults, file loading, and patch
 * application all iterate that table. `get()` stays an explicit projection so
 * the renderer-visible snapshot keeps its historical key order.
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODEL_IDS } from '../shared/constants';
import { DEFAULT_SETTINGS, applySettingsPatch } from '../shared/types';
import type { BuddyRest, CodexSignInState, Settings, SettingsPatch } from '../shared/types';
import { getCodexAuthProvider } from './auth/codex-auth';
import { shouldImportApiKeyFromEnv } from './env';
import { hotkeyLabelForPlatform } from './platform';

/** M17: signed-out fallback when the Codex auth provider is unavailable. */
const CODEX_SIGNED_OUT: CodexSignInState = {
  signedIn: false,
  valid: false,
  planType: '',
  expiresAt: null,
};

/** The user-preference keys persisted verbatim (everything patchable but the key). */
type PrefKey = Exclude<keyof SettingsPatch, 'apiKey'>;
type Prefs = Pick<Settings, PrefKey>;

/** One persisted preference: its default and how to validate a stored value. */
interface PrefField<K extends PrefKey> {
  default: Prefs[K];
  /** Narrow an untrusted persisted JSON value; anything invalid falls back. */
  load: (raw: unknown, fallback: Prefs[K]) => Prefs[K];
}

const loadString = (raw: unknown, fallback: string): string =>
  typeof raw === 'string' ? raw : fallback;
const loadBoolean = (raw: unknown, fallback: boolean): boolean =>
  typeof raw === 'boolean' ? raw : fallback;

/**
 * THE declarative field table: key -> {default, validate}. Adding a persisted
 * preference means adding one entry here (plus the shared Settings/Patch
 * schema); load, defaults, and set() pick it up automatically.
 */
const PREF_FIELDS: { readonly [K in PrefKey]: PrefField<K> } = {
  // M8.6: validate against the full model list — a stored 'mini' choice
  // must survive the default flipping to the full model.
  model: {
    default: DEFAULT_SETTINGS.model,
    load: (raw, fallback) =>
      MODEL_IDS.includes(raw as Settings['model']) ? (raw as Settings['model']) : fallback,
  },
  voice: { default: DEFAULT_SETTINGS.voice, load: loadString },
  captionsEnabled: { default: DEFAULT_SETTINGS.captionsEnabled, load: loadBoolean },
  micDeviceId: { default: DEFAULT_SETTINGS.micDeviceId, load: loadString },
  fullRealtimeMode: { default: DEFAULT_SETTINGS.fullRealtimeMode, load: loadBoolean },
  // M20 addition: whisper quiet mode (text-only answers).
  voiceMuted: { default: DEFAULT_SETTINGS.voiceMuted, load: loadBoolean },
  // M15 addition (orchestrator-approved): validate the persisted rest.
  buddyRest: { default: DEFAULT_SETTINGS.buddyRest, load: (raw) => parseBuddyRest(raw) },
  preferApiKeyGrounding: { default: DEFAULT_SETTINGS.preferApiKeyGrounding, load: loadBoolean },
  computerUseEnabled: { default: DEFAULT_SETTINGS.computerUseEnabled, load: loadBoolean },
};

/** Table order doubles as the persisted-file field order (after the key blob). */
const PREF_KEYS = Object.keys(PREF_FIELDS) as readonly PrefKey[];

function loadPref<K extends PrefKey>(key: K, raw: unknown): Prefs[K] {
  const field = PREF_FIELDS[key];
  return field.load(raw, field.default);
}

function setPref<K extends PrefKey>(target: Prefs, key: K, value: Prefs[K]): void {
  target[key] = value;
}

function defaultPrefs(): Prefs {
  const prefs = {} as Prefs;
  for (const key of PREF_KEYS) setPref(prefs, key, PREF_FIELDS[key].default);
  return prefs;
}

function loadPrefs(parsed: Partial<Record<PrefKey, unknown>>): Prefs {
  const prefs = {} as Prefs;
  for (const key of PREF_KEYS) setPref(prefs, key, loadPref(key, parsed[key]));
  return prefs;
}

/** On-disk shape. `apiKeyEncrypted` is a base64 safeStorage blob. */
interface SettingsFile extends Prefs {
  version: 3;
  apiKeyEncrypted: string | null;
  /**
   * M11: the stored blob failed DPAPI decryption (windows credentials
   * changed). Persisted so the "paste it again" prompt survives restarts;
   * cleared when a new key is stored (or the key is cleared).
   */
  keyUnreadable?: boolean;
}

const FILE_NAME = 'settings.json';

/**
 * M15 addition (orchestrator-approved): module-level handle to the started
 * store so sibling main modules (windows/overlay.ts buddy-hover feature) can
 * read hotkeyLabel/buddyRest and persist drag-repositions without bootstrap
 * wiring changes (index.ts is frozen for M15). Same pattern as
 * windows/overlay.ts getOverlayManager.
 */
let activeStore: SettingsStore | null = null;

export function getSettingsStore(): SettingsStore | null {
  return activeStore;
}

export class SettingsStore {
  private file: SettingsFile;
  private readonly path: string;
  private listeners = new Set<(settings: Settings) => void>();
  /** M11: true when a settings.json EXISTED but was corrupt (reset to defaults). */
  private wasReset = false;
  private needsMigration = false;
  /**
   * M17: resolves the renderer-safe Codex sign-in snapshot. Defaults to the
   * process-wide Codex auth provider (reads `~/.codex/auth.json` fresh);
   * injectable so unit tests stay hermetic. Any throw degrades to signed-out.
   */
  private readonly resolveCodexSignIn: () => CodexSignInState;

  constructor(filePath?: string, codexSignIn?: () => CodexSignInState) {
    this.path = filePath ?? join(app.getPath('userData'), FILE_NAME);
    this.resolveCodexSignIn = codexSignIn ?? (() => getCodexAuthProvider().codexSignInState());
    this.file = this.load();
    if (this.needsMigration) this.persist();
    // M15 addition (orchestrator-approved): see getSettingsStore above.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeStore = this;
  }

  /** Renderer-safe snapshot (never the raw key). */
  get(): Settings {
    const codex = this.codexSignInState();
    return {
      apiKeyPresent: this.file.apiKeyEncrypted !== null,
      apiKeyUnreadable: this.file.keyUnreadable === true,
      model: this.file.model,
      voice: this.file.voice,
      captionsEnabled: this.file.captionsEnabled,
      micDeviceId: this.file.micDeviceId,
      fullRealtimeMode: this.file.fullRealtimeMode,
      voiceMuted: this.file.voiceMuted,
      hotkeyLabel: hotkeyLabelForPlatform(),
      // M15 addition (orchestrator-approved).
      buddyRest: this.file.buddyRest,
      // M17 additions (integration-approved): ChatGPT-subscription sign-in
      // snapshot from the Codex auth provider (never a token). The token store
      // is self-contained (codex-tokens.json); no field is persisted here.
      codexSignedIn: codex.signedIn,
      codexValid: codex.valid,
      codexPlanType: codex.planType,
      preferApiKeyGrounding: this.file.preferApiKeyGrounding,
      computerUseEnabled: this.file.computerUseEnabled,
    };
  }

  /**
   * M17: the Codex sign-in snapshot, fail-soft. The provider reads the CLI's
   * auth.json fresh each call and the token store degrades to "no crypto"
   * outside Electron — but a construction/read error must never sink `get()`,
   * so anything thrown maps to signed-out.
   */
  private codexSignInState(): CodexSignInState {
    try {
      return this.resolveCodexSignIn();
    } catch (err) {
      console.warn(
        '[settings] codex sign-in state unavailable:',
        err instanceof Error ? err.name : 'unknown',
      );
      return CODEX_SIGNED_OUT;
    }
  }

  /**
   * M11: a settings.json existed at boot but could not be parsed, so the
   * store started from defaults. The conversation surfaces this once.
   */
  settingsWereReset(): boolean {
    return this.wasReset;
  }

  /** Apply a patch (encrypting apiKey if present), persist, notify, return snapshot. */
  set(patch: SettingsPatch): Settings {
    if (patch.apiKey !== undefined) {
      this.file.apiKeyEncrypted =
        patch.apiKey === null || patch.apiKey === '' ? null : this.encrypt(patch.apiKey);
      // M11: a freshly stored (or cleared) key resolves an unreadable blob.
      // Assigned silently — set() persists + notifies once, below.
      this.file.keyUnreadable = false;
    }
    const merged = applySettingsPatch(this.get(), patch);
    for (const key of PREF_KEYS) setPref(this.file, key, merged[key]);
    this.persist();
    this.notify();
    return this.get();
  }

  /** Decrypted API key — MAIN PROCESS ONLY. Never send over IPC. */
  getApiKey(): string | null {
    if (this.file.apiKeyEncrypted === null) return null;
    try {
      const key = safeStorage.decryptString(Buffer.from(this.file.apiKeyEncrypted, 'base64'));
      // A previously flagged blob decrypts again (rare, but heal the flag).
      this.setKeyUnreadable(false);
      return key;
    } catch (err) {
      console.error('[settings] failed to decrypt api key:', err);
      // M11: flag the dead blob (once) so the UI stops claiming a key is
      // present-and-working while every turn fails.
      this.setKeyUnreadable(true);
      return null;
    }
  }

  /**
   * M11: the one owner of the keyUnreadable heal/flag transition. Persisted +
   * notified ONCE PER TRANSITION (tests pin no persist/notify churn on
   * repeated failing or healthy decrypts) so the panel snapshot reflects it
   * immediately and across restarts.
   */
  private setKeyUnreadable(flag: boolean): void {
    if ((this.file.keyUnreadable === true) === flag) return;
    this.file.keyUnreadable = flag;
    this.persist();
    this.notify();
  }

  onChange(cb: (settings: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    const snapshot = this.get();
    for (const cb of this.listeners) cb(snapshot);
  }

  // -------------------------------------------------------------------------

  /** Import the dev launcher's local key after Electron app.ready. */
  importApiKeyFromEnvironment(): boolean {
    try {
      const imported = this.prepareApiKeyFromEnvironment();
      if (imported) this.persist();
      return imported;
    } catch (err) {
      console.error(
        '[settings] failed to import OPENAI_API_KEY:',
        err instanceof Error ? err.message : 'unknown error',
      );
      return false;
    }
  }

  private encrypt(plain: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Extremely rare on Windows (DPAPI); refuse to store plaintext.
      throw new Error('safeStorage encryption unavailable; cannot store API key');
    }
    return safeStorage.encryptString(plain).toString('base64');
  }

  /**
   * Development launcher seam: import OPENAI_API_KEY through Electron so the
   * value is encrypted by the CURRENT Windows DPAPI context. Copying a
   * safeStorage blob between app profiles is not reliable. The launcher opts
   * in explicitly; normal installed-app startup never reads this environment
   * variable. The plaintext is removed from this process after import.
   */
  private prepareApiKeyFromEnvironment(): boolean {
    if (!shouldImportApiKeyFromEnv()) return false;
    const apiKey = process.env['OPENAI_API_KEY']?.trim() ?? '';
    if (apiKey === '') return false;

    try {
      if (this.file.apiKeyEncrypted !== null) {
        try {
          const current = safeStorage.decryptString(
            Buffer.from(this.file.apiKeyEncrypted, 'base64'),
          );
          if (current === apiKey) {
            const needsPersist = this.file.keyUnreadable === true;
            this.file.keyUnreadable = false;
            return needsPersist;
          }
        } catch {
          // The stale blob is intentionally replaced below.
        }
      }

      const encrypted = this.encrypt(apiKey);
      const roundTrip = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      if (roundTrip !== apiKey) {
        throw new Error('safeStorage API key round-trip verification failed');
      }
      this.file.apiKeyEncrypted = encrypted;
      this.file.keyUnreadable = false;
      console.log('[settings] imported OPENAI_API_KEY into encrypted local settings');
      return true;
    } finally {
      delete process.env['OPENAI_API_KEY'];
    }
  }

  private load(): SettingsFile {
    const fallback: SettingsFile = {
      version: 3,
      apiKeyEncrypted: null,
      keyUnreadable: false,
      ...defaultPrefs(),
    };
    try {
      if (!existsSync(this.path)) return fallback;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<SettingsFile>;
      this.needsMigration = parsed.version !== 3;
      return {
        version: 3,
        apiKeyEncrypted: typeof parsed.apiKeyEncrypted === 'string' ? parsed.apiKeyEncrypted : null,
        keyUnreadable: parsed.keyUnreadable === true,
        ...loadPrefs(parsed),
      };
    } catch (err) {
      console.error('[settings] failed to load, using defaults:', err);
      // M11 (settings_reset): the file existed but was scrambled — remember
      // it so clicky can say so on the first turn (the key is gone with it).
      this.wasReset = true;
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

/**
 * M15 addition (orchestrator-approved): validate a persisted buddyRest —
 * screenIndex must be a non-negative integer and both fractions finite in
 * [0, 1]. Anything else falls back to null (default corner).
 */
function parseBuddyRest(value: unknown): BuddyRest | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  const screenIndex = rec['screenIndex'];
  const xFrac = rec['xFrac'];
  const yFrac = rec['yFrac'];
  if (typeof screenIndex !== 'number' || !Number.isInteger(screenIndex) || screenIndex < 0) {
    return null;
  }
  const fracOk = (f: unknown): f is number =>
    typeof f === 'number' && Number.isFinite(f) && f >= 0 && f <= 1;
  if (!fracOk(xFrac) || !fracOk(yFrac)) return null;
  return { screenIndex, xFrac, yFrac };
}
