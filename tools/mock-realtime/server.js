/**
 * Mock OpenAI Realtime server — a standalone Node WS server (no Electron
 * deps) speaking the same GA v1 protocol subset as src/main/realtime.
 *
 * Run standalone: `npm run mock` (ws://127.0.0.1:8123), or embed in tests via
 * `createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 })`.
 * Point the app at it with CLICKY_MOCK_URL=ws://127.0.0.1:8123.
 *
 * Scenarios live in ./scenarios.js and are keyed on the user's input text
 * (input_text parts, excluding the "context:" framing part) or on committed
 * audio; per-turn input accumulation is pure and lives in ./turn-state.js.
 * Every spoken response streams transcript deltas word-by-word and REAL
 * pcm16@24kHz audio deltas (a short three-note melody).
 */
// @ts-check
'use strict';

const { WebSocketServer } = require('ws');
const { synthesizeMelodyPcm16 } = require('./audio');
const { pickScenario } = require('./scenarios');
const { freshTurn, accumulateItem } = require('./turn-state');

/** @typedef {import('./turn-state').Turn} Turn */
/** @typedef {import('./scenarios').ScenarioIo} ScenarioIo */
/**
 * Pacing/logging shared by every connection of one server instance.
 * @typedef {object} PacedOptions
 * @property {number} wordDelayMs
 * @property {number} audioChunkDelayMs
 * @property {(line: string) => void} log
 */

const DEFAULT_PORT = 8123;
const DEFAULT_HOST = '127.0.0.1';

// The session audio format is pcm16@24kHz mono: 24000 samples/s * 2 bytes
// per sample = 48000 bytes/s, i.e. 48 bytes per millisecond.
const BYTES_PER_MS = 48;
// M9: real-API strictness — the live endpoint rejects commits under 100ms of
// audio. Mirror it so the quick barge-in tap regression (docs/EVAL.md §8.3
// follow-up) stays covered.
const MIN_COMMIT_MS = 100;
const MIN_COMMIT_BYTES = MIN_COMMIT_MS * BYTES_PER_MS; // 4800 bytes
// Each response.output_audio.delta carries 0.25s of tone audio.
const AUDIO_CHUNK_BYTES = 250 * BYTES_PER_MS; // 12000 bytes

