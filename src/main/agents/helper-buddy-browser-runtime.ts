import { randomUUID } from 'node:crypto';
import type { HelperBuddyStep, ApprovalRequest } from '../../shared/types';
import type { CaptureResult } from '../capture';
import type { ComputerDriver, DriverPoint } from '../computer/driver';
import { errorMessage } from '../util/guards';
import {
  HELPER_BUDDY_BROWSER_SETTLE_MS,
  HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS,
} from './helper-buddy-config';
import type {
  GateDriverPort,
  GateEscalation,
  GateExecutionAuthorization,
  GateExecutionResult,
} from './gate/action-gate';
import { tryNormalizeDomain } from './gate/signature';
import type {
  HelperBuddyBrowserAction,
  HelperBuddyBrowserDeps,
  HelperBuddyBrowserToolPort,
  HelperBuddyBrowserToolResult,
  HelperBuddyBrief,
  HelperBuddyApprovalResolution,
} from './types';
import { finiteArg, stringArg, stringArray } from './tools/browser';

interface UserVisibleDriver extends ComputerDriver, GateDriverPort {
  showForTakeover?(): Promise<void> | void;
  hideAfterTakeover?(): Promise<void> | void;
  authorizeNextNavigation?(destination: string): Promise<void>;
}

const MAX_APPROVAL_REPLACEMENTS = 3;

export interface HelperBuddyBrowserRuntimeOptions {
  brief: HelperBuddyBrief;
  deps: HelperBuddyBrowserDeps;
  signal: AbortSignal;
  getSteps(): readonly HelperBuddyStep[];
  onPark(): void;
  onResume(): void;
  onActivity(kind: HelperBuddyStep['kind'], label: string): void;
}

/** Per-run browser state; owns exactly one lazily-created driver. */
export class HelperBuddyBrowserRuntime implements HelperBuddyBrowserToolPort {
  private driver: UserVisibleDriver | null = null;
  private captures: CaptureResult[] = [];
  private readonly seenDomains = new Set<string>();
  private capabilityGranted = false;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private poisonedReason = '';
  private readonly settleMs: number;

