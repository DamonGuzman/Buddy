import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelperBuddyRunner } from '../src/main/agents/helper-buddy';
import { HelperBuddyBrowserRuntime } from '../src/main/agents/helper-buddy-browser-runtime';
import { HelperBuddyApprovalCoordinator } from '../src/main/agents/approvals';
import { HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS } from '../src/main/agents/helper-buddy-config';
import { helperBuddyToolDefinitions } from '../src/main/agents/tools';
import type {
  HelperBuddyApprovalPort,
  HelperBuddyApprovalResolution,
  HelperBuddyApprovalVerdict,
  HelperBuddyBackend,
  HelperBuddyBackendRequest,
  HelperBuddyBackendResult,
  HelperBuddyBrief,
  HelperBuddyBrowserDeps,
  HelperBuddyToolDefinition,
} from '../src/main/agents/types';
import type { CaptureResult } from '../src/main/capture';
import type {
  GateDispatch,
  GateEscalation,
  GateExecutionResult,
} from '../src/main/agents/gate/action-gate';
import { createTestHelperBuddyMemory } from './support/helper-buddy-memory';
import { createTestHelperBuddyFilesystem } from './support/helper-buddy-capabilities';

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: () => ({ toPNG: () => Buffer.from('marked screenshot') }),
  },
}));

const memory = createTestHelperBuddyMemory();
const filesystem = createTestHelperBuddyFilesystem();

function brief(id: string, task: string): HelperBuddyBrief {
  return {
    id,
    userRequest: task,
    task,
    filesystem: { taskId: 'browser-integration-task', rootName: 'test-root' },
    recentTranscript: '',
    createdAt: Date.now(),
  };
}

function success(
  functionCalls: Array<{ callId: string; name: string; args: Record<string, unknown> }> = [],
  text = '',
): HelperBuddyBackendResult {
  const describedCalls = functionCalls.map((call) => ({
    ...call,
    args: { description: 'checking the browser task', ...call.args },
  }));
  return {
    ok: true,
    outputItems: describedCalls.map((call) => ({
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.args),
    })),
    text,
    functionCalls: describedCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      argsJson: JSON.stringify(call.args),
    })),
    searchQueries: [],
    citations: [],
    usedPercent: null,
  };
}

function capture(sequence: number): CaptureResult {
  return {
    meta: {
      screenIndex: 0,
      displayId: sequence,
      imageW: 1024,
      imageH: 768,
      displayBounds: { x: 0, y: 0, width: 1024, height: 768 },
      scaleFactor: 1,
      isActive: true,
    },
    jpegBase64: `fresh-${sequence}`,
  };
}

function fakeDriver() {
  let captureSequence = 0;
  const driver = {
    capture: vi.fn(async () => [capture(++captureSequence)]),
    click: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    pressKeys: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    inspectFocused: vi.fn(async () => null),
    inspect: vi.fn(async () => null),
    readPendingPayload: vi.fn(async () => []),
    authorizeNextNavigation: vi.fn(async () => undefined),
    showForTakeover: vi.fn(async () => undefined),
    hideAfterTakeover: vi.fn(async () => undefined),
    inspectDetailed: vi.fn(async () => ({
      facts: null,
      payloadFields: [],
      fingerprint: `test-${captureSequence}`,
      pageRevision: captureSequence,
    })),
    dispose: vi.fn(async () => undefined),
  };
  return driver;
}

function approvalResolution(verdict: HelperBuddyApprovalVerdict): HelperBuddyApprovalResolution {
  return {
    verdict,
    acknowledge: vi.fn(),
    reject: vi.fn(),
    replace: async () => approvalResolution(verdict),
  };
}

function browserDeps(
  driver: ReturnType<typeof fakeDriver>,
  approvals: HelperBuddyApprovalPort = {
    request: vi.fn(async () => approvalResolution('once')),
    cancelHelperBuddy: vi.fn(),
    get: () => null,
    resolve: async () => undefined,
  },
): HelperBuddyBrowserDeps {
  return {
    createDriver: vi.fn(async () => driver),
    gate: {
      execute: vi.fn(async (input, dispatch) => ({
        kind: 'executed' as const,
        value: await dispatch({
          navigationDestination: input.action.kind === 'navigate' ? input.action.url : null,
        }),
        reviewed: false,
      })),
      resolveEscalation: vi.fn(async () => ({
        kind: 'denied' as const,
        denied: true as const,
        reason: 'there is no pending escalation',
        halt: false,
      })),
      cancelHelperBuddy: vi.fn(),
    },
    approvals,
    settleMs: 0,
  };
}

