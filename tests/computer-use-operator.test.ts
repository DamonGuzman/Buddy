import { describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../src/main/capture';
import type { ChatGptCodexAuthSource } from '../src/main/auth/auth-source';
import type { ApprovalRequest } from '../src/shared/types';
import type {
  AgentActionGatePort,
  AgentApprovalPort,
  AgentApprovalResolution,
  AgentApprovalVerdict,
} from '../src/main/agents/types';
import { ActionGate } from '../src/main/agents/gate/action-gate';
import type { WindowsInputController } from '../src/main/computer/windows-input';
import type { ComputerDriver } from '../src/main/computer/driver';
import type { LiveDesktopEvidencePort } from '../src/main/computer/live-desktop-evidence';
import { LiveDesktopDriver } from '../src/main/computer/live-desktop-driver';
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

function liveGate(ids: string[] = ['approval-1']): AgentActionGatePort {
  let index = 0;
  return new ActionGate<void>({
    reviewer: { review: vi.fn(async () => Promise.reject(new Error('live review must not run'))) },
    journal: {
      recordActionGateAssessment: vi.fn(),
      recordComputerActionOutcome: vi.fn(),
    },
    id: () => ids[index++] ?? `approval-${index}`,
    grantStore: {
      findMatches: () => [],
      create: () => {
        throw new Error('live desktop cannot create standing grants');
      },
      recordUse: () => {
        throw new Error('live desktop has no standing grants');
      },
    },
    followThrough: {
      coverageFor: () => null,
      activate: () => ({ domain: 'invalid', expiresAt: 0, remainingActions: 0 }),
      recordExecutedAction: () => false,
      deactivate: () => undefined,
    },
    markScreenshot: async (screenshot) => ({
      jpegBase64: screenshot.base64,
      pngBase64: 'bWFya2Vk',
    }),
  });
}

function approvalPort(
  verdict: AgentApprovalVerdict,
  onRequest: (request: ApprovalRequest, signal: AbortSignal) => void = () => undefined,
): AgentApprovalPort {
  const resolution = (): AgentApprovalResolution => ({
    verdict,
    acknowledge: vi.fn(),
    reject: vi.fn(),
    replace: vi.fn(async (request) => {
      onRequest(request, new AbortController().signal);
      return resolution();
    }),
  });
  return {
    request: vi.fn(async (request, signal) => {
      onRequest(request, signal);
      return resolution();
    }),
    cancelAgent: vi.fn(),
    get: vi.fn(() => null),
    resolve: vi.fn(async () => undefined),
  };
}

function operatorSafety(
  verdict: AgentApprovalVerdict = 'once',
  onRequest?: (request: ApprovalRequest, signal: AbortSignal) => void,
  evidence?: LiveDesktopEvidencePort,
) {
  return {
    agentId: 'live-run-1',
    userRequest: 'Click Save in the open app.',
    gate: liveGate(['approval-immutable', 'approval-stale']),
    approvals: approvalPort(verdict, onRequest),
    ...(evidence ? { evidence } : {}),
  };
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
    const driver = new LiveDesktopDriver({
      input,
      initialCaptures: [CAPTURE],
      dipToScreenPoint,
      capture: async () => {
        captures += 1;
        return [CAPTURE];
      },
    });
    const operator = new ComputerUseOperator({
      auth: AUTH,
      driver,
      ...operatorSafety('once', (approval) => {
        expect(Object.isFrozen(approval)).toBe(true);
        expect(Object.isFrozen(approval.payloadDigest)).toBe(true);
        expect(approval.approvalId).toBe('approval-immutable');
        expect(approval.userRequest).toBe('Click Save in the open app.');
      }),
      initialCaptures: [CAPTURE],
      isAllowed: () => true,
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
    expect(captures).toBe(3);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body['model'] === 'gpt-5.6-sol')).toBe(true);
    expect(bodies.every((body) => body['service_tier'] === 'priority')).toBe(true);
    const secondInput = bodies[1]!['input'] as Array<Record<string, unknown>>;
    expect(secondInput.at(-2)).toMatchObject({ type: 'function_call_output', call_id: 'call1' });
    expect(JSON.stringify(secondInput.at(-1))).toContain('data:image/jpeg;base64,ZmFrZQ==');
  });

  it('fails closed before inference when the setting is not allowed', async () => {
    const operator = new ComputerUseOperator({
      auth: AUTH,
      driver: {} as ComputerDriver,
      ...operatorSafety(),
      initialCaptures: [CAPTURE],
      isAllowed: () => false,
    });
    await expect(operator.run('click')).resolves.toMatchObject({ ok: false, actions: 0 });
  });

  it('denies a parked live click without ever dispatching it', async () => {
    const click = vi.fn(async () => undefined);
    const driver = desktopDriver(click, async () => [CAPTURE]);
    const operator = clickOperator(driver, operatorSafety('deny'));

    await expect(operator.run('click save')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary: 'the user denied this desktop action',
    });
    expect(click).not.toHaveBeenCalled();
  });

  it('discards a handled/reobserve verdict without dispatching the parked action', async () => {
    const click = vi.fn(async () => undefined);
    const driver = desktopDriver(click, async () => [CAPTURE]);
    const operator = clickOperator(driver, operatorSafety('handled'));

    await expect(operator.run('click save')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary: 'the pending desktop action was discarded after user control',
    });
    expect(click).not.toHaveBeenCalled();
  });

  it.each(['right', 'middle'] as const)(
    'preserves live %s-click support behind one-use human approval',
    async (button) => {
      const click = vi.fn(async () => undefined);
      const driver = desktopDriver(click, async () => [CAPTURE]);
      const operator = clickOperator(
        driver,
        operatorSafety('once', (approval) => {
          expect(approval.actionText).toBe(`${button}-click the marked target`);
        }),
        undefined,
        button,
      );

      await expect(operator.run(`${button} click save`)).resolves.toMatchObject({
        ok: true,
        actions: 1,
      });
      expect(click).toHaveBeenCalledWith(50, 100, button, 1);
    },
  );

  it.each([
    { name: 'type_text', args: { text: 'hello' }, dispatch: 'typeText' as const },
    { name: 'press_keys', args: { keys: ['ENTER'] }, dispatch: 'pressKeys' as const },
  ])('parks $name for human approval before dispatch', async ({ name, args, dispatch }) => {
    const typeText = vi.fn(async () => undefined);
    const pressKeys = vi.fn(async () => undefined);
    const driver: ComputerDriver = {
      capture: async () => [CAPTURE],
      click: async () => undefined,
      typeText,
      pressKeys,
      inspect: async () => null,
      inspectFocused: async () => null,
      readPendingPayload: async () => [],
      dispose: async () => undefined,
    };
    const seen: ApprovalRequest[] = [];
    const safety = operatorSafety('once', (request) => seen.push(request), {
      receiverIdentity: async () => 'receiver-a',
      fingerprint: async () => 'stable-native-receiver',
    });
    const operator = actionOperator(driver, safety, { name, args });

    await expect(operator.run('act')).resolves.toMatchObject({ ok: true, actions: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('live-action');
    if (name === 'type_text') {
      expect(seen[0]?.payloadDigest).toEqual(['Proposed text: hello']);
    }
    expect(dispatch === 'typeText' ? typeText : pressKeys).toHaveBeenCalledOnce();
  });

  it('hard-denies secret-shaped live text before human approval', async () => {
    const typeText = vi.fn(async () => undefined);
    const driver: ComputerDriver = {
      capture: async () => [CAPTURE],
      click: async () => undefined,
      typeText,
      pressKeys: async () => undefined,
      inspect: async () => null,
      inspectFocused: async () => null,
      readPendingPayload: async () => [],
      dispose: async () => undefined,
    };
    const approvals = approvalPort('once');
    const safety = { ...operatorSafety(), approvals };
    const operator = actionOperator(driver, safety, {
      name: 'type_text',
      args: { text: 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz' },
    });

    await expect(operator.run('enter it')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary: 'buddies cannot enter credential- or secret-shaped values',
    });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(typeText).not.toHaveBeenCalled();
  });

  it('makes safe keyboard input mechanically unavailable without native receiver evidence', async () => {
    const typeText = vi.fn(async () => undefined);
    const driver: ComputerDriver = {
      capture: async () => [CAPTURE],
      click: async () => undefined,
      typeText,
      pressKeys: async () => undefined,
      inspect: async () => null,
      inspectFocused: async () => null,
      readPendingPayload: async () => [],
      dispose: async () => undefined,
    };
    const approvals = approvalPort('once');
    const operator = actionOperator(
      driver,
      { ...operatorSafety(), approvals },
      {
        name: 'type_text',
        args: { text: 'hello' },
      },
    );

    await expect(operator.run('type hello')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary:
        'live keyboard input is unavailable because the native focused receiver cannot be verified',
    });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(typeText).not.toHaveBeenCalled();
  });

  it('replaces a stale approval before dispatching under a fresh human decision', async () => {
    const changed = { ...CAPTURE, jpegBase64: 'Y2hhbmdlZA==' };
    let captureCount = 0;
    const click = vi.fn(async () => undefined);
    const driver = desktopDriver(click, async () => {
      captureCount += 1;
      return [captureCount >= 2 ? changed : CAPTURE];
    });
    const approvalIds: string[] = [];
    const safety = operatorSafety('once', (request) => approvalIds.push(request.approvalId));
    const operator = clickOperator(driver, safety);

    await expect(operator.run('click save')).resolves.toMatchObject({
      ok: true,
      actions: 1,
    });
    expect(approvalIds).toEqual(['approval-immutable', 'approval-stale']);
    expect(click).toHaveBeenCalledOnce();
  });

  it('fails closed after bounded live approval replacements', async () => {
    let captureCount = 0;
    const click = vi.fn(async () => undefined);
    const driver = desktopDriver(click, async () => {
      captureCount += 1;
      return [{ ...CAPTURE, jpegBase64: Buffer.from(`state-${captureCount}`).toString('base64') }];
    });
    const approvals: string[] = [];
    const operator = clickOperator(
      driver,
      operatorSafety('once', (request) => approvals.push(request.approvalId)),
    );

    await expect(operator.run('click save')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary: 'desktop action approval could not stabilize after fresh evidence checks',
    });
    expect(approvals).toHaveLength(3);
    expect(click).not.toHaveBeenCalled();
  });

  it('ignores an unrelated monitor change while preserving the clicked target', async () => {
    const secondary: CaptureResult = {
      ...CAPTURE,
      meta: { ...CAPTURE.meta, screenIndex: 1, displayId: 2, isActive: false },
      jpegBase64: 'c2Vjb25kYXJ5LTE=',
    };
    let captureCount = 0;
    const click = vi.fn(async () => undefined);
    const driver = desktopDriver(click, async () => {
      captureCount += 1;
      return [
        CAPTURE,
        {
          ...secondary,
          jpegBase64: captureCount >= 2 ? 'c2Vjb25kYXJ5LTI=' : secondary.jpegBase64,
        },
      ];
    });
    const operator = clickOperator(driver, operatorSafety('once'));

    await expect(operator.run('click save')).resolves.toMatchObject({ ok: true, actions: 1 });
    expect(click).toHaveBeenCalledOnce();
  });

  it('discards keyboard input when the original native receiver is not restored', async () => {
    let receiverQuery = 0;
    const evidence: LiveDesktopEvidencePort = {
      receiverIdentity: vi.fn(async () => (++receiverQuery <= 2 ? 'focus-field-a' : 'buddy-panel')),
      fingerprint: vi.fn(async () => 'stable-visual-state'),
    };
    const typeText = vi.fn(async () => undefined);
    const driver: ComputerDriver = {
      capture: async () => [CAPTURE],
      click: async () => undefined,
      typeText,
      pressKeys: async () => undefined,
      inspect: async () => null,
      inspectFocused: async () => null,
      readPendingPayload: async () => [],
      dispose: async () => undefined,
    };
    const approvalIds: string[] = [];
    const operator = actionOperator(
      driver,
      operatorSafety('once', (request) => approvalIds.push(request.approvalId), evidence),
      {
        name: 'type_text',
        args: { text: 'hello' },
      },
    );

    await expect(operator.run('type hello')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary:
        'the original focused control could not be restored after approval, so the keyboard action was discarded',
    });
    expect(approvalIds).toEqual(['approval-immutable']);
    expect(typeText).not.toHaveBeenCalled();
  });

  it('restores and re-verifies the exact native receiver before keyboard dispatch', async () => {
    let receiver = 'target-field';
    const restoreReceiverIdentity = vi.fn(async (identity: string) => {
      expect(identity).toBe('target-field');
      receiver = identity;
      return true;
    });
    const evidence: LiveDesktopEvidencePort = {
      receiverIdentity: vi.fn(async () => receiver),
      restoreReceiverIdentity,
      fingerprint: vi.fn(async () => 'stable-visual-state'),
    };
    const typeText = vi.fn(async () => undefined);
    const driver: ComputerDriver = {
      capture: async () => [CAPTURE],
      click: async () => undefined,
      typeText,
      pressKeys: async () => undefined,
      inspect: async () => null,
      inspectFocused: async () => null,
      readPendingPayload: async () => [],
      dispose: async () => undefined,
    };
    const safety = operatorSafety(
      'once',
      () => {
        // The user clicked Buddy's approval UI, making it the OS receiver.
        receiver = 'buddy-panel';
      },
      evidence,
    );
    const operator = actionOperator(driver, safety, {
      name: 'type_text',
      args: { text: 'hello' },
    });

    await expect(operator.run('type hello')).resolves.toMatchObject({ ok: true, actions: 1 });
    expect(restoreReceiverIdentity).toHaveBeenCalledOnce();
    expect(typeText).toHaveBeenCalledWith('hello');
  });

  it('does not trust a successful restore call without an exact receiver re-query match', async () => {
    let receiver = 'target-field';
    const restoreReceiverIdentity = vi.fn(async () => true);
    const evidence: LiveDesktopEvidencePort = {
      receiverIdentity: vi.fn(async () => receiver),
      restoreReceiverIdentity,
      fingerprint: vi.fn(async () => 'stable-visual-state'),
    };
    const typeText = vi.fn(async () => undefined);
    const driver: ComputerDriver = {
      capture: async () => [CAPTURE],
      click: async () => undefined,
      typeText,
      pressKeys: async () => undefined,
      inspect: async () => null,
      inspectFocused: async () => null,
      readPendingPayload: async () => [],
      dispose: async () => undefined,
    };
    const operator = actionOperator(
      driver,
      operatorSafety(
        'once',
        () => {
          receiver = 'buddy-panel';
        },
        evidence,
      ),
      { name: 'type_text', args: { text: 'hello' } },
    );

    await expect(operator.run('type hello')).resolves.toMatchObject({
      ok: false,
      actions: 0,
      summary:
        'the original focused control could not be restored after approval, so the keyboard action was discarded',
    });
    expect(restoreReceiverIdentity).toHaveBeenCalledOnce();
    expect(typeText).not.toHaveBeenCalled();
  });

  it('fails closed when cancellation aborts a parked live action', async () => {
    const click = vi.fn(async () => undefined);
    const driver = desktopDriver(click, async () => [CAPTURE]);
    const abort = new AbortController();
    const safety = operatorSafety('deny', (_request, signal) => {
      abort.abort(new Error('superseded'));
      expect(signal.aborted).toBe(true);
    });
    const operator = clickOperator(driver, safety, abort.signal);

    await expect(operator.run('click save')).resolves.toMatchObject({ ok: false, actions: 0 });
    expect(click).not.toHaveBeenCalled();
  });
});

