/**
 * Settings schema: the renderer-safe view, the write-only patch, defaults,
 * the pure patch merge, and the Codex (ChatGPT-subscription) sign-in shapes.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

import { DEFAULT_MODEL, DEFAULT_VOICE, type MODEL_IDS } from '../constants';
import type { BuddyRest } from './overlay';

/** Selectable realtime model id — derived from MODEL_IDS (single source of truth). */
export type ModelId = (typeof MODEL_IDS)[number];

/**
 * Renderer-safe settings view. The raw API key NEVER crosses into a renderer;
 * only its presence flag does.
 */
export interface Settings {
  /** Whether an API key is stored (encrypted via safeStorage). Never the key itself. */
  apiKeyPresent: boolean;
  /**
   * M11: the stored key blob exists but DPAPI can no longer decrypt it
   * (windows credentials changed). The settings UI should prompt for a
   * re-paste; pasting a new key clears it.
   */
  apiKeyUnreadable: boolean;
  model: ModelId;
  voice: string;
  captionsEnabled: boolean;
  /** Preferred microphone deviceId ('' = system default). */
  micDeviceId: string;
  /** Opt-in open-mic mode; the hotkey toggles a server-VAD session on/off. */
  fullRealtimeMode: boolean;
  /**
   * M20 (whisper quiet mode): buddy answers in text only — model audio is not
   * played and captions are forced on regardless of captionsEnabled. Toggled
   * from the whisper composer for can't-talk/can't-listen environments.
   */
  voiceMuted: boolean;
  /** Display string for the hotkey (fixed for MVP). */
  hotkeyLabel: string;
  /**
   * M15: user-defined buddy rest position (set by drag-repositioning the
   * buddy). null = default corner on primary.
   */
  buddyRest: BuddyRest | null;
  // M17: ChatGPT-subscription (Codex CLI) sign-in snapshot, surfaced READ-ONLY
  // to the panel so the settings view can show whether clicky can ground
  // through the user's ChatGPT plan. Populated by main from the Codex auth
  // provider (`~/.codex/auth.json`); these are NOT patchable from the renderer
  // (no SettingsPatch fields) and NEVER carry a token — only booleans + the
  // plan label.
  /** A decodable Codex token is present (signed in via the Codex CLI). */
  codexSignedIn: boolean;
  /** The best-available Codex token is still valid (exp > now + 60s). */
  codexValid: boolean;
  /** Plan label from the token claim (e.g. 'pro' | 'plus' | 'free'); '' unknown. */
  codexPlanType: string;
  /** Prefer metered API-key grounding even while ChatGPT is connected. */
  preferApiKeyGrounding: boolean;
  /** Allow Sol (never the realtime model) to click and type on this device. */
  computerUseEnabled: boolean;
}

/**
 * Patch sent renderer -> main to update settings. `apiKey` is write-only:
 * a string stores a new key, `null` clears it, absent leaves it untouched.
 */
export interface SettingsPatch {
  apiKey?: string | null;
  model?: ModelId;
  voice?: string;
  captionsEnabled?: boolean;
  micDeviceId?: string;
  fullRealtimeMode?: boolean;
  voiceMuted?: boolean;
  /** M15: null resets to the default corner. */
  buddyRest?: BuddyRest | null;
  preferApiKeyGrounding?: boolean;
  computerUseEnabled?: boolean;
}

/** The renderer-safe defaults. */
export const DEFAULT_SETTINGS: Settings = {
  apiKeyPresent: false,
  apiKeyUnreadable: false,
  // M8.6: default to the full model — the live pointing eval (docs/EVAL.md §8)
  // showed mini's coordinate estimation is far less accurate (0-13% strict vs
  // full's 33-47%). mini remains selectable in settings as the faster/cheaper
  // option.
  model: DEFAULT_MODEL,
  voice: DEFAULT_VOICE,
  captionsEnabled: true,
  micDeviceId: '',
  fullRealtimeMode: false,
  voiceMuted: false,
  // F1 fix, AltGr: only LEFT Alt participates in the hotkey (Right Alt =
  // AltGr on international layouts), so say so.
  hotkeyLabel: 'Ctrl+Alt (left alt)',
  buddyRest: null,
  // M17: default to signed-out until main populates the snapshot from the
  // Codex auth provider.
  codexSignedIn: false,
  codexValid: false,
  codexPlanType: '',
  preferApiKeyGrounding: false,
  computerUseEnabled: false,
};

/**
 * Settings keys a patch copies verbatim when present. The write-only `apiKey`
 * is deliberately NOT here — it maps onto the presence flags in
 * `applySettingsPatch` instead. The M17 codex* sign-in fields are main-owned
 * (populated from the Codex auth provider, not patchable from the renderer) —
 * they carry through unchanged because they never appear in this table.
 */
export const PATCHABLE_KEYS = [
  'model',
  'voice',
  'captionsEnabled',
  'micDeviceId',
  'fullRealtimeMode',
  'voiceMuted',
  'buddyRest',
  'preferApiKeyGrounding',
  'computerUseEnabled',
] as const satisfies readonly Exclude<keyof SettingsPatch, 'apiKey'>[];

type PatchableKey = (typeof PATCHABLE_KEYS)[number];

/**
 * Pure merge of a patch onto a renderer-safe settings object.
 * (`apiKey` affects only the presence flags here; encryption happens in main.)
 */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...current };
  for (const key of PATCHABLE_KEYS) {
    copyIfPresent(next, patch, key);
  }
  // M11: storing (or clearing) a key always resolves an unreadable blob.
  if (patch.apiKey !== undefined) {
    next.apiKeyPresent = patch.apiKey !== null;
    next.apiKeyUnreadable = false;
  }
  return next;
}

/** Copy one patchable field onto the target when present (undefined = untouched). */
function copyIfPresent<K extends PatchableKey>(
  target: Pick<Settings, PatchableKey>,
  patch: Partial<Pick<Settings, PatchableKey>>,
  key: K,
): void {
  const value = patch[key];
  if (value !== undefined) {
    target[key] = value;
  }
}

// ---------------------------------------------------------------------------
// M17: Codex ChatGPT-subscription auth
// ---------------------------------------------------------------------------

/**
 * Renderer-safe sign-in snapshot for the ChatGPT-subscription (Codex CLI)
 * grounding path. NEVER carries a token — only booleans, the plan label, and
 * the best-available token's expiry. This is the exact shape main pushes to
 * the panel over `panel:codex-signin` (and returns from `codex:signin-state`).
 * The main-side auth module (`src/main/auth/codex-auth.ts`) produces it and
 * re-exports this type for its own consumers.
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

/** Result of the `codex:sign-in` invoke (system-browser PKCE sign-in flow). */
export type SignInResult = { ok: true } | { ok: false; error: string };