function scriptedBackend(
  handler: (
    request: HelperBuddyBackendRequest,
    round: number,
  ) => Promise<HelperBuddyBackendResult> | HelperBuddyBackendResult,
): HelperBuddyBackend & { requests: HelperBuddyBackendRequest[] } {
  const requests: HelperBuddyBackendRequest[] = [];
  return {
    requests,
    isReady: () => true,
    async request(request) {
      requests.push(request);
      return handler(request, requests.length);
    },
  };
}

function toolNames(request: HelperBuddyBackendRequest): string[] {
  return request.tools.flatMap((tool) => (tool.type === 'function' ? [tool.name] : [tool.type]));
}

function inputJson(request: HelperBuddyBackendRequest): string {
  return JSON.stringify(request.input);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('unified-capability HelperBuddyRunner integration', () => {
  it('rejects noncanonical run identities before constructing runtime state', () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const options = {
      brief: brief(' helper-buddy', 'inspect example.com'),
      deps,
      signal: new AbortController().signal,
      getSteps: () => [],
      onPark: vi.fn(),
      onResume: vi.fn(),
      onActivity: vi.fn(),
    };

    expect(() => new HelperBuddyBrowserRuntime(options)).toThrow('canonical');
    expect(
      () =>
        new HelperBuddyRunner({
          memory,
          filesystem,
          browser: deps,
          brief: options.brief,
          backend: scriptedBackend(() => success([], 'unused')),
          onUpdate: vi.fn(),
        }),
    ).toThrow('canonical');
    expect(deps.createDriver).not.toHaveBeenCalled();
    expect(deps.approvals.request).not.toHaveBeenCalled();
  });

  it('grants browser and filesystem tools to every helper and requires browser justification', async () => {
    const researchBackend = scriptedBackend(() => success([], 'research complete'));
    const researchRunner = new HelperBuddyRunner({
      memory,
      filesystem,
      browser: browserDeps(fakeDriver()),
      brief: brief('research-helper-buddy', 'research example.com'),
      backend: researchBackend,
      onUpdate: () => undefined,
    });
    await researchRunner.run();

    expect(toolNames(researchBackend.requests[0]!)).toContain('browser_navigate');
    expect(toolNames(researchBackend.requests[0]!)).toContain('run_shell');
    expect(researchBackend.requests[0]!.instructions).toContain(
      "both Buddy's persistent browser and a picker-authorized filesystem workspace",
    );

    const definitions = helperBuddyToolDefinitions().filter(
      (tool): tool is Extract<HelperBuddyToolDefinition, { type: 'function' }> =>
        tool.type === 'function' &&
        (tool.name.startsWith('browser_') || tool.name === 'needs_user'),
    );
    expect(definitions.map((tool) => tool.name)).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_press_keys',
      'browser_scroll',
      'browser_screenshot',
      'needs_user',
    ]);
    for (const tool of definitions) {
      const required = (tool.parameters['required'] as unknown[]) ?? [];
      expect(required, tool.name).toContain('justification');
    }

    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const browserBackend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'missing-why',
              name: 'browser_navigate',
              args: { url: 'https://example.com' },
            },
          ])
        : success([], 'stopped after validation'),
    );
    await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend: browserBackend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(toolNames(browserBackend.requests[0]!)).toContain('browser_navigate');
    expect(browserBackend.requests[0]!.instructions).toContain('exactly one browser action');
    expect(inputJson(browserBackend.requests[1]!)).toContain('justification is required');
    expect(deps.createDriver).not.toHaveBeenCalled();
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it('refuses to execute a helper tool call without a readable description', async () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'missing-description',
              name: 'browser_navigate',
              args: {
                description: undefined,
                url: 'https://example.com',
                justification: 'Open the requested page.',
              },
            },
          ])
        : success([], 'stopped after description validation'),
    );

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('description-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(inputJson(backend.requests[1]!)).toContain('description is required');
    expect(deps.createDriver).not.toHaveBeenCalled();
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'browser_screenshot',
      args: { justification: 'Inspect the browser page for the requested task.' },
    },
    {
      name: 'needs_user',
      args: {
        reason: 'the site requires a human-only step',
        justification: 'A person must handle the site challenge before work can continue.',
      },
    },
  ])(
    'does not create or read the persistent browser before capability approval: $name',
    async (call) => {
      let resolveCapability!: (resolution: HelperBuddyApprovalResolution) => void;
      const approvals: HelperBuddyApprovalPort = {
        request: vi.fn(
          () =>
            new Promise<HelperBuddyApprovalResolution>((resolve) => {
              resolveCapability = resolve;
            }),
        ),
        cancelHelperBuddy: () => resolveCapability?.(approvalResolution('deny')),
        get: () => null,
        resolve: async () => undefined,
      };
      const driver = fakeDriver();
      const deps = browserDeps(driver, approvals);
      const backend = scriptedBackend((_request, round) =>
        round === 1
          ? success([{ callId: 'private-browser-surface', name: call.name, args: call.args }])
          : success([], 'stopped after capability denial'),
      );
      const runner = new HelperBuddyRunner({
        memory,
        filesystem,
        brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
        backend,
        browser: deps,
        onUpdate: () => undefined,
      });
      const running = runner.run();

      await vi.waitFor(() => expect(runner.summary.status).toBe('waiting_approval'));
      expect(approvals.request).toHaveBeenCalledOnce();
      expect(vi.mocked(approvals.request).mock.calls[0]?.[0]).toMatchObject({
        kind: 'browser-capability',
        screenshotPng: '',
      });
      expect(deps.createDriver).not.toHaveBeenCalled();
      expect(driver.capture).not.toHaveBeenCalled();

      resolveCapability(approvalResolution('deny'));
      await expect(running).resolves.toMatchObject({ status: 'done' });
      expect(deps.createDriver).not.toHaveBeenCalled();
      expect(driver.capture).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      firstName: 'browser_screenshot',
      firstArgs: { justification: 'Inspect the current browser page.' },
    },
    {
      firstName: 'needs_user',
      firstArgs: {
        reason: 'the site requires a human-only challenge',
        justification: 'A person must handle the challenge before work can continue.',
      },
    },
  ])('rejects a precomputed click after $firstName returns a new observation', async (fixture) => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'observation-boundary',
              name: fixture.firstName,
              args: fixture.firstArgs,
            },
            {
              callId: 'stale-precomputed-click',
              name: 'browser_click',
              args: {
                x: 200,
                y: 150,
                label: 'Continue',
                justification: 'Click the target from before the new observation.',
              },
            },
          ])
        : success([], 'stopped before the stale click'),
    );

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(inputJson(backend.requests[1]!)).toContain(
      'only one action is allowed per screen observation',
    );
    expect(deps.gate.execute).not.toHaveBeenCalled();
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('executes only one action per observation, returns a fresh capture, and disposes', async () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'navigate',
              name: 'browser_navigate',
              args: {
                url: 'https://example.com',
                justification: 'Open the site the user explicitly requested.',
              },
            },
            {
              callId: 'scroll',
              name: 'browser_scroll',
              args: {
                x: 500,
                y: 500,
                dy: 400,
                justification: 'Inspect the next part of the requested page.',
              },
            },
          ])
        : success([], 'page opened'),
    );

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(driver.navigate).toHaveBeenCalledOnce();
    expect(driver.navigate).toHaveBeenCalledWith('https://example.com');
    expect(driver.scroll).not.toHaveBeenCalled();
    // Capability approval is task-scoped and does not depend on an unpainted
    // about:blank capture. The single capture is mandatory after navigation.
    expect(driver.capture).toHaveBeenCalledOnce();
    expect(inputJson(backend.requests[1]!)).toContain(
      'only one action is allowed per screen observation',
    );
    expect(inputJson(backend.requests[1]!)).toContain('data:image/jpeg;base64,fresh-1');
    expect(driver.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a driver that arrives after the helper buddy was cancelled', async () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    type CreatedDriver = Awaited<ReturnType<HelperBuddyBrowserDeps['createDriver']>>;
    let finishDriver!: (driver: CreatedDriver) => void;
    deps.createDriver = vi.fn(
      () =>
        new Promise<CreatedDriver>((resolve) => {
          finishDriver = resolve;
        }),
    );
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'late-driver',
              name: 'browser_screenshot',
              args: { justification: 'Inspect the current browser page.' },
            },
          ])
        : success([], 'should not continue'),
    );
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('cancelled-driver-helper', 'inspect the browser'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    });
    const running = runner.run();
    await vi.waitFor(() => expect(deps.createDriver).toHaveBeenCalledOnce());

    runner.cancel();
    finishDriver(driver as CreatedDriver);

    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(driver.dispose).toHaveBeenCalledOnce();
    expect(driver.capture).not.toHaveBeenCalled();
  });

  it('shares one in-flight driver factory between a browser tool and takeover request', async () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    type CreatedDriver = Awaited<ReturnType<HelperBuddyBrowserDeps['createDriver']>>;
    let finishDriver!: (driver: CreatedDriver) => void;
    const opening = new Promise<CreatedDriver>((resolve) => {
      finishDriver = resolve;
    });
    deps.createDriver = vi.fn(() => opening);
    const runtime = new HelperBuddyBrowserRuntime({
      brief: brief('shared-driver-opening', 'inspect the browser'),
      deps,
      signal: new AbortController().signal,
      getSteps: () => [],
      onPark: () => undefined,
      onResume: () => undefined,
      onActivity: () => undefined,
    });

    const screenshot = runtime.execute('browser_screenshot', {
      justification: 'Inspect the current browser page.',
    });
    await vi.waitFor(() => expect(deps.createDriver).toHaveBeenCalledOnce());
    const takeover = runtime.showForUser();
    await Promise.resolve();
    expect(deps.createDriver).toHaveBeenCalledOnce();

    finishDriver(driver as CreatedDriver);
    await expect(screenshot).resolves.toMatchObject({ observation: expect.any(Array) });
    await expect(takeover).resolves.toBeUndefined();
    expect(driver.capture).toHaveBeenCalledOnce();
    expect(driver.showForTakeover).toHaveBeenCalledOnce();
    await runtime.dispose();
    expect(driver.dispose).toHaveBeenCalledOnce();
  });

  it('joins a late driver factory and disposes its result before runtime disposal settles', async () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    type CreatedDriver = Awaited<ReturnType<HelperBuddyBrowserDeps['createDriver']>>;
    let finishDriver!: (driver: CreatedDriver) => void;
    deps.createDriver = vi.fn(
      () =>
        new Promise<CreatedDriver>((resolve) => {
          finishDriver = resolve;
        }),
    );
    const runtime = new HelperBuddyBrowserRuntime({
      brief: brief('joined-driver-opening', 'inspect the browser'),
      deps,
      signal: new AbortController().signal,
      getSteps: () => [],
      onPark: () => undefined,
      onResume: () => undefined,
      onActivity: () => undefined,
    });
    const execution = runtime.execute('browser_screenshot', {
      justification: 'Inspect the current browser page.',
    });
    const executionFailure = expect(execution).rejects.toThrow('cancelled during browser creation');
    await vi.waitFor(() => expect(deps.createDriver).toHaveBeenCalledOnce());

    let disposalSettled = false;
    const disposal = runtime.dispose().finally(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    finishDriver(driver as CreatedDriver);
    await executionFailure;
    await disposal;
    expect(driver.dispose).toHaveBeenCalledOnce();
    expect(driver.capture).not.toHaveBeenCalled();
  });

  it('approves first-navigation capability before creating or capturing an unpainted driver', async () => {
    const driver = fakeDriver();
    let navigated = false;
    driver.navigate.mockImplementation(async () => {
      navigated = true;
    });
    driver.capture.mockImplementation(async () => {
      if (!navigated) throw new Error('about:blank has not painted');
      return [capture(1)];
    });
    const deps = browserDeps(driver);
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'first-navigation',
              name: 'browser_navigate',
              args: {
                url: 'https://example.com',
                justification: 'Open the site the user explicitly requested.',
              },
            },
          ])
        : success([], 'page opened'),
    );

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(deps.approvals.request).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.approvals.request).mock.calls[0]?.[0]).toMatchObject({
      kind: 'browser-capability',
      screenshotPng: '',
      userRequest: 'open example.com and inspect it',
    });
    expect(vi.mocked(deps.approvals.request).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.createDriver).mock.invocationCallOrder[0]!,
    );
    expect(driver.capture).toHaveBeenCalledOnce();
    expect(inputJson(backend.requests[1]!)).toContain('data:image/jpeg;base64,fresh-1');
  });

  it.each([
    {
      label: 'cross-origin anchor click',
      name: 'browser_click',
      args: {
        x: 120,
        y: 80,
        label: 'Continue on accounts.example.net',
        justification: 'Open the reviewed sign-in destination.',
      },
      dispatched: 'click' as const,
    },
    {
      label: 'cross-origin form Enter',
      name: 'browser_press_keys',
      args: {
        keys: ['ENTER'],
        justification: 'Submit the reviewed form to its inspected destination.',
      },
      dispatched: 'pressKeys' as const,
    },
  ])('arms the exact reviewed destination immediately before $label', async (fixture) => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const destination = 'https://accounts.example.net/continue?state=trusted';
    deps.gate.execute = vi.fn(async (_input, dispatch) => ({
      kind: 'executed' as const,
      value: await dispatch({ navigationDestination: destination }),
      reviewed: true,
    }));
    const backend = scriptedBackend((_request, round) => {
      if (round === 1) {
        return success([
          {
            callId: 'observe-link-or-form',
            name: 'browser_screenshot',
            args: { justification: 'Inspect the visible page before acting.' },
          },
        ]);
      }
      if (round === 2) {
        return success([
          {
            callId: 'reviewed-navigation-trigger',
            name: fixture.name,
            args: fixture.args,
          },
        ]);
      }
      return success([], 'reviewed navigation trigger completed');
    });

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(driver.authorizeNextNavigation).toHaveBeenCalledExactlyOnceWith(destination);
    expect(driver[fixture.dispatched]).toHaveBeenCalledOnce();
    expect(driver.authorizeNextNavigation.mock.invocationCallOrder[0]).toBeLessThan(
      driver[fixture.dispatched].mock.invocationCallOrder[0]!,
    );
  });

  it('retains a browser-action card and rejects UI resolution when downstream approval fails', async () => {
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged: vi.fn() });
    const directCapability = approvalResolution('once');
    const approvals: HelperBuddyApprovalPort = {
      request: (request, signal) =>
        request.kind === 'browser-capability'
          ? Promise.resolve(directCapability)
          : coordinator.request(request, signal),
      cancelHelperBuddy: (helperBuddyId) => coordinator.cancelHelperBuddy(helperBuddyId),
      get: (approvalId) => coordinator.get(approvalId),
      resolve: (approvalId, verdict) => coordinator.resolve(approvalId, verdict),
    };
    const driver = fakeDriver();
    const deps = browserDeps(driver, approvals);
    const escalation: GateEscalation = {
      kind: 'escalated',
      approvalId: 'browser-action-approval',
      helperBuddyId: 'browser-helper-buddy',
      userRequest: 'open example.com and inspect it',
      actionText: 'navigate to example.com',
      browserDomain: 'example.com',
      reason: 'navigation requires review',
      concern: 'confirm the reviewed navigation',
      evidenceDigest: 'evidence-digest',
      payloadDigest: [],
      screenshotPng: null,
      signature: { domain: 'example.com', actionKind: 'navigation', target: 'example.com' },
      grantScope: 'navigate to “example.com” on example.com',
    };
    deps.gate.execute = vi.fn(async () => escalation);
    deps.gate.resolveEscalation = vi
      .fn()
      .mockRejectedValueOnce(new Error('approval grant could not be persisted'))
      .mockResolvedValueOnce({
        kind: 'denied' as const,
        denied: true as const,
        reason: 'the user denied the action after retry',
        halt: false,
      });
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'reviewed-navigation',
              name: 'browser_navigate',
              args: {
                url: 'https://example.com',
                justification: 'Open the site the user explicitly requested.',
              },
            },
          ])
        : success([], 'stopped after explicit denial'),
    );
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    });
    const running = runner.run();
    await vi.waitFor(() => expect(coordinator.list()).toHaveLength(1));

    await expect(coordinator.resolve('browser-action-approval', 'always')).rejects.toThrow(
      'approval grant could not be persisted',
    );
    expect(coordinator.get('browser-action-approval')).not.toBeNull();
    expect(runner.summary.status).toBe('waiting_approval');

    await expect(coordinator.resolve('browser-action-approval', 'deny')).resolves.toBeUndefined();
    await expect(running).resolves.toMatchObject({ status: 'done' });
    expect(coordinator.list()).toEqual([]);
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it('fails closed after bounded approval replacements when evidence never stabilizes', async () => {
    const driver = fakeDriver();
    const deps = browserDeps(driver);
    const escalation = (sequence: number): GateEscalation => ({
      kind: 'escalated',
      approvalId: `unstable-${sequence}`,
      helperBuddyId: 'browser-helper-buddy',
      userRequest: 'open example.com and inspect it',
      actionText: 'navigate to example.com',
      browserDomain: 'example.com',
      reason: 'the inspected evidence changed',
      concern: 'review the latest destination',
      evidenceDigest: `evidence-${sequence}`,
      payloadDigest: [],
      screenshotPng: null,
      signature: { domain: 'example.com', actionKind: 'navigation', target: 'example.com' },
      grantScope: 'navigate to “example.com” on example.com',
    });
    deps.gate.execute = vi.fn(async () => escalation(0));
    let sequence = 0;
    deps.gate.resolveEscalation = vi.fn(async () => escalation((sequence += 1)));
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'unstable-navigation',
              name: 'browser_navigate',
              args: {
                url: 'https://example.com',
                justification: 'Open the site the user explicitly requested.',
              },
            },
          ])
        : success([], 'stopped after the evidence failed to stabilize'),
    );

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(deps.gate.resolveEscalation).toHaveBeenCalledTimes(3);
    expect(inputJson(backend.requests[1]!)).toContain(
      'browser action approval could not stabilize after fresh evidence checks',
    );
    expect(deps.approvals.cancelHelperBuddy).toHaveBeenCalledWith('browser-helper-buddy');
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it('aborts a timed-out approval resolution before a delayed gate can dispatch', async () => {
    vi.useFakeTimers();
    const coordinator = new HelperBuddyApprovalCoordinator({ onChanged: vi.fn() });
    const approvals: HelperBuddyApprovalPort = {
      request: (request, signal) =>
        request.kind === 'browser-capability'
          ? Promise.resolve(approvalResolution('once'))
          : coordinator.request(request, signal),
      cancelHelperBuddy: (helperBuddyId) => coordinator.cancelHelperBuddy(helperBuddyId),
      get: (approvalId) => coordinator.get(approvalId),
      resolve: (approvalId, verdict) => coordinator.resolve(approvalId, verdict),
    };
    const driver = fakeDriver();
    const deps = browserDeps(driver, approvals);
    const escalation: GateEscalation = {
      kind: 'escalated',
      approvalId: 'delayed-approval',
      helperBuddyId: 'browser-helper-buddy',
      userRequest: 'open example.com and inspect it',
      actionText: 'navigate to example.com',
      browserDomain: 'example.com',
      reason: 'navigation requires review',
      concern: 'confirm the reviewed navigation',
      evidenceDigest: 'evidence-digest',
      payloadDigest: [],
      screenshotPng: 'marked-image',
      signature: { domain: 'example.com', actionKind: 'navigation', target: 'example.com' },
      grantScope: 'navigate to “example.com” on example.com',
    };
    let delayedDispatch!: GateDispatch<void>;
    deps.gate.execute = vi.fn(async (_input, dispatch) => {
      delayedDispatch = dispatch;
      return escalation;
    });
    deps.gate.resolveEscalation = vi.fn(
      () =>
        new Promise<GateExecutionResult<void>>((resolve, reject) => {
          setTimeout(() => {
            delayedDispatch({ navigationDestination: 'https://example.com' }).then(
              (value) => resolve({ kind: 'executed' as const, value, reviewed: true }),
              reject,
            );
          }, HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS + 1_000);
        }),
    );
    let finishBackend!: (result: HelperBuddyBackendResult) => void;
    const backend = scriptedBackend((_request, round) => {
      if (round === 1) {
        return success([
          {
            callId: 'delayed-navigation',
            name: 'browser_navigate',
            args: {
              url: 'https://example.com',
              justification: 'Open the site the user explicitly requested.',
            },
          },
        ]);
      }
      return new Promise<HelperBuddyBackendResult>((resolve) => {
        finishBackend = resolve;
      });
    });
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: deps,
      onUpdate: () => undefined,
    });
    const running = runner.run();
    await vi.waitFor(() => expect(coordinator.list()).toHaveLength(1));

    const uiResolution = coordinator.resolve('delayed-approval', 'once');
    const uiRejection = expect(uiResolution).rejects.toThrow('approved browser action timed out');
    await vi.advanceTimersByTimeAsync(HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS);
    await uiRejection;
    await vi.waitFor(() => expect(backend.requests).toHaveLength(2));
    expect(coordinator.list()).toEqual([]);
    await expect(coordinator.resolve('delayed-approval', 'deny')).rejects.toThrow(
      'approval is missing or stale',
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(driver.navigate).not.toHaveBeenCalled();
    expect(deps.gate.cancelHelperBuddy).toHaveBeenCalledWith('browser-helper-buddy');
    finishBackend(success([], 'stopped after the timed-out review'));
    await expect(running).resolves.toMatchObject({ status: 'done' });
  });

  it('continues browser work past the former 40-round ceiling', async () => {
    const driver = fakeDriver();
    const backend = scriptedBackend((_request, round) =>
      round <= 45
        ? success([
            {
              callId: `shot-${round}`,
              name: 'browser_screenshot',
              args: { justification: 'Inspect the current page before deciding what to do next.' },
            },
          ])
        : success([], 'finished after the former browser round ceiling'),
    );

    const result = await new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: browserDeps(driver),
      onUpdate: () => undefined,
    }).run();

    expect(result.status).toBe('done');
    expect(result.summary).toContain('finished after the former browser round ceiling');
    expect(backend.requests).toHaveLength(46);
    expect(driver.capture).toHaveBeenCalledTimes(45);
    expect(driver.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { x: -1, y: 20 },
    { x: 999_999, y: 20 },
    { x: 20, y: -1 },
    { x: 20, y: 999_999 },
  ])(
    'rejects out-of-observation coordinates before approval or gate dispatch: %o',
    async (point) => {
      const driver = fakeDriver();
      const deps = browserDeps(driver);
      const backend = scriptedBackend((_request, round) => {
        if (round === 1) {
          return success([
            {
              callId: 'observe',
              name: 'browser_screenshot',
              args: { justification: 'Inspect the browser before selecting a target.' },
            },
          ]);
        }
        if (round === 2) {
          return success([
            {
              callId: 'bad-coordinate',
              name: 'browser_click',
              args: {
                ...point,
                label: 'target',
                justification: 'Click the visible target.',
              },
            },
          ]);
        }
        return success([], 'stopped after the coordinate error');
      });

      const result = await new HelperBuddyRunner({
        memory,
        filesystem,
        brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
        backend,
        browser: deps,
        onUpdate: () => undefined,
      }).run();

      expect(result.status).toBe('done');
      expect(inputJson(backend.requests[2]!)).toContain('must be inside the 1024x768');
      expect(deps.approvals.request).toHaveBeenCalledOnce();
      expect(vi.mocked(deps.approvals.request).mock.calls[0]?.[0].kind).toBe('browser-capability');
      expect(deps.gate.execute).not.toHaveBeenCalled();
      expect(driver.click).not.toHaveBeenCalled();
    },
  );

  it('does not stop browser work after the former ten-minute wall-clock ceiling', async () => {
    vi.useFakeTimers();
    let resolveRequest!: (result: HelperBuddyBackendResult) => void;
    const backend = scriptedBackend(
      () =>
        new Promise<HelperBuddyBackendResult>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: browserDeps(fakeDriver()),
      onUpdate: () => undefined,
    });
    const running = runner.run();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runner.summary.status).toBe('running');
    resolveRequest(success([], 'finished after a long run'));

    await expect(running).resolves.toMatchObject({
      status: 'done',
      summary: 'finished after a long run',
    });
    expect(backend.requests).toHaveLength(1);
  });

  it('parks on needs_user, resumes after approval, and re-observes before continuing', async () => {
    let resolveApproval!: (resolution: HelperBuddyApprovalResolution) => void;
    const approvals: HelperBuddyApprovalPort = {
      request: vi.fn((request) =>
        request.kind === 'browser-capability'
          ? Promise.resolve(approvalResolution('once'))
          : new Promise<HelperBuddyApprovalResolution>((resolve) => {
              resolveApproval = resolve;
            }),
      ),
      cancelHelperBuddy: vi.fn(() => resolveApproval?.(approvalResolution('deny'))),
      get: () => null,
      resolve: async () => undefined,
    };
    const driver = fakeDriver();
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'human',
              name: 'needs_user',
              args: {
                reason: 'the site requires a captcha',
                action_text: 'complete the captcha',
                justification: 'A person must complete the site challenge before I continue.',
              },
            },
          ])
        : success([], 'continued after the captcha'),
    );
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: browserDeps(driver, approvals),
      onUpdate: () => undefined,
    });
    const running = runner.run();

    await vi.waitFor(() => expect(runner.summary.status).toBe('waiting_approval'));
    expect(backend.requests).toHaveLength(1);
    resolveApproval(approvalResolution('once'));

    await expect(running).resolves.toMatchObject({ status: 'done' });
    expect(approvals.request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(approvals.request).mock.calls[1]?.[0]).toMatchObject({
      kind: 'needs-user',
      userRequest: 'open example.com and inspect it',
      allowAlways: false,
      grantScope: null,
    });
    // needs_user captures evidence before parking and re-observes after the
    // person finishes; only the post-resume observation goes to the model.
    expect(driver.capture).toHaveBeenCalledTimes(2);
    expect(inputJson(backend.requests[1]!)).toContain('data:image/jpeg;base64,fresh-2');
    expect(driver.dispose).toHaveBeenCalledOnce();
  });

  it('does not charge parked human-wait time against the ten-minute browser budget', async () => {
    vi.useFakeTimers();
    let resolveApproval!: (resolution: HelperBuddyApprovalResolution) => void;
    const approvals: HelperBuddyApprovalPort = {
      request: (request) =>
        request.kind === 'browser-capability'
          ? Promise.resolve(approvalResolution('once'))
          : new Promise<HelperBuddyApprovalResolution>((resolve) => {
              resolveApproval = resolve;
            }),
      cancelHelperBuddy: () => resolveApproval?.(approvalResolution('deny')),
      get: () => null,
      resolve: async () => undefined,
    };
    const backend = scriptedBackend((_request, round) =>
      round === 1
        ? success([
            {
              callId: 'wait-for-human',
              name: 'needs_user',
              args: {
                reason: 'the site requires a captcha',
                justification: 'A person must complete the human-only challenge.',
              },
            },
          ])
        : success([], 'finished after the user returned'),
    );
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: browserDeps(fakeDriver(), approvals),
      onUpdate: () => undefined,
    });
    const running = runner.run();
    await vi.waitFor(() => expect(runner.summary.status).toBe('waiting_approval'));

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(runner.summary.status).toBe('waiting_approval');
    resolveApproval(approvalResolution('once'));
    await vi.runAllTimersAsync();

    await expect(running).resolves.toMatchObject({ status: 'done' });
  });

  it('ends a parked run cleanly when the manager shuts down', async () => {
    let resolveApproval!: (resolution: HelperBuddyApprovalResolution) => void;
    const approvals: HelperBuddyApprovalPort = {
      request: (request) =>
        request.kind === 'browser-capability'
          ? Promise.resolve(approvalResolution('once'))
          : new Promise<HelperBuddyApprovalResolution>((resolve) => {
              resolveApproval = resolve;
            }),
      cancelHelperBuddy: () => resolveApproval?.(approvalResolution('deny')),
      get: () => null,
      resolve: async () => undefined,
    };
    const backend = scriptedBackend(() =>
      success([
        {
          callId: 'waiting-at-quit',
          name: 'needs_user',
          args: {
            reason: 'the site requires a captcha',
            justification: 'A person must complete the human-only challenge.',
          },
        },
      ]),
    );
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: browserDeps(fakeDriver(), approvals),
      onUpdate: () => undefined,
    });
    const running = runner.run();
    await vi.waitFor(() => expect(runner.summary.status).toBe('waiting_approval'));

    await runner.dispose();

    await expect(running).resolves.toMatchObject({
      status: 'cancelled',
      summary: 'i was waiting on your ok when the app closed.',
    });
  });

  it('disposes a lazily-created browser when the run is cancelled', async () => {
    const driver = fakeDriver();
    const backend = scriptedBackend((request, round) => {
      if (round === 1) {
        return success([
          {
            callId: 'navigate',
            name: 'browser_navigate',
            args: {
              url: 'https://example.com',
              justification: 'Open the requested site.',
            },
          },
        ]);
      }
      return new Promise<HelperBuddyBackendResult>((resolve) => {
        request.signal.addEventListener(
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
      });
    });
    const runner = new HelperBuddyRunner({
      memory,
      filesystem,
      brief: brief('browser-helper-buddy', 'open example.com and inspect it'),
      backend,
      browser: browserDeps(driver),
      onUpdate: () => undefined,
    });
    const running = runner.run();

    await vi.waitFor(() => expect(backend.requests).toHaveLength(2));
    runner.cancel();

    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(driver.dispose).toHaveBeenCalledOnce();
  });
});
