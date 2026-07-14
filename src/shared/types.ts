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
  /**
   * M11 addition (orchestrator-approved): the stored key blob exists but
   * DPAPI can no longer decrypt it (windows credentials changed). The
   * settings UI should prompt for a re-paste; pasting a new key clears it.
   */
  apiKeyUnreadable: boolean;
  model: ModelId;
  voice: string;
  captionsEnabled: boolean;
  /** Preferred microphone deviceId ('' = system default). */
  micDeviceId: string;
  /** Opt-in open-mic mode; the hotkey toggles a server-VAD session on/off. */
  fullRealtimeMode: boolean;
  /** Display string for the hotkey (fixed for MVP). */
  hotkeyLabel: string;
  // M15 addition (orchestrator-approved): user-defined buddy rest position
  // (set by drag-repositioning the buddy). null = default corner on primary.
  buddyRest: BuddyRest | null;
  // M17 additions (integration-approved): ChatGPT-subscription (Codex CLI)
  // sign-in snapshot, surfaced READ-ONLY to the panel so the settings view can
  // show whether clicky can ground through the user's ChatGPT plan. Populated
  // by main from the Codex auth provider (`~/.codex/auth.json`); these are NOT
  // patchable from the renderer (no SettingsPatch fields) and NEVER carry a
  // token — only booleans + the plan label.
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
  // M15 addition (orchestrator-approved): null resets to the default corner.
  buddyRest?: BuddyRest | null;
  preferApiKeyGrounding?: boolean;
  computerUseEnabled?: boolean;
}

/** The renderer-safe defaults. */
export const DEFAULT_SETTINGS: Settings = {
  apiKeyPresent: false,
  apiKeyUnreadable: false,
  // M8.6 (orchestrator-approved): default to the full model — the live
  // pointing eval (docs/EVAL.md §8) showed mini's coordinate estimation is
  // far less accurate (0-13% strict vs full's 33-47%). mini remains
  // selectable in settings as the faster/cheaper option.
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  captionsEnabled: true,
  micDeviceId: '',
  fullRealtimeMode: false,
  // F1 fix (orchestrator-approved), AltGr: only LEFT Alt participates in the
  // hotkey (Right Alt = AltGr on international layouts), so say so.
  hotkeyLabel: 'Ctrl+Alt (left alt)',
  // M15 addition (orchestrator-approved).
  buddyRest: null,
  // M17 additions (integration-approved): default to signed-out until main
  // populates the snapshot from the Codex auth provider.
  codexSignedIn: false,
  codexValid: false,
  codexPlanType: '',
  preferApiKeyGrounding: false,
  computerUseEnabled: false,
};

/**
 * Pure merge of a patch onto a renderer-safe settings object.
 * (`apiKey` affects only the presence flag here; encryption happens in main.)
 */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return {
    // M17: the codex* sign-in fields are main-owned (populated from the Codex
    // auth provider, not patchable from the renderer) — they carry through
    // unchanged via this spread.
    ...current,
    preferApiKeyGrounding: patch.preferApiKeyGrounding ?? current.preferApiKeyGrounding,
    computerUseEnabled: patch.computerUseEnabled ?? current.computerUseEnabled,
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
    ...(patch.captionsEnabled !== undefined ? { captionsEnabled: patch.captionsEnabled } : {}),
    ...(patch.micDeviceId !== undefined ? { micDeviceId: patch.micDeviceId } : {}),
    ...(patch.fullRealtimeMode !== undefined ? { fullRealtimeMode: patch.fullRealtimeMode } : {}),
    // M11: storing (or clearing) a key always resolves an unreadable blob.
    ...(patch.apiKey !== undefined
      ? { apiKeyPresent: patch.apiKey !== null, apiKeyUnreadable: false }
      : {}),
    // M15 addition (orchestrator-approved).
    ...(patch.buddyRest !== undefined ? { buddyRest: patch.buddyRest } : {}),
  };
}

// ---------------------------------------------------------------------------
// M17 additions (integration-approved): Codex ChatGPT-subscription auth
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

// ---------------------------------------------------------------------------
// M15 additions (orchestrator-approved): buddy hover / dwell / rest position
// ---------------------------------------------------------------------------

