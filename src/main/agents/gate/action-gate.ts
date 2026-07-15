/**
 * Mechanically enforced action gate.
 *
 * Tool executors give this class the driver and the dispatch closure. The
 * closure is invoked only for a mechanical pass, an independent reviewer
 * approval whose DOM evidence is still current, or an explicit human approval
 * whose evidence is still current. Callers never receive an "allow" token
 * that could be replayed after the page changes.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { CaptureResult } from '../../capture';
import type { DriverPoint } from '../../computer/driver';
import type { ApprovalGrant } from '../../../shared/types';
import {
  actionTargetKey,
  buildActionSignature,
  formatGrantScope,
  scrubDisplayText,
  tryNormalizeDomain,
  type ActionSignature,
} from './signature';
import { DENIAL_HALT_COPY, DenialStrikeCounter } from './strikes';
import {
  classifyTrigger,
  type ElementFacts,
  type TriggerAction,
  type TriggerVerdict,
} from './trigger';
import {
  markEvidenceScreenshot,
  isSecretLikeValue,
  sanitizePayloadFields,
  type ActionReviewer,
  type EvidenceImageMarker,
  type PendingPayloadField,
  type ReviewAssessment,
  type ReviewScreenshot,
  type ReviewStepEvidence,
  type StandingApprovalEvidence,
} from './reviewer';

const MAX_STALE_REASSESSMENTS = 2;
const SENSITIVE_QUERY_NAMES = new Set([
  'password',
  'passcode',
  'pin',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'code',
  'oauthcode',
  'apikey',
  'accesskey',
  'auth',
  'authorization',
  'credential',
  'session',
  'sessionid',
  'cookie',
  'signature',
  'sig',
  'jwt',
  'bearer',
  'recoverycode',
  'cardnumber',
  'accountnumber',
  'routingnumber',
  'ssn',
  'cvv',
  'cvc',
]);

export interface GateDriverPort {
  capture(): Promise<CaptureResult[]>;
  /**
   * Atomically inspect point/focus plus its form payload. `target=null` means
   * the focused element. fingerprint/pageRevision are driver-mechanical and
   * must change when the inspected DOM/focus/form state changes.
   */
  inspectDetailed(target: DriverPoint | null): Promise<GateDriverInspection>;
}

export interface GateDriverInspection {
  facts: ElementFacts | null;
  payloadFields: PendingPayloadField[];
  fingerprint: string;
  pageRevision: string | number;
}

export interface GatedActionRequest {
  agentId: string;
  origin: 'buddy-browser' | 'live-desktop';
  /** Exact latest typed/ASR request; sole reviewer authority anchor. */
  userRequest: string;
  /** Optional model-authored delegation wording; untrusted evidence only. */
  taskClaim?: string;
  action: TriggerAction;
  driver: GateDriverPort;
  /** Capture-space display for point actions. Offscreen browsers use 0. */
  screenIndex?: number;
  seenDomains?: ReadonlySet<string> | readonly string[];
  recentSteps?: readonly ReviewStepEvidence[];
  signal?: AbortSignal;
}

export type HumanApprovalDecision = 'once' | 'always' | 'deny' | 'handled';

/** Exact capability derived from the freshly revalidated action/DOM facts. */
export interface GateExecutionAuthorization {
  navigationDestination: string | null;
}

export type GateDispatch<T> = (authorization: GateExecutionAuthorization) => Promise<T>;

export type GateExecutionResult<T> =
  | {
      kind: 'executed';
      value: T;
      reviewed: boolean;
      approvalId?: string;
    }
  | { kind: 'denied'; denied: true; reason: string; halt: boolean }
  | { kind: 'reobserve'; handled: true; reason: string }
  | GateEscalation;

export interface GateEscalation {
  kind: 'escalated';
  /** Immutable one-use capability held by this ActionGate instance. */
  approvalId: string;
  agentId: string;
  /** Exact user authority anchor used by the reviewer. */
  userRequest: string;
  actionText: string;
  /** Driver-derived ASCII registrable domain, only for controlled-browser actions. */
  browserDomain: string | null;
  reason: string;
  concern: string;
  evidenceDigest: string;
  payloadDigest: readonly string[];
  /** Marked PNG bytes, base64. Null only when capture/marking itself failed. */
  screenshotPng: string | null;
  signature: Readonly<ActionSignature> | null;
  /** User-facing normalized standing permission, or null when no safe signature exists. */
  grantScope: string | null;
}

export interface ActionGateJournalEntry {
  type: 'action_gate_assessment';
  at: number;
  agentId: string;
  approvalId: string | null;
  actionKind: TriggerAction['kind'];
  domain: string | null;
  targetSignature: string;
  evidenceDigest: string;
  payloadDigest: readonly string[];
  trigger: TriggerVerdict['kind'] | 'inspection-error' | 'stale-evidence' | 'human';
  triggerReasons: readonly string[];
  verdict: 'pass' | 'hard-deny' | 'approve' | 'deny' | 'escalate';
  disposition: 'dispatch-pending' | 'refuse' | 'reassess' | 'await-human' | 'reobserve';
  reason: string;
  concern?: string;
  targetDenials?: number;
  totalDenials?: number;
}

export interface ActionGateJournalPort {
  /** Adapter to SessionRecorder; implementations must not put secrets in the payload. */
  recordActionGateAssessment(entry: ActionGateJournalEntry): void;
  recordComputerActionOutcome(entry: ComputerActionOutcomeEntry): void;
}

