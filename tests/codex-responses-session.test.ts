/**
 * M18: CodexResponsesSession — the reusable Codex Responses conversational
 * client. Fully offline (mocked fetch, synthetic SSE bodies).
 *
 * Covers:
 * - the request shape: chatgpt.com/backend-api/codex/responses, gpt-5.6-sol,
 *   message-list input (input_text + input_image), tools + tool_choice,
 *   stream/store/reasoning, client-side history replay, proven headers,
 * - streaming text accumulation (onTextDelta full-so-far + onTextDone),
 * - function-call parse (item metadata + arg deltas) + tool-output continue,
 * - multi-turn client-side history replay across submit()s,
 * - quota (429 + streamed usage-limit) -> quotaExhausted,
 * - cancel() aborts + stops emitting; mock mode -> no fetch,
 * - the bearer token appears in the Authorization header ONLY.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CodexResponsesSession,
  parseUsage,
  parseUsedPercent,
} from '../src/main/codex/responses-session';
import type {
  CodexResponsesCallbacks,
  CodexResponsesSessionOptions,
} from '../src/main/codex/responses-session';
import type { ChatGptCodexAuthSource } from '../src/main/auth/auth-source';

const AUTH: ChatGptCodexAuthSource = {
  kind: 'chatgptCodex',
  getBearer: async () => 'codex-bearer-tok',
  accountId: 'acct-1',
  planType: 'pro',
};

/** Build an SSE body from a list of event objects. */
function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/** A response.completed event carrying a response id + usage. */
function completed(id = 'resp_1', usage?: unknown): unknown {
  return {
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      usage: usage ?? {
        input_tokens: 2863,
        output_tokens: 18,
        total_tokens: 2881,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  };
}

/** A Response-like object whose body streams the given SSE string in chunks. */
function streamResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string>; chunks?: number } = {},
): Response {
  const status = init.status ?? 200;
  const bytes = new TextEncoder().encode(body);
  const n = init.chunks ?? 3;
  const size = Math.max(1, Math.ceil(bytes.length / n));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return {
    ok: status < 400,
    status,
    headers: new Headers(init.headers ?? {}),
    body: stream,
    text: async () => body,
  } as unknown as Response;
}

