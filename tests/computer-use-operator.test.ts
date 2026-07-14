import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../src/main/capture';
import type { ChatGptCodexAuthSource } from '../src/main/auth/auth-source';
import type { WindowsInputController } from '../src/main/computer/windows-input';

vi.mock('electron', () => ({
  screen: {
    dipToScreenPoint: ({ x, y }: { x: number; y: number }) => ({ x: x * 2, y: y * 2 }),
  },
}));

const { ComputerUseOperator } = await import('../src/main/computer/operator');
const { CodexResponsesSession } = await import('../src/main/codex/responses-session');

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
    });
    await expect(operator.run('click')).resolves.toMatchObject({ ok: false, actions: 0 });
  });
});
