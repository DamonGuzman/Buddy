/**
 * Scripted scenarios for the mock Realtime server. QA extends this file:
 * add an entry to SCENARIOS below — first `matches(turn)` wins.
 *
 * A `Turn` (typed in ./turn-state.js) is everything the client sent since the
 * previous response.create; the `ScenarioIo` helper (implemented in
 * ./server.js) streams protocol events with realistic pacing.
 */
// @ts-check
'use strict';

/** @typedef {import('./turn-state').Turn} Turn */

/**
 * Protocol-event streaming helpers handed to every scenario `run`.
 * @typedef {object} ScenarioIo
 * @property {(text: string) => Promise<void>} speak
 *   transcript deltas (word by word) + tone audio deltas
 * @property {(name: string, args: object | string) => Promise<string>} functionCall
 *   output_item.added + argument deltas + done; returns call_id.
 *   Pass a STRING to stream it verbatim (e.g. deliberately malformed JSON).
 * @property {(message: string, code?: string) => void} error error event
 * @property {(status: string) => Promise<void>} done response.done with plausible usage
 * @property {(ms: number) => Promise<void>} sleep pacing
 * @property {() => boolean} cancelled cancel check
 */

/**
 * @typedef {object} Scenario
 * @property {string} name
 * @property {string} description
 * @property {(turn: Turn) => boolean} matches first match in SCENARIOS wins
 * @property {(io: ScenarioIo, turn: Turn) => Promise<void>} run
 */

/**
 * Center of screen 0 if the client described its dimensions, else 500,400.
 * @param {Turn} turn
 */
function centerOfScreen0(turn) {
  if (turn.screen0) {
    return { x: Math.round(turn.screen0.w / 2), y: Math.round(turn.screen0.h / 2) };
  }
  return { x: 500, y: 400 };
}

/** @param {Turn} turn */
function userTextOf(turn) {
  return turn.userTexts.join(' ').toLowerCase();
}

/** @type {Scenario[]} */
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
    // M11: mid-session rate limiting (integration tests for the error catalog).
    name: 'rate-limit',
    description: 'user text contains "rate limit"/"ratelimit": rate_limit_exceeded error event',
    matches: (turn) => /\brate ?limit/.test(userTextOf(turn)),
    async run(io) {
      io.error('Rate limit reached for the model. Please try again later.', 'rate_limit_exceeded');
      await io.done('failed');
    },
  },
  {
    // M11: mid-session server hiccup (integration tests for the error catalog).
    name: 'server-error',
    description: 'user text contains "server error"/"servererror": server_error event',
    matches: (turn) => /\bserver ?error\b/.test(userTextOf(turn)),
    async run(io) {
      io.error('The server had an error while processing your request.', 'server_error');
      await io.done('failed');
    },
  },
  {
    // M11: truncated answer (integration tests for response_incomplete).
    name: 'incomplete-done',
    description: 'user text contains "incomplete": speak, then response.done status incomplete',
    matches: (turn) => /\bincomplete\b/.test(userTextOf(turn)),
    async run(io) {
      await io.speak('so the first thing you want to do is');
      await io.done('incomplete');
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
    // M11: agent-mode stub — ARCHITECTURE §2/§5 promise a friendly
    // "coming soon" voice line when the user asks for agent mode.
    name: 'agent-mode',
    description: 'user text contains "agent": friendly coming-soon line (stubbed feature)',
    matches: (turn) => /\bagent\b/.test(userTextOf(turn)),
    async run(io) {
      await io.speak(
        "agent mode isn't ready quite yet — soon i'll be able to click around for you, " +
          'not just point. for now, ask me to point at anything and i will.',
      );
      await io.done('completed');
    },
  },
  {
    name: 'garbage-args',
    description: 'user text contains "garbage": point_at with non-JSON arguments',
    matches: (turn) => /\bgarbage\b/.test(userTextOf(turn)),
    async run(io) {
      await io.speak('let me point at that.');
      await io.functionCall('point_at', '{this is not valid json');
      await io.done('completed');
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
    name: 'native-grounding-qa',
    description:
      'user text contains "buddy project": point near the Buddy sidebar row with its name',
    matches: (turn) => /\bbuddy project\b/.test(userTextOf(turn)),
    async run(io, turn) {
      const size = turn.screen0 || { w: 1000, h: 800 };
      await io.speak('the Buddy project is right over here.');
      await io.functionCall('point_at', {
        x: Math.round(size.w * 0.086),
        y: Math.round(size.h * 0.363),
        label: 'the Buddy project',
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

/**
 * First matching scenario (the fallback always matches, so this never
 * returns undefined).
 * @param {Turn} turn
 * @returns {Scenario}
 */
function pickScenario(turn) {
  return /** @type {Scenario} */ (SCENARIOS.find((s) => s.matches(turn)));
}

module.exports = { SCENARIOS, pickScenario, centerOfScreen0 };