function makeSession(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<CodexResponsesSessionOptions> = {},
): CodexResponsesSession {
  return new CodexResponsesSession({
    auth: AUTH,
    instructions: 'you are clicky',
    tools: [
      { type: 'function', name: 'point_at', description: 'point', parameters: { type: 'object' } },
    ],
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------

describe('CodexResponsesSession: request shape + text streaming', () => {
  it('POSTs the proven request and streams text deltas (full-so-far) + done', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const session = makeSession(async (url, init) => {
      calls.push({ url, init });
      return streamResponse(
        sse([
          { type: 'response.created', response: { id: 'resp_1' } },
          { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
          { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'hey ' },
          { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'there' },
          { type: 'response.output_text.done', item_id: 'msg_1', text: 'hey there' },
          completed('resp_1'),
        ]),
        { headers: { 'x-codex-primary-used-percent': '7', 'x-codex-secondary-used-percent': '2' } },
      );
    });

    const deltas: string[] = [];
    let doneText = '';
    let completedInfo: { responseId: string | null } | null = null;
    const cb: CodexResponsesCallbacks = {
      onTextDelta: (_id, full) => deltas.push(full),
      onTextDone: (_id, text) => (doneText = text),
      onCompleted: (info) => (completedInfo = info),
    };
    const result = await session.submit({ text: 'hi', images: [{ jpegBase64: 'ZmFrZQ==' }] }, cb);

    // Full-so-far accumulation.
    expect(deltas).toEqual(['hey ', 'hey there']);
    expect(doneText).toBe('hey there');
    expect(completedInfo).not.toBeNull();
    expect(result.responseId).toBe('resp_1');
    expect(result.usage).toEqual({
      inputTokens: 2863,
      outputTokens: 18,
      totalTokens: 2881,
      reasoningTokens: 0,
    });
    expect(result.usedPercent).toEqual({ primary: 7, secondary: 2 });
    expect(result.quotaExhausted).toBe(false);
    expect(result.functionCalls).toBe(0);

    // Request shape + headers.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer codex-bearer-tok');
    expect(headers['ChatGPT-Account-Id']).toBe('acct-1');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(headers['originator']).toBe('codex_cli_rs');
    expect(headers['User-Agent']).toContain('codex_cli_rs/');

    const bodyStr = calls[0]!.init.body as string;
    const body = JSON.parse(bodyStr) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-5.6-sol');
    expect(body['stream']).toBe(true);
    expect(body['store']).toBe(false);
    expect(body['reasoning']).toEqual({ effort: 'low' });
    expect(body['tool_choice']).toBe('auto');
    expect(Array.isArray(body['tools'])).toBe(true);
    expect(body['previous_response_id']).toBeUndefined();
    const input = body['input'] as { type: string; role: string; content: { type: string }[] }[];
    expect(input[0]!.type).toBe('message');
    expect(input[0]!.role).toBe('user');
    expect(input[0]!.content.some((p) => p.type === 'input_image')).toBe(true);
    expect(input[0]!.content.some((p) => p.type === 'input_text')).toBe(true);
    // NO-TOKEN-LEAK: the bearer is in the header only, never the body.
    expect(bodyStr).not.toContain('codex-bearer-tok');
  });

  it('flushes onTextDone from accumulated deltas when no explicit done event', async () => {
    const session = makeSession(async () =>
      streamResponse(
        sse([
          { type: 'response.output_text.delta', item_id: 'm', delta: 'partial ' },
          { type: 'response.output_text.delta', item_id: 'm', delta: 'answer' },
          completed('resp_x'),
        ]),
      ),
    );
    let done = '';
    await session.submit({ text: 'q' }, { onTextDone: (_id, t) => (done = t) });
    expect(done).toBe('partial answer');
  });
});

describe('CodexResponsesSession: function calls + tool-output continue', () => {
  it('emits onFunctionCall with call_id/name from output_item.added + arg deltas', async () => {
    const session = makeSession(async () =>
      streamResponse(
        sse([
          {
            type: 'response.output_item.added',
            item: { id: 'fc_1', type: 'function_call', call_id: 'call_abc', name: 'point_at', arguments: '' },
          },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"x":10,' },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"y":20,"screen":0}' },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_1',
            arguments: '{"x":10,"y":20,"screen":0}',
          },
          completed('resp_fc'),
        ]),
      ),
    );
    const calls: { callId: string; name: string; argsJson: string }[] = [];
    const result = await session.submit({ text: 'point' }, { onFunctionCall: (c) => calls.push(c) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      callId: 'call_abc',
      name: 'point_at',
      argsJson: '{"x":10,"y":20,"screen":0}',
    });
    expect(result.functionCalls).toBe(1);
  });

  it('continue() replays history and POSTs the buffered function_call_output', async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const session = makeSession(async (_url, init) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      call += 1;
      if (call === 1) {
        return streamResponse(
          sse([
            {
              type: 'response.output_item.added',
              item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'point_at' },
            },
            { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"x":1,"y":2,"screen":0}' },
            completed('resp_1'),
          ]),
        );
      }
      return streamResponse(
        sse([
          { type: 'response.output_text.delta', item_id: 'm2', delta: 'done pointing' },
          { type: 'response.output_text.done', item_id: 'm2', text: 'done pointing' },
          completed('resp_2'),
        ]),
      );
    });

    const first = await session.submit({ text: 'point at it' }, {});
    expect(first.functionCalls).toBe(1);
    expect(session.hasPendingToolOutputs()).toBe(false);

    session.sendToolOutput('call_1', { ok: true, pointed_at: 'the button' });
    expect(session.hasPendingToolOutputs()).toBe(true);

    let finalText = '';
    const second = await session.continue({ onTextDone: (_id, t) => (finalText = t) });
    expect(finalText).toBe('done pointing');
    expect(second.responseId).toBe('resp_2');

    // The backend rejects previous_response_id, so the full client history is replayed.
    expect(bodies[1]!['previous_response_id']).toBeUndefined();
    const contInput = bodies[1]!['input'] as { type: string; call_id?: string; output?: string }[];
    expect(contInput.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
    ]);
    expect(contInput[2]!.call_id).toBe('call_1');
    expect(contInput[2]!.output).toContain('the button');
  });

  it('continue() with nothing buffered is a no-op (no fetch)', async () => {
    let fetched = 0;
    const session = makeSession(async () => {
      fetched += 1;
      return streamResponse(sse([completed()]));
    });
    const r = await session.continue({});
    expect(fetched).toBe(0);
    expect(r.responseId).toBeNull();
  });
});

