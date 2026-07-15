import { describe, expect, it, vi } from 'vitest';
import {
  ActionGate,
  type ActionGateJournalEntry,
  type GateDriverPort,
  type GatedActionRequest,
} from '../src/main/agents/gate/action-gate';
import type { ElementFacts, TriggerAction } from '../src/main/agents/gate/trigger';
import type { ActionReviewEvidence, ReviewAssessment } from '../src/main/agents/gate/reviewer';
import { ApprovalFollowThroughTracker, ApprovalGrantStore } from '../src/main/agents/gate/grants';
import type { ApprovalGrant } from '../src/shared/types';

const BUTTON: ElementFacts = {
  tag: 'button',
  text: 'Send',
  inForm: true,
  url: 'https://mail.example.com/compose',
  frame: 'top',
};

function assessment(verdict: ReviewAssessment['verdict']): ReviewAssessment {
  return {
    verdict,
    evidenceDigest: 'a'.repeat(64),
    payloadDigest: ['To: alice@example.com'],
    markedScreenshotPng: 'cG5nIQ==',
  };
}

class FakeDriver implements GateDriverPort {
  facts: ElementFacts | null = BUTTON;
  payload = [{ name: 'To', value: 'alice@example.com' }];
  pageRevision: string | number = 1;
  readonly inspectedPoints: { screenIndex: number; x: number; y: number }[] = [];
  focusedInspections = 0;
  captures = 0;

  async capture() {
    this.captures += 1;
    return [
      {
        jpegBase64: 'ZmFrZQ==',
        meta: {
          screenIndex: 0,
          displayId: 1,
          imageW: 100,
          imageH: 80,
          displayBounds: { x: 0, y: 0, width: 100, height: 80 },
          scaleFactor: 1,
          isActive: true,
        },
      },
    ];
  }

  async inspectDetailed(point: { screenIndex: number; x: number; y: number } | null) {
    if (point === null) this.focusedInspections += 1;
    else this.inspectedPoints.push(point);
    const facts = this.facts === null ? null : { ...this.facts };
    const payloadFields = this.payload.map((field) => ({ ...field }));
    return {
      facts,
      payloadFields,
      fingerprint: JSON.stringify({ facts, payloadFields }),
      pageRevision: this.pageRevision,
    };
  }
}

function request(driver: GateDriverPort, action: TriggerAction): GatedActionRequest {
  return {
    agentId: 'agent-1',
    origin: 'buddy-browser',
    userRequest: 'Send the launch note to alice@example.com.',
    taskClaim: 'send launch note',
    action,
    driver,
    seenDomains: ['example.com'],
  };
}

function setup(
  reviews: ReviewAssessment[],
  memory?: {
    grantStore: ApprovalGrantStore;
    followThrough: ApprovalFollowThroughTracker;
  },
) {
  const evidence: ActionReviewEvidence[] = [];
  const entries: ActionGateJournalEntry[] = [];
  const outcomes: unknown[] = [];
  const reviewer = {
    review: vi.fn(async (item: ActionReviewEvidence) => {
      evidence.push(item);
      const next = reviews.shift();
      if (next === undefined) throw new Error('missing fake review');
      return next;
    }),
  };
  let id = 0;
  const defaultMemory = createMemory();
  const gate = new ActionGate<string>({
    reviewer,
    journal: {
      recordActionGateAssessment: (entry) => entries.push(entry),
      recordComputerActionOutcome: (entry) => outcomes.push(entry),
    },
    id: () => `assessment-${++id}`,
    now: () => 1234,
    grantStore: memory?.grantStore ?? defaultMemory.grantStore,
    followThrough: memory?.followThrough ?? defaultMemory.followThrough,
  });
  return { gate, reviewer, evidence, entries, outcomes };
}

function createMemory(now: () => number = () => 1_000) {
  let persisted: ApprovalGrant[] = [];
  let id = 0;
  const grantStore = new ApprovalGrantStore({
    persistence: {
      load: () => persisted,
      save: (grants) => {
        persisted = grants.map((grant) => ({ ...grant }));
      },
    },
    now,
    createId: () => `grant-${++id}`,
  });
  const followThrough = new ApprovalFollowThroughTracker({ now });
  return { grantStore, followThrough };
}

const CLICK: TriggerAction = {
  kind: 'click',
  x: 40,
  y: 30,
  label: 'Send',
  justification: 'send the requested note',
};

