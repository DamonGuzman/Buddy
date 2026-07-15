/**
 * M10 layered grounding dispatch precedence (conversation.ts):
 *
 *   model point_at -> mapModelPoint -> UIA snap -> REST ground -> raw point
 *
 * - UIA hit  -> pointer at the snapped element, NO REST call;
 * - UIA miss -> REST ground with the SAME screenshot jpeg the model saw;
 * - REST null -> raw model point (today's fallback);
 * - superseded turn while grounding runs -> NO pointer routed;
 * - CLICKY_NO_REST_GROUND=1 -> REST layer skipped entirely.
 *
 * Electron and capture are mocked; the snapper + rest-grounder are fakes
 * injected through the ConversationDeps grounding seams; the RealtimeSession
 * is REAL, talking to the in-process mock server whose "point" scenario
 * calls point_at at the center of screen0 with label "the button".
 */

import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PointerCommand } from '../src/shared/types';
import type { AuthSource } from '../src/main/auth/auth-source';
import type { ConversationDeps } from '../src/main/conversation';
import type { GroundOutcome, RestGroundQuery } from '../src/main/grounding/rest-grounder';
import type { SnapOutcome, SnapQuery } from '../src/main/grounding/snapper';
import type * as MockRealtime from '../tools/mock-realtime/server';

// ---------------------------------------------------------------------------
// Controllable grounding layers (injected via the ConversationDeps seams)
// ---------------------------------------------------------------------------

const noMatch: SnapOutcome = {
  matched: false,
  point: null,
  name: null,
  score: null,
  elapsedMs: 5,
  daemonMs: 5,
  candidates: 0,
  timedOut: false,
};

const ctl = {
  noMatch,
  snapQueries: [] as SnapQuery[],
  snap: (async () => noMatch) as (q: SnapQuery) => Promise<SnapOutcome>,
  restQueries: [] as RestGroundQuery[],
  rest: (async () => null) as (q: RestGroundQuery) => Promise<{ x: number; y: number } | null>,
  // M13-core: a quota-exhausted flag to drive the fail-closed assertion, and
  // the plan-usage headers the fake RestGrounder.ground() reports.
  restQuota: false,
  restUsedPercent: null as { primary: number | null; secondary: number | null } | null,
  // M13-core: controllable Codex sign-in state for resolveGroundingAuth.
  codexInfo: null as {
    accessToken: string;
    accountId: string;
    planType: string;
    expiresAt: number;
  } | null,
};

/** The fake UIA snapper injected through `buildUiaSnapper`. */
const fakeSnapper = {
  warmUp(): void {},
  dispose(): void {},
  snap(q: SnapQuery): Promise<SnapOutcome> {
    ctl.snapQueries.push(q);
    return ctl.snap(q);
  },
};

/** The fake REST grounder injected through `buildRestGrounder`. */
const fakeRestGrounder = {
  // M13-core: the transport-selecting entry point. Records the query and
  // returns a GroundOutcome built from the controllable ctl state.
  async ground(query: RestGroundQuery, auth: AuthSource): Promise<GroundOutcome> {
    ctl.restQueries.push(query);
    const point = await ctl.rest(query);
    const source = auth.kind === 'chatgptCodex' ? 'codex' : 'apiKey';
    return {
      point: ctl.restQuota ? null : point,
      source,
      quotaExhausted: ctl.restQuota,
      usedPercent: ctl.restUsedPercent,
    };
  },
};

vi.mock('electron', () => ({
  app: { getPath: () => 'unused-in-tests' },
  screen: {
    dipToScreenPoint: (p: { x: number; y: number }) => p,
    screenToDipPoint: (p: { x: number; y: number }) => p,
    getDisplayNearestPoint: () => ({
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 1.5,
    }),
  },
}));

/**
 * One 2048x1152 screenshot of a 2560x1440 DIP display at 150% (physical
 * 3840x2160) — the §6 mapping factor image px -> DIP is 1.25.
 */
const JPEG_B64 = 'ZmFrZS1qcGVn';
vi.mock('../src/main/capture', () => ({
  captureAllDisplays: () =>
    Promise.resolve([
      {
        meta: {
          screenIndex: 0,
          displayId: 1,
          imageW: 2048,
          imageH: 1152,
          displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
          scaleFactor: 1.5,
          isActive: true,
        },
        jpegBase64: JPEG_B64,
      },
    ]),
}));

vi.mock('../src/main/windows/panel', () => ({ showPanelOnce: () => {} }));
vi.mock('../src/main/windows/overlay', () => ({}));

const { Conversation } = await import('../src/main/conversation');

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof MockRealtime;
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------

type AnimateCommand = Extract<PointerCommand, { type: 'animate' }>;