function desktopDriver(
  click: ReturnType<typeof vi.fn>,
  capture: () => Promise<CaptureResult[]>,
): LiveDesktopDriver {
  const input = {
    click,
    typeText: vi.fn(async () => undefined),
    pressKeys: vi.fn(async () => undefined),
  } as unknown as WindowsInputController;
  return new LiveDesktopDriver({
    input,
    initialCaptures: [CAPTURE],
    dipToScreenPoint,
    capture,
  });
}

function clickOperator(
  driver: LiveDesktopDriver,
  safety: ReturnType<typeof operatorSafety>,
  signal?: AbortSignal,
  button: 'left' | 'right' | 'middle' = 'left',
): ComputerUseOperator {
  return actionOperator(
    driver,
    safety,
    {
      name: 'click_at',
      args: { screen: 0, x: 25, y: 50, label: 'save', button },
    },
    signal,
  );
}

function actionOperator(
  driver: ComputerDriver,
  safety: ReturnType<typeof operatorSafety>,
  action: { name: string; args: Record<string, unknown> },
  signal?: AbortSignal,
): ComputerUseOperator {
  let request = 0;
  return new ComputerUseOperator({
    auth: AUTH,
    driver,
    ...safety,
    ...(signal ? { signal } : {}),
    initialCaptures: [CAPTURE],
    isAllowed: () => true,
    buildSession: (auth) =>
      new CodexResponsesSession({
        auth,
        instructions: 'operator',
        tools: [],
        fetchImpl: (async () => {
          request += 1;
          return request === 1
            ? response([
                {
                  type: 'response.output_item.added',
                  item: {
                    id: 'fc1',
                    type: 'function_call',
                    call_id: 'call1',
                    name: action.name,
                  },
                },
                {
                  type: 'response.function_call_arguments.done',
                  item_id: 'fc1',
                  arguments: JSON.stringify(action.args),
                },
                { type: 'response.completed', response: { id: 'r1' } },
              ])
            : response([{ type: 'response.completed', response: { id: 'r2' } }]);
        }) as typeof fetch,
        env: {},
      }),
  });
}

