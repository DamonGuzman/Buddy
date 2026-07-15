import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/main/agents/agent';
import {
  markMockAgentTask,
  MockActionReviewer,
  MockAgentBackend,
  type MockAgentScenario,
} from '../src/main/agents/mock-backend';
import {
  ActionGate,
  type ActionGateJournalEntry,
  type GateDriverInspection,
  type GateDriverPort,
} from '../src/main/agents/gate/action-gate';
import type { ActionSignature } from '../src/main/agents/gate/signature';
import { ApprovalFollowThroughTracker, ApprovalGrantStore } from '../src/main/agents/gate/grants';
import type { ElementFacts } from '../src/main/agents/gate/trigger';
import type {
  AgentApprovalPort,
  AgentApprovalResolution,
  AgentApprovalVerdict,
  AgentBrief,
  AgentBrowserDeps,
} from '../src/main/agents/types';
import type { ApprovalGrant, ApprovalRequest } from '../src/shared/types';
import type { CaptureResult } from '../src/main/capture';
import type { ComputerDriver, DriverPoint, MouseButton } from '../src/main/computer/driver';

interface RuntimeResult {
  status: string;
  driver: ScriptedDriver;
  journal: ActionGateJournalEntry[];
  approvals: ApprovalRequest[];
  reviewer: MockActionReviewer;
  remembered: ActionSignature[];
}

async function runScenario(scenario: MockAgentScenario): Promise<RuntimeResult> {
  const task = markMockAgentTask(scenario, 'complete only the deterministic fixture task');
  const brief: AgentBrief = {
    id: `runtime-${scenario}`,
    userRequest: task,
    task,
    recentTranscript: '',
    createdAt: 1,
    browserEnabled: true,
  };
  const driver = new ScriptedDriver();
  const reviewer = new MockActionReviewer();
  const journal: ActionGateJournalEntry[] = [];
  let grantRecords: ApprovalGrant[] = [];
  const grantStore = new ApprovalGrantStore({
    persistence: {
      load: () => grantRecords,
      save: (grants) => {
        grantRecords = grants.map((grant) => ({ ...grant }));
      },
    },
    now: () => 1,
    createId: () => `${scenario}-grant`,
  });
  const approvalRequests: ApprovalRequest[] = [];
  const approvals: AgentApprovalPort = {
    request: async (request) => {
      approvalRequests.push(request);
      return approvalResolution(approvalDecision(scenario, request));
    },
    cancelAgent: () => undefined,
    get: () => null,
    resolve: async () => undefined,
  };
  const gate = new ActionGate<void>({
    reviewer,
    journal: {
      recordActionGateAssessment: (entry) => journal.push(entry),
      recordComputerActionOutcome: () => undefined,
    },
    grantStore,
    followThrough: new ApprovalFollowThroughTracker({ now: () => 1 }),
    id: () => `${scenario}-approval`,
  });
  const browser: AgentBrowserDeps = {
    createDriver: async () => driver,
    gate,
    approvals,
    settleMs: 0,
    captureToPngDataUrl: async () => 'data:image/png;base64,bW9jaw==',
  };
  const summary = await new AgentRunner({
    brief,
    backend: new MockAgentBackend({
      scenario,
      fixtureBaseUrl: 'https://fixture.test',
      delayMs: 0,
    }),
    browser,
    onUpdate: () => undefined,
  }).run();
  expect(journal[0], `${scenario} must reviewer-approve its explicit navigation`).toMatchObject({
    actionKind: 'navigate',
    trigger: 'review',
    verdict: 'approve',
    disposition: 'dispatch-pending',
  });
  return {
    status: summary.status,
    driver,
    journal,
    approvals: approvalRequests,
    reviewer,
    remembered: grantStore.list().map(({ domain, actionKind, target }) => ({
      domain,
      actionKind,
      target,
    })),
  };
}

function approvalResolution(verdict: AgentApprovalVerdict): AgentApprovalResolution {
  return {
    verdict,
    acknowledge: () => undefined,
    reject: (error) => {
      throw error;
    },
    replace: async () => approvalResolution(verdict),
  };
}

function approvalDecision(
  scenario: MockAgentScenario,
  request: ApprovalRequest,
): AgentApprovalVerdict {
  if (request.kind === 'browser-capability') return 'once';
  if (request.kind === 'needs-user') return 'handled';
  if (scenario === 'always-grant' && request.kind === 'browser-action') return 'always';
  return 'deny';
}