describe('ActionGate mechanical enforcement', () => {
  it('dispatches an unflagged action without invoking the reviewer', async () => {
    const driver = new FakeDriver();
    const { gate, reviewer, entries } = setup([]);
    const dispatch = vi.fn(async () => 'scrolled');
    const value = await gate.execute(
      request(driver, {
        kind: 'scroll',
        x: 1,
        y: 2,
        dy: 10,
        justification: 'inspect lower content',
      }),
      dispatch,
    );
    expect(value).toEqual({ kind: 'executed', value: 'scrolled', reviewed: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(entries[0]).toMatchObject({
      at: 1234,
      verdict: 'pass',
      disposition: 'dispatch-pending',
    });
  });

  it('hard-denies prohibited navigation without signature/journal failures', async () => {
    const driver = new FakeDriver();
    const { gate, reviewer, entries } = setup([]);
    const dispatch = vi.fn(async () => 'navigated');
    const value = await gate.execute(
      request(driver, {
        kind: 'navigate',
        url: 'file:///etc/passwd',
        justification: 'open a local file',
      }),
      dispatch,
    );
    expect(value).toMatchObject({ kind: 'denied', reason: 'buddies cannot act on file pages' });
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
  });

  it.each(['right', 'middle'] as const)(
    'keeps %s-click hard-denied in the hidden buddy browser',
    async (button) => {
      const driver = new FakeDriver();
      driver.facts = { ...BUTTON, tag: 'div', actionable: false, text: 'Menu' };
      const { gate } = setup([]);
      const dispatch = vi.fn(async () => 'clicked');
      const value = await gate.execute(
        request(driver, { ...CLICK, label: 'Menu', button }),
        dispatch,
      );
      expect(value).toMatchObject({
        kind: 'denied',
        reason: 'buddies can only use left click',
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('inspects the focused element for type and hard-denies credentials', async () => {
    const driver = new FakeDriver();
    driver.facts = { ...BUTTON, tag: 'input', inputType: 'password', text: 'Password' };
    const { gate, reviewer } = setup([]);
    const dispatch = vi.fn(async () => 'typed');
    const value = await gate.execute(
      request(driver, { kind: 'type', text: 'secret', justification: 'sign in' }),
      dispatch,
    );
    expect(driver.focusedInspections).toBe(1);
    expect(driver.inspectedPoints).toHaveLength(0);
    expect(value).toMatchObject({ kind: 'denied', denied: true, halt: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('inspects focused form facts for ENTER and includes payload evidence', async () => {
    const driver = new FakeDriver();
    driver.facts = { ...BUTTON, tag: 'input', text: 'Title' };
    const { gate, evidence } = setup([
      assessment({ verdict: 'deny', reason: 'the requested recipient does not match' }),
    ]);
    const dispatch = vi.fn(async () => 'pressed');
    await gate.execute(
      request(driver, {
        kind: 'press_keys',
        keys: ['ENTER'],
        justification: 'submit the form',
      }),
      dispatch,
    );
    expect(driver.focusedInspections).toBe(1);
    expect(evidence[0]?.facts?.text).toBe('Title');
    expect(evidence[0]?.payloadFields).toEqual([{ name: 'To', value: 'alice@example.com' }]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('re-inspects reviewer-approved evidence immediately before dispatch', async () => {
    const driver = new FakeDriver();
    const { gate, reviewer, entries } = setup([
      assessment({ verdict: 'approve', reason: 'aligned' }),
    ]);
    const dispatch = vi.fn(async () => 'clicked');
    const value = await gate.execute(request(driver, CLICK), dispatch);
    expect(value).toEqual({ kind: 'executed', value: 'clicked', reviewed: true });
    expect(driver.inspectedPoints).toHaveLength(2);
    expect(reviewer.review).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(entries.at(-1)).toMatchObject({
      verdict: 'approve',
      disposition: 'dispatch-pending',
    });
  });

  it('discards stale reviewer approval and forces a fresh review', async () => {
    const driver = new FakeDriver();
    let inspection = 0;
    driver.inspectDetailed = vi.fn(async (point) => {
      if (point !== null) driver.inspectedPoints.push(point);
      inspection += 1;
      const facts = inspection <= 1 ? { ...BUTTON } : { ...BUTTON, text: 'Publish' };
      return {
        facts,
        payloadFields: [...driver.payload],
        fingerprint: JSON.stringify(facts),
        pageRevision: inspection <= 1 ? 1 : 2,
      };
    });
    const { gate, reviewer, entries } = setup([
      assessment({ verdict: 'approve', reason: 'send is aligned' }),
      assessment({ verdict: 'deny', reason: 'publish is not requested' }),
    ]);
    const dispatch = vi.fn(async () => 'clicked');
    const value = await gate.execute(request(driver, CLICK), dispatch);
    expect(value).toMatchObject({ kind: 'denied', reason: 'publish is not requested' });
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    expect(entries.some((entry) => entry.disposition === 'reassess')).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('parks escalation with an immutable id and dispatch closure', async () => {
    const driver = new FakeDriver();
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'this sends external mail',
      }),
    ]);
    const dispatch = vi.fn(async () => 'clicked');
    const escalated = await gate.execute(request(driver, CLICK), dispatch);
    expect(escalated).toMatchObject({
      kind: 'escalated',
      approvalId: 'assessment-1',
      userRequest: 'Send the launch note to alice@example.com.',
      browserDomain: 'example.com',
      grantScope: 'submit “send” on example.com',
      screenshotPng: 'cG5nIQ==',
      payloadDigest: ['To: alice@example.com'],
    });
    expect(Object.isFrozen(escalated)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(gate.hasPendingEscalation('assessment-1')).toBe(true);

    const resolved = await gate.resolveEscalation('assessment-1', 'once');
    expect(resolved).toEqual({
      kind: 'executed',
      value: 'clicked',
      reviewed: true,
      approvalId: 'assessment-1',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(gate.resolveEscalation('assessment-1', 'once')).rejects.toThrow(
      /already resolved/,
    );
  });

  it('cannot resurrect a pending escalation when reinspection settles after cancellation', async () => {
    const driver = new FakeDriver();
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'this sends external mail',
      }),
    ]);
    const controller = new AbortController();
    const dispatch = vi.fn(async () => 'clicked');
    await gate.execute({ ...request(driver, CLICK), signal: controller.signal }, dispatch);

    let rejectInspection!: (error: Error) => void;
    driver.inspectDetailed = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<FakeDriver['inspectDetailed']>>>((_, reject) => {
          rejectInspection = reject;
        }),
    );
    const resolving = gate.resolveEscalation('assessment-1', 'once');
    await vi.waitFor(() => expect(driver.inspectDetailed).toHaveBeenCalledOnce());

    controller.abort();
    gate.cancelAgent('agent-1');
    rejectInspection(new Error('late inspection failure'));

    await expect(resolving).rejects.toThrow(/abort/i);
    expect(gate.hasPendingEscalation('assessment-1')).toBe(false);
    expect(gate.hasPendingEscalation('assessment-2')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shows the normalized destination domain separately for navigation approval', async () => {
    const driver = new FakeDriver();
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'new destination',
      }),
    ]);
    const result = await gate.execute(
      request(driver, {
        kind: 'navigate',
        url: 'https://Login.Example.NET/account',
        justification: 'open the requested account page',
      }),
      async () => 'navigated',
    );
    expect(result).toMatchObject({
      kind: 'escalated',
      browserDomain: 'example.net',
      actionText:
        'navigate from https://mail.example.com/compose → https://login.example.net/account',
    });
  });

  it('shows destructive destination routes while redacting navigation query secrets', async () => {
    const driver = new FakeDriver();
    const secret = 'oauth-secret-value-123';
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'destructive destination',
      }),
    ]);
    const result = await gate.execute(
      request(driver, {
        kind: 'navigate',
        url: `https://admin.example.net/projects/42/delete?action=delete&confirm=true&access_token=${secret}&code=123456`,
        justification: 'open the requested project operation',
      }),
      async () => 'navigated',
    );
    expect(result).toMatchObject({
      kind: 'escalated',
      browserDomain: 'example.net',
      actionText:
        'navigate from https://mail.example.com/compose → https://admin.example.net/projects/42/delete?action=delete&confirm=true&access_token=[redacted]&code=[redacted]',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('123456');
  });

  it('does not let a deceptive anchor label hide its cross-site destination', async () => {
    const driver = new FakeDriver();
    driver.facts = {
      ...BUTTON,
      inForm: false,
      text: 'Back to your safe inbox',
      href: 'https://attacker.example.net/account/delete?confirm=true',
    };
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'label and destination differ',
        concern: 'cross-site destructive action',
      }),
    ]);
    const result = await gate.execute(request(driver, CLICK), async () => 'clicked');
    expect(result).toMatchObject({
      kind: 'escalated',
      browserDomain: 'example.net',
      actionText:
        'click page-provided target “Back to your safe inbox” on https://mail.example.com/compose → https://attacker.example.net/account/delete?confirm=true',
    });
  });

  it('shows and redacts the exact form destination for Enter submission', async () => {
    const driver = new FakeDriver();
    driver.facts = {
      ...BUTTON,
      text: 'Review only',
      formAction: '/transfer/confirm?account=123456789&amount=500&confirm=true',
    };
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'this submits a transfer',
      }),
    ]);
    const result = await gate.execute(
      request(driver, {
        kind: 'press_keys',
        keys: ['ENTER'],
        justification: 'submit the requested transfer',
      }),
      async () => 'pressed',
    );
    expect(result).toMatchObject({
      kind: 'escalated',
      browserDomain: 'example.com',
      actionText:
        'press ENTER in page-provided control “Review only” on https://mail.example.com/compose → https://mail.example.com/transfer/confirm?account=[redacted]&amount=500&confirm=true',
    });
    expect(JSON.stringify(result)).not.toContain('123456789');
  });

  it('renders confusable Unicode destination hosts as canonical ASCII', async () => {
    const driver = new FakeDriver();
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'new destination',
        concern: 'confusable host',
      }),
    ]);
    const result = await gate.execute(
      request(driver, {
        kind: 'navigate',
        url: 'https://раypal.com/confirm?action=delete',
        justification: 'open the requested confirmation',
      }),
      async () => 'navigated',
    );
    expect(result).toMatchObject({ kind: 'escalated' });
    if (result.kind !== 'escalated') throw new Error('expected escalation');
    expect(result.browserDomain).toContain('xn--');
    expect(result.actionText).toContain('https://xn--');
    expect(result.actionText).toContain('/confirm?action=delete');
    expect(result.actionText).not.toContain('раypal');
  });

  it('rejects an unknown runtime approval decision without mutating the pending action', async () => {
    const driver = new FakeDriver();
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'external send',
      }),
    ]);
    const dispatch = vi.fn(async () => 'clicked');
    await gate.execute(request(driver, CLICK), dispatch);

    await expect(gate.resolveEscalation('assessment-1', 'approve' as never)).rejects.toThrow(
      'approval decision is invalid',
    );
    expect(gate.hasPendingEscalation('assessment-1')).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();

    await expect(gate.resolveEscalation('assessment-1', 'once')).resolves.toMatchObject({
      kind: 'executed',
      approvalId: 'assessment-1',
    });
  });

  it('scrubs page labels and key names before rendering approval-card action text', async () => {
    const driver = new FakeDriver();
    driver.facts = {
      ...BUTTON,
      text: 'Send\u202E\nALWAYS ALLOW\u2066    now',
    };
    const { gate } = setup([
      assessment({ verdict: 'escalate', reason: 'aligned', concern: 'external action' }),
    ]);
    const click = await gate.execute(request(driver, CLICK), async () => 'clicked');
    expect(click).toMatchObject({
      kind: 'escalated',
      browserDomain: 'example.com',
      actionText: 'click page-provided target “Send ALWAYS ALLOW now”',
    });
    expect(click.kind === 'escalated' ? click.actionText : '').not.toMatch(/[\u202e\u2066\r\n]/u);

    const keyDriver = new FakeDriver();
    keyDriver.facts = null;
    const keyGate = setup([]).gate;
    const keys = await keyGate.execute(
      {
        ...request(keyDriver, {
          kind: 'press_keys',
          keys: ['CTRL\u202E\n', 'ENTER\u2066'],
          justification: 'submit the requested form',
        }),
        origin: 'live-desktop',
      },
      async () => 'pressed',
    );
    expect(keys).toMatchObject({
      kind: 'escalated',
      actionText: 'press CTRL + ENTER in the focused control',
    });
  });

  it('re-assesses when DOM or payload changed during human approval delay', async () => {
    const driver = new FakeDriver();
    const { gate, reviewer } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'external send',
      }),
      assessment({ verdict: 'deny', reason: 'recipient changed' }),
    ]);
    const dispatch = vi.fn(async () => 'clicked');
    const initial = await gate.execute(request(driver, CLICK), dispatch);
    expect(initial.kind).toBe('escalated');
    driver.payload = [{ name: 'To', value: 'attacker@example.net' }];
    const resolved = await gate.resolveEscalation('assessment-1', 'once');
    expect(resolved).toMatchObject({ kind: 'denied', reason: 'recipient changed' });
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps the same immutable approval retryable when downstream dispatch fails', async () => {
    const driver = new FakeDriver();
    const { gate, outcomes } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'aligned but consequential',
        concern: 'external send',
      }),
    ]);
    let attempts = 0;
    await gate.execute(request(driver, CLICK), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient dispatch failure');
      return 'clicked';
    });
    await expect(gate.resolveEscalation('assessment-1', 'once')).rejects.toThrow(
      'transient dispatch failure',
    );
    expect(gate.hasPendingEscalation('assessment-1')).toBe(true);
    await expect(gate.resolveEscalation('assessment-1', 'once')).resolves.toMatchObject({
      kind: 'executed',
      approvalId: 'assessment-1',
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ type: 'computer_action_failed', approvalId: 'assessment-1' }),
      expect.objectContaining({ type: 'computer_action_executed', approvalId: 'assessment-1' }),
    ]);
  });

  it('does not duplicate an always grant when a retained approval retries dispatch', async () => {
    const driver = new FakeDriver();
    const memory = createMemory();
    const { gate } = setup(
      [
        assessment({
          verdict: 'escalate',
          reason: 'aligned but consequential',
          concern: 'external send',
        }),
      ],
      memory,
    );
    let attempts = 0;
    await gate.execute(request(driver, CLICK), async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient dispatch failure');
      return 'clicked';
    });

    await expect(gate.resolveEscalation('assessment-1', 'always')).rejects.toThrow(
      'transient dispatch failure',
    );
    expect(memory.grantStore.list()).toHaveLength(1);
    await expect(gate.resolveEscalation('assessment-1', 'always')).resolves.toMatchObject({
      kind: 'executed',
    });
    expect(memory.grantStore.list()).toHaveLength(1);
    expect(memory.grantStore.list()[0]).toMatchObject({ timesUsed: 1 });
  });

  it('auto-escalates the third denial on one target and halts on five total', async () => {
    const driver = new FakeDriver();
    const reviews = Array.from({ length: 5 }, () =>
      assessment({ verdict: 'deny', reason: 'not aligned' }),
    );
    const { gate } = setup(reviews);
    const dispatch = vi.fn(async () => 'clicked');

    expect(await gate.execute(request(driver, CLICK), dispatch)).toMatchObject({ kind: 'denied' });
    expect(await gate.execute(request(driver, CLICK), dispatch)).toMatchObject({ kind: 'denied' });
    expect(await gate.execute(request(driver, CLICK), dispatch)).toMatchObject({
      kind: 'escalated',
    });
    gate.cancelAgent('agent-1');
    driver.facts = { ...BUTTON, text: 'Post' };
    expect(
      await gate.execute(request(driver, { ...CLICK, label: 'Post' }), dispatch),
    ).toMatchObject({
      kind: 'denied',
    });
    driver.facts = { ...BUTTON, text: 'Delete' };
    expect(
      await gate.execute(request(driver, { ...CLICK, label: 'Delete' }), dispatch),
    ).toMatchObject({ kind: 'denied', halt: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('escalates unresolved live-desktop actions without asking the reviewer', async () => {
    const driver = new FakeDriver();
    driver.facts = null;
    const { gate, reviewer } = setup([]);
    const dispatch = vi.fn(async () => 'clicked');
    const liveRequest = { ...request(driver, CLICK), origin: 'live-desktop' as const };
    const value = await gate.execute(liveRequest, dispatch);
    expect(value).toMatchObject({
      kind: 'escalated',
      concern: 'a user must verify actions on the live desktop',
    });
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('hard-denies secret-shaped proposed typing before live human escalation', async () => {
    const driver = new FakeDriver();
    driver.facts = null;
    const { gate, reviewer, entries } = setup([]);
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz';
    const dispatch = vi.fn(async () => 'typed');
    const value = await gate.execute(
      {
        ...request(driver, { kind: 'type', text: secret, justification: 'enter this value' }),
        origin: 'live-desktop',
      },
      dispatch,
    );
    expect(value).toMatchObject({ kind: 'denied', halt: false });
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('shows bounded non-secret proposed typing in live approval evidence', async () => {
    const driver = new FakeDriver();
    driver.facts = null;
    const { gate, reviewer } = setup([]);
    const value = await gate.execute(
      {
        ...request(driver, {
          kind: 'type',
          text: 'quarterly launch update',
          justification: 'enter the requested business text',
        }),
        origin: 'live-desktop',
      },
      async () => 'typed',
    );
    expect(value).toMatchObject({
      kind: 'escalated',
      payloadDigest: ['Proposed text: quarterly launch update'],
    });
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it('discards a takeover as handled and requires re-observation', async () => {
    const driver = new FakeDriver();
    const { gate } = setup([
      assessment({
        verdict: 'escalate',
        reason: 'user must sign in',
        concern: 'sign-in wall',
      }),
    ]);
    const dispatch = vi.fn(async () => 'clicked');
    await gate.execute(request(driver, CLICK), dispatch);
    await expect(gate.resolveEscalation('assessment-1', 'handled')).resolves.toEqual({
      kind: 'reobserve',
      handled: true,
      reason: 'the user handled the page; re-observe before proposing another action',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('passes only the freshly grounded navigation destination to dispatch', async () => {
    const driver = new FakeDriver();
    driver.facts = {
      ...BUTTON,
      formAction: '/send/final?draft=42',
      href: 'https://attacker.invalid/model-claim',
    };
    const { gate } = setup([assessment({ verdict: 'approve', reason: 'aligned' })]);
    const dispatch = vi.fn(async () => 'clicked');
    await gate.execute(request(driver, CLICK), dispatch);
    expect(dispatch).toHaveBeenCalledWith({
      navigationDestination: 'https://mail.example.com/send/final?draft=42',
    });
  });

  it('journals a secret-safe failed actuation outcome without claiming execution', async () => {
    const driver = new FakeDriver();
    const { gate, entries, outcomes } = setup([]);
    const failure = Object.assign(new Error('secret payload sk-never-journal'), {
      name: 'NavigationBlockedError',
    });
    await expect(
      gate.execute(
        request(driver, {
          kind: 'scroll',
          x: 1,
          y: 2,
          dy: 10,
          justification: 'inspect lower content',
        }),
        async () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(entries.at(-1)?.disposition).toBe('dispatch-pending');
    expect(outcomes).toEqual([
      expect.objectContaining({
        type: 'computer_action_failed',
        errorClass: 'NavigationBlockedError',
      }),
    ]);
    expect(JSON.stringify(outcomes)).not.toContain('sk-never-journal');
  });

  it('looks up exact standing grants internally and still invokes the reviewer on the next run', async () => {
    const memory = createMemory();
    const driver = new FakeDriver();
    const { gate, reviewer, evidence } = setup(
      [
        assessment({
          verdict: 'escalate',
          reason: 'aligned but consequential',
          concern: 'external send',
        }),
        assessment({ verdict: 'approve', reason: 'standing scope matches' }),
        assessment({ verdict: 'deny', reason: 'standing scope was revoked' }),
      ],
      memory,
    );
    await gate.execute(request(driver, CLICK), async () => 'first');
    await gate.resolveEscalation('assessment-1', 'always');

    const nextRun = { ...request(driver, CLICK), agentId: 'agent-2' };
    await gate.execute(nextRun, async () => 'second');
    expect(reviewer.review).toHaveBeenCalledTimes(2);
    expect(evidence[1]?.grants).toEqual([
      {
        domain: 'example.com',
        actionKind: 'form-submit',
        target: 'send',
        scope: 'standing',
      },
    ]);
    expect(memory.grantStore.list()[0]?.timesUsed).toBe(2);

    const grantId = memory.grantStore.list()[0]?.id;
    expect(grantId).toBeDefined();
    memory.grantStore.revoke(grantId!);
    await gate.execute({ ...nextRun, agentId: 'agent-3' }, async () => 'third');
    expect(reviewer.review).toHaveBeenCalledTimes(3);
    expect(evidence[2]?.grants).toEqual([]);
  });

  it('activates exactly three same-domain follow-through actions after human approval', async () => {
    const memory = createMemory();
    const driver = new FakeDriver();
    const { gate, evidence } = setup(
      [
        assessment({
          verdict: 'escalate',
          reason: 'aligned but consequential',
          concern: 'external send',
        }),
        ...Array.from({ length: 4 }, () =>
          assessment({ verdict: 'approve', reason: 'aligned confirmation' }),
        ),
      ],
      memory,
    );
    await gate.execute(request(driver, CLICK), async () => 'initial');
    await gate.resolveEscalation('assessment-1', 'once');
    for (let index = 0; index < 4; index += 1) {
      await gate.execute(request(driver, CLICK), async () => `follow-${index}`);
    }
    expect(evidence.slice(1, 4).every((item) => item.grants?.[0]?.scope === 'follow-through')).toBe(
      true,
    );
    expect(evidence[4]?.grants).toEqual([]);
  });

  it('ends follow-through after an executed cross-domain action and on cancellation', async () => {
    const memory = createMemory();
    memory.followThrough.activate('agent-1', 'example.com');
    const driver = new FakeDriver();
    const { gate, evidence } = setup(
      [
        assessment({ verdict: 'approve', reason: 'cross-domain navigation is aligned' }),
        assessment({ verdict: 'approve', reason: 'return action is aligned' }),
      ],
      memory,
    );
    await gate.execute(
      request(driver, {
        kind: 'navigate',
        url: 'https://other.example.net/work',
        justification: 'continue the requested workflow',
      }),
      async () => 'navigated',
    );
    await gate.execute(request(driver, CLICK), async () => 'clicked');
    expect(evidence[1]?.grants).toEqual([]);

    memory.followThrough.activate('agent-1', 'example.com');
    gate.cancelAgent('agent-1');
    expect(memory.followThrough.coverageFor('agent-1', 'example.com')).toBeNull();
  });

  it('never presents a standing grant for a different normalized target', async () => {
    const memory = createMemory();
    memory.grantStore.create({
      domain: 'example.com',
      actionKind: 'form-submit',
      target: 'send',
    });
    const driver = new FakeDriver();
    driver.facts = { ...BUTTON, text: 'Publish' };
    const { gate, evidence } = setup(
      [assessment({ verdict: 'deny', reason: 'publish was not requested' })],
      memory,
    );
    await gate.execute(request(driver, { ...CLICK, label: 'Publish' }), async () => 'clicked');
    expect(evidence[0]?.grants).toEqual([]);
  });

  it('reassesses when a standing grant is revoked during review', async () => {
    const memory = createMemory();
    const grant = memory.grantStore.create({
      domain: 'example.com',
      actionKind: 'form-submit',
      target: 'send',
    });
    const driver = new FakeDriver();
    const { gate, reviewer, evidence } = setup([], memory);
    reviewer.review
      .mockImplementationOnce(async (item) => {
        evidence.push(item);
        memory.grantStore.revoke(grant.id);
        return assessment({ verdict: 'approve', reason: 'standing scope matched' });
      })
      .mockImplementationOnce(async (item) => {
        evidence.push(item);
        return assessment({ verdict: 'deny', reason: 'fresh review has no consequence grant' });
      });
    const dispatch = vi.fn(async () => 'clicked');
    const result = await gate.execute(request(driver, CLICK), dispatch);
    expect(result).toMatchObject({
      kind: 'denied',
      reason: 'fresh review has no consequence grant',
    });
    expect(evidence[0]?.grants?.[0]?.scope).toBe('standing');
    expect(evidence[1]?.grants).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reassesses when follow-through expires during review', async () => {
    let now = 1_000;
    const memory = createMemory(() => now);
    memory.followThrough.activate('agent-1', 'example.com');
    const driver = new FakeDriver();
    const { gate, reviewer, evidence } = setup([], memory);
    reviewer.review
      .mockImplementationOnce(async (item) => {
        evidence.push(item);
        now += 60_000;
        return assessment({ verdict: 'approve', reason: 'follow-through matched' });
      })
      .mockImplementationOnce(async (item) => {
        evidence.push(item);
        return assessment({ verdict: 'deny', reason: 'follow-through expired' });
      });
    const dispatch = vi.fn(async () => 'clicked');
    const result = await gate.execute(request(driver, CLICK), dispatch);
    expect(result).toMatchObject({ kind: 'denied', reason: 'follow-through expired' });
    expect(evidence[0]?.grants?.[0]?.scope).toBe('follow-through');
    expect(evidence[1]?.grants).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
