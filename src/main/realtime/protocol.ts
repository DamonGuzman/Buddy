/**
 * Typed subset of the OpenAI Realtime API (GA v1, WebSocket) that Buddy
 * speaks (docs/ARCHITECTURE.md §7). The mock server in tools/mock-realtime
 * implements exactly this subset.
 *
 * Event names and payload shapes verified against the official reference at
 * developers.openai.com/api/reference/resources/realtime/client-events and
 * .../server-events (fetched 2026-07-11). Where the API is loose or we don't
 * consume a field, types stay honest with `unknown` passthrough.
 */

import type { CaptureMeta } from '../../shared/types';

// ---------------------------------------------------------------------------
// Session config (client -> server, inside session.update)
// ---------------------------------------------------------------------------

/** The only audio format Buddy uses: PCM16 mono @ 24kHz, both directions. */
export interface AudioPcmFormat {
  type: 'audio/pcm';
  rate: 24000;
}

export interface RealtimeFunctionTool {
  type: 'function';
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ServerVadTurnDetection {
  type: 'server_vad';
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  create_response: boolean;
  interrupt_response: true;
}

/** Reasoning effort supported by reasoning-capable Realtime models. */
export type RealtimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** GA `session` object for `session.update` (type: 'realtime' sessions). */
export interface RealtimeSessionConfig {
  type: 'realtime';
  instructions?: string;
  output_modalities?: Array<'audio' | 'text'>;
  reasoning?: { effort: RealtimeReasoningEffort };
  audio?: {
    input?: {
      format?: AudioPcmFormat;
      /** Async input transcription (separate ASR model), enabled for captions. */
      transcription?: { model: string; language?: string } | null;
      /** Push-to-talk: always null — the client commits manually. */
      turn_detection?: null | ServerVadTurnDetection;
    };
    output?: {
      format?: AudioPcmFormat;
      voice?: string;
      speed?: number;
    };
  };
  tools?: RealtimeFunctionTool[];
}

// ---------------------------------------------------------------------------
// Client -> server events
// ---------------------------------------------------------------------------

export interface SessionUpdateEvent {
  type: 'session.update';
  event_id?: string;
  session: RealtimeSessionConfig;
}

export interface InputAudioBufferAppendEvent {
  type: 'input_audio_buffer.append';
  event_id?: string;
  /** base64 PCM16 (24kHz mono). Max 15 MiB per event. */
  audio: string;
}

export interface InputAudioBufferCommitEvent {
  type: 'input_audio_buffer.commit';
  event_id?: string;
}

export interface InputAudioBufferClearEvent {
  type: 'input_audio_buffer.clear';
  event_id?: string;
}

/** Content parts of a user message item. */
export type UserContentPart =
  | { type: 'input_text'; text: string }
  | {
      /** `image_url` is a data URI (data:image/jpeg;base64,...) or https URL. */
      type: 'input_image';
      image_url: string;
      detail?: 'auto' | 'low' | 'high';
    };

export type ConversationItem =
  | { type: 'message'; role: 'user'; content: UserContentPart[] }
  | { type: 'message'; role: 'system'; content: Array<{ type: 'input_text'; text: string }> }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ConversationItemCreateEvent {
  type: 'conversation.item.create';
  event_id?: string;
  previous_item_id?: string;
  item: ConversationItem;
}

export interface ResponseCreateEvent {
  type: 'response.create';
  event_id?: string;
  /** Optional per-response overrides; Buddy doesn't use them. */
  response?: Record<string, unknown>;
}

export interface ResponseCancelEvent {
  type: 'response.cancel';
  event_id?: string;
  response_id?: string;
}

export interface ConversationItemTruncateEvent {
  type: 'conversation.item.truncate';
  event_id?: string;
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | InputAudioBufferCommitEvent
  | InputAudioBufferClearEvent
  | ConversationItemCreateEvent
  | ConversationItemTruncateEvent
  | ResponseCreateEvent
  | ResponseCancelEvent;

// ---------------------------------------------------------------------------
// Server -> client events
// ---------------------------------------------------------------------------

/** Usage block on response.done (all fields optional in practice). */
export interface ResponseUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    cached_tokens?: number;
    [k: string]: unknown;
  };
  output_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export type ResponseStatus = 'completed' | 'cancelled' | 'failed' | 'incomplete' | 'in_progress';

/** The RealtimeResponse resource (audio omitted; output items untyped). */
export interface RealtimeResponse {
  id?: string;
  status?: ResponseStatus;
  status_details?: unknown;
  output?: unknown[];
  usage?: ResponseUsage;
  [k: string]: unknown;
}

export interface SessionCreatedEvent {
  type: 'session.created';
  event_id?: string;
  session: { id?: string; [k: string]: unknown };
}

export interface SessionUpdatedEvent {
  type: 'session.updated';
  event_id?: string;
  session?: Record<string, unknown>;
}

/** Async ASR transcript of the user's committed audio (may arrive any time). */
export interface InputAudioTranscriptionCompletedEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  event_id?: string;
  item_id: string;
  content_index?: number;
  transcript: string;
  usage?: unknown;
}

