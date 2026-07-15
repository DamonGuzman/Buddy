/**
 * Pure per-turn input state for the mock Realtime server. A `Turn` is
 * everything the client sent since the previous response.create; the
 * connection handler in ./server.js folds `conversation.item.create` items in
 * via `accumulateItem`, and scenarios (./scenarios.js) key off the result.
 * No I/O here — the functions are directly unit-testable.
 */
// @ts-check
'use strict';

/**
 * @typedef {object} Turn
 * @property {string[]} userTexts input_text parts that are NOT the "context:" framing part
 * @property {string} contextText the "context:" framing part, if any
 * @property {number} imageCount input_image parts attached
 * @property {{ w: number, h: number } | null} screen0
 *   parsed from "screen0 is WxH pixels" in the context part
 * @property {boolean} committedAudio input_audio_buffer.commit happened this turn
 * @property {Array<{ callId: string, output: string }>} toolOutputs
 *   function_call_output items received this turn
 */

/** The app frames each capture with an input_text part starting with this. */
const CONTEXT_PREFIX = 'context:';

/** Screen-size line inside the context part (see src/main framing). */
const SCREEN0_DIMS_RE = /screen0 is (\d+)x(\d+) pixels/;

/** @returns {Turn} */
function freshTurn() {
  return {
    userTexts: [],
    contextText: '',
    imageCount: 0,
    screen0: null,
    committedAudio: false,
    toolOutputs: [],
  };
}

/**
 * Fold one `conversation.item.create` item into the turn (mutates `turn`).
 * Unknown item/part shapes are ignored, matching the lenient mock posture.
 *
 * @param {Turn} turn
 * @param {any} item the raw `item` field of the client event (untrusted wire data)
 * @returns {void}
 */
function accumulateItem(turn, item) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'message' && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (!part) continue;
      if (part.type === 'input_text' && typeof part.text === 'string') {
        if (part.text.startsWith(CONTEXT_PREFIX)) {
          turn.contextText = part.text;
          const dims = SCREEN0_DIMS_RE.exec(part.text);
          if (dims) turn.screen0 = { w: Number(dims[1]), h: Number(dims[2]) };
        } else {
          turn.userTexts.push(part.text);
        }
      } else if (part.type === 'input_image') {
        turn.imageCount += 1;
      }
    }
  } else if (item.type === 'function_call_output') {
    turn.toolOutputs.push({ callId: item.call_id, output: item.output });
  }
}

module.exports = { freshTurn, accumulateItem, CONTEXT_PREFIX, SCREEN0_DIMS_RE };
