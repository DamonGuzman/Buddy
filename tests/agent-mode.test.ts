import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldRetry } from '../src/main/agents/agent';
import { AgentManager } from '../src/main/agents/manager';
import { MockAgentBackend } from '../src/main/agents/mock-backend';
import { CodexAgentBackend } from '../src/main/agents/backend';
import { agentToolDefinitions, findAgentTool } from '../src/main/agents/tools';
import type {
  AgentBackend,
  AgentBackendRequest,
  AgentBackendResult,
  AgentBrief,
  AgentBrowserDeps,
  AgentPersistencePort,
  AgentToolContext,
  AgentToolDefinition,
} from '../src/main/agents/types';
import type { AgentSummary } from '../src/shared/types';
import { AGENT_MANAGER_DISPOSE_TIMEOUT_MS } from '../src/main/agents/config';
import { readActivityDescription } from '../src/main/agents/tools/activity-description';
import { AgentTools } from '../src/main/conversation/agent-tools';
import { TranscriptStore } from '../src/main/conversation/transcript-store';

afterEach(() => {
  vi.useRealTimers();
});

function brief(id: string): AgentBrief {
  return {
    id,
    userRequest: `research ${id}`,
    task: `research ${id}`,
    recentTranscript: '',
    createdAt: Date.now(),
    browserEnabled: false,
  };
}