function fakeDeps(pointers: PointerCommand[]): ConversationDeps {
  return {
    settings: {
      get: () => ({
        model: 'gpt-realtime-2.1-mini',
        voice: 'marin',
        captionsEnabled: false,
        voiceMuted: false,
        fullRealtimeMode: false,
        computerUseEnabled: false,
        preferApiKeyGrounding: false,
        apiKeyUnreadable: false,
      }),
      // A key IS present so resolveGroundingAuth returns the apiKey arm by
      // default; the realtime session runs in mock mode and ignores it.
      getApiKey: () => 'sk-mock',
      settingsWereReset: () => false,
    },
    overlays: {
      broadcast: () => {},
      routePointer: (cmd: PointerCommand) => pointers.push(cmd),
    },
    panel: { send: () => {} },
    // M13-core: deterministic Codex provider (no real ~/.codex/auth.json read).
    codexAuth: {
      getCodexAuth: () => ctl.codexInfo,
      getBearer: async () => ctl.codexInfo?.accessToken ?? '',
    },
    buildUiaSnapper: () => fakeSnapper,
    buildRestGrounder: () => fakeRestGrounder,
  };
}

describe('Conversation: layered grounding dispatch (M10)', () => {
  let server: MockServer;
  const conversations: InstanceType<typeof Conversation>[] = [];

  beforeAll(async () => {
    server = await mock.createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 });
    process.env['CLICKY_MOCK_URL'] = server.url;
  });

  afterAll(async () => {
    delete process.env['CLICKY_MOCK_URL'];
    await server.close();
  });

  afterEach(() => {
    for (const c of conversations.splice(0)) c.close();
    ctl.snap = async () => ctl.noMatch;
    ctl.rest = async () => null;
    ctl.snapQueries.length = 0;
    ctl.restQueries.length = 0;
    ctl.restQuota = false;
    ctl.restUsedPercent = null;
    ctl.codexInfo = null;
    delete process.env['CLICKY_NO_REST_GROUND'];
    delete process.env['CLICKY_NO_CODEX_SUB'];
    server.clientEvents.length = 0;
  });

  function makeConversation(pointers: PointerCommand[]) {
    const conversation = new Conversation(fakeDeps(pointers));
    conversations.push(conversation);
    return conversation;
  }

  /** Ask the "point" scenario and wait for exactly one pointer command. */
  async function askAndAwaitPointer(
    conversation: InstanceType<typeof Conversation>,
    pointers: PointerCommand[],
  ): Promise<AnimateCommand> {
    await conversation.askText('point at the button please');
    await vi.waitFor(() => expect(pointers.length).toBe(1), { timeout: 4_000 });
    const cmd = pointers[0]!;
    expect(cmd.type).toBe('animate');
    return cmd as AnimateCommand;
  }

  it('UIA hit: pointer at the snapped element, no REST call', async () => {
    ctl.snap = async () => ({
      ...ctl.noMatch,
      matched: true,
      point: { x: 600, y: 450 }, // physical px; identity DIP mock
      name: 'The Button',
      score: 1,
      candidates: 3,
    });
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    const cmd = await askAndAwaitPointer(conversation, pointers);

    expect(cmd.groundingSource).toBe('uia');
    expect(cmd.restUsed).toBe(false);
    expect(cmd.restMs).toBeUndefined();
    expect(ctl.restQueries).toHaveLength(0);
    expect(cmd.points[0]!.x).toBeCloseTo(600, 5);
    expect(cmd.points[0]!.y).toBeCloseTo(450, 5);
    // Debug surface carries the attribution.
    const debug = conversation.debugInfo();
    expect((debug.lastPointer as AnimateCommand).groundingSource).toBe('uia');
  });

  it('UIA miss -> REST ground with the SAME screenshot jpeg the model saw', async () => {
    ctl.rest = async () => ({ x: 512, y: 288 }); // image px -> DIP x1.25
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    const cmd = await askAndAwaitPointer(conversation, pointers);

    expect(ctl.snapQueries).toHaveLength(1);
    expect(ctl.restQueries).toHaveLength(1);
    // The REST layer gets the exact turn capture: same jpeg, same dims,
    // and the model's own spoken label.
    expect(ctl.restQueries[0]).toEqual({
      jpegBase64: JPEG_B64,
      imageW: 2048,
      imageH: 1152,
      label: 'the button',
    });
    expect(cmd.groundingSource).toBe('rest');
    expect(cmd.restUsed).toBe(true);
    expect(cmd.restMs).toBeTypeOf('number');
    // Grounded image point mapped like a model point: (512,288) -> (640,360) DIP.
    expect(cmd.points[0]!.x).toBeCloseTo(640, 5);
    expect(cmd.points[0]!.y).toBeCloseTo(360, 5);
    // The label chip keeps the model's words.
    expect(cmd.points[0]!.label).toBe('the button');
  });

  it("REST null -> raw model point (today's fallback)", async () => {
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    const cmd = await askAndAwaitPointer(conversation, pointers);

    expect(ctl.restQueries).toHaveLength(1);
    expect(cmd.groundingSource).toBe('raw');
    expect(cmd.restUsed).toBe(true);
    expect(cmd.restMs).toBeTypeOf('number');
    // Mock scenario points at the center of screen0: (1024,576) -> (1280,720) DIP.
    expect(cmd.points[0]!.x).toBeCloseTo(1280, 5);
    expect(cmd.points[0]!.y).toBeCloseTo(720, 5);
  });

  it('a superseding turn while REST grounding runs drops the pointer', async () => {
    let resolveRest: ((r: { x: number; y: number }) => void) | null = null;
    ctl.rest = () =>
      new Promise((resolve) => {
        resolveRest = resolve;
      });
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);

    await conversation.askText('point at the button please');
    await vi.waitFor(() => expect(ctl.restQueries.length).toBe(1), { timeout: 4_000 });
    // Supersede the turn while the grounding call is still in flight.
    await conversation.askText('hello there friend');
    resolveRest!({ x: 512, y: 288 });
    // Give the (dropped) dispatch every chance to misbehave.
    await new Promise((r) => setTimeout(r, 200));
    expect(pointers).toHaveLength(0);
  });

  it('CLICKY_NO_REST_GROUND=1 skips the REST layer (raw fallback, restUsed false)', async () => {
    process.env['CLICKY_NO_REST_GROUND'] = '1';
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    const cmd = await askAndAwaitPointer(conversation, pointers);

    expect(ctl.snapQueries).toHaveLength(1); // snap still runs
    expect(ctl.restQueries).toHaveLength(0); // rest does not
    expect(cmd.groundingSource).toBe('raw');
    expect(cmd.restUsed).toBe(false);
    expect(cmd.restMs).toBeUndefined();
    expect(cmd.points[0]!.x).toBeCloseTo(1280, 5);
  });

  // -------------------------------------------------------------------------
  // M13-core: ChatGPT-subscription grounding transport + fail-closed quota
  // -------------------------------------------------------------------------

  /** A signed-in, valid Codex sub (token far from expiry). */
  function signedInCodex(): void {
    ctl.codexInfo = {
      accessToken: 'codex-bearer',
      accountId: 'acct-123',
      planType: 'pro',
      expiresAt: Date.now() + 99 * 3_600_000,
    };
  }

  it('Codex sub signed in -> grounds via the codex backend (preferred over the key)', async () => {
    signedInCodex();
    ctl.rest = async () => ({ x: 512, y: 288 });
    ctl.restUsedPercent = { primary: 12, secondary: 3 };
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    const cmd = await askAndAwaitPointer(conversation, pointers);

    expect(cmd.groundingSource).toBe('rest');
    expect(cmd.restUsed).toBe(true);
    // Attribution records the CODEX backend + the plan usage headers.
    const debug = conversation.debugInfo();
    expect(debug.lastGrounding?.backend).toBe('codex');
    expect(debug.lastGrounding?.quotaExhausted).toBe(false);
    expect(debug.lastGrounding?.usedPercent).toEqual({ primary: 12, secondary: 3 });
    // Grounded point mapped like a model point: (512,288) -> (640,360) DIP.
    expect(cmd.points[0]!.x).toBeCloseTo(640, 5);
  });

  it('CLICKY_NO_CODEX_SUB=1 forces the metered API key even when signed in', async () => {
    process.env['CLICKY_NO_CODEX_SUB'] = '1';
    signedInCodex();
    ctl.rest = async () => ({ x: 512, y: 288 });
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    await askAndAwaitPointer(conversation, pointers);

    expect(conversation.debugInfo().lastGrounding?.backend).toBe('apiKey');
  });

  it('FAIL CLOSED: codex plan quota -> raw model point, no metered-key fallback', async () => {
    signedInCodex();
    ctl.restQuota = true; // 429/quota-classified
    ctl.rest = async () => ({ x: 512, y: 288 }); // would-be point, must be ignored
    ctl.restUsedPercent = { primary: 100, secondary: 87 };
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    const cmd = await askAndAwaitPointer(conversation, pointers);

    // The RAW model point is flown (center of screen0 -> (1280,720) DIP) —
    // the metered key is NOT consulted for this call.
    expect(cmd.groundingSource).toBe('raw');
    expect(ctl.restQueries).toHaveLength(1); // exactly one transport tried
    const debug = conversation.debugInfo();
    expect(debug.lastGrounding?.backend).toBe('codex');
    expect(debug.lastGrounding?.quotaExhausted).toBe(true);
    expect(debug.lastGrounding?.usedPercent).toEqual({ primary: 100, secondary: 87 });
    expect(cmd.points[0]!.x).toBeCloseTo(1280, 5);
  });

  it('FAIL CLOSED: surfaces the codex_plan_limit copy to the transcript (once)', async () => {
    signedInCodex();
    ctl.restQuota = true;
    ctl.rest = async () => ({ x: 512, y: 288 });
    const pointers: PointerCommand[] = [];
    const conversation = makeConversation(pointers);
    await askAndAwaitPointer(conversation, pointers);

    const planLimits = conversation
      .transcript()
      .filter((e) => e.role === 'system' && e.text.includes('chatgpt plan limit'));
    expect(planLimits).toHaveLength(1);
    expect(planLimits[0]!.text).toBe(
      "you've hit your chatgpt plan limit for now — i'll point from memory. try again " +
        'later, or add an openai key in settings.',
    );
  });
});
