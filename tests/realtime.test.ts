/**
 * RealtimeSession integration tests against a live in-process mock server
 * (tools/mock-realtime): handshake, text/audio/image turns, transcript
 * accumulation, audio delivery, point_at round-trip, error surfacing,
 * idle close and reconnect-on-drop.
 */

import { createRequire } from 'node:module';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RealtimeSession } from '../src/main/realtime/session';
import type { RealtimeSessionEvents, RealtimeSessionOptions } from '../src/main/realtime/session';
import type { PointAtArgs } from '../src/main/realtime/protocol';
import { getSessionInstructions, getToolDefinitions } from '../src/main/persona';
import type { CaptureMeta } from '../src/shared/types';
import type * as MockRealtime from '../tools/mock-realtime/server';

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof MockRealtime;
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionEvent = keyof RealtimeSessionEvents;
/** Single payload of a session event; zero-arg events (e.g. 'response-requested') yield undefined. */
type EventPayload<E extends SessionEvent> = RealtimeSessionEvents[E] extends [infer P]
  ? P
  : undefined;
/**
 * The one seam where the listener meets Node's generic emitter typing: a
 * zero-arg listener is assignable to every event's listener slot, so this
 * widening (unlike the old `as unknown as Loose`) can never lie about the
 * event names or payload shapes, which stay fully typed at the call sites.
 */
type AnyListener = () => void;

function waitForEvent<E extends SessionEvent>(
  session: RealtimeSession,
  event: E,
  predicate: (payload: EventPayload<E>) => boolean = () => true,
  timeoutMs = 5000,
): Promise<EventPayload<E>> {
  return new Promise<EventPayload<E>>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.off(event, handler as AnyListener);
      reject(new Error(`timed out waiting for '${event}'`));
    }, timeoutMs);
    const handler = (...args: RealtimeSessionEvents[E]): void => {
      const payload = args[0] as EventPayload<E>;
      if (!predicate(payload)) return;
      clearTimeout(timer);
      session.off(event, handler as AnyListener);
      resolve(payload);
    };
    session.on(event, handler as AnyListener);
  });
}

function collectEvents<E extends SessionEvent>(
  session: RealtimeSession,
  event: E,
): Array<EventPayload<E>> {
  const items: Array<EventPayload<E>> = [];
  const handler = (...args: RealtimeSessionEvents[E]): void => {
    items.push(args[0] as EventPayload<E>);
  };
  session.on(event, handler as AnyListener);
  return items;
}

const META: CaptureMeta = {
  screenIndex: 0,
  displayId: 1,
  imageW: 1000,
  imageH: 600,
  displayBounds: { x: 0, y: 0, width: 1000, height: 600 },
  scaleFactor: 1,
  isActive: true,
};

const IMAGE = { jpegBase64: Buffer.from('fake-jpeg').toString('base64'), meta: META };

// ---------------------------------------------------------------------------

