/**
 * M11: conversation-level error-catalog integration tests. The Conversation
 * and RealtimeSession are REAL; the endpoints are fakes:
 *
 * - tools/mock-realtime/server.js (healthy server, error scenarios keyed on
 *   the user text: rate limit / server error / incomplete / generic error);
 * - tools/mock-realtime/reject-server.js (hostile server: HTTP-status upgrade
 *   rejections 401/403/404/429/500, pre-settle insufficient_quota).
 *
 * Asserts the EXACT transcript copy per kind, the per-kind panel auto-show
 * calls, dedupe (one entry per failure), mic/playback/local failures, forced
 * captions, and the zero-capture context injection.
 */

import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConversationDeps } from '../src/main/conversation';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type * as MockRealtime from '../tools/mock-realtime/server';

const showPanelCalls = vi.hoisted(() => [] as string[]);

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
  showPanelOnce: (reason?: string) => {
    showPanelCalls.push(reason ?? 'first-run');
  },
  presentPanelActionableError: () => {},
  currentPanelActionableError: () => null,
  resolvePanelActionableError: () => {},
}));

vi.mock('../src/main/windows/overlay', () => ({}));

const { Conversation } = await import('../src/main/conversation');
const { describeKind } = await import('../src/main/errors');

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof MockRealtime;
const rejectMod = require('../tools/mock-realtime/reject-server') as {
  createRejectServer: (opts?: {
    port?: number;
    status?: number;
    preSettleError?: { code: string; message: string };
  }) => Promise<{ url: string; close: () => Promise<void> }>;
};

type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------

interface FakeDeps {
  deps: ConversationDeps;
  captions: { itemId: string; text: string; done: boolean }[];
  flags: {
    apiKey: string | null;
    apiKeyUnreadable: boolean;
    settingsWereReset: boolean;
    captionsEnabled: boolean;
  };
}

function fakeDeps(apiKey: string | null = null): FakeDeps {
  const flags = {
    apiKey,
    apiKeyUnreadable: false,
    settingsWereReset: false,
    captionsEnabled: false,
  };
  const captions: FakeDeps['captions'] = [];
  return {
    deps: {
      settings: {
        get: () => ({
          apiKeyUnreadable: flags.apiKeyUnreadable,
          model: 'gpt-realtime-2.1-mini',
          voice: 'marin',
          captionsEnabled: flags.captionsEnabled,
          voiceMuted: false,
          fullRealtimeMode: false,
          computerUseEnabled: false,
          preferApiKeyGrounding: false,
        }),
        getApiKey: () => flags.apiKey,
        settingsWereReset: () => flags.settingsWereReset,
      },
      overlays: {
        broadcast: (channel, payload) => {
          if (channel === 'overlay:caption') captions.push(payload as FakeDeps['captions'][number]);
        },
        routePointer: () => {},
      },
      panel: { send: () => {} },
      // Keep these realtime error tests independent of the developer machine's
      // ~/.codex/auth.json sign-in state.
      codexAuth: { getCodexAuth: () => null, getBearer: async () => '' },
    },
    captions,
    flags,
  };
}

const sysTexts = (c: InstanceType<typeof Conversation>): string[] =>
  c
    .transcript()
    .filter((e) => e.role === 'system')
    .map((e) => e.text);

