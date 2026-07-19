import type { ChatGptCodexAuthSource } from '../auth/auth-source';
import type { ApprovalRequest } from '../../shared/types';
import type {
  HelperBuddyActionGatePort,
  HelperBuddyApprovalPort,
  HelperBuddyApprovalVerdict,
} from '../agents/types';
import type {
  GateDriverInspection,
  GateDriverPort,
  GateExecutionResult,
  GatedActionRequest,
} from '../agents/gate/action-gate';
import type { TriggerAction } from '../agents/gate/trigger';
import { isSecretLikeValue } from '../agents/gate/reviewer';
import type { CaptureResult } from '../capture';
import { CodexResponsesSession, DEFAULT_CODEX_MODEL } from '../codex/responses-session';
import type {
  CodexFunctionCall,
  CodexResponsesCallbacks,
  CodexToolDef,
  CodexTurnResult,
  CodexUserTurn,
} from '../codex/responses-session';
import { asFiniteNumber, asRecord, errorMessage } from '../util/guards';
import { requireCanonicalHelperBuddyId } from '../helper-buddy-id';
import type { ComputerDriver, MouseButton } from './driver';
import { VisualLiveDesktopEvidence, type LiveDesktopEvidencePort } from './live-desktop-evidence';

const MAX_ACTIONS = 12;
const MAX_APPROVAL_REPLACEMENTS = 3;
const SETTLE_MS = 350;
/** Network budget for one Sol Responses request. */
const OPERATOR_TIMEOUT_MS = 45_000;
/** type_text upper bound (mirrored in the error copy below). */
const MAX_TYPE_TEXT_CHARS = 10_000;
/** click_at label echo cap (tool output back to Sol). */
const LABEL_MAX = 200;

const OPERATOR_INSTRUCTIONS = `you are the careful computer operator inside buddy.
the user has explicitly enabled computer use and asked you to carry out the supplied task.
you are gpt-5.6-sol, and you alone decide every click and keystroke; the realtime voice model can
only delegate the user's words and never supplies coordinates, text, or keys to an action tool.

rules:
- inspect the screenshots yourself. take exactly one action per response, then inspect the fresh screenshots.
- use click_at only with pixel coordinates in the named screenshot. aim at the center of the target.
- use type_text only when the intended field is visibly focused. use press_keys for shortcuts/navigation.
- never invent hidden state. if the target is unclear, stop and explain what prevented safe completion.
- do not perform a materially different action from the user's task.
- when the task is complete, answer with one short plain-language sentence and call no tool.`;

export function operatorInstructions(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin') return OPERATOR_INSTRUCTIONS;
  return `${OPERATOR_INSTRUCTIONS}
- this is macOS: use META or COMMAND for native Command-key shortcuts (for example META+L and
  META+TAB). CTRL means the distinct Control key and is not a substitute for Command.`;
}

export const CLICK_AT_TOOL: CodexToolDef = {
  type: 'function',
  name: 'click_at',
  description:
    'Click the center of a visible target. Coordinates are pixels in the named screenshot.',
  parameters: {
    type: 'object',
    properties: {
      screen: { type: 'integer', description: 'Screenshot index: screen0 is 0.' },
      x: { type: 'integer', description: 'Target center X in screenshot pixels.' },
      y: { type: 'integer', description: 'Target center Y in screenshot pixels.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      count: { type: 'integer', enum: [1, 2] },
      label: { type: 'string', description: 'Short visible target label.' },
    },
    required: ['screen', 'x', 'y', 'label'],
  },
};

export const TYPE_TEXT_TOOL: CodexToolDef = {
  type: 'function',
  name: 'type_text',
  description: 'Type literal Unicode text into the currently focused field.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Exact literal text to type.' } },
    required: ['text'],
  },
};

export const PRESS_KEYS_TOOL: CodexToolDef = {
  type: 'function',
  name: 'press_keys',
  description: 'Press a key or chord. Examples: ["ENTER"], ["CTRL","L"], ["ALT","TAB"].',
  parameters: {
    type: 'object',
    properties: {
      keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
    },
    required: ['keys'],
  },
};