  constructor(private readonly options: HelperBuddyBrowserRuntimeOptions) {
    this.settleMs = options.deps.settleMs ?? HELPER_BUDDY_BROWSER_SETTLE_MS;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<HelperBuddyBrowserToolResult> {
    this.assertUsable();
    const required = requiredJustification(args);
    if (!required.ok) return outputError(required.error);

    if (name === 'browser_screenshot') {
      const capability = await this.ensureCapability();
      if (capability !== null) return capability;
      const captures = await this.captureFresh();
      return {
        output: JSON.stringify({ ok: true, ...captureSummary(captures) }),
        observation: captures,
      };
    }

    const action = parseAction(name, args, required.value, this.screenIndex());
    if (!action.ok) return outputError(action.error);
    if (requiresObservation(action.value) && this.captures.length === 0) {
      return outputError('take a browser_screenshot before acting on a visible page element');
    }
    const coordinateError = validateObservedCoordinates(action.value, this.captures[0]);
    if (coordinateError) return outputError(coordinateError);
    const capability = await this.ensureCapability();
    if (capability !== null) return capability;

    const driver = await this.ensureDriver();
    const actionController = new AbortController();
    const actionSignal = AbortSignal.any([this.options.signal, actionController.signal]);
    try {
      const gateResult = await this.withFiniteBoundary(
        'browser action review',
        () =>
          this.options.deps.gate.execute(
            {
              helperBuddyId: this.options.brief.id,
              origin: 'buddy-browser',
              userRequest: this.options.brief.userRequest,
              taskClaim: this.options.brief.task,
              action: action.value,
              driver,
              screenIndex: this.screenIndex(),
              seenDomains: this.seenDomains,
              recentSteps: [...this.options.getSteps()],
              signal: actionSignal,
            },
            (authorization) => this.dispatch(driver, action.value, authorization, actionSignal),
          ),
        () => this.abortGateAction(actionController),
      );
      return await this.finishGateResult(gateResult, action.value, actionController);
    } finally {
      actionController.abort();
    }
  }

  async requestUser(args: Record<string, unknown>): Promise<HelperBuddyBrowserToolResult> {
    this.assertUsable();
    const justification = requiredJustification(args);
    if (!justification.ok) return outputError(justification.error);
    const reason = stringArg(args['reason']).trim().slice(0, 1_000);
    if (!reason) return outputError('reason is required');

    const capability = await this.ensureCapability();
    if (capability !== null) return capability;

    const captures = await this.captureFresh();
    const request: ApprovalRequest = {
      helperBuddyId: this.options.brief.id,
      approvalId: randomUUID(),
      kind: 'needs-user',
      userRequest: this.options.brief.userRequest,
      allowAlways: false,
      grantScope: null,
      allowTakeover: true,
      browserDomain: null,
      actionText:
        stringArg(args['action_text']).trim().slice(0, 500) ||
        'handle the blocked step in the buddy browser',
      concern: reason,
      screenshotPng: await this.approvalScreenshot(captures[0]),
      payloadDigest: [],
    };
    for (;;) {
      const resolution = await this.park(request);
      if (resolution.verdict === 'deny') {
        this.acknowledgeApproval(resolution);
        return { output: JSON.stringify({ denied: true, reason: 'the user declined to step in' }) };
      }
      try {
        const observation = await this.captureFresh();
        this.acknowledgeApproval(resolution);
        return {
          output: JSON.stringify({
            ok: true,
            handled_by_user: resolution.verdict === 'handled',
            note: 'inspect the fresh browser observation before deciding what to do next',
          }),
          observation,
        };
      } catch (error) {
        resolution.reject(asError(error));
      }
    }
  }

  async showForUser(): Promise<void> {
    const driver = await this.ensureDriver();
    const show = driver.showForTakeover?.bind(driver);
    if (!show) throw new Error('this browser driver cannot be shown for user takeover');
    await this.withFiniteBoundary('show buddy browser', async () => show());
  }

  async hideFromUser(): Promise<void> {
    const driver = this.driver;
    const hide = driver?.hideAfterTakeover?.bind(driver);
    if (!hide) throw new Error('this browser driver is not visible');
    await this.withFiniteBoundary('hide buddy browser', async () => hide());
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      this.options.deps.approvals.cancelHelperBuddy(this.options.brief.id);
      this.options.deps.gate.cancelHelperBuddy(this.options.brief.id);
      const driver = this.driver;
      this.driver = null;
      this.captures = [];
      if (driver) await driver.dispose();
    })();
    return this.disposePromise;
  }

  private async ensureCapability(): Promise<HelperBuddyBrowserToolResult | null> {
    if (this.capabilityGranted) return null;
    if (!this.options.brief.userRequest.trim()) {
      return outputError('browser use requires the exact user request as its authority anchor');
    }
    const request: ApprovalRequest = {
      helperBuddyId: this.options.brief.id,
      approvalId: randomUUID(),
      kind: 'browser-capability',
      userRequest: this.options.brief.userRequest,
      allowAlways: false,
      grantScope: null,
      allowTakeover: false,
      browserDomain: null,
      actionText: 'allow this buddy to use its browser for this task',
      concern: `the buddy wants to act in its browser for: ${this.options.brief.userRequest.slice(0, 500)}`,
      // Capability consent is task-scoped, not page-action consent. Creating
      // or reading the persistent browser before consent would expose signed-
      // in page state. Visible action approvals still require fresh evidence
      // in the action gate after capability consent succeeds.
      screenshotPng: await this.approvalScreenshot(this.captures[0]),
      payloadDigest: [],
    };
    const resolution = await this.park(request);
    if (resolution.verdict === 'deny' || resolution.verdict === 'handled') {
      this.acknowledgeApproval(resolution);
      return {
        output: JSON.stringify({
          denied: true,
          reason: 'the user did not grant browser use for this run',
        }),
      };
    }
    this.capabilityGranted = true;
    this.options.onActivity('review', 'browser use approved for this run');
    this.acknowledgeApproval(resolution);
    return null;
  }

  private async finishGateResult(
    initial: GateExecutionResult<void>,
    action: HelperBuddyBrowserAction,
    actionController: AbortController,
  ): Promise<HelperBuddyBrowserToolResult> {
    let result = initial;
    let delivered: HelperBuddyApprovalResolution | null = null;
    let replacements = 0;
    while (result.kind === 'escalated') {
      this.options.onActivity('review', `raised hand: ${result.concern.slice(0, 180)}`);
      const request = approvalRequest(this.options.brief.id, result);
      const resolution: HelperBuddyApprovalResolution = delivered ?? (await this.park(request));
      delivered = null;
      const approvalId = result.approvalId;
      let next: GateExecutionResult<void>;
      try {
        next = await withTimeout(
          this.options.deps.gate.resolveEscalation(approvalId, resolution.verdict),
          HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS,
          'approved browser action',
          () => this.abortGateAction(actionController),
        );
      } catch (error) {
        if (error instanceof BoundaryTimeoutError) {
          try {
            resolution.reject(asError(error));
          } finally {
            this.options.deps.approvals.cancelHelperBuddy(this.options.brief.id);
            this.options.onResume();
          }
          this.poisonedReason = error.message;
          throw error;
        }
        resolution.reject(asError(error));
        continue;
      }
      if (next.kind === 'escalated') {
        replacements += 1;
        if (replacements >= MAX_APPROVAL_REPLACEMENTS) {
          const error = new Error(
            'browser action approval could not stabilize after fresh evidence checks',
          );
          try {
            resolution.reject(error);
          } finally {
            this.options.deps.approvals.cancelHelperBuddy(this.options.brief.id);
            this.options.onResume();
          }
          this.options.deps.gate.cancelHelperBuddy(this.options.brief.id);
          this.poisonedReason = error.message;
          throw error;
        }
        try {
          delivered = await resolution.replace(approvalRequest(this.options.brief.id, next));
        } catch (error) {
          resolution.reject(asError(error));
          continue;
        }
      } else {
        this.acknowledgeApproval(resolution);
      }
      result = next;
    }

    if (result.kind === 'reobserve') {
      const observation = await this.captureFresh();
      return {
        output: JSON.stringify({
          ok: true,
          handled_by_user: true,
          note: 'the pending action was discarded; inspect the fresh page before proposing anything else',
        }),
        observation,
      };
    }

    if (result.kind === 'denied') {
      return {
        output: JSON.stringify({ denied: true, reason: result.reason }),
        ...(result.halt ? { halt: true } : {}),
      };
    }

    if (action.kind === 'navigate') {
      const domain = tryNormalizeDomain(action.url);
      if (domain) this.seenDomains.add(domain);
    }
    await settle(this.settleMs, this.options.signal);
    const observation = await this.captureFresh();
    return {
      output: JSON.stringify(successOutput(action)),
      observation,
    };
  }

  private async park(request: ApprovalRequest): Promise<HelperBuddyApprovalResolution> {
    this.options.onPark();
    try {
      return await this.options.deps.approvals.request(request, this.options.signal);
    } catch (error) {
      this.options.onResume();
      throw error;
    }
  }

  private acknowledgeApproval(resolution: HelperBuddyApprovalResolution): void {
    try {
      resolution.acknowledge();
    } catch (error) {
      this.poisonedReason = `approval acknowledgment failed: ${errorMessage(error)}`;
      this.options.deps.gate.cancelHelperBuddy(this.options.brief.id);
      throw error;
    } finally {
      this.options.onResume();
    }
  }

  private async approvalScreenshot(capture: CaptureResult | undefined): Promise<string> {
    if (!capture) return '';
    return this.options.deps.captureToPngDataUrl
      ? this.options.deps.captureToPngDataUrl(capture)
      : approvalScreenshot(capture);
  }

  private async dispatch(
    driver: UserVisibleDriver,
    action: HelperBuddyBrowserAction,
    authorization: GateExecutionAuthorization,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (action.kind === 'navigate') {
      if (!driver.navigate) throw new Error('this driver does not support navigation');
      if (!authorization.navigationDestination)
        throw new Error('the action gate did not authorize the navigation destination');
      throwIfAborted(signal);
      await driver.navigate(authorization.navigationDestination);
      return;
    }
    if (action.kind === 'click') {
      await authorizeNavigation(driver, authorization.navigationDestination);
      throwIfAborted(signal);
      await driver.click(point(this.screenIndex(), action.x, action.y), 'left', action.count ?? 1);
      return;
    }
    if (action.kind === 'type') {
      if (authorization.navigationDestination)
        throw new Error('the action gate attached navigation authority to a typing action');
      throwIfAborted(signal);
      await driver.typeText(action.text);
      return;
    }
    if (action.kind === 'press_keys') {
      await authorizeNavigation(driver, authorization.navigationDestination);
      throwIfAborted(signal);
      await driver.pressKeys(action.keys);
      return;
    }
    if (authorization.navigationDestination)
      throw new Error('the action gate attached navigation authority to a non-navigation action');
    if (!driver.scroll) throw new Error('this driver does not support scrolling');
    throwIfAborted(signal);
    await driver.scroll(point(this.screenIndex(), action.x, action.y), action.dy);
  }

  private async captureFresh(): Promise<CaptureResult[]> {
    const driver = await this.ensureDriver();
    const captures = await this.withFiniteBoundary('buddy browser capture', () => driver.capture());
    if (captures.length !== 1) throw new Error('buddy browser must return exactly one capture');
    this.captures = [...captures];
    return [...captures];
  }

  private async ensureDriver(): Promise<UserVisibleDriver> {
    this.assertUsable();
    if (this.driver) return this.driver;
    const pending = this.options.deps.createDriver(this.options.brief.id);
    try {
      this.driver = await withTimeout(
        pending,
        HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS,
        'create buddy browser',
      );
      return this.driver;
    } catch (error) {
      void pending.then((driver) => driver.dispose()).catch(() => undefined);
      this.poisonedReason = errorMessage(error);
      throw error;
    }
  }

  private screenIndex(): number {
    return this.captures[0]?.meta.screenIndex ?? 0;
  }

  private async withFiniteBoundary<T>(
    label: string,
    run: () => Promise<T>,
    onTimeout?: () => void,
  ): Promise<T> {
    try {
      return await withTimeout(run(), HELPER_BUDDY_BROWSER_TOOL_TIMEOUT_MS, label, onTimeout);
    } catch (error) {
      this.poisonedReason = `${label} failed: ${errorMessage(error)}`;
      this.options.deps.gate.cancelHelperBuddy(this.options.brief.id);
      const driver = this.driver;
      this.driver = null;
      if (driver) await driver.dispose().catch(() => undefined);
      throw error;
    }
  }

  private abortGateAction(controller: AbortController): void {
    controller.abort();
    this.options.deps.gate.cancelHelperBuddy(this.options.brief.id);
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('buddy browser runtime is disposed');
    if (this.options.signal.aborted) throw new Error('helper buddy run was cancelled');
    if (this.poisonedReason) throw new Error(`buddy browser stopped after ${this.poisonedReason}`);
  }
}

