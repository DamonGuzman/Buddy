/**
 * Scripted scenarios for the mock Realtime server. QA extends this file:
 * add an entry to SCENARIOS below — first `matches(turn)` wins.
 *
 * A `turn` is everything the client sent since the previous response.create:
 *   {
 *     userTexts: string[],      // input_text parts that are NOT the "context:" framing part
 *     contextText: string,      // the "context:" framing part, if any
 *     imageCount: number,       // input_image parts attached
 *     screen0: {w,h} | null,    // parsed from "screen0 is WxH pixels" in the context part
 *     committedAudio: boolean,  // input_audio_buffer.commit happened this turn
 *     toolOutputs: {callId, output}[], // function_call_output items received this turn
 *   }
 *
 * The `io` helper streams protocol events with realistic pacing:
 *   io.speak(text)                    -> transcript deltas (word by word) + tone audio deltas
 *   io.functionCall(name, args)       -> output_item.added + argument deltas + done; returns call_id
 *   io.error(message, code)           -> error event
 *   io.done(status)                   -> response.done with plausible usage
 *   io.sleep(ms), io.cancelled()      -> pacing / cancel check
 */
'use strict';

/** Center of screen 0 if the client described its dimensions, else 500,400. */
function centerOfScreen0(turn) {
  if (turn.screen0) {
    return { x: Math.round(turn.screen0.w / 2), y: Math.round(turn.screen0.h / 2) };
  }
  return { x: 500, y: 400 };
}

function userTextOf(turn) {
  return turn.userTexts.join(' ').toLowerCase();
}

const SCENARIOS = [
  {
    name: 'follow-up',
    description: 'after a function_call_output round-trip: short spoken follow-up',
    matches: (turn) => turn.toolOutputs.length > 0,
    async run(io) {
      await io.speak('there it is. try clicking it and see what opens up.');
      await io.done('completed');
    },
  },
  {
    name: 'error',
    description: 'user text contains "error": emit an error event, then a failed response',
    matches: (turn) => /\berror\b/.test(userTextOf(turn)),
    async run(io) {
      io.error('mock scenario error (you asked for one)', 'mock_error');
      await io.done('failed');
    },
  },
  {
    name: 'two-points',
    description: 'user text contains "two": two sequential point_at calls',
    matches: (turn) => /\btwo\b/.test(userTextOf(turn)),
    async run(io, turn) {
      const c = centerOfScreen0(turn);
      await io.speak('sure — this one here, and that one over there.');
      await io.functionCall('point_at', {
        x: Math.max(0, c.x - 120),
        y: c.y,
        label: 'the first thing',
        screen: 0,
      });
      await io.sleep(40);
      await io.functionCall('point_at', {
        x: c.x + 120,
        y: c.y,
        label: 'the second thing',
        screen: 0,
      });
      await io.done('completed');
    },
  },
  {
    name: 'point',
    description: 'user text contains "point" or "button": answer + one point_at call',
    matches: (turn) => /\bpoint\b|\bbutton\b/.test(userTextOf(turn)),
    async run(io, turn) {
      const c = centerOfScreen0(turn);
      await io.speak('see this right here? that is the one you want.');
      await io.functionCall('point_at', { ...c, label: 'the button', screen: 0 });
      await io.done('completed');
    },
  },
  {
    name: 'audio-only',
    description: 'committed audio with no typed text: canned nudge response',
    matches: (turn) => turn.committedAudio && turn.userTexts.length === 0,
    async run(io) {
      await io.speak('i can see your screen — try asking me to point at something.');
      await io.done('completed');
    },
  },
  {
    name: 'chat',
    description: 'fallback: spoken answer, no tool call',
    matches: () => true,
    async run(io) {
      await io.speak('happy to help. want to try something a little more ambitious next?');
      await io.done('completed');
    },
  },
];

/** First matching scenario (the fallback always matches). */
function pickScenario(turn) {
  return SCENARIOS.find((s) => s.matches(turn));
}

module.exports = { SCENARIOS, pickScenario, centerOfScreen0 };