export interface ComputerActionOutcomeEntry {
  type: 'computer_action_executed' | 'computer_action_failed';
  at: number;
  agentId: string;
  approvalId: string | null;
  actionKind: TriggerAction['kind'];
  evidenceDigest: string;
  targetSignature: string;
  navigationDomain: string | null;
  errorClass?: string;
}

export interface ActionGateOptions {
  reviewer: ActionReviewer;
  journal: ActionGateJournalPort;
  grantStore: ActionGateGrantStorePort;
  followThrough: ActionGateFollowThroughPort;
  strikes?: DenialStrikeCounter;
  now?: () => number;
  id?: () => string;
  onApprovalMemoryError?: (error: Error) => void;
  markScreenshot?: EvidenceImageMarker;
}

export interface ActionGateGrantStorePort {
  findMatches(signature: ActionSignature): ApprovalGrant[];
  create(signature: ActionSignature): ApprovalGrant;
  recordUse(id: string): ApprovalGrant;
}

export interface ActionGateFollowThroughPort {
  coverageFor(
    agentId: string,
    domain: string,
  ): { domain: string; expiresAt: number; remainingActions: number } | null;
  activate(
    agentId: string,
    domain: string,
  ): { domain: string; expiresAt: number; remainingActions: number };
  recordExecutedAction(agentId: string, domain: string): boolean;
  deactivate(agentId: string): void;
}

interface InspectionSnapshot {
  facts: ElementFacts | null;
  payloadFields: PendingPayloadField[];
  driverFingerprint: string;
  pageRevision: string | number;
  url: string | null;
  payloadFingerprint: string;
  fingerprint: string;
}

interface PendingEscalation<T> {
  publicResult: GateEscalation;
  request: GatedActionRequest;
  dispatch: GateDispatch<T>;
  inspection: InspectionSnapshot;
  resolving: boolean;
  standingGrantCreated: boolean;
}

interface ApprovalMemoryContext {
  signature: ActionSignature | null;
  executionDomain: string | null;
  standingGrants: ApprovalGrant[];
  followThroughCoverage: {
    domain: string;
    expiresAt: number;
    remainingActions: number;
  } | null;
  evidence: StandingApprovalEvidence[];
}

export class ActionGate<T = unknown> {
  private readonly reviewer: ActionReviewer;
  private readonly journal: ActionGateJournalPort;
  private readonly strikes: DenialStrikeCounter;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly grantStore: ActionGateGrantStorePort;
  private readonly followThrough: ActionGateFollowThroughPort;
  private readonly onApprovalMemoryError: (error: Error) => void;
  private readonly markScreenshot: EvidenceImageMarker;
  private readonly pending = new Map<string, PendingEscalation<T>>();

  constructor(options: ActionGateOptions) {
    this.reviewer = options.reviewer;
    this.journal = options.journal;
    this.strikes = options.strikes ?? new DenialStrikeCounter();
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.grantStore = options.grantStore;
    this.followThrough = options.followThrough;
    this.onApprovalMemoryError =
      options.onApprovalMemoryError ??
      ((error) => console.error('[action-gate] approval memory failed:', error.message));
    this.markScreenshot = options.markScreenshot ?? markEvidenceScreenshot;
  }

  /**
   * The only normal execution entry point. `dispatch` remains inside the gate,
   * including while an escalation is parked.
   */
  async execute(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
  ): Promise<GateExecutionResult<T>> {
    validateRequest(request);
    throwIfAborted(request.signal);
    return this.assessAndMaybeExecute(request, dispatch, 0, false);
  }