/**
 * User-defined buddy rest position, persisted in settings after a
 * drag-reposition. Fractions of the hosting display's overlay-window size
 * (window-local DIP / innerWidth|innerHeight) so the spot survives display
 * resolution changes; re-snapped to edge margins on restore.
 */
export interface BuddyRest {
  /** screenIndex (capture-labeling order) of the hosting display. */
  screenIndex: number;
  xFrac: number;
  yFrac: number;
}

/** Main -> overlay hover configuration (pushed on load and settings change). */
export interface OverlayHoverConfig {
  /** Display string for the push-to-talk hotkey (Settings.hotkeyLabel). */
  hotkeyLabel: string;
  /** Whether the hotkey toggles an open-mic Realtime session. */
  fullRealtimeMode: boolean;
  /**
   * Rest fraction for THIS overlay when it hosts the buddy at rest;
   * null = default bottom-right corner.
   */
  rest: { xFrac: number; yFrac: number } | null;
}

/** Renderer hover-machine snapshot, reported on transitions (debug/QA). */
export interface OverlayHoverStatus {
  zone: 'far' | 'aware' | 'hover';
  hint: boolean;
  dragging: boolean;
  /** Buddy center, window-local DIP. */
  buddy: { x: number; y: number };
}

/**
 * Renderer -> main hover event.
 * - 'dwell': cursor dwelled in the buddy footprint; make this overlay
 *   interactive while the cursor stays inside `region` (also sent as a
 *   region refresh while dragging).
 * - 'exit': cursor left the padded region; RESTORE CLICK-THROUGH NOW
 *   (safety-critical: the user's clicks elsewhere must never be eaten).
 * - 'status': debug/QA snapshot on hover-state transitions.
 */