export interface InputAudioBufferSpeechStartedEvent {
  type: 'input_audio_buffer.speech_started';
  event_id?: string;
  item_id: string;
  audio_start_ms?: number;
}

export interface InputAudioBufferSpeechStoppedEvent {
  type: 'input_audio_buffer.speech_stopped';
  event_id?: string;
  item_id: string;
  audio_end_ms?: number;
}

export interface InputAudioBufferCommittedEvent {
  type: 'input_audio_buffer.committed';
  event_id?: string;
  item_id: string;
  previous_item_id?: string | null;
}

export interface ResponseCreatedEvent {
  type: 'response.created';
  event_id?: string;
  response?: RealtimeResponse;
}

/** Used to learn function name/call_id early; item is loosely typed. */
export interface ResponseOutputItemAddedEvent {
  type: 'response.output_item.added';
  event_id?: string;
  response_id?: string;
  output_index?: number;
  item: { type?: string; id?: string; name?: string; call_id?: string; [k: string]: unknown };
}

export interface ResponseOutputAudioDeltaEvent {
  type: 'response.output_audio.delta';
  event_id?: string;
  response_id?: string;
  item_id: string;
  output_index?: number;
  content_index?: number;
  /** base64 PCM16 (24kHz mono). */
  delta: string;
}

export interface ResponseOutputAudioDoneEvent {
  type: 'response.output_audio.done';
  event_id?: string;
  response_id?: string;
  item_id: string;
  output_index?: number;
  content_index?: number;
}

export interface ResponseOutputAudioTranscriptDeltaEvent {
  type: 'response.output_audio_transcript.delta';
  event_id?: string;
  response_id?: string;
  item_id: string;
  output_index?: number;
  content_index?: number;
  delta: string;
}

export interface ResponseOutputAudioTranscriptDoneEvent {
  type: 'response.output_audio_transcript.done';
  event_id?: string;
  response_id?: string;
  item_id: string;
  output_index?: number;
  content_index?: number;
  transcript?: string;
}

/** Defensive: only sent when output_modalities includes 'text'. */
export interface ResponseOutputTextDeltaEvent {
  type: 'response.output_text.delta';
  event_id?: string;
  response_id?: string;
  item_id: string;
  output_index?: number;
  content_index?: number;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta';
  event_id?: string;
  response_id?: string;
  item_id?: string;
  output_index?: number;
  call_id: string;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done';
  event_id?: string;
  response_id?: string;
  item_id?: string;
  output_index?: number;
  call_id: string;
  /** Function name (per GA docs, present on done). */
  name: string;
  /** The final arguments as a JSON string. */
  arguments: string;
}

export interface ResponseDoneEvent {
  type: 'response.done';
  event_id?: string;
  response: RealtimeResponse;
}

export interface RealtimeErrorEvent {
  type: 'error';
  event_id?: string;
  error: {
    /** e.g. 'invalid_request_error', 'server_error'. */
    type?: string;
    code?: string | null;
    message: string;
    param?: string | null;
    event_id?: string | null;
  };
}

export interface RateLimitsUpdatedEvent {
  type: 'rate_limits.updated';
  event_id?: string;
  rate_limits: Array<{
    name?: string;
    limit?: number;
    remaining?: number;
    reset_seconds?: number;
  }>;
}

export type ServerEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | InputAudioBufferSpeechStartedEvent
  | InputAudioBufferSpeechStoppedEvent
  | InputAudioBufferCommittedEvent
  | InputAudioTranscriptionCompletedEvent
  | ResponseCreatedEvent
  | ResponseOutputItemAddedEvent
  | ResponseOutputAudioDeltaEvent
  | ResponseOutputAudioDoneEvent
  | ResponseOutputAudioTranscriptDeltaEvent
  | ResponseOutputAudioTranscriptDoneEvent
  | ResponseOutputTextDeltaEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseDoneEvent
  | RealtimeErrorEvent
  | RateLimitsUpdatedEvent;

/**
 * A well-formed server frame whose `type` is outside the subset above. The
 * payload passes through untouched — the session ignores it, logging once
 * per type.
 */