async function authorizeNavigation(
  driver: UserVisibleDriver,
  destination: string | null,
): Promise<void> {
  if (!destination) return;
  if (!driver.authorizeNextNavigation)
    throw new Error('this browser driver cannot authorize a reviewed navigation');
  await driver.authorizeNextNavigation(destination);
}

function parseAction(
  name: string,
  args: Record<string, unknown>,
  justification: string,
  _screenIndex: number,
): { ok: true; value: HelperBuddyBrowserAction } | { ok: false; error: string } {
  if (name === 'browser_navigate') {
    const url = stringArg(args['url']).trim();
    if (!url) return { ok: false, error: 'url is required' };
    return { ok: true, value: { kind: 'navigate', url, justification } };
  }
  if (name === 'browser_click') {
    const x = finiteArg(args['x']);
    const y = finiteArg(args['y']);
    if (x === null || y === null) return { ok: false, error: 'x and y must be numbers' };
    if (args['button'] !== undefined && args['button'] !== 'left') {
      return { ok: false, error: 'only left-click is supported in the buddy browser' };
    }
    const count = args['count'] === undefined || args['count'] === 1 ? 1 : args['count'];
    if (count !== 1 && count !== 2) return { ok: false, error: 'count must be 1 or 2' };
    const label = stringArg(args['label']).trim().slice(0, 200);
    if (!label) return { ok: false, error: 'label is required' };
    return {
      ok: true,
      value: { kind: 'click', x, y, label, button: 'left', count, justification },
    };
  }
  if (name === 'browser_type') {
    const text = args['text'];
    if (typeof text !== 'string' || text.length > 10_000)
      return { ok: false, error: 'text must be at most 10000 characters' };
    return { ok: true, value: { kind: 'type', text, justification } };
  }
  if (name === 'browser_press_keys') {
    const keys = stringArray(args['keys']);
    if (keys.length < 1 || keys.length > 8)
      return { ok: false, error: 'keys must be an array of one to eight strings' };
    return { ok: true, value: { kind: 'press_keys', keys, justification } };
  }
  if (name === 'browser_scroll') {
    const x = finiteArg(args['x']);
    const y = finiteArg(args['y']);
    const dy = finiteArg(args['dy']);
    if (x === null || y === null || dy === null)
      return { ok: false, error: 'x, y, and dy must be numbers' };
    return { ok: true, value: { kind: 'scroll', x, y, dy, justification } };
  }
  return { ok: false, error: `unknown browser tool: ${name}` };
}

