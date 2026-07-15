import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../src/main/capture';
import type { ChatGptCodexAuthSource } from '../src/main/auth/auth-source';
import type { WindowsInputController } from '../src/main/computer/windows-input';
import {
  ComputerUseOperator,
  parseClickArgs,
  parsePressKeysArgs,
  parseTypeTextArgs,
} from '../src/main/computer/operator';
import { CodexResponsesSession } from '../src/main/codex/responses-session';

/** DIP -> physical injection (replaces the old vi.mock('electron') seam). */
const dipToScreenPoint = ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 });

const AUTH: ChatGptCodexAuthSource = {
  kind: 'chatgptCodex',
  getBearer: async () => 'token',
  accountId: 'acct',
  planType: 'plus',
};

const CAPTURE: CaptureResult = {
  meta: {
    screenIndex: 0,
    displayId: 1,
    imageW: 100,
    imageH: 100,
    displayBounds: { x: 0, y: 0, width: 100, height: 100 },
    scaleFactor: 2,
    isActive: true,
  },
  jpegBase64: 'ZmFrZQ==',
};

function response(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('ComputerUseOperator', () => {
  it('lets Sol choose one click, captures again, and continues in priority fast mode', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const clicks: unknown[][] = [];
    let request = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      request += 1;
      if (request === 1) {
        return response([
          {
            type: 'response.output_item.added',
            item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'click_at' },
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'fc1',
            arguments: '{"screen":0,"x":25,"y":50,"label":"save"}',
          },
          { type: 'response.completed', response: { id: 'r1' } },
        ]);
      }
      return response([
        { type: 'response.output_text.done', item_id: 'm2', text: 'saved it.' },
        { type: 'response.completed', response: { id: 'r2' } },
      ]);
    });
    const input = {
      click: async (...args: unknown[]) => {
        clicks.push(args);
      },
      typeText: async () => undefined,
      pressKeys: async () => undefined,
    } as unknown as WindowsInputController;
    let captures = 0;
    const operator = new ComputerUseOperator({
      auth: AUTH,
      input,
      initialCaptures: [CAPTURE],
      isAllowed: () => true,
      dipToScreenPoint,
      capture: async () => {
        captures += 1;
        return [CAPTURE];
      },
      buildSession: (auth) =>
        new CodexResponsesSession({
          auth,
          instructions: 'operator',
          tools: [],
          serviceTier: 'priority',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          env: {},
        }),
    });

    const result = await operator.run('click save');
    expect(result).toEqual({ ok: true, summary: 'saved it.', actions: 1, quotaExhausted: false });
    expect(clicks).toEqual([[50, 100, 'left', 1]]);
    expect(captures).toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body['model'] === 'gpt-5.6-sol')).toBe(true);
    expect(bodies.every((body) => body['service_tier'] === 'priority')).toBe(true);
    const secondInput = bodies[1]!['input'] as Array<Record<string, unknown>>;
    expect(secondInput.at(-2)).toMatchObject({ type: 'function_call_output', call_id: 'call1' });
    expect(JSON.stringify(secondInput.at(-1))).toContain('data:image/jpeg;base64,ZmFrZQ==');
  });

  it('fails closed before inference when the setting is not allowed', async () => {
    const input = {} as WindowsInputController;
    const operator = new ComputerUseOperator({
      auth: AUTH,
      input,
      initialCaptures: [CAPTURE],
      isAllowed: () => false,
      dipToScreenPoint,
    });
    await expect(operator.run('click')).resolves.toMatchObject({ ok: false, actions: 0 });
  });
});

describe('parseClickArgs', () => {
  it('accepts a full click and defaults button/count/label', () => {
    expect(parseClickArgs({ screen: 0, x: 25, y: 50, label: 'save' })).toEqual({
      ok: true,
      value: { screen: 0, x: 25, y: 50, button: 'left', count: 1, label: 'save' },
    });
    expect(parseClickArgs({ screen: 1, x: 2, y: 3, button: 'right', count: 2 })).toEqual({
      ok: true,
      value: { screen: 1, x: 2, y: 3, button: 'right', count: 2, label: '' },
    });
  });

  it('caps the echoed label at 200 chars and ignores bogus button/count', () => {
    const parsed = parseClickArgs({
      screen: 0,
      x: 1,
      y: 1,
      label: 'x'.repeat(300),
      button: 'nuke',
      count: 7,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.label).toHaveLength(200);
      expect(parsed.value.button).toBe('left');
      expect(parsed.value.count).toBe(1);
    }
  });

  it('rejects missing/non-finite coordinates and non-record args', () => {
    expect(parseClickArgs({ screen: 0, x: 1 })).toEqual({
      ok: false,
      error: 'screen, x, and y must be numbers',
    });
    expect(parseClickArgs({ screen: 0, x: Number.NaN, y: 1 })).toEqual({
      ok: false,
      error: 'screen, x, and y must be numbers',
    });
    expect(parseClickArgs([1, 2])).toEqual({ ok: false, error: 'arguments were not valid json' });
  });
});

describe('parseTypeTextArgs', () => {
  it('accepts literal text up to the cap', () => {
    expect(parseTypeTextArgs({ text: 'hello' })).toEqual({ ok: true, value: { text: 'hello' } });
    expect(parseTypeTextArgs({ text: 'x'.repeat(10_000) }).ok).toBe(true);
  });

  it('rejects non-strings and over-long text', () => {
    const error = 'text must be at most 10000 characters';
    expect(parseTypeTextArgs({ text: 42 })).toEqual({ ok: false, error });
    expect(parseTypeTextArgs({})).toEqual({ ok: false, error });
    expect(parseTypeTextArgs({ text: 'x'.repeat(10_001) })).toEqual({ ok: false, error });
  });
});

describe('parsePressKeysArgs', () => {
  it('accepts one to eight strings', () => {
    expect(parsePressKeysArgs({ keys: ['ENTER'] })).toEqual({
      ok: true,
      value: { keys: ['ENTER'] },
    });
    expect(parsePressKeysArgs({ keys: ['CTRL', 'L'] }).ok).toBe(true);
  });

  it('rejects empty, oversized, and mixed-type arrays', () => {
    const error = 'keys must be an array of one to eight strings';
    expect(parsePressKeysArgs({ keys: [] })).toEqual({ ok: false, error });
    expect(parsePressKeysArgs({ keys: Array.from({ length: 9 }, () => 'A') })).toEqual({
      ok: false,
      error,
    });
    expect(parsePressKeysArgs({ keys: ['CTRL', 4] })).toEqual({ ok: false, error });
    expect(parsePressKeysArgs({ keys: 'ENTER' })).toEqual({ ok: false, error });
  });
});