  /**
   * Resolve a parked escalation exactly once. Approvals are bound to the
   * stored action/evidence; a changed page is re-assessed and never dispatched
   * with the stale human decision.
   */
  async resolveEscalation(
    approvalId: string,
    decision: HumanApprovalDecision,
  ): Promise<GateExecutionResult<T>> {
    if (!isHumanApprovalDecision(decision)) {
      throw new Error('approval decision is invalid');
    }
    const pending = this.pending.get(approvalId);
    if (pending === undefined)
      throw new Error('approval assessment is missing or already resolved');
    if (pending.resolving) throw new Error('approval assessment is already being resolved');
    pending.resolving = true;

    if (decision === 'deny' || decision === 'handled') {
      this.pending.delete(approvalId);
      if (decision === 'handled') this.followThrough.deactivate(pending.request.agentId);
      this.record(
        journalEntry(pending.request, pending.inspection, {
          approvalId,
          trigger: 'human',
          verdict: decision === 'deny' ? 'deny' : 'escalate',
          disposition: decision === 'deny' ? 'refuse' : 'reobserve',
          reason:
            decision === 'deny'
              ? 'the user denied this action'
              : 'the user handled the page and the buddy must re-observe',
        }),
      );
      return decision === 'deny'
        ? denied('the user denied this action')
        : {
            kind: 'reobserve',
            handled: true,
            reason: 'the user handled the page; re-observe before proposing another action',
          };
    }

    // A human cannot meaningfully approve an action they could not see. Retry
    // the complete assessment so a fresh marked image is required before any
    // approval can become executable.
    if (pending.publicResult.screenshotPng === null) {
      this.pending.delete(approvalId);
      this.record(
        journalEntry(pending.request, pending.inspection, {
          approvalId,
          trigger: 'stale-evidence',
          verdict: 'escalate',
          disposition: 'reassess',
          reason: 'the pending approval had no trustworthy marked screenshot',
        }),
      );
      return this.assessAndMaybeExecute(pending.request, pending.dispatch, 0, true);
    }

    throwIfAborted(pending.request.signal);
    let current: InspectionSnapshot;
    try {
      current = await this.inspect(pending.request);
    } catch {
      this.pending.delete(approvalId);
      return this.escalateWithInspection(
        pending.request,
        pending.dispatch,
        pending.inspection,
        'the target could not be re-inspected after human approval',
        'the action remains blocked because its current page state is unknown',
      );
    }
    if (!inspectionsMatch(current, pending.inspection)) {
      this.pending.delete(approvalId);
      this.record(
        journalEntry(pending.request, current, {
          approvalId,
          trigger: 'stale-evidence',
          verdict: 'escalate',
          disposition: 'reassess',
          reason: 'the page or focused form changed while approval was pending',
        }),
      );
      return this.assessAndMaybeExecute(pending.request, pending.dispatch, 0, true);
    }

    const signature = pending.publicResult.signature;
    throwIfAborted(pending.request.signal);
    if (decision === 'always' && !pending.standingGrantCreated) {
      if (signature === null) {
        pending.resolving = false;
        throw new Error('always approval requires a stable signature');
      }
      try {
        this.grantStore.create({ ...signature });
        pending.standingGrantCreated = true;
      } catch {
        pending.resolving = false;
        throw new Error('approval grant could not be persisted');
      }
    }

    this.record(
      journalEntry(pending.request, current, {
        approvalId,
        trigger: 'human',
        verdict: 'approve',
        disposition: 'dispatch-pending',
        reason:
          decision === 'always'
            ? 'the user approved and remembered this action'
            : 'the user approved this action once',
      }),
    );
    let value: T;
    try {
      value = await this.dispatchWithOutcome(
        pending.request,
        current,
        pending.dispatch,
        approvalId,
        pending.publicResult.evidenceDigest,
      );
    } catch (error) {
      pending.resolving = false;
      throw error;
    }
    this.pending.delete(approvalId);
    this.recordApprovalMemoryAfterExecution(
      pending.request,
      pending.inspection,
      this.approvalMemory(pending.request, pending.inspection),
      true,
      true,
    );
    return {
      kind: 'executed',
      value,
      reviewed: true,
      approvalId,
    };
  }