function pressKeysTool(platform: NodeJS.Platform = process.platform): CodexToolDef {
  if (platform !== 'darwin') return PRESS_KEYS_TOOL;
  return {
    ...PRESS_KEYS_TOOL,
    description:
      'Press a macOS key or chord. Examples: ["ENTER"], ["META","L"], ["META","TAB"]. META and COMMAND are the Command key.',
  };
}

// ---------------------------------------------------------------------------
// Pure tool-argument parsing (unknown -> typed | error). The error strings are
// tool outputs the model reads — they are part of the wire copy; keep exact.
// ---------------------------------------------------------------------------

/** Result of narrowing one tool call's untrusted arguments. */
export type ParsedArgs<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ClickArgs {
  screen: number;
  x: number;
  y: number;
  button: MouseButton;
  count: 1 | 2;
  /** Echoed back to Sol, capped at LABEL_MAX chars; '' when absent. */
  label: string;
}

export function parseClickArgs(value: unknown): ParsedArgs<ClickArgs> {
  const args = asRecord(value);
  if (args === null) return { ok: false, error: 'arguments were not valid json' };
  const screenIndex = asFiniteNumber(args['screen']);
  const x = asFiniteNumber(args['x']);
  const y = asFiniteNumber(args['y']);
  if (screenIndex === null || x === null || y === null)
    return { ok: false, error: 'screen, x, and y must be numbers' };
  return {
    ok: true,
    value: {
      screen: screenIndex,
      x,
      y,
      button: isButton(args['button']) ? args['button'] : 'left',
      count: args['count'] === 2 ? 2 : 1,
      label: typeof args['label'] === 'string' ? args['label'].slice(0, LABEL_MAX) : '',
    },
  };
}

export interface TypeTextArgs {
  text: string;
}

export function parseTypeTextArgs(value: unknown): ParsedArgs<TypeTextArgs> {
  const args = asRecord(value);
  if (args === null) return { ok: false, error: 'arguments were not valid json' };
  const text = args['text'];
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TYPE_TEXT_CHARS)
    return { ok: false, error: 'text must contain 1 to 10000 characters' };
  return { ok: true, value: { text } };
}

export interface PressKeysArgs {
  keys: string[];
}

export function parsePressKeysArgs(value: unknown): ParsedArgs<PressKeysArgs> {
  const args = asRecord(value);
  if (args === null) return { ok: false, error: 'arguments were not valid json' };
  const keys = args['keys'];
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 8)
    return { ok: false, error: 'keys must be an array of one to eight strings' };
  if (!keys.every((key): key is string => typeof key === 'string'))
    return { ok: false, error: 'keys must be an array of one to eight strings' };
  return { ok: true, value: { keys } };
}

/**
 * One executed tool call's output, JSON-serialized back to Sol via
 * `function_call_output` — the success/error shapes are pinned wire payloads.
 */
export type ToolOutcome =
  | { ok: true; clicked: string }
  | { ok: true; typed_characters: number }
  | { ok: true; pressed: string[] }
  | { ok?: never; error: string };

// ---------------------------------------------------------------------------

export interface ComputerUseResult {
  ok: boolean;
  summary: string;
  actions: number;
  quotaExhausted: boolean;
}

export interface ComputerUseOperatorOptions {
  auth: ChatGptCodexAuthSource;
  driver: ComputerDriver;
  /** One immutable identity for this foreground computer-use run. */
  helperBuddyId: string;
  /** Exact typed/ASR request. The model-authored `task` is never substituted for this authority. */
  userRequest: string;
  gate: HelperBuddyActionGatePort;
  approvals: HelperBuddyApprovalPort;
  evidence?: LiveDesktopEvidencePort;
  signal?: AbortSignal;
  initialCaptures?: CaptureResult[];
  isAllowed(): boolean;
  buildSession?: (auth: ChatGptCodexAuthSource) => CodexResponsesSession;
}

