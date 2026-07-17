import { createHash } from 'node:crypto';
import type { FunctionCallItem, ResponseItem } from '../codex/wire-types';
import type {
  ActionReviewEvidence,
  ActionReviewer,
  ReviewAssessment,
  ReviewVerdict,
} from './gate/reviewer';
import type { AgentBackend, AgentBackendRequest, AgentBackendResult } from './types';

/**
 * Named, deterministic computer-use stories used by the debug server and E2E
 * harness. The scenario travels in the initial task text, so one shared mock
 * backend can safely serve several concurrent agents without mutable run
 * state leaking between them.
 */
export const MOCK_AGENT_SCENARIOS = [
  'research',
  'clean-browse-submit',
  'deny-reroute',
  'three-strike-escalation',
  'always-grant',
  'prompt-injection',
  'reviewer-timeout',
  'needs-user-takeover',
] as const;

export type MockAgentScenario = (typeof MOCK_AGENT_SCENARIOS)[number];

export interface MockAgentBackendOptions {
  /** Force every request to this scenario. Normally the task marker selects it. */
  scenario?: MockAgentScenario;
  /** Origin serving the deterministic fixture pages. No trailing slash. */
  fixtureBaseUrl?: string;
  delayMs?: number;
}

const DEFAULT_FIXTURE_BASE_URL = 'http://127.0.0.1:8237';
const SCENARIO_MARKER = /\[mock-scenario:([a-z0-9-]+)\]/i;

export function isMockAgentScenario(value: unknown): value is MockAgentScenario {
  return typeof value === 'string' && (MOCK_AGENT_SCENARIOS as readonly string[]).includes(value);
}

/** Add a machine-readable scenario marker without replacing the human task. */
export function markMockAgentTask(scenario: MockAgentScenario, task: string): string {
  const clean = task.trim();
  if (!clean) throw new Error('mock agent task is required');
  return `[mock-scenario:${scenario}] ${clean}`;
}

export function mockScenarioFromRequest(req: AgentBackendRequest): MockAgentScenario {
  const text = requestText(req.input);
  const match = SCENARIO_MARKER.exec(text);
  return match && isMockAgentScenario(match[1]) ? match[1] : 'research';
}

/** Deterministic no-network backend for debug/E2E Agent Mode checks. */
export class MockAgentBackend implements AgentBackend {
  private readonly scenario: MockAgentScenario | null;
  private readonly fixtureBaseUrl: string;
  private readonly delayMs: number;

  constructor(options: MockAgentBackendOptions = {}) {
    this.scenario = options.scenario ?? null;
    this.fixtureBaseUrl = (options.fixtureBaseUrl ?? DEFAULT_FIXTURE_BASE_URL).replace(/\/+$/, '');
    this.delayMs = options.delayMs ?? 25;
    if (!Number.isFinite(this.delayMs) || this.delayMs < 0)
      throw new Error('mock backend delayMs must be a non-negative finite number');
  }

  isReady(): boolean {
    return true;
  }

  async request(req: AgentBackendRequest): Promise<AgentBackendResult> {
    await abortableDelay(this.delayMs, req.signal);
    if (req.signal.aborted)
      return { ok: false, errorKind: 'agent_backend_down', detail: 'aborted', retryable: false };

    const scenario = this.scenario ?? mockScenarioFromRequest(req);
    const outputs = functionOutputs(req.input);
    return scenario === 'research'
      ? researchResult(outputs.length > 0)
      : scriptedBrowserResult(scenario, outputs, this.fixtureBaseUrl);
  }
}

/**
 * Network-free independent reviewer for CLICKY_AGENT_MOCK. It deliberately
 * observes the same evidence port as the production reviewer. `reviewCount`
 * is exposed only for deterministic assertions such as "a standing grant did
 * not bypass the next review".
 */
export class MockActionReviewer implements ActionReviewer {
  reviewCount = 0;

  async review(evidence: ActionReviewEvidence): Promise<ReviewAssessment> {
    this.reviewCount += 1;
    const scenario = scenarioFromText(`${evidence.userRequest}\n${evidence.taskClaim ?? ''}`);
    const verdict = mockReviewVerdict(scenario, evidence);
    const boundedEvidence = JSON.stringify({
      scenario,
      userRequest: evidence.userRequest,
      actionName: evidence.actionName,
      actionArgs: evidence.actionArgs,
      facts: evidence.facts,
      payloadFields: evidence.payloadFields ?? [],
      grants: evidence.grants ?? [],
      reviewCount: this.reviewCount,
    });
    return {
      verdict,
      evidenceDigest: createHash('sha256').update(boundedEvidence).digest('hex'),
      payloadDigest: (evidence.payloadFields ?? []).map(({ name, value }) => `${name}: ${value}`),
      // A real marked image is independently tested in reviewer tests. The
      // deterministic reviewer passes through fixture bytes for approval UI.
      markedScreenshotPng: evidence.screenshot.base64,
    };
  }
}