let idCounter = 0;
/** @param {string} prefix */
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}_mock_${idCounter}`;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plausible usage numbers for response.done.
 * @param {Turn} turn
 * @param {number} transcriptWords
 */
function makeUsage(turn, transcriptWords) {
  const imageTokens = (turn.imageCount || 0) * 260;
  const audioIn = turn.committedAudio ? 42 : 0;
  const textIn = 35 + turn.userTexts.join(' ').length;
  const audioOut = 20 + transcriptWords * 3;
  return {
    total_tokens: textIn + imageTokens + audioIn + audioOut,
    input_tokens: textIn + imageTokens + audioIn,
    output_tokens: audioOut,
    input_token_details: {
      text_tokens: textIn,
      audio_tokens: audioIn,
      image_tokens: imageTokens,
      cached_tokens: 0,
    },
    output_token_details: { text_tokens: 0, audio_tokens: audioOut },
  };
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {MockServerState} server
 * @param {PacedOptions} options
 */
function handleConnection(ws, server, options) {
  const log = options.log;
  /** @param {Record<string, unknown>} evt */
  const send = (evt) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event_id: nextId('event'), ...evt }));
  };

  let turn = freshTurn();
  let appendedAudioBytes = 0;
  /** @type {{ cancelled: boolean, done: boolean } | null} */
  let active = null; // state of the streaming response

  send({ type: 'session.created', session: { id: nextId('sess'), type: 'realtime' } });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
      if (msg && typeof msg.type === 'string') server.clientEvents.push(msg); // test hook
    } catch {
      send({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'invalid_json',
          message: 'frame was not valid JSON',
        },
      });
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'session.update':
        server.sessionUpdates.push(msg);
        send({ type: 'session.updated', session: { ...msg.session, id: nextId('sess') } });
        break;

      case 'input_audio_buffer.append':
        appendedAudioBytes += Buffer.from(String(msg.audio || ''), 'base64').length;
        break;

      case 'input_audio_buffer.clear':
        appendedAudioBytes = 0;
        send({ type: 'input_audio_buffer.cleared' });
        break;

      case 'input_audio_buffer.commit': {
        if (appendedAudioBytes < MIN_COMMIT_BYTES) {
          log(`[mock-realtime] rejected commit: only ${appendedAudioBytes} bytes buffered`);
          send({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'input_audio_buffer_commit_empty',
              message:
                'Error committing input audio buffer: buffer too small. ' +
                `Expected at least ${MIN_COMMIT_MS}ms of audio, but buffer only has ` +
                `${(appendedAudioBytes / BYTES_PER_MS).toFixed(2)}ms of audio.`,
            },
          });
          appendedAudioBytes = 0;
          break;
        }
        turn.committedAudio = true;
        const itemId = nextId('item');
        send({ type: 'input_audio_buffer.committed', item_id: itemId });
        // Async ASR transcript of the committed audio.
        send({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: itemId,
          content_index: 0,
          transcript: `(mock transcript of ${appendedAudioBytes} audio bytes)`,
          usage: { type: 'duration', seconds: appendedAudioBytes / (BYTES_PER_MS * 1000) },
        });
        appendedAudioBytes = 0;
        break;
      }

      case 'conversation.item.create':
        accumulateItem(turn, msg.item);
        break;

      case 'response.create': {
        // F1 fix (M4 hardening): the REAL API rejects response.create while a
        // response is active — the mock must too, so tests catch that class
        // of bug (continueResponse firing mid-response).
        if (active && !active.cancelled && !active.done) {
          log('[mock-realtime] rejected response.create: response already active');
          send({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'conversation_already_has_active_response',
              message: 'Conversation already has an active response',
            },
          });
          break;
        }
        const thisTurn = turn;
        turn = freshTurn();
        const scenario = pickScenario(thisTurn);
        log(`[mock-realtime] response.create -> scenario "${scenario.name}"`);
        const responseId = nextId('resp');
        const state = { cancelled: false, done: false };
        active = state;
        runResponse(scenario, thisTurn, responseId, state, send, options).catch((err) => {
          log(`[mock-realtime] scenario "${scenario.name}" crashed: ${err.stack || err}`);
        });
        break;
      }

      case 'response.cancel':
        if (active) active.cancelled = true;
        break;

      default:
        // Unknown client event: real API would error; stay lenient but visible.
        log(`[mock-realtime] ignoring unknown client event: ${msg.type}`);
    }
  });
}

/**
 * @param {import('./scenarios').Scenario} scenario
 * @param {Turn} turn
 * @param {string} responseId
 * @param {{ cancelled: boolean, done: boolean }} state
 * @param {(evt: Record<string, unknown>) => void} send
 * @param {PacedOptions} options
 */
async function runResponse(scenario, turn, responseId, state, send, options) {
  send({ type: 'response.created', response: { id: responseId, status: 'in_progress' } });
  send({
    type: 'rate_limits.updated',
    rate_limits: [
      { name: 'requests', limit: 1000, remaining: 999, reset_seconds: 60 },
      { name: 'tokens', limit: 50000, remaining: 48000, reset_seconds: 60 },
    ],
  });

  let spokenWords = 0;
  let doneSent = false;

  /** @type {ScenarioIo} */
  const io = {
    sleep,
    cancelled: () => state.cancelled,

    /** Stream transcript deltas word-by-word, then real tone audio deltas. */
    async speak(text) {
      const itemId = nextId('item');
      const words = text.split(' ');
      spokenWords += words.length;
      for (let i = 0; i < words.length; i++) {
        if (state.cancelled) return;
        send({
          type: 'response.output_audio_transcript.delta',
          response_id: responseId,
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: i === 0 ? words[i] : ` ${words[i]}`,
        });
        await sleep(options.wordDelayMs);
      }
      send({
        type: 'response.output_audio_transcript.done',
        response_id: responseId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        transcript: text,
      });

      const tone = synthesizeMelodyPcm16();
      for (let offset = 0; offset < tone.length; offset += AUDIO_CHUNK_BYTES) {
        if (state.cancelled) return;
        send({
          type: 'response.output_audio.delta',
          response_id: responseId,
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: tone.subarray(offset, offset + AUDIO_CHUNK_BYTES).toString('base64'),
        });
        await sleep(options.audioChunkDelayMs);
      }
      send({
        type: 'response.output_audio.done',
        response_id: responseId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
      });
    },

    /**
     * Emit a function call: output_item.added + argument deltas + done.
     * Pass a STRING as `args` to stream it verbatim (e.g. deliberately
     * malformed JSON for arg-rejection scenarios).
     */
    async functionCall(name, args) {
      const callId = nextId('call');
      const itemId = nextId('fc');
      send({
        type: 'response.output_item.added',
        response_id: responseId,
        output_index: 1,
        item: { id: itemId, type: 'function_call', name, call_id: callId, arguments: '' },
      });
      const json = typeof args === 'string' ? args : JSON.stringify(args);
      const mid = Math.ceil(json.length / 2);
      for (const delta of [json.slice(0, mid), json.slice(mid)]) {
        if (state.cancelled) return callId;
        send({
          type: 'response.function_call_arguments.delta',
          response_id: responseId,
          item_id: itemId,
          output_index: 1,
          call_id: callId,
          delta,
        });
        await sleep(options.wordDelayMs);
      }
      send({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        item_id: itemId,
        output_index: 1,
        call_id: callId,
        name,
        arguments: json,
      });
      return callId;
    },

    error(message, code) {
      send({
        type: 'error',
        error: { type: 'server_error', code: code || 'mock_error', message },
      });
    },

    async done(status) {
      doneSent = true;
      state.done = true;
      send({
        type: 'response.done',
        response: {
          id: responseId,
          object: 'realtime.response',
          status: state.cancelled ? 'cancelled' : status,
          status_details: null,
          output: [],
          usage: makeUsage(turn, spokenWords),
        },
      });
    },
  };

  await scenario.run(io, turn);
  if (!doneSent) await io.done(state.cancelled ? 'cancelled' : 'completed');
}

/**
 * The resolved server handle (see server.d.ts for the public typing).
 * @typedef {object} MockServerState
 * @property {import('ws').WebSocketServer} wss
 * @property {string} host
 * @property {number} port
 * @property {string} url
 * @property {Array<{ type: string, [k: string]: unknown }>} sessionUpdates
 * @property {Array<{ type: string, [k: string]: unknown }>} clientEvents
 * @property {number} connectionCount
 * @property {() => void} dropAllConnections
 * @property {() => Promise<void>} close
 */

/**
 * Start the mock server.
 * @param {{ port?: number, host?: string, wordDelayMs?: number,
 *           audioChunkDelayMs?: number, log?: (line: string) => void }} [options]
 * @returns {Promise<MockServerState>}
 */
function createMockServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const log = options.log || (() => {});
  /** @type {PacedOptions} */
  const paced = {
    wordDelayMs: options.wordDelayMs ?? 40,
    audioChunkDelayMs: options.audioChunkDelayMs ?? 30,
    log,
  };

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port });
    /** @type {MockServerState} */
    const server = {
      wss,
      host,
      port: 0,
      url: '',
      /** Every session.update received, newest last (test hook). */
      sessionUpdates: [],
      /** Every parsed client event received, across connections (test hook). */
      clientEvents: [],
      connectionCount: 0,
      /** Hard-kill all live sockets (reconnect testing). */
      dropAllConnections() {
        for (const client of wss.clients) client.terminate();
      },
      close() {
        return new Promise((res) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => res());
        });
      },
    };
    wss.on('listening', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (wss.address());
      server.port = address.port;
      server.url = `ws://${host}:${server.port}`;
      log(`[mock-realtime] listening on ${server.url}`);
      resolve(server);
    });
    wss.on('error', reject);
    wss.on('connection', (ws) => {
      server.connectionCount += 1;
      log(`[mock-realtime] client connected (#${server.connectionCount})`);
      handleConnection(ws, server, paced);
    });
  });
}

module.exports = { createMockServer, synthesizeMelodyPcm16, DEFAULT_PORT };
