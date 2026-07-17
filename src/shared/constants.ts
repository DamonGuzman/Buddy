/**
 * Shared constants for Buddy.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

// ---------------------------------------------------------------------------
// Debug harness
// ---------------------------------------------------------------------------

export const DEBUG_HOST = '127.0.0.1';
export const DEBUG_PORT = 8199;

// ---------------------------------------------------------------------------
// Environment variable names
// ---------------------------------------------------------------------------

/** ws:// URL of the mock Realtime server; overrides the OpenAI endpoint. */
export const ENV_MOCK_URL = 'CLICKY_MOCK_URL';
/** '1' enables the local debug HTTP server on DEBUG_PORT. */
export const ENV_DEBUG = 'CLICKY_DEBUG';

/**
 * True when a mock Realtime URL is configured (CLICKY_MOCK_URL set and
 * non-empty) — the shared semantics for every consumer (endpoint resolution,
 * REST-grounding skip, codex text gating). Defaults to `process.env` where a
 * Node `process` global exists.
 */
export function isMockMode(env?: Record<string, string | undefined>): boolean {
  const resolved =
    env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const url = resolved?.[ENV_MOCK_URL];
  return url !== undefined && url !== '';
}

// ---------------------------------------------------------------------------
// Audio format (both directions — docs/ARCHITECTURE.md §3, §7)
// ---------------------------------------------------------------------------

export const AUDIO_SAMPLE_RATE = 24_000;
/** Bytes per sample for pcm16. */
export const AUDIO_BYTES_PER_SAMPLE = 2;

// ---------------------------------------------------------------------------
// Models / voices
// ---------------------------------------------------------------------------

export const MODEL_IDS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'] as const;
/** M8.6: full model is the default — far better pointing accuracy (EVAL §8). */
export const DEFAULT_MODEL = 'gpt-realtime-2.1';
export const DEFAULT_VOICE = 'marin';

/** Default OpenAI Realtime WS endpoint (model appended as query param). */
export const REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime';

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Screenshots are resized so the longest edge is at most this many px.
 *
 * Tuning knob for pointing accuracy vs. latency/token cost. M8.6: raised
 * 1280 → 2048 after the live pointing eval (docs/EVAL.md §7-§8): at 1280 a
 * 4K display loses 2 DIP per image px, doubling every model localization
 * error and shrinking small UI elements below recognizability.
 */
export const CAPTURE_MAX_EDGE = 2048;
export const CAPTURE_JPEG_QUALITY = 80;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export const PANEL_WIDTH = 380;
export const PANEL_HEIGHT = 520;

// M20: the whisper — small floating composer summoned by a hotkey tap or a
// buddy click. Sized for a short reply stack + a one-line composer.
export const WHISPER_WIDTH = 340;
export const WHISPER_HEIGHT = 390;

export const APP_NAME = 'Buddy';
