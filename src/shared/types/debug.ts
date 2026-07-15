/**
 * Assistant / session state (mirrored to both renderers), the panel
 * transcript, runtime flags, and the CLICKY_DEBUG=1 debug-server state dump.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

import type { CaptureMeta } from './capture';
import type { GroundingAttribution, PointerCommand } from './pointer';
import type { TurnTimings } from './timings';

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
// Runtime flags / debug state
// ---------------------------------------------------------------------------

/**
 * M11: main-computed runtime flags for the panel — whether the global
 * push-to-talk keyboard hook is alive (the hero hint adapts when it is not),
 * and which CLICKY_* dev/QA env flags are set for this run (besides
 * CLICKY_DEBUG), shown as a dev chip in the header.
 */
export interface RuntimeFlags {
  hookAlive: boolean;
  /** Short flag names, CLICKY_ prefix stripped, lowercase (e.g. 'mock_url'). */
  devFlags: string[];
}

/** CLICKY_DEBUG=1 HTTP server state dump. */
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
  // M6: pipeline observability.
  /** Last pointer command routed to the overlays (mapped, overlay-local DIP). */
  lastPointer: PointerCommand | null;
  /** Recent pointer commands, oldest first (capped). */
  pointerHistory: PointerCommand[];
  /** Mic chunks received from the panel / audio chunks sent to playback. */
  audio: { chunksIn: number; chunksOut: number };
  /** Whether the "capture in progress" indicator is currently shown. */
  captureIndicatorActive: boolean;
  // M8.5: audio-experience eval.
  /** Timings of the most recent turn (may still be updating). */
  lastTurnTimings: TurnTimings | null;
  /** Recent turn timings, oldest first (capped at 20). */
  turnTimingsHistory: TurnTimings[];
  // M17: grounding-auth attribution for the last pointer — which transport
  // ran (backend 'codex' when the ChatGPT sub grounded) and whether the plan
  // quota was hit (fail-closed). Null until a grounding call has been
  // attempted. Merged in via conversation.debugInfo().
  lastGrounding: GroundingAttribution | null;
}