describe('LiveDesktopDriver', () => {
  it('maps screenshot pixels to native input coordinates and keeps fresh capture state', async () => {
    const click = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const input = {
      click,
      typeText: vi.fn(async () => undefined),
      pressKeys: vi.fn(async () => undefined),
      dispose,
    } as unknown as WindowsInputController;
    const capture = vi.fn(async () => [CAPTURE]);
    const driver = new LiveDesktopDriver({ input, capture, dipToScreenPoint });

    await expect(driver.click({ screenIndex: 0, x: 25, y: 50 }, 'left', 1)).rejects.toThrow(
      'that screenshot does not exist',
    );
    await expect(driver.capture()).resolves.toEqual([CAPTURE]);
    await driver.click({ screenIndex: 0, x: 25, y: 50 }, 'right', 2);
    await driver.typeText('hé😊');
    await driver.pressKeys(['CTRL', 'L']);

    expect(click).toHaveBeenCalledWith(50, 100, 'right', 2);
    expect(input.typeText).toHaveBeenCalledWith('hé😊');
    expect(input.pressKeys).toHaveBeenCalledWith(['CTRL', 'L']);
    await expect(driver.inspect({ screenIndex: 0, x: 25, y: 50 })).resolves.toBeNull();
    await expect(driver.navigate('https://example.com')).rejects.toThrow(
      'navigate is unsupported by the live desktop driver',
    );
    await expect(driver.scroll({ screenIndex: 0, x: 25, y: 50 }, 200)).rejects.toThrow(
      'scroll is unsupported by the live desktop driver',
    );
    await driver.dispose();
    expect(dispose).toHaveBeenCalledOnce();
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