export class ComputerUseOperator {
  private readonly session: CodexResponsesSession;
  private readonly gateDriver: LiveActionGateDriver;
  private captures: CaptureResult[];
  private lastClickTarget: { screenIndex: number; x: number; y: number } | null = null;
  private finalText = '';

  constructor(private readonly options: ComputerUseOperatorOptions) {
    requireCanonicalHelperBuddyId(options.helperBuddyId);
    if (!options.userRequest.trim())
      throw new Error('computer use requires the exact user request');
    this.captures = options.initialCaptures ?? [];
    this.gateDriver = new LiveActionGateDriver(
      options.driver,
      () => this.captures,
      (captures) => {
        this.captures = [...captures];
      },
      options.evidence ?? new VisualLiveDesktopEvidence(),
    );
    this.session =
      options.buildSession?.(options.auth) ??
      new CodexResponsesSession({
        auth: options.auth,
        model: DEFAULT_CODEX_MODEL,
        instructions: operatorInstructions(),
        tools: [CLICK_AT_TOOL, TYPE_TEXT_TOOL, pressKeysTool()],
        reasoningEffort: 'low',
        serviceTier: 'priority',
        timeoutMs: OPERATOR_TIMEOUT_MS,
      });
  }

  async run(task: string): Promise<ComputerUseResult> {
    try {
      if (!this.options.isAllowed() || this.options.signal?.aborted) return stopped(0);
      if (this.captures.length === 0) this.captures = await this.options.driver.capture();
      if (this.captures.length === 0)
        return failure('i could not see the screen, so i did not act.', 0);

      let calls: CodexFunctionCall[] = [];
      const callbacks: CodexResponsesCallbacks = {
        onFunctionCall: (call) => calls.push(call),
        onTextDone: (_id, text) => {
          if (text.trim()) this.finalText = text.trim();
        },
      };
      let result = await this.session.submit(this.turn(task), callbacks);
      let actions = 0;

      for (;;) {
        const failed = resultFailure(result, actions);
        if (failed) return failed;
        if (!this.options.isAllowed() || this.options.signal?.aborted) {
          this.session.cancel();
          return stopped(actions);
        }
        if (calls.length === 0) {
          return { ok: true, summary: this.finalText || 'done.', actions, quotaExhausted: false };
        }
        if (actions >= MAX_ACTIONS)
          return failure(
            'i stopped after twelve actions before the task was clearly complete.',
            actions,
          );

        const [first, ...extra] = calls;
        calls = [];
        if (!first) return failure('the operator returned an empty action.', actions);
        const output = await this.execute(first, task);
        this.session.sendToolOutput(first.callId, output);
        for (const call of extra) {
          this.session.sendToolOutput(call.callId, {
            error: 'only one action is allowed per screen observation',
          });
        }
        if (output.ok !== true) return failure(output.error || 'the action failed.', actions);
        actions += 1;
        await delay(SETTLE_MS);
        if (!this.options.isAllowed() || this.options.signal?.aborted) {
          this.session.cancel();
          return stopped(actions);
        }
        this.captures = await this.options.driver.capture();
        if (this.captures.length === 0)
          return failure('i lost sight of the screen after acting, so i stopped.', actions);
        result = await this.session.continueWithTurn(
          this.turn(
            'the previous action completed. inspect this fresh screen state and either take the next single action or finish.',
          ),
          callbacks,
        );
      }
    } finally {
      // A stale re-assessment can produce a fresh escalation. Live desktop
      // never carries an old human decision forward, so discard every parked
      // capability when this run leaves its single-action boundary.
      this.options.approvals.cancelHelperBuddy(this.options.helperBuddyId);
      this.options.gate.cancelHelperBuddy(this.options.helperBuddyId);
    }
  }

  private turn(text: string): CodexUserTurn {
    return {
      context: captureContext(this.captures),
      text,
      images: this.captures.map((capture) => ({ jpegBase64: capture.jpegBase64 })),
    };
  }

