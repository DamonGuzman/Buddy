import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelperBuddyRunner, shouldRetry } from '../src/main/agents/helper-buddy';
import { HelperBuddyManager } from '../src/main/agents/helper-buddy-manager';
import { MockHelperBuddyBackend } from '../src/main/agents/mock-helper-buddy-backend';
import { CodexHelperBuddyBackend } from '../src/main/agents/helper-buddy-backend';
import { helperBuddyToolDefinitions, findHelperBuddyTool } from '../src/main/agents/tools';
import type {
  HelperBuddyBackend,
  HelperBuddyBackendRequest,
  HelperBuddyBackendResult,
  HelperBuddyBrief,
  HelperBuddyBrowserDeps,
  HelperBuddyFilesystemToolPort,
  HelperBuddyPersistencePort,
  HelperBuddyToolContext,
  HelperBuddyToolDefinition,
} from '../src/main/agents/types';
import type { HelperBuddySummary } from '../src/shared/types';
import { HELPER_BUDDY_MANAGER_DISPOSE_TIMEOUT_MS } from '../src/main/agents/helper-buddy-config';
import { readActivityDescription } from '../src/main/agents/tools/activity-description';
import { HelperBuddyTools } from '../src/main/conversation/helper-buddy-tools';
import { TranscriptStore } from '../src/main/conversation/transcript-store';
import { createTestHelperBuddyMemory } from './support/helper-buddy-memory';
import {
  createTestHelperBuddyCapabilities,
  TEST_FILESYSTEM_BRIEF,
} from './support/helper-buddy-capabilities';

afterEach(() => {
  vi.useRealTimers();
});

function brief(id: string): HelperBuddyBrief {
  return {
    id,
    userRequest: `research ${id}`,
    task: `research ${id}`,
    recentTranscript: '',
    createdAt: Date.now(),
    filesystem: TEST_FILESYSTEM_BRIEF,
  };
}