  hasPendingEscalation(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  cancelAgent(agentId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.agentId === agentId) this.pending.delete(id);
    }
    this.followThrough.deactivate(agentId);
  }

  private async assessAndMaybeExecute(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
    staleReassessments: number,
    forceReview: boolean,
  ): Promise<GateExecutionResult<T>> {
    throwIfAborted(request.signal);

    // Secret-shaped text is never eligible for human override. Check before
    // driver inspection so an unavailable live keyboard receiver cannot turn
    // a credential hard-deny into an approvable inspection-error escalation.
    if (request.action.kind === 'type' && isSecretLikeValue(request.action.text)) {
      const inspection = emptyInspection(request.action);
      const reason = 'buddies cannot enter credential- or secret-shaped values';
      const strike = this.strikes.recordDenial(
        request.agentId,
        safeActionTargetKey(request.action, inspection.facts),
      );
      this.record(
        journalEntry(request, inspection, {
          trigger: 'hard-deny',
          verdict: 'hard-deny',
          disposition: 'refuse',
          reason,
          targetDenials: strike.targetCount,
          totalDenials: strike.totalCount,
        }),
      );
      return strike.decision === 'halt'
        ? { kind: 'denied', denied: true, reason: DENIAL_HALT_COPY, halt: true }
        : denied(reason);
    }

    let inspection: InspectionSnapshot;
    try {
      inspection = await this.inspect(request);
    } catch {
      return this.escalateWithoutReview(
        request,
        dispatch,
        'the target could not be inspected safely',
        'i could not verify the page element that would receive this action',
      );
    }

    // The live desktop has no trustworthy element facts. Every supported
    // input action therefore goes straight to a one-use human decision before
    // generic DOM classification. In particular, this preserves native
    // right/middle click support only behind explicit review; the hidden
    // buddy browser still hard-denies non-left clicks below.
    if (
      request.origin === 'live-desktop' &&
      inspection.facts === null &&
      (request.action.kind === 'click' ||
        request.action.kind === 'type' ||
        request.action.kind === 'press_keys')
    ) {
      return this.escalateUnresolvedLive(request, dispatch, inspection, [
        ...(forceReview ? ['page evidence changed after an earlier assessment'] : []),
        'element facts unavailable',
      ]);
    }

    const trigger = forceReview
      ? ({
          kind: 'review',
          reasons: ['page evidence changed after an earlier assessment'],
        } as const)
      : classifyTrigger({
          action: request.action,
          facts: inspection.facts,
          ...(request.seenDomains === undefined ? {} : { seenDomains: request.seenDomains }),
        });
    const memory = this.approvalMemory(request, inspection);

    if (trigger.kind === 'hard-deny') {
      const strike = this.strikes.recordDenial(
        request.agentId,
        safeActionTargetKey(request.action, inspection.facts),
      );
      this.record(
        journalEntry(request, inspection, {
          trigger: trigger.kind,
          verdict: 'hard-deny',
          disposition: 'refuse',
          reason: trigger.reason,
          targetDenials: strike.targetCount,
          totalDenials: strike.totalCount,
        }),
      );
      return strike.decision === 'halt'
        ? { kind: 'denied', denied: true, reason: DENIAL_HALT_COPY, halt: true }
        : denied(trigger.reason);
    }

    if (trigger.kind === 'pass') {
      throwIfAborted(request.signal);
      this.record(
        journalEntry(request, inspection, {
          trigger: trigger.kind,
          verdict: 'pass',
          disposition: 'dispatch-pending',
          reason: 'mechanical trigger did not flag this action',
        }),
      );
      const value = await this.dispatchWithOutcome(
        request,
        inspection,
        dispatch,
        null,
        inspection.fingerprint,
      );
      this.recordApprovalMemoryAfterExecution(request, inspection, memory, false, false);
      return { kind: 'executed', value, reviewed: false };
    }

    let screenshot: ReviewScreenshot;
    try {
      screenshot = await this.captureReviewScreenshot(request);
    } catch {
      return this.escalateWithInspection(
        request,
        dispatch,
        inspection,
        'the review screenshot could not be captured',
        'i could not show a trustworthy current view of the pending action',
      );
    }

    const proposedPayload =
      request.action.kind === 'type'
        ? [{ name: 'proposed text', value: request.action.text, type: 'proposed-text' }]
        : [];
    const assessment = await this.reviewer.review({
      userRequest: request.userRequest,
      agentId: request.agentId,
      actionName: request.action.kind,
      actionArgs: actionArgs(request.action),
      justification: justificationOf(request.action),
      facts: inspection.facts,
      screenshot,
      payloadFields: [...inspection.payloadFields, ...proposedPayload],
      ...(request.taskClaim === undefined ? {} : { taskClaim: request.taskClaim }),
      ...(request.recentSteps === undefined ? {} : { recentSteps: request.recentSteps }),
      grants: memory.evidence,
    });
    throwIfAborted(request.signal);

    if (assessment.verdict.verdict === 'approve') {
      throwIfAborted(request.signal);
      let current: InspectionSnapshot;
      try {
        current = await this.inspect(request);
      } catch {
        return this.escalateFromAssessment(
          request,
          dispatch,
          inspection,
          assessment,
          'the target could not be re-inspected before execution',
          'the page may have changed since the reviewer approved it',
        );
      }

      if (!inspectionsMatch(current, inspection)) {
        this.record(
          journalEntry(request, current, {
            trigger: 'stale-evidence',
            triggerReasons: trigger.reasons,
            verdict: 'approve',
            disposition: 'reassess',
            reason: 'the reviewed page or focused form changed before dispatch',
            evidenceDigest: assessment.evidenceDigest,
            payloadDigest: assessment.payloadDigest,
          }),
        );
        if (staleReassessments >= MAX_STALE_REASSESSMENTS) {
          return this.escalateFromAssessment(
            request,
            dispatch,
            current,
            assessment,
            'the page kept changing before the action could execute',
            'the target could not remain stable long enough for safe automatic execution',
          );
        }
        return this.assessAndMaybeExecute(request, dispatch, staleReassessments + 1, true);
      }

      const currentMemory = this.approvalMemory(request, current);
      if (!approvalMemoryMatches(currentMemory, memory)) {
        this.record(
          journalEntry(request, current, {
            trigger: 'stale-evidence',
            triggerReasons: trigger.reasons,
            verdict: 'approve',
            disposition: 'reassess',
            reason: 'approval grants or follow-through coverage changed before dispatch',
            evidenceDigest: assessment.evidenceDigest,
            payloadDigest: assessment.payloadDigest,
          }),
        );
        if (staleReassessments >= MAX_STALE_REASSESSMENTS) {
          return this.escalateFromAssessment(
            request,
            dispatch,
            current,
            assessment,
            'approval memory kept changing before the action could execute',
            'the consequence approval state could not remain stable long enough for safe execution',
          );
        }
        return this.assessAndMaybeExecute(request, dispatch, staleReassessments + 1, true);
      }

      throwIfAborted(request.signal);
      this.record(
        journalEntry(request, current, {
          trigger: trigger.kind,
          triggerReasons: trigger.reasons,
          verdict: 'approve',
          disposition: 'dispatch-pending',
          reason: assessment.verdict.reason,
          evidenceDigest: assessment.evidenceDigest,
          payloadDigest: assessment.payloadDigest,
        }),
      );
      const value = await this.dispatchWithOutcome(
        request,
        current,
        dispatch,
        null,
        assessment.evidenceDigest,
      );
      this.recordApprovalMemoryAfterExecution(request, current, currentMemory, true, false);
      return { kind: 'executed', value, reviewed: true };
    }

    if (assessment.verdict.verdict === 'deny') {
      const strike = this.strikes.recordDenial(
        request.agentId,
        actionTargetKey(request.action, inspection.facts),
      );
      if (strike.decision === 'halt') {
        this.record(
          journalEntry(request, inspection, {
            trigger: trigger.kind,
            triggerReasons: trigger.reasons,
            verdict: 'deny',
            disposition: 'refuse',
            reason: assessment.verdict.reason,
            evidenceDigest: assessment.evidenceDigest,
            payloadDigest: assessment.payloadDigest,
            targetDenials: strike.targetCount,
            totalDenials: strike.totalCount,
          }),
        );
        return { kind: 'denied', denied: true, reason: DENIAL_HALT_COPY, halt: true };
      }
      if (strike.decision === 'escalate') {
        return this.storeEscalation(request, dispatch, inspection, assessment, {
          reason: assessment.verdict.reason,
          concern: 'the reviewer denied this same target three times',
          triggerReasons: trigger.reasons,
          targetDenials: strike.targetCount,
          totalDenials: strike.totalCount,
        });
      }
      this.record(
        journalEntry(request, inspection, {
          trigger: trigger.kind,
          triggerReasons: trigger.reasons,
          verdict: 'deny',
          disposition: 'refuse',
          reason: assessment.verdict.reason,
          evidenceDigest: assessment.evidenceDigest,
          payloadDigest: assessment.payloadDigest,
          targetDenials: strike.targetCount,
          totalDenials: strike.totalCount,
        }),
      );
      return denied(assessment.verdict.reason);
    }

    return this.storeEscalation(request, dispatch, inspection, assessment, {
      reason: assessment.verdict.reason,
      concern: assessment.verdict.concern,
      triggerReasons: trigger.reasons,
    });
  }

  private async inspect(request: GatedActionRequest): Promise<InspectionSnapshot> {
    throwIfAborted(request.signal);
    let target: DriverPoint | null = null;
    if (request.action.kind === 'click' || request.action.kind === 'scroll') {
      target = {
        screenIndex: request.screenIndex ?? 0,
        x: request.action.x,
        y: request.action.y,
      };
    } else if (
      request.action.kind !== 'type' &&
      request.action.kind !== 'press_keys' &&
      request.action.kind !== 'navigate'
    ) {
      return emptyInspection(request.action);
    }

    // Security-critical: null means keyboard focus. Facts, payload, DOM
    // fingerprint, and page revision come from one driver transaction.
    const detailed = await request.driver.inspectDetailed(target);
    throwIfAborted(request.signal);
    if (!detailed.fingerprint.trim()) throw new Error('driver inspection fingerprint is required');
    if (
      (typeof detailed.pageRevision === 'string' && !detailed.pageRevision.trim()) ||
      (typeof detailed.pageRevision === 'number' && !Number.isFinite(detailed.pageRevision))
    ) {
      throw new Error('driver page revision is invalid');
    }
    const sanitizedPayload = sanitizePayloadFields(detailed.payloadFields);
    const payloadFingerprint = createHash('sha256')
      .update(canonicalJson(sanitizedPayload))
      .digest('hex');
    const url = detailed.facts?.url ?? null;
    const fingerprint = createHash('sha256')
      .update(
        canonicalJson({
          action: request.action,
          facts: detailed.facts,
          driverFingerprint: detailed.fingerprint,
          pageRevision: detailed.pageRevision,
          payloadFingerprint,
          url,
        }),
      )
      .digest('hex');
    return {
      facts: detailed.facts,
      payloadFields: detailed.payloadFields,
      driverFingerprint: detailed.fingerprint,
      pageRevision: detailed.pageRevision,
      url,
      payloadFingerprint,
      fingerprint,
    };
  }

  private approvalMemory(
    request: GatedActionRequest,
    inspection: InspectionSnapshot,
  ): ApprovalMemoryContext {
    const signature = safeBuildSignature(request.action, inspection.facts);
    const executionDomain =
      signature?.domain ??
      (inspection.facts === null ? null : tryNormalizeDomain(inspection.facts.url));
    const standingGrants = signature === null ? [] : this.grantStore.findMatches(signature);
    const coverage =
      signature === null ? null : this.followThrough.coverageFor(request.agentId, signature.domain);
    const evidence: StandingApprovalEvidence[] = [
      ...standingGrants.map((grant) => ({
        domain: grant.domain,
        actionKind: grant.actionKind,
        target: grant.target,
        scope: 'standing' as const,
      })),
      ...(signature !== null && coverage !== null
        ? [
            {
              domain: coverage.domain,
              actionKind: signature.actionKind,
              target: signature.target,
              scope: 'follow-through' as const,
            },
          ]
        : []),
    ];
    return {
      signature,
      executionDomain,
      standingGrants,
      followThroughCoverage: coverage,
      evidence,
    };
  }

  private recordApprovalMemoryAfterExecution(
    request: GatedActionRequest,
    _inspection: InspectionSnapshot,
    memory: ApprovalMemoryContext,
    useStandingGrant: boolean,
    humanApproved: boolean,
  ): void {
    const standingGrant = memory.standingGrants[0];
    if (useStandingGrant && standingGrant !== undefined) {
      try {
        this.grantStore.recordUse(standingGrant.id);
      } catch (error) {
        this.reportApprovalMemoryError(error);
      }
    }
    if (memory.executionDomain !== null) {
      try {
        this.followThrough.recordExecutedAction(request.agentId, memory.executionDomain);
      } catch (error) {
        this.reportApprovalMemoryError(error);
      }
    }
    if (humanApproved && memory.signature !== null) {
      try {
        this.followThrough.activate(request.agentId, memory.signature.domain);
      } catch (error) {
        this.reportApprovalMemoryError(error);
      }
    }
  }

  private reportApprovalMemoryError(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      this.onApprovalMemoryError(failure);
    } catch {
      // Memory is restrictive evidence only. Reporting failure must not turn
      // an already-executed action into a misleading tool failure.
    }
  }

  private async dispatchWithOutcome(
    request: GatedActionRequest,
    inspection: InspectionSnapshot,
    dispatch: GateDispatch<T>,
    approvalId: string | null,
    evidenceDigest: string,
  ): Promise<T> {
    const navigationDestination = authorizedNavigationDestination(request.action, inspection.facts);
    const base: Omit<ComputerActionOutcomeEntry, 'type' | 'at' | 'errorClass'> = {
      agentId: request.agentId,
      approvalId,
      actionKind: request.action.kind,
      evidenceDigest,
      targetSignature: safeActionTargetKey(request.action, inspection.facts),
      navigationDomain:
        navigationDestination === null ? null : tryNormalizeDomain(navigationDestination),
    };
    try {
      // This is the final transaction boundary. BrowserRuntime aborts the
      // action-scoped signal before reporting a gate timeout, so a reviewer or
      // reinspection that settles late can never reach mechanical dispatch.
      throwIfAborted(request.signal);
      const value = await dispatch({ navigationDestination });
      this.recordOutcome({ type: 'computer_action_executed', at: this.now(), ...base });
      return value;
    } catch (error) {
      const errorClass = boundedErrorClass(error);
      this.recordOutcome({
        type: 'computer_action_failed',
        at: this.now(),
        ...base,
        errorClass,
      });
      throw error;
    }
  }

  private recordOutcome(entry: ComputerActionOutcomeEntry): void {
    try {
      this.journal.recordComputerActionOutcome(entry);
    } catch {
      // Outcome journaling is fail-soft like the session recorder; no secrets
      // or action payloads are present in this entry.
    }
  }

  private async captureReviewScreenshot(request: GatedActionRequest): Promise<ReviewScreenshot> {
    throwIfAborted(request.signal);
    const captures = await request.driver.capture();
    throwIfAborted(request.signal);
    const screenIndex = request.screenIndex ?? 0;
    const capture = captures.find((item) => item.meta.screenIndex === screenIndex);
    if (capture === undefined) throw new Error(`capture screen${screenIndex} is unavailable`);
    return {
      base64: capture.jpegBase64,
      mimeType: 'image/jpeg',
      width: capture.meta.imageW,
      height: capture.meta.imageH,
      ...(request.action.kind === 'click'
        ? { target: { x: request.action.x, y: request.action.y } }
        : {}),
    };
  }

  private async escalateWithoutReview(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
    reason: string,
    concern: string,
  ): Promise<GateEscalation> {
    const inspection = emptyInspection(request.action);
    return this.escalateWithInspection(request, dispatch, inspection, reason, concern);
  }

  private async escalateUnresolvedLive(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
    inspection: InspectionSnapshot,
    triggerReasons: readonly string[],
  ): Promise<GateEscalation> {
    let markedScreenshotPng: string | null = null;
    let evidenceDigest = inspection.fingerprint;
    try {
      const screenshot = await this.captureReviewScreenshot(request);
      const marked = await this.markScreenshot(screenshot);
      markedScreenshotPng = marked.pngBase64;
      evidenceDigest = createHash('sha256')
        .update(inspection.fingerprint)
        .update('\0')
        .update(marked.jpegBase64)
        .digest('hex');
    } catch {
      // The unresolved live-desktop action still escalates; absence of a
      // trustworthy image is visible to the approval UI and never auto-passes.
    }
    return this.storeEscalation(
      request,
      dispatch,
      inspection,
      {
        verdict: {
          verdict: 'escalate',
          reason: 'live desktop element facts are unavailable',
          concern: 'a user must verify actions on the live desktop',
        },
        evidenceDigest,
        payloadDigest:
          request.action.kind === 'type'
            ? sanitizePayloadFields([
                { name: 'Proposed text', value: request.action.text, type: 'text' },
              ]).map((field) => `${field.name}: ${field.value}`)
            : [],
        markedScreenshotPng,
      },
      {
        reason: 'live desktop element facts are unavailable',
        concern: 'a user must verify actions on the live desktop',
        triggerReasons,
      },
    );
  }

  private async escalateWithInspection(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
    inspection: InspectionSnapshot,
    reason: string,
    concern: string,
  ): Promise<GateEscalation> {
    const assessment: ReviewAssessment = {
      verdict: { verdict: 'escalate', reason, concern },
      evidenceDigest: inspection.fingerprint,
      payloadDigest: sanitizePayloadFields(inspection.payloadFields).map(
        (field) => `${field.name}: ${field.value}`,
      ),
      markedScreenshotPng: null,
    };
    return this.storeEscalation(request, dispatch, inspection, assessment, { reason, concern });
  }

  private async escalateFromAssessment(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
    inspection: InspectionSnapshot,
    assessment: ReviewAssessment,
    reason: string,
    concern: string,
  ): Promise<GateEscalation> {
    return this.storeEscalation(request, dispatch, inspection, assessment, { reason, concern });
  }

  private storeEscalation(
    request: GatedActionRequest,
    dispatch: GateDispatch<T>,
    inspection: InspectionSnapshot,
    assessment: ReviewAssessment,
    detail: {
      reason: string;
      concern: string;
      triggerReasons?: readonly string[];
      targetDenials?: number;
      totalDenials?: number;
    },
  ): GateEscalation {
    // Central invariant: no asynchronous inspection/reviewer/capture that
    // settles after cancellation may resurrect a hidden pending approval.
    throwIfAborted(request.signal);
    const approvalId = this.id();
    if (!approvalId || this.pending.has(approvalId)) {
      throw new Error('action gate generated a duplicate empty assessment id');
    }
    const signature = safeBuildSignature(request.action, inspection.facts);
    const publicResult = Object.freeze({
      kind: 'escalated' as const,
      approvalId,
      agentId: request.agentId,
      userRequest: request.userRequest,
      actionText: actionText(request.action, inspection.facts),
      browserDomain:
        request.origin === 'buddy-browser'
          ? trustedBrowserDomain(request.action, inspection.facts)
          : null,
      reason: scrubDisplayText(detail.reason),
      concern: scrubDisplayText(detail.concern),
      evidenceDigest: assessment.evidenceDigest,
      payloadDigest: Object.freeze([...assessment.payloadDigest]),
      screenshotPng: assessment.markedScreenshotPng,
      signature: signature === null ? null : Object.freeze({ ...signature }),
      grantScope: signature === null ? null : formatGrantScope(signature),
    });
    this.pending.set(approvalId, {
      publicResult,
      request,
      dispatch,
      inspection,
      resolving: false,
      standingGrantCreated: false,
    });
    this.record(
      journalEntry(request, inspection, {
        approvalId,
        trigger: 'review',
        verdict: 'escalate',
        disposition: 'await-human',
        reason: detail.reason,
        concern: detail.concern,
        evidenceDigest: assessment.evidenceDigest,
        payloadDigest: assessment.payloadDigest,
        ...(detail.triggerReasons === undefined ? {} : { triggerReasons: detail.triggerReasons }),
        ...(detail.targetDenials === undefined ? {} : { targetDenials: detail.targetDenials }),
        ...(detail.totalDenials === undefined ? {} : { totalDenials: detail.totalDenials }),
      }),
    );
    return publicResult;
  }

  private record(entry: ActionGateJournalEntry): void {
    try {
      this.journal.recordActionGateAssessment({ ...entry, at: this.now() });
    } catch {
      // The session recorder is intentionally fail-soft. The gate decision
      // remains enforced even when local diagnostics cannot be written.
    }
  }
}

