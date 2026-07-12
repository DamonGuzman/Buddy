/**
 * Typed subset of the OpenAI Realtime API (v1 GA, WebSocket) that Clicky
 * speaks (docs/ARCHITECTURE.md §7). The mock server in tools/mock-realtime
 * implements exactly this subset.
 */

// ---------------------------------------------------------------------------
// Client -> server events
// ---------------------------------------------------------------------------

export interface SessionUpdateEvent {
  type: 'session.update';
  session: {
    type: 'realtime';
    instructions?: string;
    output_modalities?: ['audio'];
    audio?: {
      input?: { format: { type: 'audio/pcm'; rate: 24000 }; turn_detection: null };
      output?: { format: { type: 'audio/pcm'; rate: 24000 }; voice?: string };
    };
    tools?: ToolDefinition[];
  };
}

export interface InputAudioBufferAppendEvent {
  type: 'input_audio_buffer.append';
  /** base64 PCM16 (24kHz mono). */
  audio: string;
}

export interface InputAudioBufferCommitEvent {
  type: 'input_audio_buffer.commit';
}

export interface InputAudioBufferClearEvent {
  type: 'input_audio_buffer.clear';
}

export type ContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string };

export interface ConversationItemCreateEvent {
  type: 'conversation.item.create';
  item:
    | { type: 'message'; role: 'user' | 'system'; content: ContentPart[] }
    | { type: 'function_call_output'; call_id: string; output: string };
}

export interface ResponseCreateEvent {
  type: 'response.create';
}

export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | InputAudioBufferCommitEvent
  | InputAudioBufferClearEvent
  | ConversationItemCreateEvent
  | ResponseCreateEvent;

// ---------------------------------------------------------------------------
// Server -> client events
// ---------------------------------------------------------------------------

export interface SessionCreatedEvent {
  type: 'session.created';
  session: { id: string };
}

export interface SessionUpdatedEvent {
  type: 'session.updated';
}

export interface ResponseOutputAudioDeltaEvent {
  type: 'response.output_audio.delta';
  response_id: string;
  item_id: string;
  /** base64 PCM16 (24kHz mono). */
  delta: string;
}

export interface ResponseOutputAudioTranscriptDeltaEvent {
  type: 'response.output_audio_transcript.delta';
  response_id: string;
  item_id: string;
  delta: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done';
  response_id: string;
  item_id: string;
  call_id: string;
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

export interface ResponseDoneEvent {
  type: 'response.done';
  response: { id: string; status: 'completed' | 'cancelled' | 'failed' | 'incomplete' };
}

export interface ErrorEvent {
  type: 'error';
  error: { type: string; code?: string; message: string };
}

export type ServerEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | ResponseOutputAudioDeltaEvent
  | ResponseOutputAudioTranscriptDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseDoneEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** Arguments of the `point_at` tool call (screenshot pixel space, §6). */
export interface PointAtArgs {
  screenIndex: number;
  points: Array<{ x: number; y: number; label?: string }>;
}

/** Parse server event JSON; returns null for unknown/malformed frames. */
export function parseServerEvent(raw: string): ServerEvent | null {
  try {
    const evt = JSON.parse(raw) as { type?: unknown };
    if (typeof evt.type !== 'string') return null;
    return evt as ServerEvent;
  } catch {
    return null;
  }
}