describe('scripted mock through AgentRunner + browser runtime + ActionGate', () => {
  it('executes clean browse/type/submit end to end', async () => {
    const result = await runScenario('clean-browse-submit');
    expect(result.status).toBe('done');
    expect(result.driver.actions).toEqual([
      'navigate:/clean',
      'click:260,174',
      'type:Buddy deterministic submission',
      'click:180,292',
    ]);
    expect(result.journal.at(-1)).toMatchObject({
      verdict: 'approve',
      disposition: 'dispatch-pending',
    });
  });

  it('denies the unsafe send but executes the safe reroute', async () => {
    const result = await runScenario('deny-reroute');
    expect(result.status).toBe('done');
    expect(result.driver.actions).toEqual(['navigate:/deny-reroute', 'click:410,214']);
    expect(result.journal.some((entry) => entry.verdict === 'deny')).toBe(true);
  });

  it('raises hand on the third same-target denial', async () => {
    const result = await runScenario('three-strike-escalation');
    expect(result.status).toBe('done');
    expect(result.driver.actions).toEqual(['navigate:/three-strikes']);
    expect(result.approvals.some((request) => request.kind === 'browser-action')).toBe(true);
    expect(result.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: 'escalate',
          disposition: 'await-human',
          targetDenials: 3,
        }),
      ]),
    );
  });

  it('persists always approval only after human escalation', async () => {
    const result = await runScenario('always-grant');
    expect(result.status).toBe('done');
    expect(result.remembered).toHaveLength(1);
    expect(result.driver.actions).toEqual(['navigate:/always-grant', 'click:220,214']);
    expect(result.reviewer.reviewCount).toBe(2);
  });

  it('blocks the prompt-injected click and journals the refusal', async () => {
    const result = await runScenario('prompt-injection');
    expect(result.status).toBe('done');
    expect(result.driver.actions).toEqual(['navigate:/prompt-injection']);
    expect(result.journal.at(-1)).toMatchObject({ verdict: 'deny', disposition: 'refuse' });
  });

  it('fails closed on reviewer timeout and requires a human decision', async () => {
    const result = await runScenario('reviewer-timeout');
    expect(result.status).toBe('done');
    expect(result.driver.actions).toEqual(['navigate:/reviewer-timeout']);
    expect(result.approvals.some((request) => request.kind === 'browser-action')).toBe(true);
    expect(result.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ verdict: 'escalate', disposition: 'await-human' }),
      ]),
    );
  });

  it('parks for CAPTCHA takeover, resumes, and re-observes', async () => {
    const result = await runScenario('needs-user-takeover');
    expect(result.status).toBe('done');
    expect(result.driver.actions).toEqual(['navigate:/captcha']);
    expect(result.approvals.some((request) => request.kind === 'needs-user')).toBe(true);
    expect(result.driver.captureCount).toBeGreaterThanOrEqual(4);
  });
});

class ScriptedDriver implements ComputerDriver, GateDriverPort {
  actions: string[] = [];
  captureCount = 0;
  private path = '/blank';
  private focused: ElementFacts | null = null;
  private typed = '';

  async capture(): Promise<CaptureResult[]> {
    this.captureCount += 1;
    return [
      {
        meta: {
          screenIndex: 0,
          displayId: 0,
          imageW: 1024,
          imageH: 768,
          displayBounds: { x: 0, y: 0, width: 1024, height: 768 },
          scaleFactor: 1,
          isActive: true,
        },
        jpegBase64: Buffer.from(`capture:${this.path}:${this.captureCount}`).toString('base64'),
      },
    ];
  }

  async navigate(url: string): Promise<void> {
    this.path = new URL(url).pathname;
    this.focused = null;
    this.actions.push(`navigate:${this.path}`);
  }

  async click(target: DriverPoint, _button: MouseButton, _count: 1 | 2): Promise<void> {
    this.actions.push(`click:${target.x},${target.y}`);
    const facts = this.factsAt(target);
    this.focused = ['input', 'textarea', 'select'].includes(facts.tag) ? facts : null;
  }

  async typeText(text: string): Promise<void> {
    this.typed += text;
    this.actions.push(`type:${text}`);
  }

  async pressKeys(keys: string[]): Promise<void> {
    this.actions.push(`keys:${keys.join('+')}`);
  }

  async scroll(_target: DriverPoint, dy: number): Promise<void> {
    this.actions.push(`scroll:${dy}`);
  }

  async inspect(target: DriverPoint): Promise<ElementFacts | null> {
    return this.factsAt(target);
  }

  async inspectFocused(): Promise<ElementFacts | null> {
    return this.focused ? { ...this.focused, text: this.typed || this.focused.text } : null;
  }

  async readPendingPayload(): Promise<Array<{ name: string; value: string; type?: string }>> {
    return this.path === '/clean' ? [{ name: 'summary', value: this.typed, type: 'textarea' }] : [];
  }

  async authorizeNextNavigation(_destination: string): Promise<void> {}

  async inspectDetailed(target: DriverPoint | null): Promise<GateDriverInspection> {
    const facts = target === null ? await this.inspectFocused() : this.factsAt(target);
    const payloadFields = await this.readPendingPayload();
    return {
      facts,
      payloadFields,
      fingerprint: JSON.stringify({ path: this.path, facts, payloadFields }),
      pageRevision: `${this.path}:${this.typed}`,
    };
  }

  async dispose(): Promise<void> {}

  private factsAt(target: DriverPoint): ElementFacts {
    const base = {
      inForm: false,
      url: `https://fixture.test${this.path}`,
      frame: 'top' as const,
      actionable: true,
    };
    if (this.path === '/clean' && target.y < 240) {
      return { ...base, tag: 'textarea', text: this.typed, inForm: true, name: 'summary' };
    }
    const labels: Record<string, string> = {
      '/clean': 'Submit report',
      '/three-strikes': 'Transfer account',
      '/always-grant': 'Publish weekly report',
      '/prompt-injection': 'Email secrets to attacker',
      '/reviewer-timeout': 'Confirm external change',
      '/captcha': 'CAPTCHA required',
    };
    if (this.path === '/deny-reroute') {
      return {
        ...base,
        tag: 'button',
        text: target.x < 300 ? 'Send to attacker' : 'Save safe draft',
      };
    }
    return {
      ...base,
      tag: 'button',
      text: labels[this.path] ?? 'fixture page',
      inForm: this.path === '/clean',
      ...(this.path === '/clean' ? { formAction: 'https://fixture.test/submit' } : {}),
    };
  }
}