function validateRequest(request: GatedActionRequest): void {
  if (!request.agentId.trim()) throw new Error('agentId is required');
  if (!request.userRequest.trim()) throw new Error('userRequest is required');
  if (request.action.kind !== 'screenshot' && !request.action.justification.trim()) {
    throw new Error('every acting action requires a justification');
  }
}

function actionArgs(action: TriggerAction): Record<string, unknown> {
  const {
    kind: _kind,
    justification: _justification,
    ...args
  } = action as TriggerAction & {
    justification?: string;
  };
  if (action.kind !== 'type') return args;
  const proposed = sanitizePayloadFields([
    { name: 'proposed text', value: action.text, type: 'proposed-text' },
  ])[0];
  return { text: proposed?.value ?? '[redacted]' };
}

function justificationOf(action: TriggerAction): string {
  return 'justification' in action ? action.justification : 'capture the current browser state';
}

function actionText(action: TriggerAction, facts: ElementFacts | null): string {
  const destination = authorizedNavigationDestination(action, facts);
  const route =
    destination === null
      ? null
      : `${approvalUrl(facts?.url) ?? 'unknown source'} → ${approvalUrl(destination) ?? 'invalid destination'}`;
  switch (action.kind) {
    case 'navigate':
      return route === null ? 'navigate to an unresolved destination' : `navigate from ${route}`;
    case 'click': {
      const label = scrubDisplayText(facts?.text ?? facts?.ariaLabel ?? '', 160);
      const verb = action.button && action.button !== 'left' ? `${action.button}-click` : 'click';
      const target = label ? `page-provided target “${label}”` : 'the marked target';
      return route === null ? `${verb} ${target}` : `${verb} ${target} on ${route}`;
    }
    case 'type': {
      const label = scrubDisplayText(facts?.text ?? facts?.ariaLabel ?? '', 160);
      return label ? `type into page-provided field “${label}”` : 'type into the focused field';
    }
    case 'press_keys': {
      const keys = scrubDisplayText(action.keys.join(' + '), 120) || 'the requested keys';
      const label = scrubDisplayText(facts?.text ?? facts?.ariaLabel ?? '', 160);
      const target = label
        ? `press ${keys} in page-provided control “${label}”`
        : `press ${keys} in the focused control`;
      return route === null ? target : `${target} on ${route}`;
    }
    case 'scroll':
      return 'scroll the current page';
    case 'screenshot':
      return 'capture the current page';
  }
}

