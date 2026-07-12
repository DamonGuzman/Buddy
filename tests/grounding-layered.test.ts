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
 * Electron, capture, snapper and rest-grounder are mocked; the
 * RealtimeSession is REAL, talking to the in-process mock server whose
 * "point" scenario calls point_at at the center of screen0 with label
 * "the button".
 */

import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PointerCommand } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Controllable grounding layers (hoisted for the vi.mock factories)
// ---------------------------------------------------------------------------

const ctl = vi.hoisted(() => {
  const noMatch = {
    matched: false,
    point: null,
    name: null,
    score: null,
    elapsedMs: 5,
    daemonMs: 5,
    candidates: 0,
    timedOut: false,
  };
  return {
    noMatch,
    snapQueries: [] as unknown[],
    snap: (async () => noMatch) as (q: unknown) => Promise<unknown>,
    restQueries: [] as { jpegBase64: string; imageW: number; imageH: number; label: string }[],
    rest: (async () => null) as (q: unknown) => Promise<{ x: number; y: number } | null>,
  };
});

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

vi.mock('../src/main/grounding/snapper', () => ({
  GroundingService: class {
    warmUp(): void {}
    dispose(): void {}
    snap(q: unknown): Promise<unknown> {
      ctl.snapQueries.push(q);
      return ctl.snap(q);
    }
  },
}));

vi.mock('../src/main/grounding/rest-grounder', () => ({
  RestGrounder: class {
    groundWithModel(q: unknown): Promise<{ x: number; y: number } | null> {
      ctl.restQueries.push(q as (typeof ctl.restQueries)[number]);
      return ctl.rest(q);
    }
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
const mock = require('../tools/mock-realtime/server') as typeof import('../tools/mock-realtime/server');
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

// ---------------------------------------------------------------------------

type AnimateCommand = Extract<PointerCommand, { type: 'animate' }>;

function fakeDeps(pointers: PointerCommand[]) {
  const settings = {
    get: () => ({
      apiKeyPresent: false,
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      captionsEnabled: false,
      micDeviceId: '',
      hotkeyLabel: 'Ctrl+Alt',
    }),
    getApiKey: () => null, // mock mode: the session needs no key
    onChange: () => () => {},
  };
  const overlays = {
    broadcast: () => {},
    routePointer: (cmd: PointerCommand) => pointers.push(cmd),
    count: () => 1,
  };
  const panel = { send: () => {} };
  return { settings: settings as never, overlays: overlays as never, panel: panel as never };
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
    delete process.env['CLICKY_NO_REST_GROUND'];
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

  it('REST null -> raw model point (today\'s fallback)', async () => {
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
});