  private async execute(call: CodexFunctionCall, taskClaim: string): Promise<ToolOutcome> {
    let args: Record<string, unknown> | null;
    try {
      args = asRecord(JSON.parse(call.argsJson || '{}'));
    } catch {
      args = null;
    }
    if (args === null) return { error: 'arguments were not valid json' };

    try {
      if (call.name === 'click_at') {
        const parsed = parseClickArgs(args);
        if (!parsed.ok) return { error: parsed.error };
        const click = parsed.value;
        return await this.executeGated(
          {
            kind: 'click',
            x: click.x,
            y: click.y,
            label: click.label,
            button: click.button,
            count: click.count,
            justification: 'perform the operator-proposed click for the delegated task',
          },
          click.screen,
          async () => {
            await this.options.driver.click(
              { screenIndex: click.screen, x: click.x, y: click.y },
              click.button,
              click.count,
            );
            this.lastClickTarget = {
              screenIndex: click.screen,
              x: click.x,
              y: click.y,
            };
          },
          { ok: true, clicked: click.label },
          taskClaim,
        );
      }
      if (call.name === 'type_text') {
        const parsed = parseTypeTextArgs(args);
        if (!parsed.ok) return { error: parsed.error };
        return await this.executeGated(
          {
            kind: 'type',
            text: parsed.value.text,
            justification: 'type the operator-proposed text for the delegated task',
          },
          undefined,
          () => this.options.driver.typeText(parsed.value.text),
          { ok: true, typed_characters: parsed.value.text.length },
          taskClaim,
        );
      }
      if (call.name === 'press_keys') {
        const parsed = parsePressKeysArgs(args);
        if (!parsed.ok) return { error: parsed.error };
        return await this.executeGated(
          {
            kind: 'press_keys',
            keys: parsed.value.keys,
            justification: 'press the operator-proposed keys for the delegated task',
          },
          undefined,
          () => this.options.driver.pressKeys(parsed.value.keys),
          { ok: true, pressed: parsed.value.keys },
          taskClaim,
        );
      }
      return { error: `unknown tool: ${call.name}` };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  private async executeGated(
    action: TriggerAction,
    screenIndex: number | undefined,
    dispatch: () => Promise<void>,
    success: Extract<ToolOutcome, { ok: true }>,
    taskClaim: string,
  ): Promise<ToolOutcome> {
    const requiresReceiverIdentity =
      (action.kind === 'type' || action.kind === 'press_keys') &&
      !(action.kind === 'type' && isSecretLikeValue(action.text));
    let expectedReceiverIdentity: string | null = null;
    let receiverScreenIndex: number | null = null;
    if (requiresReceiverIdentity) {
      expectedReceiverIdentity = await this.gateDriver.queryReceiverIdentity();
      if (expectedReceiverIdentity === null) {
        return {
          error:
            'live keyboard input is unavailable because the native focused receiver cannot be verified',
        };
      }
      receiverScreenIndex = this.gateDriver.receiverScreenIndex(expectedReceiverIdentity);
      if (receiverScreenIndex === null) {
        return {
          error:
            'live keyboard input is unavailable because the focused receiver cannot be mapped to one captured display',
        };
      }
    }
    this.gateDriver.prepare(
      action.kind === 'click'
        ? { screenIndex: screenIndex ?? 0, x: action.x, y: action.y }
        : this.lastClickTarget,
      requiresReceiverIdentity,
      expectedReceiverIdentity,
      receiverScreenIndex,
      action.kind === 'press_keys',
    );
    const actionAbort = new AbortController();
    const parentSignal = this.options.signal;
    const abortFromParent = (): void => actionAbort.abort(parentSignal?.reason);
    if (parentSignal?.aborted || !this.options.isAllowed()) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const allowedPoll = setInterval(() => {
      if (!this.options.isAllowed()) actionAbort.abort(new Error('computer use was cancelled'));
    }, 50);
    allowedPoll.unref?.();

    const request: GatedActionRequest = {
      helperBuddyId: this.options.helperBuddyId,
      origin: 'live-desktop',
      userRequest: this.options.userRequest,
      taskClaim,
      action,
      driver: this.gateDriver,
      ...(action.kind === 'click'
        ? { screenIndex: screenIndex ?? 0 }
        : receiverScreenIndex === null
          ? {}
          : { screenIndex: receiverScreenIndex }),
      signal: actionAbort.signal,
    };
    const verifiedDispatch =
      action.kind === 'type' && requiresReceiverIdentity
        ? async (): Promise<void> => {
            const proofToken = await this.gateDriver.prepareTypeTextPostcondition(action.text);
            if (proofToken === null) {
              throw new Error(
                'literal text input is unavailable because its exact receiver-bound result cannot be verified; no text was sent',
              );
            }
            await dispatch();
            if (!(await this.gateDriver.verifyTypeTextPostcondition(proofToken))) {
              throw new Error(
                'the exact focused control did not confirm the intended text edit, so the action failed closed',
              );
            }
          }
        : dispatch;

    try {
      let result = await this.options.gate.execute(request, verifiedDispatch);
      if (result.kind !== 'escalated') return closedGateOutcome(result, success);

      let escalation = result;
      let replacements = 0;
      let resolution = await this.options.approvals.request(
        liveApprovalRequest(escalation),
        actionAbort.signal,
      );
      for (;;) {
        const verdict = resolution.verdict;
        try {
          if (
            verdict === 'once' &&
            requiresReceiverIdentity &&
            !(await this.gateDriver.restoreExpectedReceiver())
          ) {
            await this.options.gate.resolveEscalation(escalation.approvalId, 'handled');
            resolution.acknowledge();
            return { error: receiverRestoreFailure() };
          }
          result = await this.options.gate.resolveEscalation(escalation.approvalId, verdict);
          if (result.kind === 'escalated') {
            if (requiresReceiverIdentity && !(await this.gateDriver.matchesExpectedReceiver())) {
              await this.options.gate.resolveEscalation(result.approvalId, 'handled');
              resolution.acknowledge();
              return { error: receiverRestoreFailure() };
            }
            replacements += 1;
            if (replacements >= MAX_APPROVAL_REPLACEMENTS) {
              resolution.acknowledge();
              this.options.gate.cancelHelperBuddy(this.options.helperBuddyId);
              return {
                error: 'desktop action approval could not stabilize after fresh evidence checks',
              };
            }
            // The old human decision is never carried across fresh evidence.
            // Atomically replace its card/capability and park for a new choice.
            escalation = result;
            resolution = await resolution.replace(liveApprovalRequest(escalation));
            continue;
          }
          resolution.acknowledge();
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(errorMessage(error));
          resolution.reject(failure);
          throw failure;
        }
        if (verdict !== 'once') return { error: approvalFailure(verdict) };
        return closedGateOutcome(result, success);
      }
    } finally {
      clearInterval(allowedPoll);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }
}

function liveApprovalRequest(
  escalation: Extract<GateExecutionResult<void>, { kind: 'escalated' }>,
): ApprovalRequest {
  return Object.freeze<ApprovalRequest>({
    helperBuddyId: escalation.helperBuddyId,
    approvalId: escalation.approvalId,
    kind: 'live-action',
    userRequest: escalation.userRequest,
    allowAlways: false,
    grantScope: null,
    allowTakeover: false,
    browserDomain: null,
    actionText: escalation.actionText,
    concern: escalation.concern,
    screenshotPng: escalation.screenshotPng
      ? `data:image/png;base64,${escalation.screenshotPng}`
      : '',
    payloadDigest: Object.freeze([...escalation.payloadDigest]) as string[],
  });
}

/** Gate adapter binding live keyboard actions to one native receiver identity. */
class LiveActionGateDriver implements GateDriverPort {
  private approvalEvidence: CaptureResult[] | null = null;
  private anchor: { screenIndex: number; x: number; y: number } | null = null;
  private requiresReceiverIdentity = false;
  private expectedReceiverIdentity: string | null = null;
  private receiverCaptureScreenIndex: number | null = null;
  private requiresReceiverVisualEvidence = false;

  constructor(
    private readonly driver: ComputerDriver,
    private readonly currentCaptures: () => CaptureResult[],
    private readonly replaceCaptures: (captures: CaptureResult[]) => void,
    private readonly evidence: LiveDesktopEvidencePort,
  ) {}

  prepare(
    anchor: { screenIndex: number; x: number; y: number } | null,
    requiresReceiverIdentity: boolean,
    expectedReceiverIdentity: string | null,
    receiverCaptureScreenIndex: number | null,
    requiresReceiverVisualEvidence: boolean,
  ): void {
    this.anchor = anchor;
    this.requiresReceiverIdentity = requiresReceiverIdentity;
    this.expectedReceiverIdentity = expectedReceiverIdentity;
    this.receiverCaptureScreenIndex = receiverCaptureScreenIndex;
    this.requiresReceiverVisualEvidence = requiresReceiverVisualEvidence;
    this.approvalEvidence = null;
  }

  async queryReceiverIdentity(): Promise<string | null> {
    return (await this.evidence.receiverIdentity?.()) ?? null;
  }

  receiverScreenIndex(identity: string): number | null {
    return this.evidence.receiverCaptureScreenIndex?.(this.currentCaptures(), identity) ?? null;
  }

  async matchesExpectedReceiver(): Promise<boolean> {
    if (!this.requiresReceiverIdentity || this.expectedReceiverIdentity === null) return false;
    return (await this.queryReceiverIdentity()) === this.expectedReceiverIdentity;
  }

  async restoreExpectedReceiver(): Promise<boolean> {
    if (!this.requiresReceiverIdentity || this.expectedReceiverIdentity === null) return false;
    if (await this.matchesExpectedReceiver()) return true;
    const restored =
      (await this.evidence.restoreReceiverIdentity?.(this.expectedReceiverIdentity)) ?? false;
    return restored && (await this.matchesExpectedReceiver());
  }

  async prepareTypeTextPostcondition(text: string): Promise<string | null> {
    if (!this.requiresReceiverIdentity || this.expectedReceiverIdentity === null) return null;
    // The native provider re-validates the retained receiver while taking its
    // private before-state. No control value or selection crosses this port.
    return (
      (await this.evidence.prepareTypeTextPostcondition?.(this.expectedReceiverIdentity, text)) ??
      null
    );
  }

  async verifyTypeTextPostcondition(proofToken: string): Promise<boolean> {
    if (!this.requiresReceiverIdentity || this.expectedReceiverIdentity === null) return false;
    return (await this.evidence.verifyTypeTextPostcondition?.(proofToken)) ?? false;
  }

  async capture(): Promise<CaptureResult[]> {
    // ActionGate asks for review evidence immediately after inspectDetailed.
    // Return that exact observation once so the image shown to the user and
    // the pending mechanical fingerprint describe the same desktop state.
    if (this.approvalEvidence !== null) {
      const captures = this.approvalEvidence;
      this.approvalEvidence = null;
      return [...captures];
    }
    const captures = await this.driver.capture();
    this.replaceCaptures(captures);
    return captures;
  }

  async inspectDetailed(
    target: Parameters<GateDriverPort['inspectDetailed']>[0],
  ): Promise<GateDriverInspection> {
    // Capture and query native focus inside every inspection. The approval
    // image, visual fingerprint, and keyboard receiver describe one bounded
    // pre-dispatch observation.
    const receiverBeforeCapture = this.requiresReceiverIdentity
      ? await this.queryReceiverIdentity()
      : null;
    if (
      this.requiresReceiverIdentity &&
      (receiverBeforeCapture === null || receiverBeforeCapture !== this.expectedReceiverIdentity)
    ) {
      throw new Error('the original native desktop receiver is no longer focused');
    }
    const captures = await this.driver.capture();
    this.replaceCaptures(captures);
    const facts =
      target === null ? await this.driver.inspectFocused() : await this.driver.inspect(target);
    const payloadFields = await this.driver.readPendingPayload(target);
    const current = this.currentCaptures();
    const receiverAfterCapture = this.requiresReceiverIdentity
      ? await this.queryReceiverIdentity()
      : null;
    if (
      this.requiresReceiverIdentity &&
      (receiverAfterCapture === null ||
        receiverAfterCapture !== receiverBeforeCapture ||
        receiverAfterCapture !== this.expectedReceiverIdentity)
    ) {
      throw new Error('the native desktop receiver changed during capture');
    }
    if (this.requiresReceiverIdentity) {
      const receiverScreenIndex =
        receiverAfterCapture === null
          ? null
          : (this.evidence.receiverCaptureScreenIndex?.(current, receiverAfterCapture) ?? null);
      const receiverCapture = current.find(
        (capture) => capture.meta.screenIndex === receiverScreenIndex,
      );
      if (receiverScreenIndex === null || !receiverCapture) {
        throw new Error('the native desktop receiver cannot be mapped to one captured display');
      }
      if (receiverScreenIndex !== this.receiverCaptureScreenIndex) {
        throw new Error('the native desktop receiver changed captured displays');
      }
      // ActionGate selects the first capture for focused keyboard actions.
      // Provide only the uniquely mapped receiver display, from this exact
      // observation, so the human never approves an unrelated screen0 image.
      this.approvalEvidence = [receiverCapture];
    } else {
      this.approvalEvidence = [...captures];
    }
    const fingerprint = await this.evidence.fingerprint(
      current,
      this.anchor,
      this.requiresReceiverIdentity,
      receiverAfterCapture,
      this.requiresReceiverVisualEvidence,
    );
    if (fingerprint === null) throw new Error('native desktop receiver identity is unavailable');
    return {
      facts,
      payloadFields,
      fingerprint,
      pageRevision: fingerprint,
    };
  }
}

function receiverRestoreFailure(): string {
  return 'the original focused control could not be restored after approval, so the keyboard action was discarded';
}

function closedGateOutcome(
  result: GateExecutionResult<void>,
  success: Extract<ToolOutcome, { ok: true }>,
): ToolOutcome {
  if (result.kind === 'executed') return success;
  if (result.kind === 'denied') return { error: result.reason };
  if (result.kind === 'reobserve') return { error: result.reason };
  return { error: 'the desktop changed while approval was pending, so the action was discarded' };
}

function approvalFailure(verdict: Exclude<HelperBuddyApprovalVerdict, 'once'>): string {
  if (verdict === 'deny') return 'the user denied this desktop action';
  if (verdict === 'handled') return 'the pending desktop action was discarded after user control';
  return 'standing approval is unavailable for live desktop actions';
}

function captureContext(captures: CaptureResult[]): string {
  return captures
    .map((capture) => {
      const m = capture.meta;
      return `screen${m.screenIndex}: ${m.imageW}x${m.imageH} screenshot pixels${m.isActive ? ' (active)' : ''}; coordinates use this image.`;
    })
    .join('\n');
}

function isButton(value: unknown): value is MouseButton {
  return value === 'left' || value === 'right' || value === 'middle';
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function failure(summary: string, actions: number): ComputerUseResult {
  return { ok: false, summary, actions, quotaExhausted: false };
}
function stopped(actions: number): ComputerUseResult {
  return failure('computer use was turned off or the turn was superseded, so i stopped.', actions);
}
function resultFailure(result: CodexTurnResult, actions: number): ComputerUseResult | null {
  if (result.quotaExhausted)
    return {
      ok: false,
      summary: 'chatgpt fast-mode usage is unavailable right now, so i did not continue.',
      actions,
      quotaExhausted: true,
    };
  if (result.aborted) return stopped(actions);
  if (result.error) return failure(`the sol operator stopped: ${result.error.message}`, actions);
  return null;
}
