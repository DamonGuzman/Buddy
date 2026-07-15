/**
 * M9 regression: the quick barge-in tap. A hold can pass the 250ms
 * accidental-tap guard yet carry under 100ms of APPENDED audio (the mic
 * spins up late after a barge-in) — committing that used to make the live
 * API reject the buffer ("buffer too small") and wedge the session. The
 * conversation must cancel such holds gracefully: no commit, no turn record,
 * straight back to idle. Holds with enough audio must still commit.
 *
 * Electron and the capture/window modules are mocked; the RealtimeSession is
 * REAL, talking to the in-process mock server (CLICKY_MOCK_URL).
 */

import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationDeps } from '../src/main/conversation';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type * as MockRealtime from '../tools/mock-realtime/server';

const captureAllDisplaysMock = vi.hoisted(() =>
  vi.fn<() => Promise<Array<Record<string, unknown>>>>(() => Promise.resolve([])),
);

vi.mock('electron', () => ({
  app: {
    getPath: () => 'unused-in-tests',
  },
  screen: {
    dipToScreenPoint: (p: { x: number; y: number }) => p,
    screenToDipPoint: (p: { x: number; y: number }) => p,
    getDisplayNearestPoint: () => ({
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.5,
    }),
  },
}));

vi.mock('../src/main/capture', () => ({
  captureAllDisplays: captureAllDisplaysMock,
}));

vi.mock('../src/main/windows/panel', () => ({
  showPanelOnce: () => {},
  presentPanelActionableError: () => {},
  currentPanelActionableError: () => null,
  resolvePanelActionableError: () => {},
}));

vi.mock('../src/main/windows/overlay', () => ({}));

const { Conversation, MIN_COMMIT_AUDIO_MS } = await import('../src/main/conversation');

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof MockRealtime;
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------

function fakeDeps(
  phoneAudio?: {
    capture: (command: 'start' | 'stop') => void;
    playback: (command: 'stop' | 'flush') => void;
    sendAudio: (chunk: ArrayBuffer) => void;
  },
  fullRealtimeMode = false,
): ConversationDeps {
  return {
    settings: {
      get: () => ({
        model: 'gpt-realtime-2.1-mini',
        voice: 'marin',
        captionsEnabled: false,
        voiceMuted: false,
        fullRealtimeMode,
        computerUseEnabled: false,
        preferApiKeyGrounding: false,
        apiKeyUnreadable: false,
      }),
      getApiKey: () => null,
      settingsWereReset: () => false,
    },
    overlays: { broadcast: () => {}, routePointer: () => {} },
    panel: { send: () => {} },
    ...(phoneAudio ? { phoneAudio } : {}),
  };
}

/** PCM16@24kHz mono: 48 bytes per ms. */
const chunkOfMs = (ms: number) => new ArrayBuffer(ms * 48);