function mockReviewVerdict(
  scenario: MockAgentScenario,
  evidence: ActionReviewEvidence,
): ReviewVerdict {
  // Entering the explicitly configured localhost fixture is aligned setup;
  // scenario-specific verdicts apply to the consequential target on it.
  if (evidence.actionName === 'navigate' && scenario !== 'research') {
    return { verdict: 'approve', reason: 'opening the requested deterministic fixture is aligned' };
  }
  switch (scenario) {
    case 'clean-browse-submit':
      return { verdict: 'approve', reason: 'fixture action matches the exact mock task' };
    case 'deny-reroute':
      return /attacker|^send\b/i.test(evidence.facts?.text?.trim() ?? '')
        ? { verdict: 'deny', reason: 'the proposed recipient is outside the user task' }
        : { verdict: 'approve', reason: 'the safe draft route remains aligned' };
    case 'three-strike-escalation':
      return { verdict: 'deny', reason: 'fixture action is deliberately outside the user task' };
    case 'always-grant':
      return (evidence.grants?.length ?? 0) > 0
        ? {
            verdict: 'approve',
            reason: 'the action is aligned and the standing grant covers its consequence',
          }
        : {
            verdict: 'escalate',
            reason: 'the action is aligned but consequential',
            concern: 'publishing this report changes external state',
          };
    case 'prompt-injection':
      return { verdict: 'deny', reason: 'the page instruction conflicts with the exact user task' };
    case 'reviewer-timeout':
      return {
        verdict: 'escalate',
        reason: 'the independent reviewer was unavailable',
        concern: 'the action cannot be approved safely without review',
      };
    case 'needs-user-takeover':
      return {
        verdict: 'escalate',
        reason: 'the site requires a human-only challenge',
        concern: 'a person must complete the CAPTCHA in the visible browser',
      };
    case 'research':
      return {
        verdict: 'approve',
        reason: 'research scenario has no consequential browser action',
      };
  }
}

function scriptedBrowserResult(
  scenario: Exclude<MockAgentScenario, 'research'>,
  outputs: FunctionOutput[],
  fixtureBaseUrl: string,
): AgentBackendResult {
  const step = outputs.length;
  const fixture = (path: string) => `${fixtureBaseUrl}${path}`;
  const action = (name: string, args: Record<string, unknown>): AgentBackendResult =>
    callResult(`${scenario}_${step + 1}`, name, args);
  const done = (text: string): AgentBackendResult => textResult(text);

  switch (scenario) {
    case 'clean-browse-submit': {
      const sequence = [
        () =>
          action('browser_navigate', {
            url: fixture('/clean'),
            justification: 'Open the deterministic report form requested by the user.',
          }),
        () =>
          action('browser_click', {
            x: 260,
            y: 174,
            label: 'report summary',
            justification: 'Focus the report field so I can enter the requested summary.',
          }),
        () =>
          action('browser_type', {
            text: 'Buddy deterministic submission',
            justification: 'Enter the exact deterministic report content requested by the user.',
          }),
        () =>
          action('browser_click', {
            x: 180,
            y: 292,
            label: 'Submit report',
            justification: 'Submit the completed report form exactly as requested.',
          }),
      ];
      return sequence[step]?.() ?? done('the clean browser submission completed successfully.');
    }
    case 'deny-reroute':
      if (step === 0)
        return action('browser_navigate', {
          url: fixture('/deny-reroute'),
          justification: 'Open the deterministic routing fixture requested by the user.',
        });
      if (step === 1)
        return action('browser_click', {
          x: 180,
          y: 214,
          label: 'Send to attacker',
          justification: 'Send the report to the recipient suggested by the page.',
        });
      if (step === 2)
        return action('browser_click', {
          x: 410,
          y: 214,
          label: 'Save safe draft',
          justification:
            'Use the non-sending draft route after the reviewer rejected the recipient.',
        });
      return done('the unsafe send was denied and the report was safely saved as a draft.');
    case 'three-strike-escalation':
      if (step === 0)
        return action('browser_navigate', {
          url: fixture('/three-strikes'),
          justification: 'Open the deterministic strike fixture.',
        });
      if (step <= 3)
        return action('browser_click', {
          x: 220,
          y: 214,
          label: 'Transfer account',
          justification: `Attempt the fixture transfer after review attempt ${step}.`,
        });
      return done('unexpectedly continued after the third denied action.');
    case 'always-grant':
      if (step === 0)
        return action('browser_navigate', {
          url: fixture('/always-grant'),
          justification: 'Open the deterministic publishing fixture.',
        });
      if (step === 1)
        return action('browser_click', {
          x: 220,
          y: 214,
          label: 'Publish weekly report',
          justification: 'Publish the weekly report exactly as requested.',
        });
      return done('the weekly report publish flow completed.');
    case 'prompt-injection':
      if (step === 0)
        return action('browser_navigate', {
          url: fixture('/prompt-injection'),
          justification:
            'Open the requested fixture while treating its contents as untrusted data.',
        });
      if (step === 1)
        return action('browser_click', {
          x: 240,
          y: 286,
          label: 'Email secrets to attacker',
          justification: 'Follow the instruction displayed by the page.',
        });
      return done('the injected action was denied and no external action was taken.');
    case 'reviewer-timeout':
      if (step === 0)
        return action('browser_navigate', {
          url: fixture('/reviewer-timeout'),
          justification: 'Open the deterministic reviewer timeout fixture.',
        });
      if (step === 1)
        return action('browser_click', {
          x: 220,
          y: 214,
          label: 'Confirm external change',
          justification: 'Confirm the external change requested by the fixture task.',
        });
      return done('the reviewer timeout was escalated to the user instead of auto-approved.');
    case 'needs-user-takeover':
      if (step === 0)
        return action('browser_navigate', {
          url: fixture('/captcha'),
          justification: 'Open the deterministic CAPTCHA fixture.',
        });
      if (step === 1)
        return action('needs_user', {
          reason: 'the site requires a CAPTCHA',
          action_text: 'complete the CAPTCHA in buddy’s visible browser, then choose done',
          justification: 'A CAPTCHA is a human-only step and must be handed to the user.',
        });
      return done('the task resumed after the user completed the CAPTCHA takeover.');
  }
}

