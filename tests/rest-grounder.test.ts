/**
 * M10 REST grounding fallback tests (rest-grounder.ts), all offline:
 * - the request replicates the COORD-STUDY §8 winning protocol (gpt-5.4-mini,
 *   reasoning effort low, bare image as a data URI, strict-JSON PIXEL coords),
 * - null (never throw) on: no key, mock mode, timeout, HTTP error, garbage
 *   output, out-of-bounds coordinates, concurrent call,
 * - the API key is sent in the Authorization header only.
 */

import { describe, expect, it } from 'vitest';
import { RestGrounder, parseGroundingResponse } from '../src/main/grounding/rest-grounder';
import type { RestGrounderOptions } from '../src/main/grounding/rest-grounder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const QUERY = { jpegBase64: 'ZmFrZS1qcGVn', imageW: 2048, imageH: 1152, label: 'the save button' };

/** Minimal Responses-API payload with the point in a message output item. */
function responsesPayload(text: string): unknown {
  return {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ],
  };
}

function okResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

function makeGrounder(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<RestGrounderOptions> = {},
): RestGrounder {
  return new RestGrounder({
    getApiKey: () => 'sk-test-key',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    env: {}, // no CLICKY_MOCK_URL leakage from the test runner env
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Success path + protocol shape
// ---------------------------------------------------------------------------

describe('RestGrounder: success path', () => {
  it('returns the pixel point and sends the COORD-STUDY winning protocol', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const grounder = makeGrounder(async (url, init) => {
      calls.push({ url, init });
      return okResponse(responsesPayload('{"x":123,"y":456}'));
    });

    const result = await grounder.groundWithModel({ ...QUERY, spokenContext: 'click save' });
    expect(result).toEqual({ x: 123, y: 456 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-key');
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    // The §9 winner, exactly: gpt-5.4-mini, low effort, strict JSON schema,
    // bare image as data URI, PIXEL coordinates (no normalization anywhere).
    expect(body['model']).toBe('gpt-5.4-mini');
    expect(body['reasoning']).toEqual({ effort: 'low' });
    const text = body['text'] as { format: Record<string, unknown> };
    expect(text.format['type']).toBe('json_schema');
    expect(text.format['strict']).toBe(true);
    expect(text.format['schema']).toEqual({
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
      additionalProperties: false,
    });
    const input = body['input'] as {
      role: string;
      content: { type: string; text?: string; image_url?: string }[];
    }[];
    expect(input[0]!.content.find((p) => p.type === 'input_image')!.image_url).toBe(
      `data:image/jpeg;base64,${QUERY.jpegBase64}`,
    );
    const ask = input[0]!.content.find((p) => p.type === 'input_text')!.text!;
    expect(ask).toContain('pixel coordinates of the center of: the save button');
    expect(ask).toContain('2048x1152');
    expect(ask).toContain('context: click save');
    expect(JSON.stringify(body)).not.toMatch(/normaliz|0-1000/i);
    // The key appears in the Authorization header ONLY.
    expect(JSON.stringify(body)).not.toContain('sk-test-key');
  });

  it('accepts the aggregate output_text convenience field', async () => {
    const grounder = makeGrounder(async () =>
      okResponse({ output_text: '{"x":1,"y":1}', output: [] }),
    );
    expect(await grounder.groundWithModel(QUERY)).toEqual({ x: 1, y: 1 });
  });

  it('accepts edge coordinates (0,0) and (imageW,imageH)', async () => {
    const g1 = makeGrounder(async () => okResponse(responsesPayload('{"x":0,"y":0}')));
    expect(await g1.groundWithModel(QUERY)).toEqual({ x: 0, y: 0 });
    const g2 = makeGrounder(async () => okResponse(responsesPayload('{"x":2048,"y":1152}')));
    expect(await g2.groundWithModel(QUERY)).toEqual({ x: 2048, y: 1152 });
  });
});

// ---------------------------------------------------------------------------
// Null paths (never throw)
// ---------------------------------------------------------------------------

describe('RestGrounder: null paths', () => {
  it('returns null without fetching when no API key is configured', async () => {
    let fetched = 0;
    const grounder = makeGrounder(
      async () => {
        fetched += 1;
        return okResponse(responsesPayload('{"x":1,"y":1}'));
      },
      { getApiKey: () => null },
    );
    expect(await grounder.groundWithModel(QUERY)).toBeNull();
    expect(fetched).toBe(0);
  });

  it('returns null without fetching in mock mode (CLICKY_MOCK_URL)', async () => {
    let fetched = 0;
    const grounder = makeGrounder(
      async () => {
        fetched += 1;
        return okResponse(responsesPayload('{"x":1,"y":1}'));
      },
      { env: { CLICKY_MOCK_URL: 'ws://127.0.0.1:9' } },
    );
    expect(await grounder.groundWithModel(QUERY)).toBeNull();
    expect(fetched).toBe(0);
  });

  it('returns null on timeout (abort respected, no hang)', async () => {
    const grounder = makeGrounder(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          );
        }),
      { timeoutMs: 40 },
    );
    const t0 = Date.now();
    expect(await grounder.groundWithModel(QUERY)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('returns null on an HTTP error status', async () => {
    const grounder = makeGrounder(async () => {
      return {
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'quota' } }),
      } as unknown as Response;
    });
    expect(await grounder.groundWithModel(QUERY)).toBeNull();
  });

  it('returns null on garbage output (non-JSON text, wrong types, empty)', async () => {
    for (const text of ['not json at all', '{"x":"left","y":"top"}', '{"only":"noise"}', '']) {
      const grounder = makeGrounder(async () => okResponse(responsesPayload(text)));
      expect(await grounder.groundWithModel(QUERY)).toBeNull();
    }
    const weird = makeGrounder(async () => okResponse({ totally: 'unexpected' }));
    expect(await weird.groundWithModel(QUERY)).toBeNull();
  });

  it('returns null on out-of-bounds coordinates', async () => {
    for (const text of [
      '{"x":5000,"y":100}',
      '{"x":100,"y":5000}',
      '{"x":-3,"y":100}',
      '{"x":100,"y":-1}',
    ]) {
      const grounder = makeGrounder(async () => okResponse(responsesPayload(text)));
      expect(await grounder.groundWithModel(QUERY)).toBeNull();
    }
  });

  it('never throws when fetch itself rejects or throws', async () => {
    const rejecting = makeGrounder(async () => {
      throw new Error('network down');
    });
    expect(await rejecting.groundWithModel(QUERY)).toBeNull();
  });

  it('allows only one in-flight call (second returns null immediately)', async () => {
    let release: (() => void) | null = null;
    const grounder = makeGrounder(
      (_url, _init) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(okResponse(responsesPayload('{"x":9,"y":9}')));
        }),
    );
    const first = grounder.groundWithModel(QUERY);
    // Give the first call a tick to reach fetch.
    await new Promise((r) => setTimeout(r, 10));
    expect(await grounder.groundWithModel(QUERY)).toBeNull(); // busy
    release!();
    expect(await first).toEqual({ x: 9, y: 9 });
    // And the guard resets afterwards.
    const again = makeGrounder(async () => okResponse(responsesPayload('{"x":2,"y":2}')));
    expect(await again.groundWithModel(QUERY)).toEqual({ x: 2, y: 2 });
  });
});

// ---------------------------------------------------------------------------
// parseGroundingResponse (pure)
// ---------------------------------------------------------------------------

describe('parseGroundingResponse', () => {
  it('walks output items past reasoning to the message text', () => {
    expect(parseGroundingResponse(responsesPayload('{"x":7,"y":8}'), 100, 100)).toEqual({
      x: 7,
      y: 8,
    });
  });

  it('rejects non-object payloads and non-finite coords', () => {
    expect(parseGroundingResponse(null, 100, 100)).toBeNull();
    expect(parseGroundingResponse('nope', 100, 100)).toBeNull();
    expect(parseGroundingResponse(responsesPayload('{"x":null,"y":3}'), 100, 100)).toBeNull();
  });
});
