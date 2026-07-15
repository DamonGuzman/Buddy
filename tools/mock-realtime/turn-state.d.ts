/**
 * Type declarations for tools/mock-realtime/turn-state.js — the pure per-turn
 * input accumulation used by server.js and keyed on by scenarios.js.
 */

/** Everything the client sent since the previous response.create. */
export interface Turn {
  /** input_text parts that are NOT the "context:" framing part. */
  userTexts: string[];
  /** The "context:" framing part, if any. */
  contextText: string;
  /** input_image parts attached. */
  imageCount: number;
  /** Parsed from "screen0 is WxH pixels" in the context part. */
  screen0: { w: number; h: number } | null;
  /** input_audio_buffer.commit happened this turn. */
  committedAudio: boolean;
  /** function_call_output items received this turn. */
  toolOutputs: Array<{ callId: string; output: string }>;
}

export function freshTurn(): Turn;

/**
 * Fold one `conversation.item.create` item into the turn (mutates `turn`).
 * Unknown item/part shapes are ignored.
 */
export function accumulateItem(turn: Turn, item: unknown): void;

/** The app frames each capture with an input_text part starting with this. */
export const CONTEXT_PREFIX: string;

/** Screen-size line inside the context part. */
export const SCREEN0_DIMS_RE: RegExp;
