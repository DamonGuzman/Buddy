/**
 * M13-core: the ChatGPT-subscription (Codex) grounding transport in
 * rest-grounder.ts. Fully offline (mocked fetch, synthetic SSE bodies).
 *
 * Covers:
 * - the request shape: chatgpt.com/backend-api/codex/responses, gpt-5.6-sol,
 *   message-LIST input (input_text + input_image), stream/store/reasoning,
 *   NO request-level text.format, and the proven headers (Authorization,
 *   ChatGPT-Account-Id, Accept SSE, OpenAI-Beta, originator, User-Agent),
 * - SSE parsing (deltas + response.completed) with tolerant JSON,
 * - usage + x-codex-*-used-percent header surfacing,
 * - quota 429 -> quotaExhausted (point null); streamed usage-limit error too,
 * - timeout / garbage / out-of-bounds -> null (never throws),
 * - mock mode (CLICKY_MOCK_URL) -> source 'none', no fetch,
 * - the token appears in the Authorization header ONLY.
 */

import { describe, expect, it } from 'vitest';
import {
  RestGrounder,
  parseCodexStream,
  parseTolerantPoint,
  parseUsedPercent,
} from '../src/main/grounding/rest-grounder';
import type { RestGrounderOptions } from '../src/main/grounding/rest-grounder';
import type { AuthSource } from '../src/main/auth/auth-source';

const QUERY = { jpegBase64: 'ZmFrZS1qcGVn', imageW: 2048, imageH: 1152, label: 'the save button' };

const CODEX_AUTH: AuthSource = {
  kind: 'chatgptCodex',
  getBearer: async () => 'codex-bearer-tok',
  accountId: 'acct-1',
  planType: 'pro',
};

/** Build an SSE body from a list of event objects. */
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** A completed-response event carrying the given final text + usage. */
function completed(text: string): unknown {
  return {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
      usage: { input_tokens: 2700, output_tokens: 8, total_tokens: 2708 },
    },
  };
}

function response(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    text: async () => body,
  } as unknown as Response;
}

