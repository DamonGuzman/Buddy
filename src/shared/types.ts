/**
 * Shared domain types for Clicky.
 *
 * This file is part of the frozen `src/shared/*` contract (see docs/ARCHITECTURE.md §5, §9).
 * Change only via integration/orchestrator-approved edits.
 */

// ---------------------------------------------------------------------------
// Assistant / session state
// ---------------------------------------------------------------------------

/** High-level state of the assistant, driven by main, mirrored to both renderers. */
export type AssistantState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export type SessionConnectionState = 'disconnected' | 'connecting' | 'ready' | 'error';

/** Status snapshot of the realtime session, shown in the panel. */
export interface SessionStatus {
  state: SessionConnectionState;
  /** Model id the session is (or will be) using. */
  model: string;
  /** True when CLICKY_MOCK_URL is in effect. */
  usingMockServer: boolean;
  /** Human-readable error, present only when state === 'error'. */
  error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ModelId = 'gpt-realtime-2.1-mini' | 'gpt-realtime-2.1';

/**
 * Renderer-safe settings view. The raw API key NEVER crosses into a renderer;
 * only its presence flag does.
 */
export interface Settings {
  /** Whether an API key is stored (encrypted via safeStorage). Never the key itself. */
  apiKeyPresent: boolean;
  model: ModelId;
  voice: string;
  captionsEnabled: boolean;
  /** Preferred microphone deviceId ('' = system default). */
  micDeviceId: string;
  /** Display string for the hotkey (fixed for MVP). */
  hotkeyLabel: string;
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
}

/** The renderer-safe defaults. `hotkeyLabel` mirrors constants.HOTKEY_LABEL. */
export const DEFAULT_SETTINGS: Settings = {
  apiKeyPresent: false,
  model: 'gpt-realtime-2.1-mini',
  voice: 'marin',
  captionsEnabled: true,
  micDeviceId: '',
  hotkeyLabel: 'Ctrl+Alt',
};

/**
 * Pure merge of a patch onto a renderer-safe settings object.
 * (`apiKey` affects only the presence flag here; encryption happens in main.)
 */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return {
    ...current,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
    ...(patch.captionsEnabled !== undefined ? { captionsEnabled: patch.captionsEnabled } : {}),
    ...(patch.micDeviceId !== undefined ? { micDeviceId: patch.micDeviceId } : {}),
    ...(patch.apiKey !== undefined ? { apiKeyPresent: patch.apiKey !== null } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capture / coordinates (docs/ARCHITECTURE.md §6)
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-display metadata produced by every capture. */
export interface CaptureMeta {
  /** Stable index for this capture batch; images are labeled screen0..N. */
  screenIndex: number;
  /** Electron display id. */
  displayId: number;
  /** Width of the (possibly resized) screenshot the model sees, in px. */
  imageW: number;
  /** Height of the (possibly resized) screenshot the model sees, in px. */
  imageH: number;
  /** Display bounds in DIP (global coordinate space). */
  displayBounds: Rect;
  /** Display scale factor (1, 1.5, 2, ...). */
  scaleFactor: number;
  /** Whether the cursor was on this display at capture time. */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Pointer / overlay
// ---------------------------------------------------------------------------

/** A point in screenshot pixel space (see coordinate contract §6), with optional label. */
export interface PointerPoint {
  x: number;
  y: number;
  label?: string;
}

/** Command from main driving the buddy pointer on one overlay. */
export type PointerCommand =
  | {
      type: 'animate';
      /** Points in overlay-window-local DIP coordinates (already mapped by coords.ts). */
      points: PointerPoint[];
      screenIndex: number;
    }
  | { type: 'idle' }
  | { type: 'hide' };

/** Streaming caption text (the spoken words) for the overlay bubble. */
export interface CaptionUpdate {
  /** Id of the response item this caption belongs to (resets the bubble on change). */
  itemId: string;
  /** Full text so far (not a delta) — simplifies renderer state. */
  text: string;
  done: boolean;
}

// ---------------------------------------------------------------------------
// Transcript (panel)
// ---------------------------------------------------------------------------

export type TranscriptRole = 'user' | 'assistant' | 'system';

export interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  /** Full text so far; updated in place while `streaming` is true. */
  text: string;
  streaming: boolean;
  /** Epoch ms. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/** A chunk of model audio output for the renderer playback queue. */
export interface AudioOutputDelta {
  /** Raw PCM16 (24kHz mono) bytes. */
  chunk: ArrayBuffer;
  /** Id of the response item, so stale chunks can be dropped after a flush. */
  itemId: string;
}

export type PlaybackCommand = 'stop' | 'flush';

export interface MicDevice {
  deviceId: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Debug (CLICKY_DEBUG=1 HTTP server state dump)
// ---------------------------------------------------------------------------

export interface DebugState {
  appVersion: string;
  assistantState: AssistantState;
  overlayWindowCount: number;
  panelVisible: boolean;
  hotkey: {
    hookAlive: boolean;
    holding: boolean;
    error?: string | undefined;
  };
  session: SessionStatus;
  lastCapture: CaptureMeta[] | null;
}
