import { describe, expect, it, vi } from 'vitest';
import type { ChatGptCodexAuthSource } from '../src/main/auth/auth-source';
import type { CodexFunctionCall, CodexTurnResult } from '../src/main/codex/responses-session';
import {
  CodexActionReviewer,
  markEvidenceBitmap,
  parseReviewVerdict,
  sanitizePayloadFields,
  type ActionReviewEvidence,
} from '../src/main/agents/gate/reviewer';

const AUTH: ChatGptCodexAuthSource = {
  kind: 'chatgptCodex',
  accountId: 'account-1',
  planType: 'pro',
  getBearer: async () => 'secret-bearer',
};

function result(overrides: Partial<CodexTurnResult> = {}): CodexTurnResult {
  return {
    responseId: 'response-1',
    usage: null,
    usedPercent: null,
    quotaExhausted: false,
    aborted: false,
    functionCalls: 1,
    error: null,
    ...overrides,
  };
}

function evidence(overrides: Partial<ActionReviewEvidence> = {}): ActionReviewEvidence {
  return {
    userRequest: 'Send the finished launch note to alice@example.com.',
    taskClaim: 'Send the launch note.',
    agentId: 'agent-1',
    actionName: 'click',
    actionArgs: { x: 40, y: 30, label: 'Send' },
    justification: 'This sends the note requested by the user.',
    facts: {
      tag: 'button',
      text: 'Send',
      inForm: true,
      url: 'https://mail.example.test/compose',
      frame: 'top',
    },
    screenshot: {
      base64: 'ZmFrZQ==',
      mimeType: 'image/jpeg',
      width: 100,
      height: 80,
      target: { x: 40, y: 30 },
    },
    payloadFields: [
      { name: 'To', value: 'alice@example.com' },
      { name: 'Body', value: 'launch note' },
      { name: 'Password', value: 'do-not-send', type: 'password' },
    ],
    ...overrides,
  };
}

function call(args: object): CodexFunctionCall {
  return {
    callId: 'call-1',
    name: 'record_review_verdict',
    argsJson: JSON.stringify(args),
  };
}

const MARKER = async () => ({ jpegBase64: 'bWFya2Vk', pngBase64: 'cG5nIQ==' });

describe('CodexActionReviewer', () => {
  it('uses a fresh forced-schema session and preserves the user request as the sole authority', async () => {
    const turns: { context?: string; images?: { jpegBase64: string }[] }[] = [];
    let sessions = 0;
    const reviewer = new CodexActionReviewer({
      auth: AUTH,
      markScreenshot: MARKER,
      sessionFactory: () => {
        sessions += 1;
        return {
          submit: async (turn, callbacks) => {
            turns.push(turn);
            callbacks.onFunctionCall?.(
              call({ verdict: 'approve', reason: 'recipient and content match', concern: '' }),
            );
            return result();
          },
        };
      },
    });

    const first = await reviewer.review(evidence());
    const second = await reviewer.review(evidence({ justification: 'a second agent claim' }));

    expect(sessions).toBe(2);
    expect(first.verdict).toEqual({ verdict: 'approve', reason: 'recipient and content match' });
    expect(first.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.payloadDigest).toContain('Password: [redacted]');
    expect(first.markedScreenshotPng).toBe('cG5nIQ==');
    expect(second.evidenceDigest).not.toBe(first.evidenceDigest);

    const context = turns[0]?.context ?? '';
    expect(context).toContain('exact_user_request');
    expect(context).toContain('Send the finished launch note to alice@example.com.');
    expect(context).toContain('acting_agent_claims');
    expect(context).toContain('Password');
    expect(context).not.toContain('do-not-send');
    expect(turns[0]?.images).toEqual([{ jpegBase64: 'bWFya2Vk' }]);
  });

  it.each([
    ['timeout', result({ aborted: true })],
    ['transport error', result({ error: new Error('offline') })],
    ['quota', result({ quotaExhausted: true })],
    ['missing call', result({ functionCalls: 0 })],
  ])('fails closed to escalation on %s', async (_name, response) => {
    const reviewer = new CodexActionReviewer({
      auth: AUTH,
      markScreenshot: MARKER,
      sessionFactory: () => ({ submit: async () => response }),
    });
    const assessed = await reviewer.review(evidence());
    expect(assessed.verdict.verdict).toBe('escalate');
  });

  it('fails closed on malformed or extra verdict properties', async () => {
    const reviewer = new CodexActionReviewer({
      auth: AUTH,
      markScreenshot: MARKER,
      sessionFactory: () => ({
        submit: async (_turn, callbacks) => {
          callbacks.onFunctionCall?.(
            call({ verdict: 'approve', reason: 'ok', concern: '', surprise: true }),
          );
          return result();
        },
      }),
    });
    expect((await reviewer.review(evidence())).verdict.verdict).toBe('escalate');
  });

  it('sends a strict forced verdict tool through the production Codex transport', async () => {
    let body: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const events = [
        {
          type: 'response.output_item.added',
          item: {
            id: 'fc-1',
            type: 'function_call',
            call_id: 'call-1',
            name: 'record_review_verdict',
          },
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc-1',
          arguments: JSON.stringify({
            verdict: 'deny',
            reason: 'wrong recipient',
            concern: '',
          }),
        },
        {
          type: 'response.completed',
          response: { id: 'response-1', status: 'completed' },
        },
      ];
      const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(sse, { status: 200 });
    });
    const reviewer = new CodexActionReviewer({
      auth: AUTH,
      fetchImpl: fetchImpl as typeof fetch,
      env: {},
      markScreenshot: MARKER,
    });

    expect((await reviewer.review(evidence())).verdict).toEqual({
      verdict: 'deny',
      reason: 'wrong recipient',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(body?.['tool_choice']).toEqual({
      type: 'function',
      name: 'record_review_verdict',
    });
    expect(body?.['reasoning']).toEqual({ effort: 'low' });
    expect(body?.['service_tier']).toBe('priority');
    const tools = (body?.['tools'] ?? []) as Record<string, unknown>[];
    expect(tools[0]?.['strict']).toBe(true);
    expect((tools[0]?.['parameters'] as Record<string, unknown>)['additionalProperties']).toBe(
      false,
    );
    expect(JSON.stringify(body)).not.toContain('secret-bearer');
  });
});