function makeGrounder(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<RestGrounderOptions> = {},
): RestGrounder {
  return new RestGrounder({
    getApiKey: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('Codex transport: success + request shape', () => {
  it('grounds via chatgpt.com/backend-api/codex with the proven request', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const grounder = makeGrounder(async (url, init) => {
      calls.push({ url, init });
      return response(
        sse([
          { type: 'response.output_text.delta', delta: '{"x":' },
          { type: 'response.output_text.delta', delta: '640,"y":360}' },
          completed('{"x":640,"y":360}'),
        ]),
        {
          headers: {
            'x-codex-primary-used-percent': '12.5',
            'x-codex-secondary-used-percent': '4',
          },
        },
      );
    });

    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toEqual({ x: 640, y: 360 });
    expect(outcome.source).toBe('codex');
    expect(outcome.quotaExhausted).toBe(false);
    expect(outcome.usedPercent).toEqual({ primary: 12.5, secondary: 4 });
    expect(outcome.usage).toEqual({ inputTokens: 2700, outputTokens: 8, totalTokens: 2708 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer codex-bearer-tok');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-1');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(headers['originator']).toBe('codex_cli_rs');
    expect(headers['User-Agent']).toContain('codex_cli_rs/');

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-5.6-sol');
    expect(body['stream']).toBe(true);
    expect(body['store']).toBe(false);
    expect(body['reasoning']).toEqual({ effort: 'low' });
    // NO request-level text.format on this endpoint (prompt-enforced JSON).
    expect(body['text']).toBeUndefined();
    // input MUST be a message LIST with input_text + input_image.
    const input = body['input'] as {
      type: string;
      role: string;
      content: { type: string; text?: string; image_url?: string }[];
    }[];
    expect(Array.isArray(input)).toBe(true);
    expect(input[0]!.type).toBe('message');
    expect(input[0]!.role).toBe('user');
    expect(input[0]!.content.find((p) => p.type === 'input_image')!.image_url).toBe(
      `data:image/jpeg;base64,${QUERY.jpegBase64}`,
    );
    const ask = input[0]!.content.find((p) => p.type === 'input_text')!.text!;
    expect(ask).toContain('the save button');
    // The bearer appears in the Authorization header ONLY.
    expect(calls[0]!.init.body as string).not.toContain('codex-bearer-tok');
  });

  it('takes the final text from response.completed and tolerates a code fence', async () => {
    const grounder = makeGrounder(async () =>
      response(sse([completed('```json\n{"x":10,"y":20}\n```')])),
    );
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toEqual({ x: 10, y: 20 });
  });

  it('falls back to accumulated deltas when no completed event carries text', async () => {
    const grounder = makeGrounder(async () =>
      response(
        sse([
          { type: 'response.output_text.delta', delta: 'here: {"x":5,' },
          { type: 'response.output_text.delta', delta: '"y":6} ok' },
        ]),
      ),
    );
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toEqual({ x: 5, y: 6 });
  });
});

describe('Codex transport: null + quota paths', () => {
  it('returns source none and does NOT fetch in mock mode', async () => {
    let fetched = 0;
    const grounder = makeGrounder(
      async () => {
        fetched += 1;
        return response(sse([completed('{"x":1,"y":1}')]));
      },
      { env: { CLICKY_MOCK_URL: 'ws://127.0.0.1:9' } },
    );
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome).toEqual({
      point: null,
      source: 'none',
      quotaExhausted: false,
      usedPercent: null,
    });
    expect(fetched).toBe(0);
  });

  it('classifies a 429 as quota exhausted (point null, fail-closed flag)', async () => {
    const grounder = makeGrounder(async () =>
      response('', { status: 429, headers: { 'x-codex-primary-used-percent': '100' } }),
    );
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toBeNull();
    expect(outcome.quotaExhausted).toBe(true);
    expect(outcome.usedPercent).toEqual({ primary: 100, secondary: null });
  });

  it('classifies a streamed usage-limit error event as quota exhausted', async () => {
    const grounder = makeGrounder(async () =>
      response(
        sse([
          {
            type: 'response.failed',
            error: { code: 'usage_limit_reached', message: 'plan quota' },
          },
        ]),
      ),
    );
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toBeNull();
    expect(outcome.quotaExhausted).toBe(true);
  });

  it('returns null (not quota) on a generic HTTP 500', async () => {
    const grounder = makeGrounder(async () => response('', { status: 500 }));
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toBeNull();
    expect(outcome.quotaExhausted).toBe(false);
  });

  it('returns null on a timeout (abort respected, no hang)', async () => {
    const grounder = makeGrounder(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
      { timeoutMs: 40 },
    );
    const t0 = Date.now();
    const outcome = await grounder.ground(QUERY, CODEX_AUTH);
    expect(outcome.point).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('returns null on garbage / out-of-bounds coordinates', async () => {
    for (const text of ['not json', '{"x":"a","y":"b"}', '{"x":9999,"y":10}', '{"x":10,"y":-5}']) {
      const grounder = makeGrounder(async () => response(sse([completed(text)])));
      expect((await grounder.ground(QUERY, CODEX_AUTH)).point).toBeNull();
    }
  });

  it('never throws when getBearer rejects (not signed in)', async () => {
    const grounder = makeGrounder(async () => response(sse([completed('{"x":1,"y":1}')])));
    const failing: AuthSource = {
      kind: 'chatgptCodex',
      getBearer: async () => {
        throw new Error('codex sub not signed in');
      },
      accountId: '',
      planType: '',
    };
    const outcome = await grounder.ground(QUERY, failing);
    expect(outcome).toEqual({
      point: null,
      source: 'codex',
      quotaExhausted: false,
      usedPercent: null,
    });
  });
});

describe('pure parsers', () => {
  it('parseTolerantPoint strips fences, extracts embedded JSON, bounds-checks', () => {
    expect(parseTolerantPoint('{"x":3,"y":4}', 100, 100)).toEqual({ x: 3, y: 4 });
    expect(parseTolerantPoint('```json\n{"x":3,"y":4}\n```', 100, 100)).toEqual({ x: 3, y: 4 });
    expect(parseTolerantPoint('the point is {"x":3,"y":4} ok', 100, 100)).toEqual({ x: 3, y: 4 });
    expect(parseTolerantPoint('{"x":300,"y":4}', 100, 100)).toBeNull(); // OOB
    expect(parseTolerantPoint('no json here', 100, 100)).toBeNull();
  });

  it('parseCodexStream ignores [DONE] and unknown events, keeps the last text', () => {
    const body =
      sse([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: '{"x":1,"y":2}' },
        completed('{"x":7,"y":8}'),
      ]) + 'data: [DONE]\n\n';
    const r = parseCodexStream(body, 100, 100);
    expect(r.point).toEqual({ x: 7, y: 8 });
    expect(r.usage).toEqual({ inputTokens: 2700, outputTokens: 8, totalTokens: 2708 });
    expect(r.quotaExhausted).toBe(false);
  });

  it('parseUsedPercent reads the two headers (null when absent/unparsable)', () => {
    expect(parseUsedPercent(new Headers({ 'x-codex-primary-used-percent': '42' }))).toEqual({
      primary: 42,
      secondary: null,
    });
    expect(parseUsedPercent(new Headers({ 'x-codex-secondary-used-percent': 'nope' }))).toEqual({
      primary: null,
      secondary: null,
    });
  });
});