describe('Agent Mode runtime', () => {
  it('runs the deterministic research loop to completion and pushes renderer-safe summaries', async () => {
    const updates: unknown[] = [];
    let finished = '';
    const manager = new AgentManager({
      backend: new MockAgentBackend(),
      isReady: () => true,
      onAgentsChanged: (list) => updates.push(list),
      onFinished: (summary) => {
        finished = summary.id;
      },
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
      isReady: () => true,
      async request(): Promise<AgentBackendResult> {
        requests += 1;
        if (requests <= 15) {
          const callId = `note_${requests}`;
          const args = {
            description: 'saving the latest findings',
            text: `round ${requests}`,
          };
          return {
            ok: true,
            outputItems: [
              {
                type: 'function_call',
                call_id: callId,
                name: 'scratchpad_write',
                arguments: JSON.stringify(args),
              },
            ],
            text: '',
            functionCalls: [
              {
                callId,
                name: 'scratchpad_write',
                argsJson: JSON.stringify(args),
              },
            ],
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
      onFinished: () => {
        finished = true;
      },
    });

    expect(manager.spawn(brief('unbounded'))).toEqual({ ok: true, agentId: 'unbounded' });
    await vi.waitFor(() => expect(finished).toBe(true));

    const record = manager.list()[0]!;
    expect(requests).toBe(16);
    expect(record.status).toBe('done');
    expect(record.step).toBe(16);
    expect(record.summary).toContain('finished after the old round ceiling');
  });

  it('fails closed when signed out and admits helpers without a concurrency ceiling', async () => {
    const signedOut = new AgentManager({
      backend: new MockAgentBackend(),
      isReady: () => false,
      onAgentsChanged: () => {},
      onFinished: () => {},
    });
    expect(signedOut.spawn(brief('nope'))).toEqual({ ok: false, reason: 'not_signed_in' });

    const blocking: AgentBackend = {
      isReady: () => true,
      request: (req) =>
        new Promise<AgentBackendResult>((resolve) => {
          req.signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                errorKind: 'agent_backend_down',
                detail: 'aborted',
                retryable: false,
              }),
            { once: true },
          );
        }),
    };
    const manager = new AgentManager({
      backend: blocking,
      isReady: () => true,
      onAgentsChanged: () => {},
      onFinished: () => {},
    });
    for (let index = 0; index < 25; index += 1) {
      expect(manager.spawn(brief(`parallel-${index}`))).toEqual({
        ok: true,
        agentId: `parallel-${index}`,
      });
    }
    expect(manager.list()).toHaveLength(25);
    manager.cancelAll();
    await vi.waitFor(() =>
      expect(manager.list().every((item) => item.status === 'cancelled')).toBe(true),
    );
  });

  it('routes web search through Firecrawl and records returned sources', async () => {
    const tool = findAgentTool('web_search')!;
    const search = vi.fn(
      async (_query: string, _options: Record<string, unknown>, _signal: AbortSignal) => ({
        success: true,
        data: { web: [{ url: 'https://example.com/article', markdown: 'full article' }] },
      }),
    );
    const sources: string[] = [];
    const ctx: AgentToolContext = {
      brief: brief('safe'),
      signal: new AbortController().signal,
      scratchpad: { get: () => '', set: () => {}, append: () => {} },
      addSource: (url) => sources.push(url),
      firecrawl: {
        search,
        scrape: vi.fn(),
        map: vi.fn(),
        crawl: vi.fn(),
        batchScrape: vi.fn(),
        research: vi.fn(),
      },
    };
    await expect(tool.execute({ query: 'recent articles' }, ctx)).resolves.toContain(
      'full article',
    );
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[1]).toMatchObject({
      sources: [{ type: 'web' }, { type: 'news' }],
      scrapeOptions: { onlyMainContent: true },
    });
    expect(sources).toEqual(['https://example.com/article']);
  });

  it('the mock backend reports itself ready (no sign-in required)', () => {
    expect(new MockAgentBackend().isReady()).toBe(true);
  });

  it('exposes every Firecrawl tool to research, browser, and filesystem agents', () => {
    const firecrawlNames = [
      'web_search',
      'web_scrape',
      'web_map',
      'web_crawl',
      'web_batch_scrape',
      'web_research',
    ];
    for (const definitions of [
      agentToolDefinitions(false, false),
      agentToolDefinitions(true, false),
      agentToolDefinitions(false, true),
    ]) {
      const names = definitions.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(firecrawlNames));
    }
    for (const name of firecrawlNames) {
      expect(findAgentTool(name, false, true)?.definition.name).toBe(name);
    }
  });

  it('requires a short plain-language description on every helper function tool', () => {
    const definitions = [
      ...agentToolDefinitions(false, false),
      ...agentToolDefinitions(true, false),
      ...agentToolDefinitions(false, true),
    ].filter(
      (tool): tool is Extract<AgentToolDefinition, { type: 'function' }> =>
        tool.type === 'function',
    );
    const uniqueDefinitions = new Map(definitions.map((tool) => [tool.name, tool]));
    expect([...uniqueDefinitions.keys()].sort()).toEqual([
      'browser_click',
      'browser_navigate',
      'browser_press_keys',
      'browser_screenshot',
      'browser_scroll',
      'browser_type',
      'needs_user',
      'present_file',
      'read_screen',
      'run_shell',
      'run_staged_shell',
      'scratchpad_write',
      'stage_paths',
      'web_batch_scrape',
      'web_crawl',
      'web_map',
      'web_research',
      'web_scrape',
      'web_search',
      'workspace_changes',
    ]);
    for (const tool of uniqueDefinitions.values()) {
      const properties = tool.parameters['properties'] as Record<string, unknown>;
      const required = tool.parameters['required'] as unknown[];
      expect(properties['description'], tool.name).toMatchObject({
        type: 'string',
        minLength: 3,
        maxLength: 120,
      });
      expect(required, tool.name).toContain('description');
    }
  });

  it('normalizes readable descriptions and rejects verbose or technical progress copy', () => {
    expect(readActivityDescription({ description: '  checking\n  the project files  ' })).toEqual({
      ok: true,
      description: 'checking the project files',
    });
    expect(readActivityDescription({ description: 'checking files' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('3 to 12 simple words'),
    });
    expect(
      readActivityDescription({ description: 'opening https://example.com for the user' }),
    ).toMatchObject({ ok: false, error: 'description must not include a URL' });
    expect(
      readActivityDescription({
        description:
          'checking every available project file before deciding which specific part needs attention next today',
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('3 to 12 simple words') });
  });

  it('persists terminal summaries through an injected persistence port', async () => {
    let saved: AgentSummary[] = [];
    const store: AgentPersistencePort = {
      load: () => null,
      save: (records) => {
        saved = records;
      },
    };
    let finished = false;
    const manager = new AgentManager({
      backend: new MockAgentBackend(),
      isReady: () => true,
      persistence: store,
      onAgentsChanged: () => {},
      onFinished: () => {
        finished = true;
      },
    });
    expect(manager.spawn(brief('persist_me')).ok).toBe(true);
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(saved.map((item) => item.id)).toEqual(['persist_me']);
    expect(saved[0]?.status).toBe('done');
    expect(saved[0]?.finishedAt).toBeDefined();

    // A fresh manager reloads from the same port; malformed rows are dropped.
    const reloaded = new AgentManager({
      backend: new MockAgentBackend(),
      isReady: () => true,
      persistence: {
        load: () => [
          ...saved,
          { id: 'bogus', task: 42 },
          {
            id: 'bad_status',
            task: 'x',
            status: 'exploded',
            createdAt: 1,
            spoken: false,
            unseen: false,
            steps: [],
          },
        ],
        save: () => {},
      },
      onAgentsChanged: () => {},
      onFinished: () => {},
    });
    expect(reloaded.list().map((item) => item.id)).toEqual(['persist_me']);
  });

  it('a throwing persistence port never takes down spawn/persist', async () => {
    let finished = false;
    const manager = new AgentManager({
      backend: new MockAgentBackend(),
      isReady: () => true,
      persistence: {
        load: () => {
          throw new Error('corrupt');
        },
        save: () => {
          throw new Error('disk full');
        },
      },
      onAgentsChanged: () => {},
      onFinished: () => {
        finished = true;
      },
    });
    expect(manager.spawn(brief('fragile')).ok).toBe(true);
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(manager.list()[0]?.status).toBe('done');
  });

  it('disposes active runners and suppresses lifecycle callbacks after shutdown begins', async () => {
    const changed = vi.fn();
    const finished = vi.fn();
    const backend: AgentBackend = {
      isReady: () => true,
      request: (request) =>
        new Promise<AgentBackendResult>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                errorKind: 'agent_backend_down',
                detail: 'aborted for shutdown',
                retryable: false,
              }),
            { once: true },
          );
        }),
    };
    const manager = new AgentManager({
      backend,
      isReady: () => true,
      onAgentsChanged: changed,
      onFinished: finished,
    });
    expect(manager.spawn(brief('shutdown')).ok).toBe(true);
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('running'));
    const callbacksBeforeDispose = changed.mock.calls.length;

    await manager.dispose();

    expect(manager.list()[0]?.status).toBe('cancelled');
    expect(changed).toHaveBeenCalledTimes(callbacksBeforeDispose);
    expect(finished).not.toHaveBeenCalled();
    expect(() => manager.spawn(brief('too_late'))).toThrow('agent manager is disposed');
  });

  it('fails manager disposal within a finite bound when a backend ignores abort', async () => {
    vi.useFakeTimers();
    const manager = new AgentManager({
      backend: {
        isReady: () => true,
        request: () => new Promise<AgentBackendResult>(() => undefined),
      },
      isReady: () => true,
      onAgentsChanged: () => undefined,
      onFinished: () => undefined,
    });
    expect(manager.spawn(brief('stuck-shutdown')).ok).toBe(true);
    const disposal = manager.dispose();
    const rejection = expect(disposal).rejects.toThrow('agent manager disposal timed out');

    await vi.advanceTimersByTimeAsync(AGENT_MANAGER_DISPOSE_TIMEOUT_MS);

    await rejection;
  });

  it('joins a browser run cancelled during initial deliberation before profile clearing proceeds', async () => {
    const backend: AgentBackend = {
      isReady: () => true,
      request: (request) =>
        new Promise<AgentBackendResult>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                errorKind: 'agent_backend_down',
                detail: 'aborted before first browser action',
                retryable: false,
              }),
            { once: true },
          );
        }),
    };
    const createDriver = vi.fn(async () => {
      throw new Error('a driver must not be created after cancellation joined');
    });
    const browser: AgentBrowserDeps = {
      createDriver,
      gate: {
        execute: async () => {
          throw new Error('gate must not run');
        },
        resolveEscalation: async () => {
          throw new Error('gate must not run');
        },
        cancelAgent: () => undefined,
      },
      approvals: {
        request: async () => {
          throw new Error('approval must not be requested');
        },
        cancelAgent: () => undefined,
        get: () => null,
        resolve: async () => undefined,
      },
    };
    const manager = new AgentManager({
      backend,
      browser,
      isReady: () => true,
      onAgentsChanged: () => undefined,
      onFinished: () => undefined,
    });
    expect(manager.spawn({ ...brief('initial-browser-race'), browserEnabled: true })).toEqual({
      ok: true,
      agentId: 'initial-browser-race',
    });

    await manager.cancelBrowserRuns();

    expect(manager.list()[0]).toMatchObject({ status: 'cancelled' });
    expect(createDriver).not.toHaveBeenCalled();
  });

  it('atomically blocks browser admission through cancellation and destructive profile mutation', async () => {
    let mutationStarted = false;
    let finishMutation!: () => void;
    const mutationWait = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    const browser: AgentBrowserDeps = {
      createDriver: async () => {
        throw new Error('no browser action is expected');
      },
      gate: {
        execute: async () => {
          throw new Error('no gate action is expected');
        },
        resolveEscalation: async () => {
          throw new Error('no gate action is expected');
        },
        cancelAgent: () => undefined,
      },
      approvals: {
        request: async () => {
          throw new Error('no approval is expected');
        },
        cancelAgent: () => undefined,
        get: () => null,
        resolve: async () => undefined,
      },
    };
    const manager = new AgentManager({
      backend: new MockAgentBackend(),
      browser,
      isReady: () => true,
      onAgentsChanged: () => undefined,
      onFinished: () => undefined,
    });

    const mutation = manager.withBrowserAdmissionBlocked(async () => {
      mutationStarted = true;
      await mutationWait;
    });
    await vi.waitFor(() => expect(mutationStarted).toBe(true));

    expect(manager.spawn({ ...brief('blocked-browser-spawn'), browserEnabled: true })).toEqual({
      ok: false,
      reason: 'browser_unavailable',
    });
    expect(manager.spawn(brief('allowed-research-spawn'))).toEqual({
      ok: true,
      agentId: 'allowed-research-spawn',
    });
    await expect(manager.withBrowserAdmissionBlocked(async () => undefined)).rejects.toThrow(
      'a browser state mutation is already in progress',
    );

    finishMutation();
    await mutation;
    expect(manager.spawn({ ...brief('browser-after-mutation'), browserEnabled: true })).toEqual({
      ok: true,
      agentId: 'browser-after-mutation',
    });
    manager.cancelAll();
    await manager.dispose();
  });

  it('reports filesystem runtime unavailability without misclassifying it as sign-in failure', async () => {
    const transcript = new TranscriptStore(10, () => undefined);
    transcript.upsert({
      id: 'user_1',
      role: 'user',
      text: 'file the issue in linear',
      streaming: false,
      timestamp: Date.now(),
    });
    const surfaceError = vi.fn();
    const tools = new AgentTools({
      agents: {
        isReady: () => true,
        list: () => [],
        spawn: () => ({ ok: false, reason: 'filesystem_unavailable' }),
        markSpoken: () => undefined,
      },
      transcript,
      turnCaptures: () => [],
      noteOrigin: () => undefined,
      surfaceError,
      prepareFilesystem: async () => ({ taskId: 'task-1', rootName: 'project' }),
      failFilesystem: async () => undefined,
    });

    await expect(tools.spawnAgent({ task: 'edit the project' }, 'text')).resolves.toEqual({
      error: 'filesystem use is unavailable for background buddies right now',
    });
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it('does not reject foreground spawns when many helpers are already active', async () => {
    const transcript = new TranscriptStore(10, () => undefined);
    transcript.upsert({
      id: 'user_1',
      role: 'user',
      text: 'update the project',
      streaming: false,
      timestamp: Date.now(),
    });
    const spawn = vi.fn(() => ({ ok: true as const, agentId: 'new-helper' }));
    const tools = new AgentTools({
      agents: {
        isReady: () => true,
        list: () =>
          Array.from({ length: 100 }, (_, index) => ({
            id: `existing-${index}`,
            task: `existing task ${index}`,
            status: 'running' as const,
            createdAt: Date.now(),
            steps: [],
            spoken: false,
            unseen: false,
          })),
        spawn,
        markSpoken: () => undefined,
      },
      transcript,
      turnCaptures: () => [],
      noteOrigin: () => undefined,
      surfaceError: () => undefined,
      prepareFilesystem: async () => ({ taskId: 'task-new', rootName: 'project' }),
      failFilesystem: async () => undefined,
    });

    await expect(tools.spawnAgent({ task: 'update the project' }, 'text')).resolves.toEqual({
      ok: true,
      agent_id: 'new-helper',
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('never authorizes an agent from an older user turn while the latest request is streaming', async () => {
    const transcript = new TranscriptStore(10, () => undefined);
    transcript.upsert({
      id: 'user_old',
      role: 'user',
      text: 'send the payment',
      streaming: false,
      timestamp: 1,
    });
    transcript.upsert({
      id: 'user_current',
      role: 'user',
      text: '…',
      streaming: true,
      timestamp: 2,
    });
    const spawn = vi.fn(() => ({ ok: true as const, agentId: 'must-not-spawn' }));
    const tools = new AgentTools({
      agents: {
        isReady: () => true,
        list: () => [],
        spawn,
        markSpoken: () => undefined,
      },
      transcript,
      turnCaptures: () => [],
      noteOrigin: () => undefined,
      surfaceError: () => undefined,
      prepareFilesystem: async () => ({ taskId: 'must-not-prepare', rootName: 'project' }),
      failFilesystem: async () => undefined,
    });

    await expect(tools.spawnAgent({ task: 'send the payment' }, 'text')).resolves.toEqual({
      error: 'the original user request is still being transcribed',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('shouldRetry policy', () => {
  const ok: AgentBackendResult = {
    ok: true,
    outputItems: [],
    text: 'fine',
    functionCalls: [],
    searchQueries: [],
    citations: [],
    usedPercent: null,
  };
  const failure = (
    errorKind: 'agent_not_signed_in' | 'agent_quota' | 'agent_backend_down',
    retryable: boolean,
  ): AgentBackendResult => ({ ok: false, errorKind, detail: 'x', retryable });

  it('never retries successes or exhausted attempts', () => {
    expect(shouldRetry(ok, 0)).toBe(false);
    expect(shouldRetry(failure('agent_backend_down', true), 1)).toBe(false);
  });

  it('retries retryable failures and backend-down blips once', () => {
    expect(shouldRetry(failure('agent_backend_down', true), 0)).toBe(true);
    expect(shouldRetry(failure('agent_backend_down', false), 0)).toBe(true);
    expect(shouldRetry(failure('agent_quota', true), 0)).toBe(true);
  });

  it('stops immediately on non-retryable quota / sign-in failures', () => {
    expect(shouldRetry(failure('agent_quota', false), 0)).toBe(false);
    expect(shouldRetry(failure('agent_not_signed_in', false), 0)).toBe(false);
  });
});

describe('CodexAgentBackend wire contract', () => {
  it('uses store:false and sends Firecrawl web access only as client function tools', async () => {
    let body: Record<string, unknown> | null = null;
    const events = [
      {
        type: 'response.output_item.added',
        item: {
          id: 'fc1',
          type: 'function_call',
          call_id: 'call1',
          name: 'scratchpad_write',
          arguments: '{"text":"note"}',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: 'fc1',
        arguments: '{"text":"note"}',
      },
      { type: 'response.output_text.delta', delta: 'working' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
      },
    ];
    const raw = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const backend = new CodexAgentBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      (async (_url, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(raw, { status: 200, headers: { 'x-codex-primary-used-percent': '5' } });
      }) as typeof fetch,
    );
    const req: AgentBackendRequest = {
      model: 'gpt-5.6-sol',
      instructions: 'research',
      input: [],
      tools: [
        {
          type: 'function',
          name: 'web_search',
          description: 'Search through Firecrawl',
          parameters: { type: 'object' },
        },
      ],
      effort: 'medium',
      signal: new AbortController().signal,
    };
    const result = await backend.request(req);
    expect(body?.['store']).toBe(false);
    expect(body?.['previous_response_id']).toBeUndefined();
    expect(body?.['tools']).toEqual([
      expect.objectContaining({ type: 'function', name: 'web_search' }),
    ]);
    expect(JSON.stringify(body?.['tools'])).not.toContain('"type":"web_search"');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.searchQueries).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.functionCalls[0]?.name).toBe('scratchpad_write');
    expect(result.text).toBe('working');
  });

  it('allows an active response to outlive the idle budget and stops at its terminal event', async () => {
    const encoder = new TextEncoder();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"still "}\n'),
        );
        timers.push(
          setTimeout(
            () =>
              controller.enqueue(
                encoder.encode('data: {"type":"response.output_text.delta","delta":"working"}\n'),
              ),
            10,
          ),
          setTimeout(
            () =>
              controller.enqueue(
                encoder.encode('data: {"type":"response.completed","response":{"usage":{}}}\n'),
              ),
            20,
          ),
        );
      },
      cancel() {
        cancelled = true;
        for (const timer of timers) clearTimeout(timer);
      },
    });
    const backend = new CodexAgentBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: stream,
          text: async () => '',
        }) as Response) as typeof fetch,
      { responseStartTimeoutMs: 15, streamIdleTimeoutMs: 15 },
    );

    const result = await backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'finish a long artifact',
      input: [],
      tools: [],
      effort: 'medium',
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('still working');
    expect(cancelled).toBe(true);
  });

  it('fails a genuinely idle response with a diagnostic reason', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const backend = new CodexAgentBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      (async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: stream,
          text: async () => '',
        }) as Response) as typeof fetch,
      { responseStartTimeoutMs: 20, streamIdleTimeoutMs: 10 },
    );

    const result = await backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      errorKind: 'agent_backend_down',
      detail: 'backend stream was idle for 10ms',
      retryable: true,
    });
    expect(cancelled).toBe(true);
  });

  it('fails when response headers never arrive', async () => {
    const backend = new CodexAgentBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        })) as typeof fetch,
      { responseStartTimeoutMs: 10, streamIdleTimeoutMs: 20 },
    );

    const result = await backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      detail: 'backend response did not start within 10ms',
      retryable: true,
    });
  });

  it('rejects a stream that ends without a terminal event', async () => {
    const backend = new CodexAgentBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      (async () => new Response('', { status: 200 })) as typeof fetch,
      { responseStartTimeoutMs: 20, streamIdleTimeoutMs: 20 },
    );

    const result = await backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      detail: 'backend stream ended before a terminal event',
      retryable: true,
    });
  });
});
