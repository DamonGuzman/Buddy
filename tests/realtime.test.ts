/**
 * RealtimeSession integration tests against a live in-process mock server
 * (tools/mock-realtime): handshake, text/audio/image turns, transcript
 * accumulation, audio delivery, point_at round-trip, error surfacing,
 * idle close and reconnect-on-drop.
 */

import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RealtimeSession } from '../src/main/realtime/session';
import type { RealtimeSessionOptions, ToolCall } from '../src/main/realtime/session';
import type { PointAtArgs } from '../src/main/realtime/protocol';
import { getSessionInstructions, getToolDefinitions } from '../src/main/persona';
import type { CaptureMeta, SessionStatus } from '../src/shared/types';

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof import('../tools/mock-realtime/server');
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Loose = {
  on(event: string, cb: (payload: unknown) => void): unknown;
  off(event: string, cb: (payload: unknown) => void): unknown;
};

function waitFor<T>(
  session: RealtimeSession,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 5000,
): Promise<T> {
  const emitter = session as unknown as Loose;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`timed out waiting for '${event}'`));
    }, timeoutMs);
    const handler = (payload: unknown): void => {
      if (!predicate(payload as T)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(payload as T);
    };
    emitter.on(event, handler);
  });
}

function collect<T>(session: RealtimeSession, event: string): T[] {
  const items: T[] = [];
  (session as unknown as Loose).on(event, (payload) => items.push(payload as T));
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
    const statuses = collect<SessionStatus>(session, 'status');
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
      audio: { input: { turn_detection: null; format: { type: string; rate: number } }; output: { voice: string } };
      tools: Array<{ name: string }>;
    };
    expect(update.type).toBe('realtime');
    expect(update.instructions).toContain('clicky');
    expect(update.output_modalities).toEqual(['audio']);
    expect(update.audio.input.turn_detection).toBeNull();
    expect(update.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(update.audio.output.voice).toBe('marin');
    expect(update.tools.map((t) => t.name)).toEqual(['point_at']);
  });

  it('text turn: transcript deltas accumulate to the full text, audio arrives as ArrayBuffers', async () => {
    const session = makeSession();
    const transcripts = collect<{ itemId: string; text: string; done: boolean }>(
      session,
      'assistant-transcript',
    );
    const audio = collect<{ itemId: string; chunk: ArrayBuffer }>(session, 'audio-delta');
    const audioDone = collect<{ itemId: string }>(session, 'audio-done');

    await session.askText('hello there');
    const done = await waitFor<{ responseId: string; status: string; usage?: { total_tokens?: number } }>(
      session,
      'response-done',
    );

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

  it('voice turn: pre-connect appends are queued; commit yields user transcript + canned response', async () => {
    const session = makeSession();
    // appendAudio before any connect: must not throw, triggers lazy connect.
    session.appendAudio(new ArrayBuffer(4800));
    session.appendAudio(new ArrayBuffer(4800));

    const userTranscript = waitFor<{ itemId: string; text: string }>(session, 'user-transcript');
    await session.commitAudioAndRespond([], '');

    expect((await userTranscript).text).toContain('9600 audio bytes');
    const transcript = await waitFor<{ text: string; done: boolean }>(
      session,
      'assistant-transcript',
      (t) => t.done,
    );
    expect(transcript.text).toContain('point at something');
    await waitFor(session, 'response-done');
  });

  it('point_at flow: validated tool call -> sendToolOutput -> follow-up response', async () => {
    const session = makeSession();
    const toolCall = waitFor<ToolCall>(session, 'tool-call');
    const dones = collect<{ status: string }>(session, 'response-done');

    await session.askText('please point at the button', [IMAGE], 'the user is on their desktop');
    const call = await toolCall;

    expect(call.name).toBe('point_at');
    const args = call.args as PointAtArgs;
    // Mock points at the center of screen0's dims, which it read from our context part.
    expect(args).toEqual({ x: 500, y: 300, screen: 0, label: 'the button' });

    await vi.waitFor(() => expect(dones).toHaveLength(1));
    expect(dones[0]!.status).toBe('completed');

    const followUp = waitFor<{ text: string; done: boolean }>(
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
    const calls = collect<ToolCall>(session, 'tool-call');
    await session.askText('point at two things', [IMAGE]);
    await waitFor(session, 'response-done');
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
    const errors = collect<Error>(session, 'error');
    const dones = collect<{ status: string }>(session, 'response-done');

    const errored = waitFor<SessionStatus>(session, 'status', (s) => s.state === 'error');
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
    await waitFor<SessionStatus>(session, 'status', (s) => s.state === 'disconnected');

    // A new turn triggers a fresh connection + handshake, then completes.
    await session.askText('hello after the drop');
    const done = await waitFor<{ status: string }>(session, 'response-done');
    expect(done.status).toBe('completed');
    expect(server.connectionCount).toBe(before + 1);
    expect(session.status().state).toBe('ready');
  });

  it('keep-warm idle timeout closes gracefully (no error state)', async () => {
    const session = makeSession({ idleTimeoutMs: 150 });
    await session.connect();
    const status = await waitFor<SessionStatus>(session, 'status', (s) => s.state !== 'ready');
    expect(status.state).toBe('disconnected');
    expect(status.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // F1 fixes
  // -------------------------------------------------------------------------

  it('M4: tool outputs mid-response defer a SINGLE continue until response.done', async () => {
    const session = makeSession();
    const errors = collect<Error>(session, 'error');
    const requested = collect<unknown>(session, 'response-requested');
    const dones = collect<{ status: string }>(session, 'response-done');
    // Emulate the conversation layer: output + continue per tool call. The
    // two-points scenario delivers BOTH calls while the response is still
    // in_progress — an immediate response.create would be rejected by the
    // (now real-API-strict) mock with conversation_already_has_active_response.
    session.on('tool-call', (call) => {
      session.sendToolOutput(call.callId, { ok: true });
      session.continueResponse();
    });
    const followUp = waitFor<{ text: string; done: boolean }>(
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

  it('M3: malformed tool args reject internally and the continue is counted via response-requested', async () => {
    const session = makeSession();
    const errors = collect<Error>(session, 'error');
    const toolCalls = collect<ToolCall>(session, 'tool-call');
    const requested = collect<unknown>(session, 'response-requested');
    const dones = collect<{ status: string }>(session, 'response-done');
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
      const dones = collect<{ status: string }>(session, 'response-done');
      await session.askText('hello there');
      await waitFor(session, 'assistant-transcript'); // response is streaming
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
      await waitFor<SessionStatus>(session, 'status', (s) => s.state === 'disconnected');

      // A hold streams chunks while the endpoint is unreachable: they queue,
      // and the auto-connect attempt fails.
      session.appendAudio(new ArrayBuffer(4800));
      session.appendAudio(new ArrayBuffer(4800));
      session.appendAudio(new ArrayBuffer(4800));
      await waitFor<SessionStatus>(session, 'status', (s) => s.state === 'error');

      // The turn fails -> the conversation clears the held audio.
      session.clearAudio();

      // The endpoint comes back; the NEXT turn must not deliver stale audio.
      second = await mock.createMockServer({ port, wordDelayMs: 1, audioChunkDelayMs: 1 });
      await session.askText('hello');
      await waitFor(session, 'response-done');

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