describe('Conversation: quick barge-in tap commit guard (M9)', () => {
  let server: MockServer;
  let nowOffset = 0;
  const conversations: InstanceType<typeof Conversation>[] = [];

  beforeAll(async () => {
    server = await mock.createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 });
    process.env['CLICKY_MOCK_URL'] = server.url;
    process.env['CLICKY_NO_SNAP'] = '1'; // no snapper daemon in unit tests
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env['CLICKY_MOCK_URL'];
    delete process.env['CLICKY_NO_SNAP'];
    await server.close();
  });

  afterEach(() => {
    for (const c of conversations.splice(0)) c.close();
    nowOffset = 0;
    server.clientEvents.length = 0;
    captureAllDisplaysMock.mockReset();
    captureAllDisplaysMock.mockResolvedValue([]);
  });

  function makeConversation() {
    const conversation = new Conversation(fakeDeps());
    conversations.push(conversation);
    return conversation;
  }

  it('does not read safeStorage-backed API credentials during construction', () => {
    const deps = fakeDeps();
    const getApiKey = vi.fn(() => {
      throw new Error('safeStorage cannot be used before app is ready');
    });
    deps.settings.getApiKey = getApiKey;

    const conversation = new Conversation(deps);
    conversations.push(conversation);

    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('an unrelated settings update preserves a live mock push-to-talk session', async () => {
    const deps = fakeDeps();
    const getApiKey = vi.fn(() => null);
    deps.settings.getApiKey = getApiKey;
    const conversation = new Conversation(deps);
    conversations.push(conversation);

    conversation.holdStart();
    await vi.waitFor(() => expect(conversation.sessionStatus().state).toBe('ready'));
    expect(getApiKey).toHaveBeenCalledOnce();

    conversation.onSettingsChanged({
      ...DEFAULT_SETTINGS,
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      captionsEnabled: true,
    });

    expect(conversation.sessionStatus().state).toBe('ready');
    expect(conversation.assistantState()).toBe('listening');
    conversation.cancelHold();
  });

  it('an unrelated settings update preserves a live mock open-mic session', async () => {
    const capture = vi.fn();
    const deps = fakeDeps({ capture, playback: vi.fn(), sendAudio: vi.fn() }, true);
    const getApiKey = vi.fn(() => null);
    deps.settings.getApiKey = getApiKey;
    const conversation = new Conversation(deps);
    conversations.push(conversation);

    await conversation.toggleFullRealtime();
    expect(conversation.sessionStatus().state).toBe('ready');
    expect(getApiKey).toHaveBeenCalledOnce();

    conversation.onSettingsChanged({
      ...DEFAULT_SETTINGS,
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      captionsEnabled: true,
      fullRealtimeMode: true,
    });

    expect(conversation.sessionStatus().state).toBe('ready');
    expect(conversation.assistantState()).toBe('listening');
    expect(capture).not.toHaveBeenCalledWith('stop');
  });

  it('a >250ms hold with <200ms of appended audio cancels instead of committing', async () => {
    const conversation = makeConversation();
    conversation.holdStart();
    // Mic spun up late: only 100ms of audio arrived during the whole hold.
    conversation.handleAudioChunk(chunkOfMs(50));
    conversation.handleAudioChunk(chunkOfMs(50));
    expect(MIN_COMMIT_AUDIO_MS).toBeGreaterThan(100);
    nowOffset = 400; // the hold itself lasted 400ms — passes the tap guard
    conversation.holdEnd();

    await vi.waitFor(() => expect(conversation.assistantState()).toBe('idle'));
    // Grace period: nothing may arrive late.
    await new Promise((r) => setTimeout(r, 150));
    const commits = server.clientEvents.filter((e) => e.type === 'input_audio_buffer.commit');
    expect(commits).toHaveLength(0);
    // The aborted hold leaves no turn record (same as a short tap).
    expect(conversation.turnTimingsHistory()).toHaveLength(0);
    expect(conversation.assistantState()).toBe('idle');
  });

  it('a hold with enough appended audio still commits and completes', async () => {
    const conversation = makeConversation();
    conversation.holdStart();
    for (let i = 0; i < 6; i++) conversation.handleAudioChunk(chunkOfMs(60)); // 360ms
    nowOffset = 400;
    conversation.holdEnd();

    await vi.waitFor(
      () => {
        const commits = server.clientEvents.filter((e) => e.type === 'input_audio_buffer.commit');
        expect(commits).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    // The mock answers and the turn settles back to idle (no error state).
    await vi.waitFor(() => expect(conversation.assistantState()).toBe('idle'), { timeout: 10_000 });
    expect(conversation.turnTimingsHistory().length).toBeGreaterThan(0);
  });

  it('a tap never interrupts: no playback stop while the barge-in is deferred (M20)', async () => {
    const capture = vi.fn();
    const playback = vi.fn();
    const sendAudio = vi.fn();
    const conversation = new Conversation(fakeDeps({ capture, playback, sendAudio }));
    conversations.push(conversation);

    conversation.holdStart();
    conversation.handleAudioChunk(chunkOfMs(50)); // parked, never appended
    nowOffset = 100; // released fast — a tap (whisper summon)
    conversation.holdEnd();

    // Outlive the deferral timer: a leaked commit would stop playback late.
    await new Promise((r) => setTimeout(r, 400));
    expect(playback).not.toHaveBeenCalled();
    const appends = server.clientEvents.filter((e) => e.type === 'input_audio_buffer.append');
    expect(appends).toHaveLength(0); // parked audio was dropped, not sent
    expect(conversation.assistantState()).toBe('idle');
  });

  it('a real hold still barges in (playback stop) once committed (M20)', async () => {
    const capture = vi.fn();
    const playback = vi.fn();
    const sendAudio = vi.fn();
    const conversation = new Conversation(fakeDeps({ capture, playback, sendAudio }));
    conversations.push(conversation);

    conversation.holdStart();
    for (let i = 0; i < 6; i++) conversation.handleAudioChunk(chunkOfMs(60));
    nowOffset = 400; // outlived the tap window — holdEnd force-commits
    conversation.holdEnd();

    expect(playback).toHaveBeenCalledWith('stop');
    await vi.waitFor(
      () => {
        const commits = server.clientEvents.filter((e) => e.type === 'input_audio_buffer.commit');
        expect(commits).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    await vi.waitFor(() => expect(conversation.assistantState()).toBe('idle'), { timeout: 10_000 });
  });

  it('routes capture and response PCM through the disposable phone transport', async () => {
    const capture = vi.fn();
    const playback = vi.fn();
    const sendAudio = vi.fn();
    const conversation = new Conversation(fakeDeps({ capture, playback, sendAudio }));
    conversations.push(conversation);

    conversation.holdStart();
    expect(capture).toHaveBeenCalledWith('start');
    for (let i = 0; i < 6; i++) conversation.handleAudioChunk(chunkOfMs(60));
    nowOffset = 400;
    conversation.holdEnd();
    expect(capture).toHaveBeenCalledWith('stop');

    await vi.waitFor(() => expect(sendAudio).toHaveBeenCalled(), { timeout: 10_000 });
    expect(sendAudio.mock.calls[0]?.[0]).toBeInstanceOf(ArrayBuffer);
  });

  it('toggles a server-VAD open-mic session and returns to listening after each turn', async () => {
    const freshCapture = {
      jpegBase64: Buffer.from('fresh-realtime-screen').toString('base64'),
      meta: {
        screenIndex: 0,
        displayId: 1,
        imageW: 1280,
        imageH: 720,
        displayBounds: { x: 0, y: 0, width: 1280, height: 720 },
        scaleFactor: 1,
        isActive: true,
      },
    };
    captureAllDisplaysMock.mockResolvedValue([freshCapture]);
    const capture = vi.fn();
    const playback = vi.fn();
    const sendAudio = vi.fn();
    const conversation = new Conversation(fakeDeps({ capture, playback, sendAudio }, true));
    conversations.push(conversation);

    await conversation.toggleFullRealtime();
    expect(capture).toHaveBeenCalledWith('start');
    expect(captureAllDisplaysMock).not.toHaveBeenCalled();
    expect(conversation.assistantState()).toBe('listening');
    conversation.handleAudioChunk(chunkOfMs(60));
    await vi.waitFor(() => {
      expect(server.clientEvents.some((event) => event.type === 'input_audio_buffer.append')).toBe(
        true,
      );
    });
    expect(server.clientEvents.some((event) => event.type === 'input_audio_buffer.commit')).toBe(
      false,
    );
    expect(server.clientEvents.some((event) => event.type === 'response.create')).toBe(false);
    await vi.waitFor(() => {
      const update = server.sessionUpdates.at(-1)?.session as {
        audio?: { input?: { turn_detection?: Record<string, unknown> | null } };
      };
      expect(update.audio?.input?.turn_detection).toMatchObject({
        type: 'server_vad',
        create_response: false,
      });
    });

    const beforeTurns = server.clientEvents.length;
    const socket = [...server.wss.clients].at(-1);
    expect(socket).toBeDefined();
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        item_id: 'continuous_user_1',
      }),
    );
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'continuous_user_1',
      }),
    );
    await vi.waitFor(() => expect(conversation.assistantState()).toBe('thinking'));
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'continuous_user_1',
      }),
    );

    await vi.waitFor(() => {
      expect(conversation.lastTurnTimings()?.tResponseDone).toBeTypeOf('number');
      expect(conversation.assistantState()).toBe('listening');
    });
    expect(captureAllDisplaysMock).toHaveBeenCalledTimes(1);

    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        item_id: 'continuous_user_2',
      }),
    );
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'continuous_user_2',
      }),
    );
    socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'continuous_user_2',
      }),
    );
    await vi.waitFor(() => {
      expect(captureAllDisplaysMock).toHaveBeenCalledTimes(2);
      expect(server.clientEvents.filter((event) => event.type === 'response.create')).toHaveLength(
        2,
      );
      expect(conversation.assistantState()).toBe('listening');
    });

    const turnEvents = server.clientEvents.slice(beforeTurns);
    const contextIndexes = turnEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'conversation.item.create')
      .map(({ index }) => index);
    const responseIndexes = turnEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.type === 'response.create')
      .map(({ index }) => index);
    expect(contextIndexes).toHaveLength(2);
    expect(responseIndexes).toHaveLength(2);
    expect(responseIndexes[0]).toBeGreaterThan(contextIndexes[0]!);
    expect(responseIndexes[1]).toBeGreaterThan(contextIndexes[1]!);

    await conversation.toggleFullRealtime();
    expect(capture).toHaveBeenLastCalledWith('stop');
    expect(conversation.assistantState()).toBe('idle');
  });
});