describe('RealtimeSession against the mock server', () => {
  let server: MockServer;
  const sessions: RealtimeSession[] = [];

  beforeAll(async () => {
    server = await mock.createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 });
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    for (const s of sessions.splice(0)) s.close();
  });

  function makeSession(overrides: Partial<RealtimeSessionOptions> = {}): RealtimeSession {
    const session = new RealtimeSession({
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      instructions: getSessionInstructions(),
      tools: getToolDefinitions(),
      urlOverride: server.url,
      ...overrides,
    });
    session.on('error', () => {
      /* collected per-test where relevant; never unhandled */
    });
    sessions.push(session);
    return session;
  }

  it('connects lazily and completes the session.update handshake', async () => {
    const session = makeSession();
    const statuses = collectEvents(session, 'status');
    expect(session.status().state).toBe('disconnected');
    expect(session.usingMock).toBe(true);

    await session.connect();
    expect(session.status()).toMatchObject({
      state: 'ready',
      model: 'gpt-realtime-2.1-mini',
      usingMockServer: true,
    });
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'ready']);

    // connect() is idempotent — no second handshake.
    const connections = server.connectionCount;
    await session.connect();
    expect(server.connectionCount).toBe(connections);

    // The frame travels client -> server asynchronously.
    await vi.waitFor(() => expect(server.sessionUpdates.length).toBeGreaterThan(0));
    const update = server.sessionUpdates.at(-1)?.session as {
      type: string;
      instructions: string;
      output_modalities: string[];
      reasoning: { effort: string };
      audio: {
        input: { turn_detection: null; format: { type: string; rate: number } };
        output: { voice: string };
      };
      tools: Array<{ name: string }>;
    };
    expect(update.type).toBe('realtime');
    expect(update.instructions).toContain('buddy');
    expect(update.output_modalities).toEqual(['audio']);
    expect(update.reasoning).toEqual({ effort: 'medium' });
    expect(update.audio.input.turn_detection).toBeNull();
    expect(update.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(update.audio.output.voice).toBe('marin');
    expect(update.tools.map((t) => t.name)).toEqual(['point_at']);
  });

  it('commits server-VAD audio, then adds fresh screen context before responding', async () => {
    const session = makeSession({ turnDetection: 'server_vad' });
    const speechStarts = collectEvents(session, 'speech-started');
    const speechStops = collectEvents(session, 'speech-stopped');
    const audioCommits = collectEvents(session, 'audio-committed');
    let requested = 0;
    session.on('response-requested', () => (requested += 1));

    await session.connect();
    await vi.waitFor(() => {
      const update = server.sessionUpdates.at(-1)?.session as {
        audio?: { input?: { turn_detection?: Record<string, unknown> | null } };
      };
      expect(update.audio?.input?.turn_detection).toMatchObject({
        type: 'server_vad',
        create_response: false,
        interrupt_response: true,
      });
    });

    const before = server.clientEvents.length;
    const socket = [...server.wss.clients].at(-1);
    expect(socket).toBeDefined();
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        item_id: 'vad_user_1',
        audio_start_ms: 0,
      }),
    );
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'vad_user_1',
        audio_end_ms: 800,
      }),
    );
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'vad_user_1',
        previous_item_id: null,
      }),
    );

    await vi.waitFor(() => expect(audioCommits).toEqual([{ itemId: 'vad_user_1' }]));
    const donePromise = waitForEvent(session, 'response-done');
    await session.respondToVadTurn([IMAGE]);
    const done = await donePromise;
    expect(done.status).toBe('completed');
    expect(speechStarts).toEqual([{ itemId: 'vad_user_1' }]);
    expect(speechStops).toEqual([{ itemId: 'vad_user_1' }]);
    expect(requested).toBe(1);

    const events = server.clientEvents.slice(before) as Array<Record<string, unknown>>;
    const contextIndex = events.findIndex((event) => event['type'] === 'conversation.item.create');
    const responseIndex = events.findIndex((event) => event['type'] === 'response.create');
    expect(contextIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeGreaterThan(contextIndex);
    const context = events[contextIndex] as {
      item?: { content?: Array<{ type?: string; image_url?: string }> };
    };
    expect(context.item?.content?.some((part) => part.type === 'input_image')).toBe(true);
  });

  it('text turn: transcript deltas accumulate to the full text, audio arrives as ArrayBuffers', async () => {
    const session = makeSession();
    const transcripts = collectEvents(session, 'assistant-transcript');
    const audio = collectEvents(session, 'audio-delta');
    const audioDone = collectEvents(session, 'audio-done');

    await session.askText('hello there');
    const done = await waitForEvent(session, 'response-done');

    expect(done.status).toBe('completed');
    expect(done.usage?.total_tokens).toBeGreaterThan(0);

    // Full-so-far semantics: monotonically growing, final one marked done.
    expect(transcripts.length).toBeGreaterThan(3);
    for (let i = 1; i < transcripts.length; i++) {
      expect(transcripts[i]!.text.startsWith(transcripts[i - 1]!.text)).toBe(true);
    }
    const final = transcripts.at(-1)!;
    expect(final.done).toBe(true);
    expect(final.text).toBe('happy to help. want to try something a little more ambitious next?');

    // Real pcm16 audio, chunked, totalling the mock's tone melody exactly.
    expect(audio.length).toBeGreaterThan(1);
    for (const { chunk } of audio) expect(chunk).toBeInstanceOf(ArrayBuffer);
    const totalBytes = audio.reduce((sum, a) => sum + a.chunk.byteLength, 0);
    expect(totalBytes).toBe(mock.synthesizeMelodyPcm16().length);
    expect(audioDone).toHaveLength(1); // audio-done precedes response-done
    expect(audioDone[0]!.itemId).toBe(audio[0]!.itemId);
  });

  it('automated continuation is a user-role turn that wakes a response', async () => {
    const session = makeSession();
    const before = server.clientEvents.length;

    await session.injectUserAndRespond(
      '<system_reminder>review the completed background work</system_reminder>',
    );
    await waitForEvent(session, 'response-done');

    const events = server.clientEvents.slice(before) as Array<Record<string, unknown>>;
    const created = events.find((event) => event['type'] === 'conversation.item.create') as
      | {
          item?: {
            type?: string;
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        }
      | undefined;
    expect(created?.item).toMatchObject({ type: 'message', role: 'user' });
    expect(created?.item?.content?.[0]?.text).toContain('<system_reminder>');
    expect(events.some((event) => event['type'] === 'response.create')).toBe(true);
  });

  it('admits only one direct inference when two starts race on the same connect', async () => {
    const session = makeSession();
    const before = server.clientEvents.length;

    const userTurn = session.askText('the foreground question');
    const automatedTurn = session.injectUserAndRespond(
      '<system_reminder>a background agent completed</system_reminder>',
    );

    await userTurn;
    await expect(automatedTurn).rejects.toThrow('a realtime response is already active');
    await waitForEvent(session, 'response-done');

    const creates = server.clientEvents
      .slice(before)
      .filter((event) => event.type === 'response.create');
    expect(creates).toHaveLength(1);
  });

  it('drops late audio events from a cancelled response after its replacement starts', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const { port } = wss.address() as { port: number };
    let responseCreates = 0;

    wss.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'session.created', session: { id: 'session_late' } }));
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as { type?: string };
        if (event.type !== 'response.create') return;
        responseCreates += 1;
        if (responseCreates === 1) {
          socket.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_old', status: 'in_progress' },
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'response.output_audio.delta',
              response_id: 'resp_old',
              item_id: 'old_initial',
              delta: Buffer.from([1, 0]).toString('base64'),
            }),
          );
          return;
        }
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_new', status: 'in_progress' },
          }),
        );
        // Deliberately violate clean cancellation: stale audio arrives after
        // the new response is active. Buddy must never forward this chunk.
        socket.send(
          JSON.stringify({
            type: 'response.output_audio.delta',
            response_id: 'resp_old',
            item_id: 'old_late',
            delta: Buffer.from([2, 0]).toString('base64'),
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_audio.delta',
            response_id: 'resp_new',
            item_id: 'new_audio',
            delta: Buffer.from([3, 0]).toString('base64'),
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: { id: 'resp_old', status: 'cancelled' },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_audio.done',
            response_id: 'resp_new',
            item_id: 'new_audio',
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.done',
            response: { id: 'resp_new', status: 'completed' },
          }),
        );
      });
    });

    const session = new RealtimeSession({
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      instructions: getSessionInstructions(),
      urlOverride: `ws://127.0.0.1:${port}`,
    });
    session.on('error', () => {});
    const audio = collectEvents(session, 'audio-delta');
    try {
      await session.askText('first');
      await vi.waitFor(() => expect(audio.map((item) => item.itemId)).toContain('old_initial'));
      session.cancelResponse();
      await session.askText('second');
      await waitForEvent(session, 'response-done', (done) => done.responseId === 'resp_new');
      expect(audio.map((item) => item.itemId)).toEqual(['old_initial', 'new_audio']);
    } finally {
      session.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('voice turn: pre-connect appends are queued; commit yields user transcript + canned response', async () => {
    const session = makeSession();
    // appendAudio before any connect: must not throw, triggers lazy connect.
    session.appendAudio(new ArrayBuffer(4800));
    session.appendAudio(new ArrayBuffer(4800));

    const userTranscript = waitForEvent(session, 'user-transcript');
    await session.commitAudioAndRespond([], '');

    expect((await userTranscript).text).toContain('9600 audio bytes');
    const transcript = await waitForEvent(session, 'assistant-transcript', (t) => t.done);
    expect(transcript.text).toContain('point at something');
    await waitForEvent(session, 'response-done');
  });

  it('point_at flow: validated tool call -> sendToolOutput -> follow-up response', async () => {
    const session = makeSession();
    const toolCall = waitForEvent(session, 'tool-call');
    const dones = collectEvents(session, 'response-done');

    await session.askText('please point at the button', [IMAGE], 'the user is on their desktop');
    const call = await toolCall;

    expect(call.name).toBe('point_at');
    const args = call.args as PointAtArgs;
    // Mock points at the center of screen0's dims, which it read from our context part.
    expect(args).toEqual({ x: 500, y: 300, screen: 0, label: 'the button' });

    await vi.waitFor(() => expect(dones).toHaveLength(1));
    expect(dones[0]!.status).toBe('completed');

    const followUp = waitForEvent(
      session,
      'assistant-transcript',
      (t) => t.done && t.text.includes('there it is'),
    );
    session.sendToolOutput(call.callId, { ok: true, pointed: true });
    session.continueResponse();
    await followUp;
    await vi.waitFor(() => expect(dones).toHaveLength(2));
  });

  it('"two" turn delivers two sequential validated point_at calls', async () => {
    const session = makeSession();
    const calls = collectEvents(session, 'tool-call');
    await session.askText('point at two things', [IMAGE]);
    await waitForEvent(session, 'response-done');
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c.args as PointAtArgs).label)).toEqual([
      'the first thing',
      'the second thing',
    ]);
    // Clamped into the 1000x600 screenshot.
    for (const c of calls) {
      const a = c.args as PointAtArgs;
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThan(1000);
      expect(a.screen).toBe(0);
    }
  });

  it('server error event surfaces via onError and the error state, then recovers', async () => {
    const session = makeSession();
    const errors = collectEvents(session, 'error');
    const dones = collectEvents(session, 'response-done');

    const errored = waitForEvent(session, 'status', (s) => s.state === 'error');
    await session.askText('cause an error');
    const status = await errored;
    expect(status.error).toContain('mock scenario error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain('mock scenario error');

    // The mock still closes the turn (response.done always arrives).
    await vi.waitFor(() => expect(dones.at(-1)?.status).toBe('failed'));

    // The socket survived; the next turn restores ready and completes.
    await session.askText('hello again');
    await vi.waitFor(() => expect(dones.at(-1)?.status).toBe('completed'));
    expect(session.status().state).toBe('ready');
  });

  it('reconnects when a turn is requested after the connection dropped', async () => {
    const session = makeSession();
    await session.connect();
    const before = server.connectionCount;

    server.dropAllConnections();
    await waitForEvent(session, 'status', (s) => s.state === 'disconnected');

    // A new turn triggers a fresh connection + handshake, then completes.
    await session.askText('hello after the drop');
    const done = await waitForEvent(session, 'response-done');
    expect(done.status).toBe('completed');
    expect(server.connectionCount).toBe(before + 1);
    expect(session.status().state).toBe('ready');
  });

  it('keep-warm idle timeout closes gracefully (no error state)', async () => {
    const session = makeSession({ idleTimeoutMs: 150 });
    await session.connect();
    const status = await waitForEvent(session, 'status', (s) => s.state !== 'ready');
    expect(status.state).toBe('disconnected');
    expect(status.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F1 fixes
  // -------------------------------------------------------------------------

  it('M4: tool outputs mid-response defer a SINGLE continue until response.done', async () => {
    const session = makeSession();
    const errors = collectEvents(session, 'error');
    const requested = collectEvents(session, 'response-requested');
    const dones = collectEvents(session, 'response-done');
    // Emulate the conversation layer: output + continue per tool call. The
    // two-points scenario delivers BOTH calls while the response is still
    // in_progress — an immediate response.create would be rejected by the
    // (now real-API-strict) mock with conversation_already_has_active_response.
    session.on('tool-call', (call) => {
      session.sendToolOutput(call.callId, { ok: true });
      session.continueResponse();
    });
    const followUp = waitForEvent(
      session,
      'assistant-transcript',
      (t) => t.done && t.text.includes('there it is'),
      10_000,
    );
    await session.askText('show me two things', [IMAGE]);
    await followUp;
    await vi.waitFor(() => expect(dones).toHaveLength(2));
    expect(errors).toHaveLength(0);
    expect(dones.map((d) => d.status)).toEqual(['completed', 'completed']);
    // Initial response + exactly ONE coalesced deferred continue.
    expect(requested).toHaveLength(2);
  });

  it('M9: a rejected tiny commit (<100ms audio) synthesizes a failed response-done and recovers', async () => {
    const session = makeSession();
    const errors = collectEvents(session, 'error');
    const dones = collectEvents(session, 'response-done');

    // 2400 bytes of pcm16@24kHz = 50ms — under the server's 100ms minimum.
    session.appendAudio(new ArrayBuffer(2400));
    await session.commitAudioAndRespond([], '');

    // Without the fix: the error event left responseActive stuck true and no
    // response-done ever surfaced for the turn (the app-level ledger wedged).
    await vi.waitFor(() => expect(dones.some((d) => d.status === 'failed')).toBe(true));
    expect(errors.some((e) => /buffer too small/i.test(e.message))).toBe(true);

    // The mock (like the real API) still runs the audio-less response.create
    // to completion — let it drain so the next turn doesn't collide.
    await vi.waitFor(() => expect(dones.some((d) => d.status === 'completed')).toBe(true));

    // Clean recovery: the next turn completes normally on the same session.
    const before = dones.length;
    await session.askText('hello again');
    await vi.waitFor(() =>
      expect(dones.slice(before).some((d) => d.status === 'completed')).toBe(true),
    );
    expect(session.status().state).toBe('ready');
  });

  it('M3: malformed tool args reject internally and the continue is counted via response-requested', async () => {
    const session = makeSession();
    const errors = collectEvents(session, 'error');
    const toolCalls = collectEvents(session, 'tool-call');
    const requested = collectEvents(session, 'response-requested');
    const dones = collectEvents(session, 'response-done');
    await session.askText('send me garbage arguments');
    // Main response + the rejection's follow-up response both complete.
    await vi.waitFor(() => expect(dones).toHaveLength(2), { timeout: 10_000 });
    expect(toolCalls).toHaveLength(0); // never surfaced to the app
    expect(errors).toHaveLength(0); // the deferred create was accepted
    expect(dones.map((d) => d.status)).toEqual(['completed', 'completed']);
    // The internal rejectToolCall continue MUST be visible to app-level
    // accounting: initial create + internal continue = 2 requests.
    expect(requested).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F1 fixes needing their own (slower / restartable) mock servers
// ---------------------------------------------------------------------------

describe('RealtimeSession resilience (F1)', () => {
  function makeStandaloneSession(url: string): RealtimeSession {
    const session = new RealtimeSession({
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      instructions: getSessionInstructions(),
      tools: getToolDefinitions(),
      urlOverride: url,
    });
    session.on('error', () => {
      /* asserted explicitly where relevant */
    });
    return session;
  }

  it('M6: a connection drop mid-response synthesizes a failed response-done, then recovers', async () => {
    // Slow pacing so the response is reliably still streaming at the drop.
    const server = await mock.createMockServer({ port: 0, wordDelayMs: 25, audioChunkDelayMs: 25 });
    const session = makeStandaloneSession(server.url);
    try {
      const dones = collectEvents(session, 'response-done');
      await session.askText('hello there');
      await waitForEvent(session, 'assistant-transcript'); // response is streaming
      server.dropAllConnections();
      // Without the fix: responseActive stays true forever (keep-warm dead,
      // eternal reconnect) and no response-done ever arrives.
      await vi.waitFor(() => expect(dones.at(-1)?.status).toBe('failed'), { timeout: 5_000 });
      // The next turn reconnects lazily and completes.
      await session.askText('hello again');
      await vi.waitFor(() => expect(dones.at(-1)?.status).toBe('completed'), { timeout: 5_000 });
    } finally {
      session.close();
      await server.close();
    }
  });

  it('M7: mic audio queued while disconnected never leaks into the next turn', async () => {
    const first = await mock.createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 });
    const port = first.port;
    const session = makeStandaloneSession(first.url);
    let second: MockServer | null = null;
    try {
      await session.connect();
      await first.close(); // server goes away entirely
      await waitForEvent(session, 'status', (s) => s.state === 'disconnected');

      // A hold streams chunks while the endpoint is unreachable: they queue,
      // and the auto-connect attempt fails.
      session.appendAudio(new ArrayBuffer(4800));
      session.appendAudio(new ArrayBuffer(4800));
      session.appendAudio(new ArrayBuffer(4800));
      await waitForEvent(session, 'status', (s) => s.state === 'error');

      // The turn fails -> the conversation clears the held audio.
      session.clearAudio();

      // The endpoint comes back; the NEXT turn must not deliver stale audio.
      second = await mock.createMockServer({ port, wordDelayMs: 1, audioChunkDelayMs: 1 });
      await session.askText('hello');
      await waitForEvent(session, 'response-done');

      const appends = second.clientEvents.filter((e) => e.type === 'input_audio_buffer.append');
      expect(appends).toHaveLength(0); // repro delivered 3 stale appends here
      const commits = second.clientEvents.filter((e) => e.type === 'input_audio_buffer.commit');
      expect(commits).toHaveLength(0); // and no phantom commit either
    } finally {
      session.close();
      await second?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Handshake rejection: the server accepts the WS, sends a pre-session `error`
// event, then closes — the connect failure must carry the REAL reason (live
// repro: insufficient_quota closes 1013 after the error event; the old code
// swallowed it into a bare 'connection closed during handshake').
// ---------------------------------------------------------------------------

describe('RealtimeSession handshake rejection', () => {
  /**
   * Bare in-process WS server that accepts the handshake, optionally emits a
   * server `error` event, then closes with the given code/reason — exactly
   * the shape of a post-upgrade rejection from the real endpoint.
   */
  async function makeRejectingServer(
    errorEvent: object | null,
    closeCode: number,
    closeReason: string,
  ): Promise<{ url: string; close: () => Promise<void> }> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    wss.on('connection', (socket) => {
      if (errorEvent !== null) socket.send(JSON.stringify(errorEvent));
      socket.close(closeCode, closeReason);
    });
    const { port } = wss.address() as { port: number };
    return {
      url: `ws://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
    };
  }

  function makeSession(url: string): RealtimeSession {
    const session = new RealtimeSession({
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      instructions: getSessionInstructions(),
      tools: getToolDefinitions(),
      urlOverride: url,
    });
    session.on('error', () => {
      /* rejection asserted via connect(); never unhandled */
    });
    return session;
  }

  it('insufficient_quota (live repro): connect rejects with the friendly out-of-credit line', async () => {
    const server = await makeRejectingServer(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      },
      1013,
      'insufficient_quota.insufficient_quota',
    );
    const session = makeSession(server.url);
    try {
      const expected =
        'openai says your account is out of credit — add credits at platform.openai.com/billing';
      await expect(session.connect()).rejects.toThrow(expected);
      // The panel reads this status: header pill + failTurn system entry.
      expect(session.status()).toMatchObject({ state: 'error', error: expected });
    } finally {
      session.close();
      await server.close();
    }
  });

  it('other pre-session error events surface message + code', async () => {
    const server = await makeRejectingServer(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          message: 'Incorrect API key provided.',
        },
      },
      1008,
      'invalid_api_key',
    );
    const session = makeSession(server.url);
    try {
      const expected = 'openai error: Incorrect API key provided. (invalid_api_key)';
      await expect(session.connect()).rejects.toThrow(expected);
      expect(session.status()).toMatchObject({ state: 'error', error: expected });
    } finally {
      session.close();
      await server.close();
    }
  });

  it('close without a preceding error event falls back to code + reason', async () => {
    const server = await makeRejectingServer(null, 1013, 'try again later');
    const session = makeSession(server.url);
    try {
      const expected = 'connection closed during handshake (code 1013: try again later)';
      await expect(session.connect()).rejects.toThrow(expected);
      expect(session.status()).toMatchObject({ state: 'error', error: expected });
    } finally {
      session.close();
      await server.close();
    }
  });
});
