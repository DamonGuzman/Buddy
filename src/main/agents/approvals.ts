import type { ApprovalRequest } from '../../shared/types';
import type { AgentApprovalPort, AgentApprovalResolution, AgentApprovalVerdict } from './types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface PendingApproval {
  request: ApprovalRequest;
  signal: AbortSignal;
  delivery: Deferred<AgentApprovalResolution>;
  acknowledgment: Deferred<void> | null;
  resolving: boolean;
  onAbort(): void;
}

export interface AgentApprovalCoordinatorOptions {
  /** Full immutable snapshot after every add/remove/atomic replacement. */
  onChanged(requests: ApprovalRequest[]): void;
}

/**
 * In-memory approval transaction coordinator. The card remains present while
 * a delivered verdict is resolving; UI invocation completes only after the
 * parked executor acknowledges the gate/persistence/dispatch outcome.
 */
export class AgentApprovalCoordinator implements AgentApprovalPort {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly options: AgentApprovalCoordinatorOptions) {}

  request(request: ApprovalRequest, signal: AbortSignal): Promise<AgentApprovalResolution> {
    if (signal.aborted) return Promise.resolve(cancelledResolution());
    const existing = this.pending.get(request.approvalId);
    if (existing) {
      if (existing.request.agentId !== request.agentId)
        throw new Error('approval id is already bound to another agent');
      if (!sameRequest(existing.request, request))
        throw new Error('approval id cannot be reused with different immutable evidence');
      if (existing.resolving)
        throw new Error(`approval ${request.approvalId} is already resolving`);
      return existing.delivery.promise;
    }
    if (this.list().some((item) => item.agentId === request.agentId))
      throw new Error(`agent ${request.agentId} already has a pending approval`);

    const pending = this.createPending(request, signal);
    this.pending.set(request.approvalId, pending);
    try {
      this.push();
    } catch (error) {
      this.removePending(pending);
      throw error;
    }
    return pending.delivery.promise;
  }

  resolve(approvalId: string, verdict: AgentApprovalVerdict): Promise<void> {
    if (!isApprovalVerdict(verdict))
      return Promise.reject(new Error('approval verdict is invalid'));
    const pending = this.pending.get(approvalId);
    if (!pending) return Promise.reject(new Error('approval is missing or stale'));
    if (pending.resolving)
      return Promise.reject(new Error(`approval ${approvalId} is already resolving`));
    if (
      verdict === 'always' &&
      (pending.request.allowAlways !== true || !pending.request.grantScope?.trim())
    ) {
      return Promise.reject(new Error('approval does not allow a standing permission'));
    }
    if (verdict === 'handled' && pending.request.allowTakeover !== true) {
      return Promise.reject(new Error('approval does not allow browser takeover'));
    }

    pending.resolving = true;
    pending.acknowledgment = deferred<void>();
    pending.delivery.resolve(this.resolution(pending, verdict));
    return pending.acknowledgment.promise;
  }

  cancelAgent(agentId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.request.agentId === agentId) this.cancelPending(pending);
    }
  }

  cancelAll(): void {
    for (const pending of [...this.pending.values()]) this.cancelPending(pending);
  }

  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ request }) => cloneRequest(request));
  }

  get(approvalId: string): ApprovalRequest | null {
    const request = this.pending.get(approvalId)?.request;
    return request ? cloneRequest(request) : null;
  }

  private resolution(
    pending: PendingApproval,
    verdict: AgentApprovalVerdict,
  ): AgentApprovalResolution {
    let settled = false;
    const assertLive = (): void => {
      if (settled) throw new Error('approval resolution was already settled');
      if (this.pending.get(pending.request.approvalId) !== pending || !pending.resolving)
        throw new Error('approval resolution is stale');
    };
    return {
      verdict,
      acknowledge: () => {
        assertLive();
        const acknowledgment = pending.acknowledgment;
        this.removePending(pending);
        try {
          this.push();
        } catch (error) {
          this.restorePending(pending);
          settled = true;
          pending.resolving = false;
          pending.acknowledgment = null;
          pending.delivery = deferred<AgentApprovalResolution>();
          acknowledgment?.reject(asError(error));
          throw error;
        }
        settled = true;
        acknowledgment?.resolve(undefined);
      },
      reject: (error) => {
        assertLive();
        settled = true;
        const acknowledgment = pending.acknowledgment;
        pending.resolving = false;
        pending.acknowledgment = null;
        pending.delivery = deferred<AgentApprovalResolution>();
        acknowledgment?.reject(error);
      },
      replace: async (request) => {
        assertLive();
        if (pending.signal.aborted) throw new Error('approval was cancelled');
        if (request.agentId !== pending.request.agentId)
          throw new Error('replacement approval must belong to the same agent');
        if (request.approvalId === pending.request.approvalId)
          throw new Error('replacement approval requires a new immutable id');
        if (this.pending.has(request.approvalId))
          throw new Error('replacement approval id is already pending');

        const acknowledgment = pending.acknowledgment;
        this.removePending(pending);
        const replacement = this.createPending(request, pending.signal);
        this.pending.set(request.approvalId, replacement);
        try {
          this.push();
        } catch (error) {
          this.removePending(replacement);
          this.restorePending(pending);
          throw error;
        }
        settled = true;
        acknowledgment?.resolve(undefined);
        return replacement.delivery.promise;
      },
    };
  }

  private createPending(request: ApprovalRequest, signal: AbortSignal): PendingApproval {
    const pending: PendingApproval = {
      request: cloneRequest(request),
      signal,
      delivery: deferred<AgentApprovalResolution>(),
      acknowledgment: null,
      resolving: false,
      onAbort: () => this.cancelPending(pending),
    };
    signal.addEventListener('abort', pending.onAbort, { once: true });
    return pending;
  }

  private cancelPending(pending: PendingApproval): void {
    if (this.pending.get(pending.request.approvalId) !== pending) return;
    const acknowledgment = pending.acknowledgment;
    const delivery = pending.delivery;
    this.removePending(pending);
    this.push();
    acknowledgment?.reject(new Error('approval was cancelled'));
    if (!pending.resolving) delivery.resolve(cancelledResolution());
  }

  private removePending(pending: PendingApproval): void {
    this.pending.delete(pending.request.approvalId);
    pending.signal.removeEventListener('abort', pending.onAbort);
  }

  private restorePending(pending: PendingApproval): void {
    this.pending.set(pending.request.approvalId, pending);
    pending.signal.addEventListener('abort', pending.onAbort, { once: true });
  }

  private push(): void {
    this.options.onChanged(this.list());
  }
}

function isApprovalVerdict(value: unknown): value is AgentApprovalVerdict {
  return value === 'once' || value === 'always' || value === 'deny' || value === 'handled';
}

function cloneRequest(request: ApprovalRequest): ApprovalRequest {
  return { ...request, payloadDigest: [...request.payloadDigest] };
}

function sameRequest(left: ApprovalRequest, right: ApprovalRequest): boolean {
  return (
    left.agentId === right.agentId &&
    left.approvalId === right.approvalId &&
    left.kind === right.kind &&
    left.userRequest === right.userRequest &&
    left.allowAlways === right.allowAlways &&
    left.grantScope === right.grantScope &&
    left.allowTakeover === right.allowTakeover &&
    left.browserDomain === right.browserDomain &&
    left.actionText === right.actionText &&
    left.concern === right.concern &&
    left.screenshotPng === right.screenshotPng &&
    left.payloadDigest.length === right.payloadDigest.length &&
    left.payloadDigest.every((value, index) => value === right.payloadDigest[index])
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function cancelledResolution(): AgentApprovalResolution {
  return {
    verdict: 'deny',
    acknowledge: () => undefined,
    reject: () => undefined,
    replace: async () => {
      throw new Error('cancelled approval cannot be replaced');
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
