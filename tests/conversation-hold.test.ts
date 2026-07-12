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
  captureAllDisplays: () => Promise.resolve([]),
}));

vi.mock('../src/main/windows/panel', () => ({
  showPanelOnce: () => {},
}));

vi.mock('../src/main/windows/overlay', () => ({}));

const { Conversation, MIN_COMMIT_AUDIO_MS } = await import('../src/main/conversation');

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof import('../tools/mock-realtime/server');
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------

function fakeDeps() {
  const settings = {
    get: () => ({
      apiKeyPresent: false,
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      captionsEnabled: false,
      micDeviceId: '',
      hotkeyLabel: 'Ctrl+Alt',
    }),
    getApiKey: () => null,
    onChange: () => () => {},
  };
  const overlays = { broadcast: () => {}, routePointer: () => {}, count: () => 0 };
  const panel = { send: () => {} };
  return {
    settings: settings as never,
    overlays: overlays as never,
    panel: panel as never,
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
  });

  function makeConversation() {
    const conversation = new Conversation(fakeDeps());
    conversations.push(conversation);
    return conversation;
  }

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
});