describe('conversation error catalog (M11)', () => {
  let server: MockServer;
  let nowOffset = 0;
  const conversations: InstanceType<typeof Conversation>[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    server = await mock.createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 });
    process.env['CLICKY_NO_SNAP'] = '1';
    process.env['CLICKY_NO_REST_GROUND'] = '1';
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    delete process.env['CLICKY_MOCK_URL'];
    delete process.env['CLICKY_NO_SNAP'];
    delete process.env['CLICKY_NO_REST_GROUND'];
    await server.close();
  });

  afterEach(async () => {
    for (const c of conversations.splice(0)) c.close();
    for (const fn of cleanups.splice(0)) await fn();
    nowOffset = 0;
    showPanelCalls.length = 0;
    server.clientEvents.length = 0;
    delete process.env['CLICKY_MOCK_URL'];
  });

  function makeConversation(
    url?: string,
    apiKey: string | null = null,
  ): { c: InstanceType<typeof Conversation> } & FakeDeps {
    if (url !== undefined) process.env['CLICKY_MOCK_URL'] = url;
    else delete process.env['CLICKY_MOCK_URL'];
    const f = fakeDeps(apiKey);
    const c = new Conversation(f.deps);
    conversations.push(c);
    return { c, ...f };
  }

  async function makeRejectConversation(opts: {
    status?: number;
    preSettleError?: { code: string; message: string };
  }) {
    const reject = await rejectMod.createRejectServer(opts);
    cleanups.push(() => reject.close());
    return makeConversation(reject.url);
  }

  // -------------------------------------------------------------------------
  // Turn-start / handshake failures — exact copy per kind
  // -------------------------------------------------------------------------

  it('no_api_key: exact copy + auto-show for that kind', async () => {
    const { c, captions } = makeConversation(); // real endpoint, no key -> rejected pre-socket
    await c.askText('hello');
    const copy = describeKind('no_api_key').message;
    expect(sysTexts(c)).toContain(copy);
    expect(captions.some((caption) => caption.text === copy)).toBe(true);
    expect(c.assistantState()).toBe('error');
    expect(showPanelCalls).toContain('no_api_key');
  });

  it('api_key_unreadable: "no key" upgrades when an undecryptable blob is stored', async () => {
    const { c, flags } = makeConversation();
    flags.apiKeyUnreadable = true;
    await c.askText('hello');
    expect(sysTexts(c)).toContain(describeKind('api_key_unreadable').message);
    expect(sysTexts(c)).not.toContain(describeKind('no_api_key').message);
    expect(showPanelCalls).toContain('api_key_unreadable');
  });

  it('api_key_rejected: HTTP 401 upgrade rejection', async () => {
    const { c } = await makeRejectConversation({ status: 401 });
    await c.askText('hello');
    expect(sysTexts(c)).toContain(describeKind('api_key_rejected').message);
    expect(showPanelCalls).toContain('api_key_rejected');
  });

  it('api_access_forbidden: generic HTTP 403 gives project/key permission guidance', async () => {
    const { c } = await makeRejectConversation({ status: 403 });
    await c.askText('hello');
    expect(sysTexts(c)).toContain(describeKind('api_access_forbidden').message);
    expect(showPanelCalls).toContain('api_access_forbidden');
  });

  it('model_unavailable: HTTP 404 upgrade rejection', async () => {
    const { c } = await makeRejectConversation({ status: 404 });
    await c.askText('hello');
    expect(sysTexts(c)).toContain(
      describeKind('model_unavailable', { model: 'gpt-realtime-2.1-mini' }).message,
    );
  });

  it('rate_limited: HTTP 429 upgrade rejection', async () => {
    const { c } = await makeRejectConversation({ status: 429 });
    await c.askText('hello');
    expect(sysTexts(c)).toContain(describeKind('rate_limited').message);
    // NOT an auto-show kind.
    expect(showPanelCalls).not.toContain('rate_limited');
  });

  it('server_error: HTTP 500 upgrade rejection', async () => {
    const { c } = await makeRejectConversation({ status: 500 });
    await c.askText('hello');
    expect(sysTexts(c)).toContain(describeKind('server_error').message);
  });

  it('insufficient_quota: pre-settle error event gives concrete billing guidance', async () => {
    const { c } = await makeRejectConversation({
      preSettleError: {
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      },
    });
    await c.askText('hello');
    expect(sysTexts(c)).toContain(describeKind('insufficient_quota').message);
    expect(showPanelCalls).toContain('insufficient_quota');
  });

  it('network_unreachable: nothing listening on the endpoint', async () => {
    const { c, captions } = makeConversation('ws://127.0.0.1:1');
    await c.askText('hello');
    const copy = describeKind('network_unreachable').message;
    expect(sysTexts(c)).toContain(copy);
    // The capture_failed preflight may caption because this test stubs capture
    // to empty; the transient network error itself must remain non-intrusive.
    expect(captions.some((caption) => caption.text === copy)).toBe(false);
    expect(showPanelCalls).not.toContain('network_unreachable');
  });

  it('rebuilds an authenticated session when the stored key is replaced', async () => {
    const { c, flags } = makeConversation(server.url, 'sk-original-credential-1234567890');
    await c.askText('hello');
    await vi.waitFor(() => expect(c.sessionStatus().state).toBe('ready'));

    flags.apiKey = 'sk-replacement-credential-1234567890';
    c.onSettingsChanged({
      ...DEFAULT_SETTINGS,
      apiKeyPresent: true,
      model: 'gpt-realtime-2.1-mini',
    });

    expect(c.sessionStatus().state).toBe('disconnected');
  });

  it('an unrelated settings update preserves a typed-turn session after its first key read', async () => {
    const { c } = makeConversation(); // real endpoint: reads the key, then fails locally
    await c.askText('hello');
    expect(c.sessionStatus().state).toBe('error');

    c.onSettingsChanged({
      ...DEFAULT_SETTINGS,
      captionsEnabled: true,
      model: 'gpt-realtime-2.1-mini',
    });

    // A rebuild changes the fresh session to disconnected. Keeping the error
    // status proves this unrelated setting did not tear the session down.
    expect(c.sessionStatus().state).toBe('error');
  });

  it('an unrelated settings update preserves a full-realtime session after its first key read', async () => {
    const f = fakeDeps();
    f.deps.settings.get = () => ({
      ...DEFAULT_SETTINGS,
      fullRealtimeMode: true,
      apiKeyUnreadable: false,
    });
    const c = new Conversation(f.deps);
    conversations.push(c);

    await c.toggleFullRealtime(); // real endpoint: reads the key, then fails locally
    expect(c.sessionStatus().state).toBe('error');

    c.onSettingsChanged({
      ...DEFAULT_SETTINGS,
      captionsEnabled: true,
      fullRealtimeMode: true,
    });

    expect(c.sessionStatus().state).toBe('error');
  });

  it('mid-hold connect failures stay quiet; the commit resolves the turn', async () => {
    const { c } = makeConversation('ws://127.0.0.1:1'); // dead endpoint
    c.holdStart();
    expect(c.assistantState()).toBe('listening');
    // Mic chunks flow while the fire-and-forget connect fails underneath.
    for (let i = 0; i < 6; i++) c.handleAudioChunk(new ArrayBuffer(60 * 48)); // 360ms
    await new Promise((r) => setTimeout(r, 300));
    // M11: no mid-hold red flash, no transcript entry while still talking.
    expect(c.assistantState()).toBe('listening');
    expect(sysTexts(c)).toHaveLength(0);
    nowOffset = 500;
    c.holdEnd();
    await vi.waitFor(
      () => expect(sysTexts(c)).toContain(describeKind('network_unreachable').message),
      { timeout: 5_000 },
    );
    expect(c.assistantState()).toBe('error');
  });

  // -------------------------------------------------------------------------
  // Mid-session server error events (real mock server scenarios)
  // -------------------------------------------------------------------------

  it('rate_limited mid-session: classified copy, exactly ONE error entry (dedupe)', async () => {
    const { c } = makeConversation(server.url);
    await c.askText('please rate limit me');
    await vi.waitFor(() => expect(sysTexts(c)).toContain(describeKind('rate_limited').message), {
      timeout: 5_000,
    });
    // The failed response.done that follows must not add a second entry.
    await new Promise((r) => setTimeout(r, 200));
    const texts = sysTexts(c);
    expect(texts.filter((t) => t === describeKind('rate_limited').message)).toHaveLength(1);
    expect(texts).not.toContain(describeKind('response_interrupted').message);
  });

  it('server_error mid-session: classified copy reaches the transcript', async () => {
    const { c } = makeConversation(server.url);
    await c.askText('give me a servererror please');
    await vi.waitFor(() => expect(sysTexts(c)).toContain(describeKind('server_error').message), {
      timeout: 5_000,
    });
  });

  it('unclassified mid-session error still reaches the transcript (fallback line)', async () => {
    const { c } = makeConversation(server.url);
    await c.askText('please trigger an error now');
    await vi.waitFor(
      () =>
        expect(sysTexts(c)).toContain(
          'something went wrong: mock scenario error (you asked for one)',
        ),
      { timeout: 5_000 },
    );
  });

  it('response_incomplete: status incomplete appends the system entry, no error state', async () => {
    const { c } = makeConversation(server.url);
    await c.askText('this will be incomplete');
    await vi.waitFor(
      () => expect(sysTexts(c)).toContain(describeKind('response_incomplete').message),
      { timeout: 5_000 },
    );
    // Informational: the assistant settles back to idle, never 'error'.
    await vi.waitFor(() => expect(c.assistantState()).toBe('idle'), { timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // Zero-capture turns (capture_failed + context injection)
  // -------------------------------------------------------------------------

  it('capture_failed: transcript + caption + factual context sent to the model', async () => {
    const { c, captions } = makeConversation(server.url);
    await c.askText('just chat with me');
    const copy = describeKind('capture_failed').message;
    expect(sysTexts(c)).toContain(copy);
    expect(captions.some((cap) => cap.text === copy)).toBe(true);
    // The model is told it cannot see the screen (context part injection).
    await vi.waitFor(() => {
      const contextParts = server.clientEvents
        .filter((e) => e.type === 'conversation.item.create')
        .flatMap((e) => {
          const item = (e as { item?: { content?: { type: string; text?: string }[] } }).item;
          return item?.content ?? [];
        })
        .filter((p) => p.type === 'input_text' && (p.text ?? '').startsWith('context:'));
      expect(contextParts.some((p) => (p.text ?? '').includes('screen capture failed'))).toBe(true);
    });
    // No error state for an informational failure.
    expect(c.assistantState()).not.toBe('error');
  });

  // -------------------------------------------------------------------------
  // Local device / interaction failures
  // -------------------------------------------------------------------------

  it('mic_unavailable: a real hold with zero mic chunks says so (was silent)', async () => {
    const { c } = makeConversation(server.url);
    c.holdStart();
    nowOffset = 400; // past MIN_HOLD_MS — a real hold, not a tap
    c.holdEnd();
    await vi.waitFor(() => expect(sysTexts(c)).toContain(describeKind('mic_unavailable').message), {
      timeout: 5_000,
    });
    expect(c.assistantState()).toBe('error'); // overlay flash
    expect(showPanelCalls).toContain('mic_unavailable');
    expect(c.turnTimingsHistory()).toHaveLength(0); // still no turn record
  });

  it('mic_unavailable NotAllowedError variant leads with the privacy toggle', async () => {
    const { c } = makeConversation(server.url);
    c.holdStart();
    c.handleAudioDeviceError({
      source: 'mic',
      name: 'NotAllowedError',
      message: 'Permission denied',
    });
    nowOffset = 400;
    c.holdEnd();
    await vi.waitFor(
      () =>
        expect(sysTexts(c)).toContain(
          describeKind('mic_unavailable', { micErrorName: 'NotAllowedError' }).message,
        ),
      { timeout: 5_000 },
    );
  });

  it('a zero-audio release surfaces a racing API-key rejection, not mic_unavailable', async () => {
    const { c } = await makeRejectConversation({
      preSettleError: {
        code: 'invalid_api_key',
        message: 'Incorrect API key provided: sk-secret-value-that-must-not-leak',
      },
    });
    c.holdStart();
    nowOffset = 400;
    c.holdEnd();

    await vi.waitFor(
      () => expect(sysTexts(c)).toContain(describeKind('api_key_rejected').message),
      { timeout: 5_000 },
    );
    expect(sysTexts(c)).not.toContain(describeKind('mic_unavailable').message);
    expect(JSON.stringify(c.debugInfo())).not.toContain('sk-secret-value-that-must-not-leak');
  });

  it('a settings rebuild invalidates a released hold awaiting its old connection', async () => {
    const reject = await rejectMod.createRejectServer(); // accepts, then deliberately stays silent
    cleanups.push(() => reject.close());
    const { c, flags } = makeConversation(reject.url, 'sk-original-credential-1234567890');

    c.holdStart();
    nowOffset = 400;
    c.holdEnd();

    flags.apiKey = 'sk-replacement-credential-1234567890';
    c.onSettingsChanged({
      ...DEFAULT_SETTINGS,
      apiKeyPresent: true,
      model: 'gpt-realtime-2.1-mini',
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(c.sessionStatus().state).toBe('disconnected');
    expect(sysTexts(c)).toHaveLength(0);
  });

  it('mic_unavailable NotFoundError tells the user to choose an input device', async () => {
    const { c, captions } = makeConversation(server.url);
    c.holdStart();
    c.handleAudioDeviceError({
      source: 'mic',
      name: 'NotFoundError',
      message: 'Requested device not found',
    });
    nowOffset = 400;
    c.holdEnd();
    const copy = describeKind('mic_unavailable', { micErrorName: 'NotFoundError' }).message;
    await vi.waitFor(() => expect(sysTexts(c)).toContain(copy), { timeout: 5_000 });
    await vi.waitFor(() => expect(captions.some((caption) => caption.text === copy)).toBe(true), {
      timeout: 5_000,
    });
  });

  it('a short tap stays silent (no mic error, no turn)', async () => {
    const { c } = makeConversation(server.url);
    c.holdStart();
    nowOffset = 100; // under MIN_HOLD_MS
    c.holdEnd();
    expect(sysTexts(c)).toHaveLength(0);
    expect(c.assistantState()).toBe('idle');
  });

  it('hold_too_long: transcript + caption, no auto-show', () => {
    const { c, captions } = makeConversation(server.url);
    c.reportError('hold_too_long');
    const copy = describeKind('hold_too_long').message;
    expect(sysTexts(c)).toContain(copy);
    expect(captions.some((cap) => cap.text === copy)).toBe(true);
    expect(showPanelCalls).not.toContain('hold_too_long');
  });

  it('hotkey_dead: transcript entry + auto-show once', () => {
    const { c } = makeConversation(server.url);
    c.reportError('hotkey_dead');
    expect(sysTexts(c)).toContain(describeKind('hotkey_dead').message);
    expect(showPanelCalls).toContain('hotkey_dead');
  });

  it('audio_output_failed: surfaced once per failure episode, re-armed on recovery', () => {
    const { c } = makeConversation(server.url);
    const report = () =>
      c.handleAudioDeviceError({ source: 'playback', name: 'Error', message: 'no output device' });
    report();
    report(); // same episode: no duplicate
    const copy = describeKind('audio_output_failed', {
      audioOutputErrorName: 'Error',
      audioOutputErrorMessage: 'no output device',
    }).message;
    expect(sysTexts(c).filter((t) => t === copy)).toHaveLength(1);
    expect(showPanelCalls).toContain('audio_output_failed');
    // Sound came back (samples actually played) -> re-armed.
    c.handlePlaybackStats({
      itemId: 'item-x',
      samplesPlayed: 1200,
      rms: 0.1,
      peak: 0.2,
      underruns: 0,
      firstPlayedAt: Date.now(),
      done: true,
    });
    report();
    expect(sysTexts(c).filter((t) => t === copy)).toHaveLength(2);
  });

  it('audio_output_failed forces captions on even when captions are disabled', async () => {
    const { c, captions, flags } = makeConversation(server.url);
    flags.captionsEnabled = false;
    c.handleAudioDeviceError({ source: 'playback', name: 'Error', message: 'worklet dead' });
    await c.askText('just chat with me please');
    await vi.waitFor(
      () => expect(captions.some((cap) => cap.text.includes('happy to help'))).toBe(true),
      { timeout: 5_000 },
    );
  });

  it('settings_reset: one transcript entry on the first turn + auto-show', async () => {
    const { c, flags } = makeConversation(server.url);
    flags.settingsWereReset = true;
    await c.askText('hello there');
    const copy = describeKind('settings_reset').message;
    expect(sysTexts(c).filter((t) => t === copy)).toHaveLength(1);
    expect(showPanelCalls).toContain('settings_reset');
    await c.askText('hello again');
    expect(sysTexts(c).filter((t) => t === copy)).toHaveLength(1); // once only
  });
});