describe('reviewer evidence helpers', () => {
  it('strictly parses verdicts', () => {
    expect(parseReviewVerdict('{"verdict":"approve","reason":"aligned","concern":""}')).toEqual({
      verdict: 'approve',
      reason: 'aligned',
    });
    expect(
      parseReviewVerdict('{"verdict":"escalate","reason":"aligned","concern":"money"}'),
    ).toEqual({ verdict: 'escalate', reason: 'aligned', concern: 'money' });
    expect(parseReviewVerdict('{"verdict":"escalate","reason":"aligned","concern":""}')).toBeNull();
    expect(parseReviewVerdict('{"verdict":"approve","reason":"","concern":""}')).toBeNull();
  });

  it('redacts credentials and card-number-shaped values', () => {
    expect(
      sanitizePayloadFields([
        { name: 'api token', value: 'top-secret' },
        { name: 'card', value: '4242 4242 4242 4242' },
        { name: 'title', value: 'safe' },
      ]),
    ).toEqual([
      { name: 'api token', value: '[redacted]' },
      { name: 'card', value: '[redacted]' },
      { name: 'title', value: 'safe' },
    ]);
  });

  it.each([
    '-----BEGIN PRIVATE KEY-----\nnever expose\n-----END PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturevalue',
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'access_token=oauth-code-ABCDEF1234567890',
    '123-45-6789',
    '021000021',
    'ABCD-EFGH-IJKL-MNOP',
    'aB9xQ2mN7vR4pL8sT1wY6zK3',
  ])('redacts value-shaped secrets even under a generic field name', (secret) => {
    expect(sanitizePayloadFields([{ name: 'value', value: secret }])).toEqual([
      { name: 'value', value: '[redacted]' },
    ]);
  });

  it('never places raw secret-shaped payloads in reviewer context or digests', async () => {
    const contexts: string[] = [];
    const secret = '-----BEGIN PRIVATE KEY-----\nnever expose\n-----END PRIVATE KEY-----';
    const reviewer = new CodexActionReviewer({
      auth: AUTH,
      markScreenshot: MARKER,
      sessionFactory: () => ({
        submit: async (turn, callbacks) => {
          contexts.push(turn.context ?? '');
          callbacks.onFunctionCall?.(
            call({ verdict: 'deny', reason: 'secret entry is prohibited', concern: '' }),
          );
          return result();
        },
      }),
    });
    const reviewed = await reviewer.review(
      evidence({
        actionName: 'type',
        actionArgs: { text: secret },
        justification: `type ${secret}`,
        taskClaim: `use ${secret}`,
        facts: { ...evidence().facts!, text: secret },
        recentSteps: [{ kind: 'action', label: `copied ${secret}` }],
        payloadFields: [{ name: 'generic value', value: secret }],
      }),
    );
    expect(contexts[0]).not.toContain('never expose');
    expect(contexts[0]).toContain('[redacted]');
    expect(reviewed.payloadDigest).toEqual(['generic value: [redacted]']);
  });

  it('marks an exact target in a copied Electron BGRA bitmap', () => {
    const width = 100;
    const height = 80;
    const original = Buffer.alloc(width * height * 4, 0xaa);
    const marked = markEvidenceBitmap(original, width, height, { x: 40, y: 30 });
    const center = (30 * width + 40) * 4;
    expect([...marked.subarray(center, center + 4)]).toEqual([0x30, 0x3b, 0xff, 0xff]);
    expect([...marked.subarray(0, 4)]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
    expect([...original.subarray(center, center + 4)]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
  });
});
