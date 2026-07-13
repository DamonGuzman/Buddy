import { describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../src/main/agents/manager';
import { MockAgentBackend } from '../src/main/agents/mock-backend';
import { CodexAgentBackend } from '../src/main/agents/backend';
import { findAgentTool } from '../src/main/agents/tools';
import type { AgentBackend, AgentBackendRequest, AgentBackendResult, AgentBrief, AgentToolContext } from '../src/main/agents/types';

function brief(id: string): AgentBrief {
  return { id, task: `research ${id}`, recentTranscript: '', createdAt: Date.now() };
}

describe('Agent Mode runtime', () => {
  it('runs the deterministic research loop to completion and pushes renderer-safe summaries', async () => {
    const updates: unknown[] = [];
    let finished = '';
    const manager = new AgentManager({
      backend: new MockAgentBackend(),
      isReady: () => true,
      onAgentsChanged: (list) => updates.push(list),
      onFinished: (summary) => { finished = summary.id; },
    });
    expect(manager.spawn(brief('agent_1'))).toEqual({ ok: true, agentId: 'agent_1' });
    await vi.waitFor(() => expect(finished).toBe('agent_1'));
    const record = manager.list()[0]!;
    expect(record.status).toBe('done');
    expect(record.summary).toContain('mock research run completed');
    expect(record.output).toContain('mock research checked');
    expect(record.sources).toEqual(['https://example.com/mock-source']);
    expect(record.steps.map((step) => step.kind)).toEqual(['search', 'note']);
    expect(updates.length).toBeGreaterThan(2);
  });

  it('continues past twelve tool rounds until the backend finishes', async () => {
    let requests = 0;
    let finished = false;
    const backend: AgentBackend = {
      async request(): Promise<AgentBackendResult> {
        requests += 1;
        if (requests <= 15) {
          const callId = `note_${requests}`;
          return {
            ok: true,
            outputItems: [{
              type: 'function_call',
              call_id: callId,
              name: 'scratchpad_write',
              arguments: JSON.stringify({ text: `round ${requests}` }),
            }],
            text: '',
            functionCalls: [{
              callId,
              name: 'scratchpad_write',
              argsJson: JSON.stringify({ text: `round ${requests}` }),
            }],
            searchQueries: [],
            citations: [],
            usedPercent: null,
          };
        }
        return {
          ok: true,
          outputItems: [],
          text: 'finished after the old round ceiling',
          functionCalls: [],
          searchQueries: [],
          citations: [],
          usedPercent: null,
        };
      },
    };
    const manager = new AgentManager({
      backend,
      isReady: () => true,
      onAgentsChanged: () => {},
      onFinished: () => { finished = true; },
    });

    expect(manager.spawn(brief('unbounded'))).toEqual({ ok: true, agentId: 'unbounded' });
    await vi.waitFor(() => expect(finished).toBe(true));

    const record = manager.list()[0]!;
    expect(requests).toBe(16);
    expect(record.status).toBe('done');
    expect(record.step).toBe(16);
    expect(record.maxSteps).toBeNull();
    expect(record.summary).toContain('finished after the old round ceiling');
  });

  it('fails closed when signed out and enforces the three-agent cap', async () => {
    const signedOut = new AgentManager({
      backend: new MockAgentBackend(), isReady: () => false, onAgentsChanged: () => {}, onFinished: () => {},
    });
    expect(signedOut.spawn(brief('nope'))).toEqual({ ok: false, reason: 'not_signed_in' });

    const blocking: AgentBackend = {
      request: (req) => new Promise<AgentBackendResult>((resolve) => {
        req.signal.addEventListener('abort', () => resolve({ ok: false, errorKind: 'agent_backend_down', detail: 'aborted', retryable: false }), { once: true });
      }),
    };
    const manager = new AgentManager({
      backend: blocking, isReady: () => true, onAgentsChanged: () => {}, onFinished: () => {},
    });
    expect(manager.spawn(brief('a')).ok).toBe(true);
    expect(manager.spawn(brief('b')).ok).toBe(true);
    expect(manager.spawn(brief('c')).ok).toBe(true);
    expect(manager.spawn(brief('d'))).toEqual({ ok: false, reason: 'at_capacity' });
    manager.cancelAll();
    await vi.waitFor(() => expect(manager.list().every((item) => item.status === 'cancelled')).toBe(true));
  });

  it('blocks localhost/private web fetches before network access', async () => {
    const tool = findAgentTool('web_fetch')!;
    const ctx: AgentToolContext = {
      brief: brief('safe'),
      signal: new AbortController().signal,
      scratchpad: { get: () => '', set: () => {}, append: () => {} },
      addSource: () => {}, fetchCount: () => 0, noteFetch: () => {},
    };
    await expect(tool.execute({ url: 'http://127.0.0.1:8199/state' }, ctx)).rejects.toThrow('private addresses are blocked');
    await expect(tool.execute({ url: 'http://localhost/secret' }, ctx)).rejects.toThrow('local addresses are blocked');
  });
});

describe('CodexAgentBackend wire contract', () => {
  it('uses store:false, hosted web_search, and accumulates streamed calls/citations', async () => {
    let body: Record<string, unknown> | null = null;
    const events = [
      { type: 'response.web_search_call.searching', item: { action: { query: 'best monitor' } } },
      { type: 'response.output_text.annotation.added', annotation: { url: 'https://example.com/review' } },
      { type: 'response.output_item.added', item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'scratchpad_write', arguments: '{"text":"note"}' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc1', arguments: '{"text":"note"}' },
      { type: 'response.output_text.delta', delta: 'working' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ];
    const raw = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const backend = new CodexAgentBackend(
      { getCodexAuth: () => ({ accessToken: 'secret', accountId: 'acct', planType: 'pro', expiresAt: Date.now() + 60_000 }), getBearer: async () => 'secret' },
      (async (_url, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(raw, { status: 200, headers: { 'x-codex-primary-used-percent': '5' } });
      }) as typeof fetch,
    );
    const req: AgentBackendRequest = {
      model: 'gpt-5.6-sol', instructions: 'research', input: [], tools: [{ type: 'web_search' }], effort: 'medium', signal: new AbortController().signal,
    };
    const result = await backend.request(req);
    expect(body?.['store']).toBe(false);
    expect(body?.['previous_response_id']).toBeUndefined();
    expect(body?.['tools']).toEqual([{ type: 'web_search' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.searchQueries).toEqual(['best monitor']);
    expect(result.citations).toEqual(['https://example.com/review']);
    expect(result.functionCalls[0]?.name).toBe('scratchpad_write');
    expect(result.text).toBe('working');
  });
});