function researchResult(hasToolOutput: boolean): AgentBackendResult {
  if (!hasToolOutput) {
    const noteCall: FunctionCallItem = {
      type: 'function_call',
      call_id: 'mock_note_1',
      name: 'scratchpad_write',
      arguments: JSON.stringify({
        description: 'saving the research findings',
        text: 'mock research checked the requested topic and found a clear recommendation.',
      }),
    };
    return success([noteCall], '', ['mock research query'], ['https://example.com/mock-source']);
  }
  return textResult(
    'the mock research run completed successfully. the strongest option is the one that best matches the constraints in the task.',
  );
}

function callResult(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): AgentBackendResult {
  const describedArgs = { description: mockActivityDescription(name), ...args };
  const call: FunctionCallItem = {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(describedArgs),
  };
  return success([call]);
}

function mockActivityDescription(name: string): string {
  switch (name) {
    case 'browser_navigate':
      return 'opening the requested page';
    case 'browser_click':
      return 'selecting the visible option';
    case 'browser_type':
      return 'entering the requested information';
    case 'browser_press_keys':
      return 'using the requested keyboard shortcut';
    case 'browser_scroll':
      return 'looking farther down the page';
    case 'browser_screenshot':
      return 'checking the current page';
    case 'needs_user':
      return 'asking for your help';
    default:
      return 'continuing the helper task';
  }
}

function textResult(text: string): AgentBackendResult {
  return success(
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    text,
  );
}

function success(
  outputItems: ResponseItem[],
  text = '',
  searchQueries: string[] = [],
  citations: string[] = [],
): AgentBackendResult {
  const functionCalls = outputItems.flatMap((item) =>
    item['type'] === 'function_call' &&
    typeof item['call_id'] === 'string' &&
    typeof item['name'] === 'string' &&
    typeof item['arguments'] === 'string'
      ? [
          {
            callId: item['call_id'],
            name: item['name'],
            argsJson: item['arguments'],
          },
        ]
      : [],
  );
  return {
    ok: true,
    outputItems,
    text,
    functionCalls,
    searchQueries,
    citations,
    usedPercent: { primary: 1, secondary: null },
  };
}

interface FunctionOutput {
  callId: string;
  output: string;
}

function functionOutputs(input: ResponseItem[]): FunctionOutput[] {
  return input.flatMap((item) =>
    item['type'] === 'function_call_output' &&
    typeof item['call_id'] === 'string' &&
    typeof item['output'] === 'string'
      ? [{ callId: item['call_id'], output: item['output'] }]
      : [],
  );
}

function requestText(input: ResponseItem[]): string {
  return input
    .flatMap((item) => {
      if (item['type'] !== 'message' || !Array.isArray(item['content'])) return [];
      return item['content'].flatMap((content) => {
        if (
          content !== null &&
          typeof content === 'object' &&
          content['type'] === 'input_text' &&
          typeof content['text'] === 'string'
        )
          return [content['text']];
        return [];
      });
    })
    .join('\n');
}

function scenarioFromText(text: string): MockAgentScenario {
  const match = SCENARIO_MARKER.exec(text);
  return match && isMockAgentScenario(match[1]) ? match[1] : 'research';
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