function requiresObservation(action: HelperBuddyBrowserAction): boolean {
  return action.kind !== 'navigate';
}

function validateObservedCoordinates(
  action: HelperBuddyBrowserAction,
  capture: CaptureResult | undefined,
): string | null {
  if (action.kind !== 'click' && action.kind !== 'scroll') return null;
  if (!capture) return 'take a browser_screenshot before acting on a visible page element';
  if (
    action.x < 0 ||
    action.y < 0 ||
    action.x >= capture.meta.imageW ||
    action.y >= capture.meta.imageH
  ) {
    return `x and y must be inside the ${capture.meta.imageW}x${capture.meta.imageH} browser screenshot`;
  }
  return null;
}

function approvalRequest(helperBuddyId: string, result: GateEscalation): ApprovalRequest {
  return {
    helperBuddyId,
    approvalId: result.approvalId,
    kind: 'browser-action',
    userRequest: result.userRequest,
    allowAlways: result.signature !== null && result.grantScope !== null,
    grantScope: result.grantScope,
    allowTakeover: true,
    browserDomain: result.browserDomain,
    actionText: result.actionText,
    concern: result.concern,
    screenshotPng: result.screenshotPng ? `data:image/png;base64,${result.screenshotPng}` : '',
    payloadDigest: [...result.payloadDigest],
  };
}