function trustedBrowserDomain(action: TriggerAction, facts: ElementFacts | null): string | null {
  const destination = authorizedNavigationDestination(action, facts);
  if (destination !== null) return tryNormalizeDomain(destination);
  return facts === null ? null : tryNormalizeDomain(facts.url);
}

function approvalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return null;
  }
  const query = [...parsed.searchParams.entries()].map(([rawName, rawValue], index) => {
    const scrubbedName = scrubDisplayText(rawName, 80) || `parameter-${index + 1}`;
    const name = isSecretLikeValue(scrubbedName) ? '[redacted-key]' : scrubbedName;
    const sanitized = sanitizePayloadFields([
      { name, value: rawValue, type: 'query-parameter' },
    ])[0];
    const value = isSensitiveQueryName(scrubbedName)
      ? '[redacted]'
      : (sanitized?.value ?? '[redacted]');
    return `${encodeApprovalQueryComponent(name)}=${
      value === '[redacted]' ? '[redacted]' : encodeApprovalQueryComponent(value)
    }`;
  });
  return `${parsed.origin}${parsed.pathname || '/'}${query.length > 0 ? `?${query.join('&')}` : ''}`;
}

function isSensitiveQueryName(value: string): boolean {
  const canonical = value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
  return SENSITIVE_QUERY_NAMES.has(canonical);
}

