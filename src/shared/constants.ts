/**
 * Shared constants for Clicky.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

// ---------------------------------------------------------------------------
// Hotkey (fixed for MVP)
// ---------------------------------------------------------------------------

/** Hold-to-talk combo: both modifiers held; release (either) = send. */
export const HOTKEY_LABEL = 'Ctrl+Alt';

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

/** Default port of tools/mock-realtime (ws://127.0.0.1:8123). */
export const MOCK_DEFAULT_PORT = 8123;

// ---------------------------------------------------------------------------
// Audio format (both directions — docs/ARCHITECTURE.md §3, §7)
// ---------------------------------------------------------------------------

export const AUDIO_SAMPLE_RATE = 24_000;
export const AUDIO_CHANNELS = 1;
export const AUDIO_FORMAT = 'pcm16' as const;
/** Bytes per sample for pcm16. */
export const AUDIO_BYTES_PER_SAMPLE = 2;

// ---------------------------------------------------------------------------
// Models / voices
// ---------------------------------------------------------------------------

export const MODEL_IDS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'] as const;
export const DEFAULT_MODEL = 'gpt-realtime-2.1-mini';
export const DEFAULT_VOICE = 'marin';

/** Default OpenAI Realtime WS endpoint (model appended as query param). */
export const REALTIME_BASE_URL = 'wss://api.openai.com/v1/realtime';

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** Screenshots are resized so the longest edge is at most this many px. */
export const CAPTURE_MAX_EDGE = 1280;
export const CAPTURE_JPEG_QUALITY = 80;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export const PANEL_WIDTH = 380;
export const PANEL_HEIGHT = 520;

export const APP_NAME = 'Clicky';