export interface OverlayHoverEvent {
  kind: 'dwell' | 'exit' | 'status';
  /** Padded buddy region, window-local DIP (present on 'dwell'). */
  region?: Rect;
  /** Present on 'status'. */
  status?: OverlayHoverStatus;
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

/**
 * M9 addition (orchestrator-approved): element-snap grounding attribution.
 * Recorded on pointer commands so the eval can attribute hits to the raw
 * model point vs the UIA-snapped element (docs/EVAL.md §9).
 */
export interface PointerSnapInfo {
  /** The model's own point after §6 mapping, global DIP (pre-snap). */
  rawPoint: { x: number; y: number };
  /** Center of the matched UIA element, global DIP — null when no match. */
  snappedPoint: { x: number; y: number } | null;
  /** Label↔Name text-similarity score of the match (0..1), null when none. */
  snapScore: number | null;
  /** UIA Name of the matched element, null when none. */
  snapName: string | null;
  /** Wall time spent querying the snapper (incl. timeout fallbacks). */
  snapMs: number;
  /** Candidates the snapper enumerated (diagnosis). */
  candidates?: number;
}

/** Command from main driving the buddy pointer on one overlay. */
export type PointerCommand =
  | {
      type: 'animate';
      /** Points in overlay-window-local DIP coordinates (already mapped by coords.ts). */
      points: PointerPoint[];
      screenIndex: number;
      /** M9: grounding attribution (absent when snapping was skipped). */
      snap?: PointerSnapInfo;
      /**
       * M10: which grounding layer produced the final point (layered
       * pipeline: UIA snap -> REST grounding -> raw model point).
       */
      groundingSource?: 'uia' | 'rest' | 'raw';
      /** M10: true when a REST grounding call was attempted for this pointer. */
      restUsed?: boolean;
      /** M10: wall time of the REST grounding call, ms (present when attempted). */
      restMs?: number;
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

/**
 * M11 addition (orchestrator-approved): an audio device failure reported by
 * the panel renderer — mic capture failed to start ('mic') or the playback
 * worklet/context failed to initialize ('playback'). Main classifies these
 * into mic_unavailable / audio_output_failed catalog entries.
 */
export interface AudioDeviceError {
  source: 'mic' | 'playback';
  /** DOMException name when available (e.g. 'NotAllowedError'), else 'Error'. */
  name: string;
  message: string;
}

/**
 * M11 addition (orchestrator-approved): main-computed runtime flags for the
 * panel — whether the global push-to-talk keyboard hook is alive (the hero
 * hint adapts when it is not), and which CLICKY_* dev/QA env flags are set
 * for this run (besides CLICKY_DEBUG), shown as a dev chip in the header.
 */
export interface RuntimeFlags {
  hookAlive: boolean;
  /** Short flag names, CLICKY_ prefix stripped, lowercase (e.g. 'mock_url'). */
  devFlags: string[];
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
  /**
   * M9: the pointer command actually reached the overlays (after the async
   * element-snap query). The eval must gate on this, not tFirstToolCall.
   */
  tPointerDispatched?: number;
  /** M9: wall time the first snap query of the turn took (incl. fallback). */
  snapMs?: number;
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
// M17 additions (integration-approved): grounding-auth attribution
// ---------------------------------------------------------------------------

/**
 * Which grounding TRANSPORT actually ran for a pointer: the ChatGPT
 * subscription ('codex' = the codex-sub / gpt-5.6-sol path), the metered
 * platform key ('apiKey' = gpt-5.4-mini), or neither ('none' = UIA snap alone,
 * skipped, or no auth). Mirrors `GroundSource` in main's rest-grounder — the
 * renderer-safe copy so `DebugState` can carry it without a main-side import.
 */
export type GroundingBackend = 'apiKey' | 'codex' | 'none';

/**
 * ChatGPT-plan rate-limit telemetry parsed from the `x-codex-*-used-percent`
 * response headers (renderer-safe copy of main's rest-grounder shape). A field
 * is null when its header was absent/unparsable.
 */
export interface CodexUsedPercent {
  /** Primary (short) window used %, 0..100. */
  primary: number | null;
  /** Secondary (long / weekly) window used %, 0..100. */
  secondary: number | null;
}

/**
 * Grounding-auth attribution for the most recent pointer, surfaced on
 * `DebugState.lastGrounding`. `backend` names the transport that ran; `source`
 * is the layer that produced the final point (UIA snap / REST re-ground / raw
 * model point); `quotaExhausted` is the FAIL-CLOSED signal (the ChatGPT plan
 * quota was hit and the metered key was NOT spent for that call).
 */
export interface GroundingAttribution {
  backend: GroundingBackend;
  source: 'uia' | 'rest' | 'raw';
  quotaExhausted: boolean;
  usedPercent: CodexUsedPercent | null;
}

// ---------------------------------------------------------------------------
// M18 additions (integration-approved): agent mode (docs/AGENT-MODE.md)
// ---------------------------------------------------------------------------

/** Lifecycle of one background agent (docs/AGENT-MODE.md §2.4, §5.3). */
export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'timed_out' | 'cancelled';

/** One activity-log line on the agent Card (docs/AGENT-MODE.md §5.2). */
export interface AgentStep {
  kind: 'search' | 'fetch' | 'note' | 'think';
  /** e.g. 'searched "best 27 inch monitor 2026"', 'read rtings.com/…'. */
  label: string;
  /** Epoch ms. */
  at: number;
}

/**
 * Renderer-safe agent record — the ONLY agent shape that crosses to the panel
 * (over `panel:agents` / `agents:list`). Screenshot bytes and the raw brief
 * NEVER cross; they stay in main's internal AgentBrief (src/main/agents).
 */
export interface AgentSummary {
  id: string;
  task: string;
  status: AgentStatus;
  createdAt: number;
  finishedAt?: number;
  /** Current loop round while running (1-based). */
  step?: number;
  /** Tool-round ceiling, or null when the agent may continue until stopped or timed out. */
  maxSteps: number | null;
  /** Capped activity log (cap 30, oldest dropped). */
  steps: AgentStep[];
  /** Short recap — also the text voice speaks. */
  summary?: string;
  /** Full findings (scratchpad, light markdown). */
  output?: string;
  /** Urls (fetched + citations), deduped. */
  sources?: string[];
  /** Lowercase catalog copy when failed. */
  error?: string;
  /** Has voice delivered it yet (at-most-once spoken delivery). */
  spoken: boolean;
  /** Panel badge: finished but not yet viewed. */
  unseen: boolean;
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
  // M17 addition (integration-approved): grounding-auth attribution for the
  // last pointer — which transport ran (backend 'codex' when the ChatGPT sub
  // grounded) and whether the plan quota was hit (fail-closed). Null until a
  // grounding call has been attempted. Merged in via conversation.debugInfo().
  lastGrounding: GroundingAttribution | null;
}