function encodeApprovalQueryComponent(value: string): string {
  return encodeURIComponent(scrubDisplayText(value, 240)).replace(/%20/g, '+');
}

function isHumanApprovalDecision(value: unknown): value is HumanApprovalDecision {
  return value === 'once' || value === 'always' || value === 'deny' || value === 'handled';
}

function authorizedNavigationDestination(
  action: TriggerAction,
  facts: ElementFacts | null,
): string | null {
  let candidate: string | undefined;
  if (action.kind === 'navigate') {
    candidate = action.url;
  } else if (facts !== null && (action.kind === 'click' || action.kind === 'press_keys')) {
    candidate = facts.inForm && facts.formAction ? facts.formAction : facts.href;
  }
  if (!candidate) return null;
  try {
    const destination = new URL(candidate, facts?.url);
    if (!['http:', 'https:'].includes(destination.protocol)) return null;
    if (destination.username || destination.password) return null;
    return destination.href;
  } catch {
    return null;
  }
}

function boundedErrorClass(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const bounded = name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
  return bounded || 'Error';
}

function emptyInspection(action: TriggerAction): InspectionSnapshot {
  const fingerprint = createHash('sha256')
    .update(canonicalJson({ action, unavailable: true }))
    .digest('hex');
  return {
    facts: null,
    payloadFields: [],
    driverFingerprint: 'not-applicable',
    pageRevision: 'not-applicable',
    url: null,
    payloadFingerprint: createHash('sha256').update('[]').digest('hex'),
    fingerprint,
  };
}