function successOutput(action: HelperBuddyBrowserAction): Record<string, unknown> {
  if (action.kind === 'navigate') return { ok: true, navigated: action.url };
  if (action.kind === 'click') return { ok: true, clicked: action.label };
  if (action.kind === 'type') return { ok: true, typed_characters: action.text.length };
  if (action.kind === 'press_keys') return { ok: true, pressed: action.keys };
  return { ok: true, scrolled: action.dy };
}

function requiredJustification(
  args: Record<string, unknown>,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = stringArg(args['justification']).trim().slice(0, 1_000);
  return value ? { ok: true, value } : { ok: false, error: 'justification is required' };
}

function point(screenIndex: number, x: number, y: number): DriverPoint {
  return { screenIndex, x, y };
}

function outputError(error: string): HelperBuddyBrowserToolResult {
  return { output: JSON.stringify({ error }) };
}

function captureSummary(captures: readonly CaptureResult[]): Record<string, unknown> {
  const first = captures[0];
  return first
    ? { screen: first.meta.screenIndex, width: first.meta.imageW, height: first.meta.imageH }
    : {};
}

async function approvalScreenshot(capture: CaptureResult | undefined): Promise<string> {
  if (!capture) return '';
  const { nativeImage } = await import('electron');
  const png = nativeImage.createFromBuffer(Buffer.from(capture.jpegBase64, 'base64')).toPNG();
  return `data:image/png;base64,${png.toString('base64')}`;
}

function settle(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

class BoundaryTimeoutError extends Error {
  constructor(
    message: string,
    readonly cancellationError: unknown = null,
  ) {
    super(message);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      let cancellationError: unknown = null;
      try {
        onTimeout?.();
      } catch (error) {
        cancellationError = error;
      }
      reject(new BoundaryTimeoutError(`${label} timed out`, cancellationError));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('browser action was cancelled before dispatch');
}
