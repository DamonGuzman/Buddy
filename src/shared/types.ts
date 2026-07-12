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

/** The renderer-safe defaults. */
export const DEFAULT_SETTINGS: Settings = {
  apiKeyPresent: false,
  // M8.6 (orchestrator-approved): default to the full model — the live
  // pointing eval (docs/EVAL.md §8) showed mini's coordinate estimation is
  // far less accurate (0-13% strict vs full's 33-47%). mini remains
  // selectable in settings as the faster/cheaper option.
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  captionsEnabled: true,
  micDeviceId: '',
  // F1 fix (orchestrator-approved), AltGr: only LEFT Alt participates in the
  // hotkey (Right Alt = AltGr on international layouts), so say so.
  hotkeyLabel: 'Ctrl+Alt (left alt)',
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
  /**
   * F1 fix (orchestrator-approved), M2: main-owned playback epoch of the
   * response this delta belongs to. The renderer drops any delta whose epoch
   * is older than the newest 'audio:playback' flush epoch — this silences a
   * cancelled response whose first chunk never reached the renderer (no
   * itemId to mark stale). Absent on dev/QA tones (always played).
   */
  epoch?: number;
}

export type PlaybackCommand = 'stop' | 'flush';

/** M5 addition (orchestrator-approved): push-to-talk mic capture command. */
export type CaptureCommand = 'start' | 'stop';

/**
 * M8.5 addition (orchestrator-approved): per-item playback stats reported by
 * the panel renderer's player worklet — proof that model audio was actually
 * scheduled into the output device, not just queued.
 */
export interface PlaybackStatsUpdate {
  /** Response item this audio belongs to. */
  itemId: string;
  /** Samples actually rendered to the output so far (24kHz mono). */
  samplesPlayed: number;
  /** RMS (0..1) over all samples played so far for this item. */
  rms: number;
  /** Peak |sample| (0..1) seen so far for this item. */
  peak: number;
  /** Silence gaps mid-item that later resumed (queue starvation). */
  underruns: number;
  /** Epoch ms when the first sample of this item hit the output. */
  firstPlayedAt: number;
  /** Final update: item drained, was superseded, or was cleared (barge-in). */
  done: boolean;
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Turn timings (M8.5 addition, orchestrator-approved — audio-experience eval)
// ---------------------------------------------------------------------------

/**
 * Per-turn latency instrumentation collected by the conversation orchestrator.
 * All `t*` fields are epoch ms; optional fields stay absent until (unless)
 * the corresponding event happens for the turn.
 */
export interface TurnTimings {
  turnId: string;
  kind: 'voice' | 'text';
  /** Voice: hotkey went down. */
  tHoldStart?: number;
  /** Voice: hotkey released (== the "ask" moment for voice turns). */
  tHoldEnd?: number;
  /** Text: /ask (or panel composer) submitted. */
  tAsk?: number;
  /** Screenshot capture for this turn finished. */
  tCaptureDone?: number;
  /** Capture duration: tCaptureDone minus the capture kick-off. */
  captureMs?: number;
  /** input_audio_buffer.commit / conversation.item.create sent to the server. */
  tCommitSent?: number;
  /** First ASR transcript of the user's audio arrived. */
  tFirstUserTranscript?: number;
  /** First assistant transcript delta arrived. */
  tFirstAssistantTranscript?: number;
  /** First model audio delta arrived from the server. */
  tFirstAudioDelta?: number;
  /** First sample of the response actually rendered to the output device. */
  tFirstAudioPlayed?: number;
  /** First tool call (point_at) of the response arrived. */
  tFirstToolCall?: number;
  /** Final response.done for the turn (after tool continuations). */
  tResponseDone?: number;
  /** Mic chunks appended during this turn's hold. */
  chunksIn: number;
  /** Model audio chunks received for this turn. */
  chunksOut: number;
  /** Barge-in: cancel requested -> playback actually stopped (ms). */
  bargeInStopMs?: number;
  /**
   * M8.5 live eval: token usage summed over every response.done of the turn
   * (a tool-call continuation is a second response). Absent until the first
   * response.done that carries a usage block (the mock sends none).
   */
  usage?: TurnUsage;
}

/** Accumulated token usage for one turn (from response.done usage blocks). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  inputImageTokens: number;
  cachedTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  /** Number of response.done events accumulated. */
  responses: number;
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
  // M6 additions (integration-approved): pipeline observability.
  /** Last pointer command routed to the overlays (mapped, overlay-local DIP). */
  lastPointer: PointerCommand | null;
  /** Recent pointer commands, oldest first (capped). */
  pointerHistory: PointerCommand[];
  /** Mic chunks received from the panel / audio chunks sent to playback. */
  audio: { chunksIn: number; chunksOut: number };
  /** Whether the "capture in progress" indicator is currently shown. */
  captureIndicatorActive: boolean;
  // M8.5 additions (orchestrator-approved): audio-experience eval.
  /** Timings of the most recent turn (may still be updating). */
  lastTurnTimings: TurnTimings | null;
  /** Recent turn timings, oldest first (capped at 20). */
  turnTimingsHistory: TurnTimings[];
}