describe('Helper buddy runtime', () => {
  const memory = createTestHelperBuddyMemory();
  const capabilities = createTestHelperBuddyCapabilities();
  it('runs the deterministic research loop to completion and pushes renderer-safe summaries', async () => {
    const updates: unknown[] = [];
    let finished = '';
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend: new MockHelperBuddyBackend(),
      memory,
      isReady: () => true,
      onHelperBuddiesChanged: (list) => updates.push(list),
      onFinished: (summary) => {
        finished = summary.id;
      },
    });
    expect(manager.spawn(brief('helper_buddy_1'))).toEqual({
      ok: true,
      helperBuddyId: 'helper_buddy_1',
    });
    await vi.waitFor(() => expect(finished).toBe('helper_buddy_1'));
    const record = manager.list()[0]!;
    expect(record.status).toBe('done');
    expect(record.summary).toContain('mock research run completed');
    expect(record.output).toContain('mock research checked');
    expect(record.sources).toEqual(['https://example.com/mock-source']);
    expect(record.steps.map((step) => step.kind)).toEqual(['search', 'note']);
    expect(updates.length).toBeGreaterThan(2);
  });

  it('starts every tool call from one model response concurrently', async () => {
    let releaseTools!: () => void;
    const toolRelease = new Promise<void>((resolve) => {
      releaseTools = resolve;
    });
    const started: string[] = [];
    const filesystem: HelperBuddyFilesystemToolPort = {
      ...capabilities.filesystem,
      runShell: async (_taskId, script) => {
        started.push(script);
        await toolRelease;
        return { exitCode: 0, stdout: script, stderr: '' };
      },
    };
    const requests: HelperBuddyBackendRequest[] = [];
    const backend: HelperBuddyBackend = {
      isReady: () => true,
      async request(request): Promise<HelperBuddyBackendResult> {
        requests.push(request);
        if (requests.length === 1) {
          const calls = ['first inspection', 'second inspection'].map((script, index) => ({
            callId: `shell_${index + 1}`,
            name: 'run_shell',
            argsJson: JSON.stringify({
              description: `checking project area ${index + 1}`,
              script,
            }),
          }));
          return {
            ok: true,
            outputItems: calls.map((call) => ({
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              arguments: call.argsJson,
            })),
            text: '',
            functionCalls: calls,
            searchQueries: [],
            citations: [],
            usedPercent: null,
          };
        }
        return {
          ok: true,
          outputItems: [],
          text: 'both inspections finished',
          functionCalls: [],
          searchQueries: [],
          citations: [],
          usedPercent: null,
        };
      },
    };
    const running = new HelperBuddyRunner({
      brief: brief('concurrent-tools'),
      backend,
      browser: capabilities.browser,
      filesystem,
      memory,
      onUpdate: () => undefined,
    }).run();

    try {
      await vi.waitFor(() => expect(started).toEqual(['first inspection', 'second inspection']));
    } finally {
      releaseTools();
    }

    await expect(running).resolves.toMatchObject({ status: 'done' });
    const outputOrder = requests[1]!.input
      .filter((item) => item['type'] === 'function_call_output')
      .map((item) => item['call_id']);
    expect(outputOrder).toEqual(['shell_1', 'shell_2']);
  });

  it('continues past twelve tool rounds until the backend finishes', async () => {
    let requests = 0;
    let finished = false;
    const backend: HelperBuddyBackend = {
      isReady: () => true,
      async request(): Promise<HelperBuddyBackendResult> {
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
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend,
      memory,
      isReady: () => true,
      onHelperBuddiesChanged: () => {},
      onFinished: () => {
        finished = true;
      },
    });

    expect(manager.spawn(brief('unbounded'))).toEqual({ ok: true, helperBuddyId: 'unbounded' });
    await vi.waitFor(() => expect(finished).toBe(true));

    const record = manager.list()[0]!;
    expect(requests).toBe(16);
    expect(record.status).toBe('done');
    expect(record.step).toBe(16);
    expect(record.summary).toContain('finished after the old round ceiling');
  });

  it('fails closed when signed out and admits helpers without a concurrency ceiling', async () => {
    const signedOut = new HelperBuddyManager({
      ...capabilities,
      backend: new MockHelperBuddyBackend(),
      memory,
      isReady: () => false,
      onHelperBuddiesChanged: () => {},
      onFinished: () => {},
    });
    expect(signedOut.spawn(brief('nope'))).toEqual({ ok: false, reason: 'not_signed_in' });
    expect(() => signedOut.cancel(' nope')).toThrow('canonical');
    expect(() => signedOut.markSeen('nope\0')).toThrow('invalid');
    expect(() => signedOut.markSpoken('nope ')).toThrow('canonical');

    const blocking: HelperBuddyBackend = {
      isReady: () => true,
      request: (req) =>
        new Promise<HelperBuddyBackendResult>((resolve) => {
          req.signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                errorKind: 'helper_buddy_backend_down',
                detail: 'aborted',
                retryable: false,
              }),
            { once: true },
          );
        }),
    };
    const notify = vi.fn();
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend: blocking,
      memory,
      browser: capabilities.browser,
      filesystem: capabilities.filesystem,
      isReady: () => true,
      onHelperBuddiesChanged: () => {},
      onFinished: () => {},
      notify,
    });
    for (let index = 0; index < 25; index += 1) {
      expect(manager.spawn(brief(`parallel-${index}`))).toEqual({
        ok: true,
        helperBuddyId: `parallel-${index}`,
      });
    }
    expect(manager.list()).toHaveLength(25);
    manager.cancelAll();
    await vi.waitFor(() =>
      expect(manager.list().every((item) => item.status === 'cancelled')).toBe(true),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it('routes web search through Firecrawl and records returned sources', async () => {
    const tool = findHelperBuddyTool('web_search')!;
    const search = vi.fn(
      async (_query: string, _options: Record<string, unknown>, _signal: AbortSignal) => ({
        success: true,
        data: { web: [{ url: 'https://example.com/article', markdown: 'full article' }] },
      }),
    );
    const sources: string[] = [];
    const ctx: HelperBuddyToolContext = {
      brief: brief('safe'),
      signal: new AbortController().signal,
      scratchpad: { get: () => '', set: () => {}, append: () => {} },
      addSource: (url) => sources.push(url),
      memory,
      browser: {
        execute: async () => ({ output: '{}' }),
        requestUser: async () => ({ output: '{}' }),
        dispose: async () => undefined,
      },
      filesystem: capabilities.filesystem,
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
    expect(new MockHelperBuddyBackend().isReady()).toBe(true);
  });

  it('exposes Firecrawl, browser, and filesystem tools to every helper buddy', () => {
    const firecrawlNames = [
      'web_search',
      'web_scrape',
      'web_map',
      'web_crawl',
      'web_batch_scrape',
      'web_research',
    ];
    const names = helperBuddyToolDefinitions().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(firecrawlNames));
    expect(names).toEqual(
      expect.arrayContaining(['browser_navigate', 'run_shell', 'run_staged_shell']),
    );
    for (const name of firecrawlNames) {
      expect(findHelperBuddyTool(name)?.definition.name).toBe(name);
    }
  });

  it('attaches a helper-selected workspace image to the next model turn', async () => {
    const requests: HelperBuddyBackendRequest[] = [];
    const backend: HelperBuddyBackend = {
      isReady: () => true,
      async request(req): Promise<HelperBuddyBackendResult> {
        requests.push(req);
        if (requests.length === 1) {
          const args = JSON.stringify({
            description: 'inspecting the generated image',
            path: 'art/result.png',
          });
          return {
            ok: true,
            outputItems: [
              {
                type: 'function_call',
                call_id: 'view_1',
                name: 'view_image',
                arguments: args,
              },
            ],
            text: '',
            functionCalls: [{ callId: 'view_1', name: 'view_image', argsJson: args }],
            searchQueries: [],
            citations: [],
            usedPercent: null,
          };
        }
        return {
          ok: true,
          outputItems: [],
          text: 'the selected image was inspected',
          functionCalls: [],
          searchQueries: [],
          citations: [],
          usedPercent: null,
        };
      },
    };
    let finished = false;
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend,
      memory,
      isReady: () => true,
      onHelperBuddiesChanged: () => {},
      onFinished: () => {
        finished = true;
      },
    });

    expect(manager.spawn(brief('helper_buddy_view_image'))).toEqual({
      ok: true,
      helperBuddyId: 'helper_buddy_view_image',
    });
    await vi.waitFor(() => expect(finished).toBe(true));

    const replay = requests[1]?.input ?? [];
    expect(replay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'view_1',
          output: expect.stringContaining('attached as visual input'),
        }),
        expect.objectContaining({
          type: 'message',
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
            }),
          ]),
        }),
      ]),
    );
  });

  it('requires a short plain-language description on every helper function tool', () => {
    const definitions = helperBuddyToolDefinitions().filter(
      (tool): tool is Extract<HelperBuddyToolDefinition, { type: 'function' }> =>
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
      'memory_delete',
      'memory_load',
      'memory_save',
      'needs_user',
      'present_file',
      'read_screen',
      'run_shell',
      'run_staged_shell',
      'scratchpad_write',
      'stage_paths',
      'view_image',
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
    let saved: HelperBuddySummary[] = [];
    const store: HelperBuddyPersistencePort = {
      load: () => null,
      save: (records) => {
        saved = records;
      },
    };
    let finished = false;
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend: new MockHelperBuddyBackend(),
      memory,
      isReady: () => true,
      persistence: store,
      onHelperBuddiesChanged: () => {},
      onFinished: () => {
        finished = true;
      },
    });
    expect(manager.spawn(brief('persist_me')).ok).toBe(true);
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(saved.map((item) => item.id)).toEqual(['persist_me']);
    expect(saved[0]?.status).toBe('done');
    expect(saved[0]?.finishedAt).toBeDefined();

    // A fresh manager reloads from the same port. Malformed/non-terminal rows
    // do not consume the bounded terminal-summary budget.
    const reloaded = new HelperBuddyManager({
      ...capabilities,
      backend: new MockHelperBuddyBackend(),
      memory,
      isReady: () => true,
      persistence: {
        load: () => [
          ...Array.from({ length: 55 }, (_, index) => ({ id: `bogus-${index}`, task: 42 })),
          {
            id: 'stale_running',
            task: 'x',
            status: 'running',
            createdAt: 1,
            finishedAt: 2,
            spoken: false,
            unseen: false,
            steps: [],
          },
          {
            id: 'unfinished_done',
            task: 'x',
            status: 'done',
            createdAt: 1,
            spoken: false,
            unseen: false,
            steps: [],
          },
          {
            id: 'bad_status',
            task: 'x',
            status: 'exploded',
            createdAt: 1,
            spoken: false,
            unseen: false,
            steps: [],
          },
          {
            ...saved[0],
            id: 'malformed_optional_field',
            sources: 42,
          },
          ...saved,
        ],
        save: () => {},
      },
      onHelperBuddiesChanged: () => {},
      onFinished: () => {},
    });
    expect(reloaded.list().map((item) => item.id)).toEqual(['persist_me']);
  });

  it('a throwing persistence port never takes down spawn/persist', async () => {
    let finished = false;
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend: new MockHelperBuddyBackend(),
      memory,
      isReady: () => true,
      persistence: {
        load: () => {
          throw new Error('corrupt');
        },
        save: () => {
          throw new Error('disk full');
        },
      },
      onHelperBuddiesChanged: () => {},
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
    const backend: HelperBuddyBackend = {
      isReady: () => true,
      request: (request) =>
        new Promise<HelperBuddyBackendResult>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                errorKind: 'helper_buddy_backend_down',
                detail: 'aborted for shutdown',
                retryable: false,
              }),
            { once: true },
          );
        }),
    };
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend,
      memory,
      isReady: () => true,
      onHelperBuddiesChanged: changed,
      onFinished: finished,
    });
    expect(manager.spawn(brief('shutdown')).ok).toBe(true);
    await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('running'));
    const callbacksBeforeDispose = changed.mock.calls.length;

    await manager.dispose();

    expect(manager.list()[0]).toMatchObject({ status: 'cancelled', unseen: false });
    expect(changed).toHaveBeenCalledTimes(callbacksBeforeDispose);
    expect(finished).not.toHaveBeenCalled();
    expect(() => manager.spawn(brief('too_late'))).toThrow('helper buddy manager is disposed');
  });

  it('fails manager disposal within a finite bound when a backend ignores abort', async () => {
    vi.useFakeTimers();
    let requestStarted = false;
    const manager = new HelperBuddyManager({
      ...capabilities,
      backend: {
        isReady: () => true,
        request: () => {
          requestStarted = true;
          return new Promise<HelperBuddyBackendResult>(() => undefined);
        },
      },
      memory,
      isReady: () => true,
      onHelperBuddiesChanged: () => undefined,
      onFinished: () => undefined,
    });
    expect(manager.spawn(brief('stuck-shutdown')).ok).toBe(true);
    await vi.waitFor(() => expect(requestStarted).toBe(true));
    const disposal = manager.dispose();
    const rejection = expect(disposal).rejects.toThrow('helper buddy manager disposal timed out');

    await vi.advanceTimersByTimeAsync(HELPER_BUDDY_MANAGER_DISPOSE_TIMEOUT_MS);

    await rejection;
  });

  it('joins a browser run cancelled during initial deliberation before profile clearing proceeds', async () => {
    const backend: HelperBuddyBackend = {
      isReady: () => true,
      request: (request) =>
        new Promise<HelperBuddyBackendResult>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () =>
              resolve({
                ok: false,
                errorKind: 'helper_buddy_backend_down',
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
    const browser: HelperBuddyBrowserDeps = {
      createDriver,
      gate: {
        execute: async () => {
          throw new Error('gate must not run');
        },
        resolveEscalation: async () => {
          throw new Error('gate must not run');
        },
        cancelHelperBuddy: () => undefined,
      },
      approvals: {
        request: async () => {
          throw new Error('approval must not be requested');
        },
        cancelHelperBuddy: () => undefined,
        get: () => null,
        resolve: async () => undefined,
      },
    };
    const manager = new HelperBuddyManager({
      backend,
      memory,
      browser,
      filesystem: capabilities.filesystem,
      isReady: () => true,
      onHelperBuddiesChanged: () => undefined,
      onFinished: () => undefined,
    });
    expect(manager.spawn(brief('initial-browser-race'))).toEqual({
      ok: true,
      helperBuddyId: 'initial-browser-race',
    });

    await manager.cancelBrowserRuns();

    expect(manager.list()[0]).toMatchObject({ status: 'cancelled', unseen: false });
    expect(createDriver).not.toHaveBeenCalled();
  });

  it('atomically blocks browser admission through cancellation and destructive profile mutation', async () => {
    let mutationStarted = false;
    let finishMutation!: () => void;
    const mutationWait = new Promise<void>((resolve) => {
      finishMutation = resolve;
    });
    const browser: HelperBuddyBrowserDeps = {
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
        cancelHelperBuddy: () => undefined,
      },
      approvals: {
        request: async () => {
          throw new Error('no approval is expected');
        },
        cancelHelperBuddy: () => undefined,
        get: () => null,
        resolve: async () => undefined,
      },
    };
    const manager = new HelperBuddyManager({
      backend: new MockHelperBuddyBackend(),
      memory,
      browser,
      filesystem: capabilities.filesystem,
      isReady: () => true,
      onHelperBuddiesChanged: () => undefined,
      onFinished: () => undefined,
    });

    const mutation = manager.withBrowserAdmissionBlocked(async () => {
      mutationStarted = true;
      await mutationWait;
    });
    await vi.waitFor(() => expect(mutationStarted).toBe(true));

    expect(manager.spawn(brief('blocked-browser-spawn'))).toEqual({
      ok: false,
      reason: 'browser_unavailable',
    });
    expect(manager.spawn(brief('blocked-filesystem-spawn'))).toEqual({
      ok: false,
      reason: 'browser_unavailable',
    });
    await expect(manager.withBrowserAdmissionBlocked(async () => undefined)).rejects.toThrow(
      'a browser state mutation is already in progress',
    );

    finishMutation();
    await mutation;
    expect(manager.spawn(brief('helper-after-mutation'))).toEqual({
      ok: true,
      helperBuddyId: 'helper-after-mutation',
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
    const tools = new HelperBuddyTools({
      helperBuddies: {
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

    await expect(tools.spawnHelperBuddy({ task: 'edit the project' }, 'text')).resolves.toEqual({
      error: 'filesystem use is unavailable for helper buddies right now',
    });
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it('keeps helpers waiting for approval in the unfiltered active status view', () => {
    const now = Date.now();
    const completed: HelperBuddySummary[] = Array.from({ length: 6 }, (_, index) => ({
      id: `completed-${index}`,
      task: `completed task ${index}`,
      status: 'done',
      createdAt: now - 2_000,
      finishedAt: now - 1_000,
      steps: [],
      spoken: false,
      unseen: false,
    }));
    const waiting: HelperBuddySummary = {
      id: 'waiting-for-approval',
      task: 'submit the reviewed form',
      status: 'waiting_approval',
      createdAt: now - 3_000,
      steps: [],
      spoken: false,
      unseen: false,
    };
    const tools = helperBuddyStatusTools([...completed, waiting]);

    const result = tools.checkHelperBuddies({}) as {
      helper_buddies: Array<{ helper_buddy_id: string; status: string }>;
    };

    expect(result.helper_buddies[0]).toMatchObject({
      helper_buddy_id: 'waiting-for-approval',
      status: 'waiting_approval',
    });
    expect(result.helper_buddies).toHaveLength(6);
  });

  it('rejects an overlong helper-buddy id instead of checking a truncated identity', () => {
    const list = vi.fn(() => []);
    const tools = helperBuddyStatusTools([], list);

    expect(tools.checkHelperBuddies({ helper_buddy_id: 'x'.repeat(201) })).toEqual({
      error: 'helper buddy id exceeds the size limit',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an aliased helper-buddy id instead of trimming it to another run', () => {
    const list = vi.fn(() => []);
    const tools = helperBuddyStatusTools([], list);

    expect(tools.checkHelperBuddies({ helper_buddy_id: ' existing-helper-buddy ' })).toEqual({
      error: 'helper buddy id must be canonical and not contain surrounding whitespace',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('resolves the tool call and releases prepared filesystem state when admission throws', async () => {
    const transcript = new TranscriptStore(10, () => undefined);
    transcript.upsert({
      id: 'user_1',
      role: 'user',
      text: 'update the project',
      streaming: false,
      timestamp: Date.now(),
    });
    const failFilesystem = vi.fn(async () => undefined);
    const tools = new HelperBuddyTools({
      helperBuddies: {
        isReady: () => true,
        list: () => [],
        spawn: () => {
          throw new Error('helper buddy manager is disposed');
        },
        markSpoken: () => undefined,
      },
      transcript,
      turnCaptures: () => [],
      noteOrigin: () => undefined,
      surfaceError: () => undefined,
      prepareFilesystem: async () => ({ taskId: 'prepared-task', rootName: 'project' }),
      failFilesystem,
    });

    await expect(tools.spawnHelperBuddy({ task: 'update the project' }, 'voice')).resolves.toEqual({
      error: 'helper buddy could not start: helper buddy manager is disposed',
    });
    expect(failFilesystem).toHaveBeenCalledWith(
      'prepared-task',
      'helper buddy manager is disposed',
    );
  });

  it('reports a filesystem cleanup failure instead of rejecting the model tool call', async () => {
    const transcript = new TranscriptStore(10, () => undefined);
    transcript.upsert({
      id: 'user_1',
      role: 'user',
      text: 'update the project',
      streaming: false,
      timestamp: Date.now(),
    });
    const tools = new HelperBuddyTools({
      helperBuddies: {
        isReady: () => true,
        list: () => [],
        spawn: () => ({ ok: false, reason: 'filesystem_unavailable' }),
        markSpoken: () => undefined,
      },
      transcript,
      turnCaptures: () => [],
      noteOrigin: () => undefined,
      surfaceError: () => undefined,
      prepareFilesystem: async () => ({ taskId: 'prepared-task', rootName: 'project' }),
      failFilesystem: async () => {
        throw new Error('filesystem journal is unavailable');
      },
    });

    await expect(tools.spawnHelperBuddy({ task: 'update the project' }, 'text')).resolves.toEqual({
      error:
        'helper buddy could not start: Filesystem execution is unavailable.; filesystem cleanup failed: filesystem journal is unavailable',
    });
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
    const spawn = vi.fn(() => ({ ok: true as const, helperBuddyId: 'new-helper' }));
    const tools = new HelperBuddyTools({
      helperBuddies: {
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

    await expect(tools.spawnHelperBuddy({ task: 'update the project' }, 'text')).resolves.toEqual({
      ok: true,
      helper_buddy_id: 'new-helper',
    });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('never authorizes a helper buddy from an older user turn while the latest request is streaming', async () => {
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
    const spawn = vi.fn(() => ({ ok: true as const, helperBuddyId: 'must-not-spawn' }));
    const tools = new HelperBuddyTools({
      helperBuddies: {
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

    await expect(tools.spawnHelperBuddy({ task: 'send the payment' }, 'text')).resolves.toEqual({
      error: 'the original user request is still being transcribed',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

function helperBuddyStatusTools(
  helperBuddies: HelperBuddySummary[],
  list: () => HelperBuddySummary[] = () => helperBuddies,
): HelperBuddyTools {
  return new HelperBuddyTools({
    helperBuddies: {
      isReady: () => true,
      list,
      spawn: () => ({ ok: true, helperBuddyId: 'unused' }),
      markSpoken: () => undefined,
    },
    transcript: new TranscriptStore(10, () => undefined),
    turnCaptures: () => [],
    noteOrigin: () => undefined,
    surfaceError: () => undefined,
    prepareFilesystem: async () => ({ taskId: 'unused', rootName: 'unused' }),
    failFilesystem: async () => undefined,
  });
}

describe('shouldRetry policy', () => {
  const ok: HelperBuddyBackendResult = {
    ok: true,
    outputItems: [],
    text: 'fine',
    functionCalls: [],
    searchQueries: [],
    citations: [],
    usedPercent: null,
  };
  const failure = (
    errorKind: 'helper_buddy_not_signed_in' | 'helper_buddy_quota' | 'helper_buddy_backend_down',
    retryable: boolean,
  ): HelperBuddyBackendResult => ({ ok: false, errorKind, detail: 'x', retryable });

  it('never retries successes or exhausted attempts', () => {
    expect(shouldRetry(ok, 0)).toBe(false);
    expect(shouldRetry(failure('helper_buddy_backend_down', true), 1)).toBe(false);
  });

  it('retries retryable failures and backend-down blips once', () => {
    expect(shouldRetry(failure('helper_buddy_backend_down', true), 0)).toBe(true);
    expect(shouldRetry(failure('helper_buddy_backend_down', false), 0)).toBe(true);
    expect(shouldRetry(failure('helper_buddy_quota', true), 0)).toBe(true);
  });

  it('stops immediately on non-retryable quota / sign-in failures', () => {
    expect(shouldRetry(failure('helper_buddy_quota', false), 0)).toBe(false);
    expect(shouldRetry(failure('helper_buddy_not_signed_in', false), 0)).toBe(false);
  });
});

describe('CodexHelperBuddyBackend wire contract', () => {
  it('reports readiness as false when the auth provider cannot be inspected', () => {
    const backend = new CodexHelperBuddyBackend({
      getCodexAuth: () => {
        throw new Error('keychain unavailable');
      },
      getBearer: async () => 'unused',
    });

    expect(backend.isReady()).toBe(false);
  });

  it('rejects noncanonical run correlation before authentication or transport side effects', async () => {
    const getCodexAuth = vi.fn(() => null);
    const getBearer = vi.fn(async () => 'unused');
    const fetchImpl = vi.fn<typeof fetch>();
    const backend = new CodexHelperBuddyBackend({ getCodexAuth, getBearer }, fetchImpl);

    await expect(
      backend.request({
        model: 'gpt-5.6-sol',
        instructions: 'test',
        input: [],
        tools: [],
        effort: 'medium',
        signal: new AbortController().signal,
        runContext: { helperBuddyId: ' helper-buddy-1', requestAttempt: 1 },
      }),
    ).resolves.toMatchObject({
      ok: false,
      retryable: false,
      detail: expect.stringContaining('canonical'),
    });
    expect(getCodexAuth).not.toHaveBeenCalled();
    expect(getBearer).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a request cancelled before admission without touching authentication', async () => {
    const getCodexAuth = vi.fn(() => null);
    const getBearer = vi.fn(async () => 'must-not-be-read');
    const fetchImpl = vi.fn<typeof fetch>();
    const backend = new CodexHelperBuddyBackend({ getCodexAuth, getBearer }, fetchImpl);
    const controller = new AbortController();
    controller.abort(new Error('cancelled before authentication'));

    const result = await backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: controller.signal,
    });

    expect(result).toEqual({
      ok: false,
      errorKind: 'helper_buddy_backend_down',
      detail: 'cancelled before authentication',
      retryable: false,
    });
    expect(getCodexAuth).not.toHaveBeenCalled();
    expect(getBearer).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not start a transport when cancellation overtakes asynchronous bearer access', async () => {
    let finishBearer!: (bearer: string) => void;
    const getBearer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishBearer = resolve;
        }),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer,
      },
      fetchImpl,
    );
    const controller = new AbortController();
    const pending = backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(getBearer).toHaveBeenCalledOnce());

    controller.abort(new Error('cancelled during credential refresh'));
    finishBearer('secret');

    await expect(pending).resolves.toEqual({
      ok: false,
      errorKind: 'helper_buddy_backend_down',
      detail: 'cancelled during credential refresh',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('settles cancellation even when credential refresh never returns', async () => {
    const getBearer = vi.fn(() => new Promise<string>(() => undefined));
    const fetchImpl = vi.fn<typeof fetch>();
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer,
      },
      fetchImpl,
    );
    const controller = new AbortController();
    const pending = backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(getBearer).toHaveBeenCalledOnce());

    controller.abort(new Error('cancelled during hung credential refresh'));

    await expect(pending).resolves.toEqual({
      ok: false,
      errorKind: 'helper_buddy_backend_down',
      detail: 'cancelled during hung credential refresh',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not send an empty refreshed bearer', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => '   ',
      },
      fetchImpl,
    );

    await expect(
      backend.request({
        model: 'gpt-5.6-sol',
        instructions: 'test',
        input: [],
        tools: [],
        effort: 'medium',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorKind: 'helper_buddy_not_signed_in',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not pair a refreshed bearer with stale account metadata after sign-out', async () => {
    let signedIn = true;
    const fetchImpl = vi.fn<typeof fetch>();
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () =>
          signedIn
            ? {
                accessToken: 'secret',
                accountId: 'acct',
                planType: 'pro',
                expiresAt: Date.now() + 60_000,
              }
            : null,
        getBearer: async () => {
          signedIn = false;
          return 'stale-secret';
        },
      },
      fetchImpl,
    );

    const result = await backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      ok: false,
      errorKind: 'helper_buddy_not_signed_in',
      detail: 'codex sign-in unavailable',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

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
    const backend = new CodexHelperBuddyBackend(
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
    const req: HelperBuddyBackendRequest = {
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
    const backend = new CodexHelperBuddyBackend(
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

  it('does not let a stalled stream-cancellation hook suppress a terminal result', async () => {
    const encoder = new TextEncoder();
    let cancelStarted = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.completed","response":{"usage":{}}}\n'),
        );
      },
      cancel() {
        cancelStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    const backend = new CodexHelperBuddyBackend(
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

    await expect(
      backend.request({
        model: 'gpt-5.6-sol',
        instructions: 'test',
        input: [],
        tools: [],
        effort: 'medium',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(cancelStarted).toBe(true);
  });

  it('settles cancellation even when a response keeps producing bytes after transport abort', async () => {
    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"response.output_text.delta","delta":"working"}\n'),
        );
        interval = setInterval(
          () =>
            controller.enqueue(
              encoder.encode('data: {"type":"response.output_text.delta","delta":"."}\n'),
            ),
          2,
        );
      },
      cancel() {
        cancelled = true;
        if (interval !== null) clearInterval(interval);
      },
    });
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: stream,
          text: async () => '',
        }) as Response,
    ) as typeof fetch;
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      fetchImpl,
      { responseStartTimeoutMs: 20, streamIdleTimeoutMs: 50 },
    );
    const controller = new AbortController();
    const pending = backend.request({
      model: 'gpt-5.6-sol',
      instructions: 'test',
      input: [],
      tools: [],
      effort: 'medium',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    controller.abort(new Error('cancelled during a live stream'));

    await expect(pending).resolves.toEqual({
      ok: false,
      errorKind: 'helper_buddy_backend_down',
      detail: 'cancelled during a live stream',
      retryable: false,
    });
    expect(cancelled).toBe(true);
  });

  it('fails a genuinely idle response with a diagnostic reason', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const backend = new CodexHelperBuddyBackend(
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
      errorKind: 'helper_buddy_backend_down',
      detail: 'backend stream was idle for 10ms',
      retryable: true,
    });
    expect(cancelled).toBe(true);
  });

  it('fails when response headers never arrive', async () => {
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      (() => new Promise<Response>(() => undefined)) as typeof fetch,
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

  it('bounds a stalled HTTP error body while preserving quota classification', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const backend = new CodexHelperBuddyBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'secret',
          accountId: 'acct',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'secret',
      },
      (async () => new Response(body, { status: 429 })) as typeof fetch,
      { responseStartTimeoutMs: 20, streamIdleTimeoutMs: 10 },
    );

    await expect(
      backend.request({
        model: 'gpt-5.6-sol',
        instructions: 'test',
        input: [],
        tools: [],
        effort: 'medium',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorKind: 'helper_buddy_quota',
      detail: expect.stringContaining('response body was idle for 10ms'),
      retryable: false,
    });
    expect(cancelled).toBe(true);
  });

  it('rejects a stream that ends without a terminal event', async () => {
    const backend = new CodexHelperBuddyBackend(
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