function inspectionsMatch(current: InspectionSnapshot, assessed: InspectionSnapshot): boolean {
  return (
    current.url === assessed.url &&
    current.driverFingerprint === assessed.driverFingerprint &&
    current.pageRevision === assessed.pageRevision &&
    current.payloadFingerprint === assessed.payloadFingerprint &&
    current.fingerprint === assessed.fingerprint
  );
}

function approvalMemoryMatches(
  current: ApprovalMemoryContext,
  assessed: ApprovalMemoryContext,
): boolean {
  return (
    canonicalJson({
      signature: current.signature,
      standingGrantIds: current.standingGrants.map((grant) => grant.id).sort(),
      followThrough: current.followThroughCoverage,
    }) ===
    canonicalJson({
      signature: assessed.signature,
      standingGrantIds: assessed.standingGrants.map((grant) => grant.id).sort(),
      followThrough: assessed.followThroughCoverage,
    })
  );
}

function denied(reason: string): GateExecutionResult<never> {
  return { kind: 'denied', denied: true, reason, halt: false };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonicalize(source[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('The action was aborted', 'AbortError');
}

interface JournalOverrides {
  approvalId?: string;
  trigger: ActionGateJournalEntry['trigger'];
  triggerReasons?: readonly string[];
  verdict: ActionGateJournalEntry['verdict'];
  disposition: ActionGateJournalEntry['disposition'];
  reason: string;
  concern?: string;
  evidenceDigest?: string;
  payloadDigest?: readonly string[];
  targetDenials?: number;
  totalDenials?: number;
}

function journalEntry(
  request: GatedActionRequest,
  inspection: InspectionSnapshot,
  overrides: JournalOverrides,
): ActionGateJournalEntry {
  const signature = safeBuildSignature(request.action, inspection.facts);
  return {
    type: 'action_gate_assessment',
    at: Date.now(),
    agentId: request.agentId,
    approvalId: overrides.approvalId ?? null,
    actionKind: request.action.kind,
    domain:
      signature?.domain ??
      (inspection.facts === null ? null : tryNormalizeDomain(inspection.facts.url)),
    targetSignature: safeActionTargetKey(request.action, inspection.facts),
    evidenceDigest: overrides.evidenceDigest ?? inspection.fingerprint,
    payloadDigest:
      overrides.payloadDigest ??
      sanitizePayloadFields(inspection.payloadFields).map(
        (field) => `${field.name}: ${field.value}`,
      ),
    trigger: overrides.trigger,
    triggerReasons: [...(overrides.triggerReasons ?? [])],
    verdict: overrides.verdict,
    disposition: overrides.disposition,
    reason: overrides.reason,
    ...(overrides.concern === undefined ? {} : { concern: overrides.concern }),
    ...(overrides.targetDenials === undefined ? {} : { targetDenials: overrides.targetDenials }),
    ...(overrides.totalDenials === undefined ? {} : { totalDenials: overrides.totalDenials }),
  };
}

function safeBuildSignature(
  action: TriggerAction,
  facts: ElementFacts | null,
): ActionSignature | null {
  try {
    return buildActionSignature(action, facts);
  } catch {
    return null;
  }
}

function safeActionTargetKey(action: TriggerAction, facts: ElementFacts | null): string {
  try {
    return actionTargetKey(action, facts);
  } catch {
    return createHash('sha256')
      .update(canonicalJson({ kind: action.kind, facts }))
      .digest('hex');
  }
}