describe('CodexResponsesSession: multi-turn continuity', () => {
  it('replays client-side user and assistant history across submit() turns', async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const session = makeSession(async (_url, init) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      n += 1;
      return streamResponse(sse([
        { type: 'response.output_text.done', item_id: `m_${n}`, text: `answer ${n}` },
        completed(`resp_${n}`),
      ]));
    });
    await session.submit({ text: 'first' }, {});
    await session.submit({ text: 'second' }, {});
    await session.submit({ text: 'third' }, {});
    expect(bodies.every((body) => body['previous_response_id'] === undefined)).toBe(true);
    expect((bodies[0]!['input'] as unknown[])).toHaveLength(1);
    expect((bodies[1]!['input'] as unknown[])).toHaveLength(3);
    expect((bodies[2]!['input'] as unknown[])).toHaveLength(5);
    // reset() forgets the thread.
    session.reset();
    await session.submit({ text: 'fresh' }, {});
    expect((bodies[3]!['input'] as unknown[])).toHaveLength(1);
  });
});

describe('CodexResponsesSession: quota + failure paths', () => {
  it('classifies a 429 as quotaExhausted (fail-closed, no text)', async () => {
    const session = makeSession(async () =>
      streamResponse('', { status: 429, headers: { 'x-codex-primary-used-percent': '100' } }),
    );
    let errored = false;
    const result = await session.submit({ text: 'q' }, { onError: () => (errored = true) });
    expect(result.quotaExhausted).toBe(true);
    expect(result.usedPercent).toEqual({ primary: 100, secondary: null });
    expect(errored).toBe(true);
  });

  it('classifies a streamed usage-limit error as quotaExhausted', async () => {
    const session = makeSession(async () =>
      streamResponse(
        sse([{ type: 'response.failed', error: { code: 'usage_limit_reached', message: 'plan quota' } }]),
      ),
    );
    const result = await session.submit({ text: 'q' }, {});
    expect(result.quotaExhausted).toBe(true);
  });

  it('never throws when getBearer rejects (not signed in)', async () => {
    const session = makeSession(async () => streamResponse(sse([completed()])), {
      auth: {
        kind: 'chatgptCodex',
        getBearer: async () => {
          throw new Error('codex sub not signed in');
        },
        accountId: '',
        planType: '',
      },
    });
    let err: Error | null = null;
    const result = await session.submit({ text: 'q' }, { onError: (e) => (err = e) });
    expect(result.error).not.toBeNull();
    expect(err).not.toBeNull();
    expect(result.responseId).toBeNull();
  });

  it('returns source none and does NOT fetch in mock mode', async () => {
    let fetched = 0;
    const session = makeSession(
      async () => {
        fetched += 1;
        return streamResponse(sse([completed()]));
      },
      { env: { CLICKY_MOCK_URL: 'ws://127.0.0.1:9' } },
    );
    const result = await session.submit({ text: 'q' }, {});
    expect(fetched).toBe(0);
    expect(result.error).not.toBeNull();
  });
});

describe('CodexResponsesSession: cancellation', () => {
  it('cancel() aborts the in-flight request and stops emitting', async () => {
    let abortSeen = false;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const session = makeSession(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          started();
          init.signal?.addEventListener('abort', () => {
            abortSeen = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const deltas: string[] = [];
    const p = session.submit({ text: 'q' }, { onTextDelta: (_id, f) => deltas.push(f) });
    await startedP; // the fetch is now in flight
    session.cancel();
    const result = await p;
    expect(abortSeen).toBe(true);
    expect(result.aborted).toBe(true);
    expect(result.error).toBeNull(); // an abort is not surfaced as an error
    expect(deltas).toHaveLength(0);
  });
});

describe('CodexResponsesSession: pure parsers', () => {
  it('parseUsage reads Responses-API token fields incl. reasoning', () => {
    expect(
      parseUsage({ input_tokens: 100, output_tokens: 5, total_tokens: 105, output_tokens_details: { reasoning_tokens: 3 } }),
    ).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105, reasoningTokens: 3 });
    expect(parseUsage(null)).toBeNull();
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