export interface UnknownServerEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Exhaustiveness guard: `Record<ServerEvent['type'], true>` forces this map
 * to list EXACTLY the union's discriminants — adding a ServerEvent member
 * without registering its type here is a compile error, and vice versa.
 */
const SERVER_EVENT_TYPES: Record<ServerEvent['type'], true> = {
  'session.created': true,
  'session.updated': true,
  'input_audio_buffer.speech_started': true,
  'input_audio_buffer.speech_stopped': true,
  'input_audio_buffer.committed': true,
  'conversation.item.input_audio_transcription.completed': true,
  'response.created': true,
  'response.output_item.added': true,
  'response.output_audio.delta': true,
  'response.output_audio.done': true,
  'response.output_audio_transcript.delta': true,
  'response.output_audio_transcript.done': true,
  'response.output_text.delta': true,
  'response.function_call_arguments.delta': true,
  'response.function_call_arguments.done': true,
  'response.done': true,
  error: true,
  'rate_limits.updated': true,
};

const KNOWN_SERVER_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(SERVER_EVENT_TYPES));

/** Narrow a parsed frame to the typed subset the session's switch handles. */
export function isKnownServerEvent(evt: ServerEvent | UnknownServerEvent): evt is ServerEvent {
  return KNOWN_SERVER_EVENT_TYPES.has(evt.type);
}

/**
 * Parse a server frame. Returns null for malformed JSON / missing type.
 * Unknown event types are returned as-is (see UnknownServerEvent) — use
 * isKnownServerEvent() to narrow to the typed subset.
 */
export function parseServerEvent(raw: string): ServerEvent | UnknownServerEvent | null {
  try {
    const evt = JSON.parse(raw) as { type?: unknown };
    if (evt === null || typeof evt !== 'object' || typeof evt.type !== 'string') return null;
    return evt as ServerEvent | UnknownServerEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// point_at tool arguments
// ---------------------------------------------------------------------------

/**
 * Arguments of the `point_at` tool call: pixel coords in the screenshot of
 * screen `screen` (docs/ARCHITECTURE.md §6), plus a short human label.
 */
export interface PointAtArgs {
  x: number;
  y: number;
  label?: string;
  screen: number;
}

/**
 * Look up the capture for a model-named screen index. F1 fix (m2): captures
 * are KEYED by meta.screenIndex — a display can be skipped, so array position
 * is NOT the screen index. An unknown index falls back to the ACTIVE screen's
 * capture, then the first. Returns undefined only for an empty batch.
 */
export function findCaptureForScreen(
  metas: CaptureMeta[],
  screen: number,
): CaptureMeta | undefined {
  return metas.find((m) => m.screenIndex === screen) ?? metas.find((m) => m.isActive) ?? metas[0];
}

/**
 * Validate + clamp raw point_at arguments from the model.
 *
 * - x/y must be finite numbers; rounded to integers, clamped to >= 0 and,
 *   when `capture` metadata for that screen is known, to the image bounds.
 * - screen must be a finite number; rounded, clamped to >= 0, then validated
 *   against the actual screenIndex values present (findCaptureForScreen);
 *   an unknown index falls back to the ACTIVE screen's capture (matching the
 *   conversation's lookup).
 * - label is kept only if it's a non-empty string (trimmed, capped at 120).
 *
 * Returns null for fundamentally malformed input (missing/non-numeric x, y
 * or screen) — the caller rejects the call rather than pointing at garbage.
 */
export function validatePointAtArgs(raw: unknown, capture?: CaptureMeta[]): PointAtArgs | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const xNum = toFiniteNumber(obj['x']);
  const yNum = toFiniteNumber(obj['y']);
  const screenNum = toFiniteNumber(obj['screen']);
  if (xNum === null || yNum === null || screenNum === null) return null;

  let screen = Math.max(0, Math.round(screenNum));
  const meta = capture !== undefined ? findCaptureForScreen(capture, screen) : undefined;
  // Unknown screen index: explicit fallback to the active screen (m2).
  if (meta !== undefined && meta.screenIndex !== screen) screen = meta.screenIndex;
  const maxX = meta ? Math.max(0, meta.imageW - 1) : Number.MAX_SAFE_INTEGER;
  const maxY = meta ? Math.max(0, meta.imageH - 1) : Number.MAX_SAFE_INTEGER;
  const x = Math.min(Math.max(0, Math.round(xNum)), maxX);
  const y = Math.min(Math.max(0, Math.round(yNum)), maxY);

  const rawLabel = obj['label'];
  const label =
    typeof rawLabel === 'string' && rawLabel.trim().length > 0
      ? rawLabel.trim().slice(0, 120)
      : undefined;

  return { x, y, screen, ...(label !== undefined ? { label } : {}) };
}

function toFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
