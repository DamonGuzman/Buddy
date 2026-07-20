import { join } from 'node:path';
import type { ApprovalGrant, ApprovalRequest, EnrolledSite } from '../../shared/types';
import type { CaptureResult } from '../capture';
import type { ChatGptCodexAuthSource, CodexProvider } from '../auth/auth-source';
import type { ComputerDriver } from '../computer/driver';
import type { OffscreenBrowserDriver } from '../computer/browser-driver';
import type { BuddyBrowserProfile } from '../computer/browser-profile';
import { requireCanonicalHelperBuddyId } from '../helper-buddy-id';
import type {
  ApprovalOperations,
  BuddyBrowserIpcController,
  BuddyBrowserWindowService,
} from '../windows/buddy-browser';
import { HelperBuddyApprovalCoordinator } from './approvals';
import { ActionGate, type ActionGateJournalPort, type GateDriverPort } from './gate/action-gate';
import {
  ApprovalFollowThroughTracker,
  ApprovalGrantStore,
  createApprovalGrantFilePersistence,
} from './gate/grants';
import { CodexActionReviewer, type ActionReviewer } from './gate/reviewer';
import type {
  HelperBuddyActionGatePort,
  HelperBuddyApprovalPort,
  HelperBuddyApprovalResolution,
  HelperBuddyBrowserDeps,
} from './types';

const GRANTS_FILE = 'approval-grants.json';

export interface ComputerUseRuntimeOptions {
  /** Electron's app-ready boundary. No profile, Session, or BrowserWindow is touched before it. */
  whenAppReady(): Promise<void>;
  userDataPath(): string;
  /** Resolved afresh for every independent review so sign-in/account changes take effect. */
  codexProvider(): CodexProvider;
  /** Complete immutable queue snapshot after every add and removal. */
  onApprovalsChanged(requests: ApprovalRequest[]): void;
  /**
   * Ephemeral observation stream for helper-card PiP. null closes the frame.
   * The composition root may retain only the latest frame per active helper.
   */
  onBrowserPreviewChanged?(update: { helperBuddyId: string; capture: CaptureResult | null }): void;
  journal: ActionGateJournalPort;
  /** Lifecycle/callback failures are never discarded into an empty catch. */
  onError(error: Error): void;
  onEnrollmentClosed?(): void | Promise<void>;
  /** Restore the standalone approval UI immediately after the takeover surface is hidden. */
  onTakeoverWindowHidden?(request: ApprovalRequest): void | Promise<void>;
  /** Hide Buddy surfaces before a live-desktop verdict can trigger reinspection/input. */
  beforeLiveApprovalResolution?(request: ApprovalRequest): void | Promise<void>;
  /** Restore approval visibility after a downstream live-action rejection. */
  onLiveApprovalResolutionFailed?(request: ApprovalRequest, error: Error): void | Promise<void>;
  createReviewer?(auth: ChatGptCodexAuthSource): ActionReviewer;
  createProfile?(): BuddyBrowserProfile | Promise<BuddyBrowserProfile>;
  createWindowService?(
    profile: BuddyBrowserProfile,
    callbacks: {
      onEnrollmentClosed?: () => void | Promise<void>;
      onTakeoverDone(helperBuddyId: string, approvalId: string): void | Promise<void>;
      onTakeoverClosed(helperBuddyId: string, approvalId: string): void | Promise<void>;
      onBackgroundError(error: Error): void;
    },
  ): BuddyBrowserWindowService | Promise<BuddyBrowserWindowService>;
  createOffscreenDriver?(
    profile: BuddyBrowserProfile,
  ): OffscreenBrowserDriver | Promise<OffscreenBrowserDriver>;
}

interface RuntimeState {
  profile: BuddyBrowserProfile;
  windows: BuddyBrowserWindowService;
  grants: ApprovalGrantStore;
  followThrough: ApprovalFollowThroughTracker;
  gate: ActionGate<void>;
  ipc: BuddyBrowserIpcController;
}

interface ApprovalBinding {
  helperBuddyId: string;
  release: () => Promise<void>;
  releasing: Promise<void> | null;
}

export interface ComputerUseController {
  resolveApproval(
    helperBuddyId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void>;
  showApprovalWindow(helperBuddyId: string, approvalId: string): Promise<void>;
  hideApprovalWindow(helperBuddyId: string, approvalId: string): Promise<void>;
  listApprovals(): ApprovalRequest[];
  listGrants(): Promise<ApprovalGrant[]>;
  revokeGrant(id: string): Promise<void>;
  openEnrollment(url: string): Promise<void>;
  listEnrolledSites(): Promise<EnrolledSite[]>;
  signOutSite(domain: string): Promise<void>;
  clearAll(): Promise<void>;
}

/**
 * Composition root for every browser/live-desktop action safety service.
 *
 * Construction is Electron-free. The first operation awaits app readiness,
 * then creates one persistent profile, grant store, gate, and visible-window
 * service. Every HelperBuddyManager run receives `browser`; foreground
 * ComputerUseRunner receives the same `gate` and `approvals` ports.
 */
export class ComputerUseRuntime {
  readonly browser: HelperBuddyBrowserDeps;
  readonly gate: HelperBuddyActionGatePort;
  readonly approvals: HelperBuddyApprovalPort;
  readonly controller: ComputerUseController;

  private readonly coordinator: HelperBuddyApprovalCoordinator;
  private readonly approvalBindings = new Map<string, ApprovalBinding>();
  /** Bindings whose ordered freeze/complete lifecycle is owned by the IPC controller. */
  private readonly controllerOwnedReleases = new Set<string>();
  /** Per-helper generation invalidates asynchronous driver creation on cancellation. */
  private readonly helperBuddyCancellationEpochs = new Map<string, number>();
  /** A helper ID is reserved from the first await until its driver is registered or cleaned up. */
  private readonly driverOpenings = new Map<string, Promise<ComputerDriver & GateDriverPort>>();
  private readonly drivers = new Map<string, ComputerDriver>();
  private state: RuntimeState | null = null;
  private stateOpening: Promise<RuntimeState> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private suspended = false;
  private lifecycleEpoch = 0;

  constructor(private readonly options: ComputerUseRuntimeOptions) {
    this.coordinator = new HelperBuddyApprovalCoordinator({
      onCancellationError: (error) => this.report(error),
      onChanged: (requests) => {
        try {
          options.onApprovalsChanged(requests);
        } finally {
          this.releaseBindingsMissingFrom(requests);
        }
      },
    });

    this.gate = {
      execute: async (input, dispatch) => {
        assertCanonicalHelperBuddyId(input.helperBuddyId);
        return this.withState((state) => state.gate.execute(input, dispatch));
      },
      resolveEscalation: (approvalId, verdict) =>
        this.withState((state) => state.gate.resolveEscalation(approvalId, verdict)),
      cancelHelperBuddy: (helperBuddyId) => {
        assertCanonicalHelperBuddyId(helperBuddyId);
        this.state?.gate.cancelHelperBuddy(helperBuddyId);
      },
    };

    this.approvals = {
      request: (request, signal) => this.requestApproval(request, signal),
      cancelHelperBuddy: (helperBuddyId) => {
        assertCanonicalHelperBuddyId(helperBuddyId);
        this.cancelCoordinatorHelperBuddy(helperBuddyId);
        void this.releaseHelperBuddyApprovals(helperBuddyId).catch((error: unknown) =>
          this.report(error),
        );
      },
      get: (approvalId) => this.coordinator.get(approvalId),
      resolve: (approvalId, verdict) => {
        // Takeover-capable approvals must go through `controller`, which
        // freezes the bound surface before waking the run.
        if (this.coordinator.get(approvalId)?.allowTakeover) {
          return Promise.reject(
            new Error('takeover-capable approval must resolve through the window controller'),
          );
        }
        return this.coordinator.resolve(approvalId, verdict);
      },
    };

    this.browser = {
      createDriver: (helperBuddyId) => this.createDriver(helperBuddyId),
      gate: this.gate,
      approvals: this.approvals,
    };

    this.controller = {
      resolveApproval: async (helperBuddyId, approvalId, verdict) => {
        assertCanonicalHelperBuddyId(helperBuddyId);
        return this.withState((state) =>
          this.resolveThroughController(state, helperBuddyId, approvalId, verdict),
        );
      },
      showApprovalWindow: async (helperBuddyId, approvalId) => {
        assertCanonicalHelperBuddyId(helperBuddyId);
        return this.withState((state) => state.ipc.showApprovalWindow(helperBuddyId, approvalId));
      },
      hideApprovalWindow: async (helperBuddyId, approvalId) => {
        assertCanonicalHelperBuddyId(helperBuddyId);
        return this.withState((state) => state.ipc.hideApprovalWindow(helperBuddyId, approvalId));
      },
      listApprovals: () => this.coordinator.list(),
      listGrants: () => this.withState((state) => state.ipc.listGrants()),
      revokeGrant: (id) => this.withState((state) => state.ipc.revokeGrant(id)),
      openEnrollment: (url) => this.withState((state) => state.ipc.openEnrollment(url)),
      listEnrolledSites: () => this.withState((state) => state.ipc.listEnrolledSites()),
      signOutSite: (domain) => this.withState((state) => this.signOutSite(state, domain)),
      clearAll: () => this.withState((state) => this.clearAll(state)),
    };
  }

  /** Cancel one run's queue, gate capability, follow-through, and browser surface. */
  async cancelHelperBuddy(helperBuddyId: string): Promise<void> {
    assertCanonicalHelperBuddyId(helperBuddyId);
    this.helperBuddyCancellationEpochs.set(
      helperBuddyId,
      (this.helperBuddyCancellationEpochs.get(helperBuddyId) ?? 0) + 1,
    );
    this.cancelCoordinatorHelperBuddy(helperBuddyId);
    const state = this.state;
    state?.gate.cancelHelperBuddy(helperBuddyId);
    state?.followThrough.deactivate(helperBuddyId);
    const driver = this.drivers.get(helperBuddyId);
    const releases = [...this.approvalBindings.entries()]
      .filter(([, binding]) => binding.helperBuddyId === helperBuddyId)
      .map(([approvalId, binding]) => this.releaseApproval(approvalId, binding));
    await Promise.all([...(driver ? [driver.dispose()] : []), ...releases]);
  }

  async cancelAll(): Promise<void> {
    await this.cancelAllBrowserHelpers();
    this.cancelCoordinatorAll();
    this.state?.followThrough.clear();
  }

  /** Lock/suspend is destructive: no authenticated page or parked action survives it. */
  async suspend(): Promise<void> {
    if (this.disposed) return;
    const epoch = (this.lifecycleEpoch += 1);
    this.suspended = true;
    const helperBuddyIds = new Set([
      ...this.drivers.keys(),
      ...this.driverOpenings.keys(),
      ...this.coordinator.list().map((request) => request.helperBuddyId),
    ]);
    const cancellationResults = await Promise.allSettled(
      [...helperBuddyIds].map((helperBuddyId) => this.cancelHelperBuddy(helperBuddyId)),
    );
    this.reportRejected(cancellationResults);
    if (this.disposed || epoch !== this.lifecycleEpoch || !this.suspended) return;
    this.cancelCoordinatorAll();
    this.reportRejected(await this.releaseAllApprovalsSettled());
    if (this.state) {
      this.state.followThrough.clear();
      try {
        await this.state.windows.suspend();
        // A resume can land while surface disposal is in flight. Restore the
        // profile if this transition was superseded before it completed.
        if (!this.disposed && (epoch !== this.lifecycleEpoch || !this.suspended)) {
          this.state.windows.resume();
        }
      } finally {
        // Window suspension destroys every registered surface even when one
        // surface reports a disposal failure. Never retain stale driver slots.
        this.drivers.clear();
      }
    }
  }

  resume(): void {
    if (this.disposed) throw new Error('computer-use runtime is disposed');
    this.lifecycleEpoch += 1;
    // Supersede an in-flight suspend immediately, but do not reopen admission
    // until the shared profile has actually resumed successfully.
    this.state?.windows.resume();
    this.suspended = false;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.disposePromise = this.disposeResources();
    return this.disposePromise;
  }

  private async disposeResources(): Promise<void> {
    this.cancelCoordinatorAll();
    const releaseResults = await this.releaseAllApprovalsSettled();
    const state =
      this.state ??
      (await this.stateOpening?.catch((error: unknown) => {
        this.report(error);
        return null;
      }));
    this.stateOpening = null;
    const openingResults = await Promise.allSettled([...this.driverOpenings.values()]);
    const results = [
      ...releaseResults,
      ...openingResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected' && !isDriverCreationCancellation(result.reason),
      ),
      ...(await Promise.allSettled([
        ...[...this.drivers.values()].map((driver) => driver.dispose()),
      ])),
    ];
    this.driverOpenings.clear();
    this.drivers.clear();
    this.approvalBindings.clear();
    state?.followThrough.clear();
    if (state) {
      results.push(...(await disposeStateResources(state.windows, state.profile)));
    }
    for (const result of results) {
      if (result.status === 'rejected') this.report(result.reason);
    }
  }

  private async createDriver(helperBuddyId: string): Promise<ComputerDriver & GateDriverPort> {
    assertCanonicalHelperBuddyId(helperBuddyId);
    const cancellationEpoch = this.helperBuddyCancellationEpochs.get(helperBuddyId) ?? 0;
    const lifecycleEpoch = this.lifecycleEpoch;
    if (this.disposed) throw new Error('computer-use runtime is disposed');
    if (this.suspended) throw new Error('computer-use runtime is suspended');
    if (this.drivers.has(helperBuddyId) || this.driverOpenings.has(helperBuddyId)) {
      throw new Error(`computer-use driver already exists for helper buddy: ${helperBuddyId}`);
    }
    const opening = this.openDriver(helperBuddyId, cancellationEpoch, lifecycleEpoch).finally(
      () => {
        if (this.driverOpenings.get(helperBuddyId) === opening) {
          this.driverOpenings.delete(helperBuddyId);
        }
      },
    );
    this.driverOpenings.set(helperBuddyId, opening);
    return opening;
  }

  private async openDriver(
    helperBuddyId: string,
    cancellationEpoch: number,
    lifecycleEpoch: number,
  ): Promise<ComputerDriver & GateDriverPort> {
    let state: RuntimeState;
    try {
      state = await this.ensureState();
    } catch (error) {
      if (
        this.disposed ||
        this.suspended ||
        this.lifecycleEpoch !== lifecycleEpoch ||
        (this.helperBuddyCancellationEpochs.get(helperBuddyId) ?? 0) !== cancellationEpoch
      ) {
        throw new DriverCreationCancelledError();
      }
      throw error;
    }
    this.assertDriverCreationCurrent(helperBuddyId, cancellationEpoch, lifecycleEpoch);
    const raw = this.options.createOffscreenDriver
      ? await this.options.createOffscreenDriver(state.profile)
      : await defaultOffscreenDriver(state.profile);
    try {
      this.assertDriverCreationCurrent(helperBuddyId, cancellationEpoch, lifecycleEpoch);
    } catch (error) {
      return disposeAndRethrow(raw, asError(error));
    }
    let registered: OffscreenBrowserDriver;
    try {
      registered = state.windows.registerOffscreenDriver(helperBuddyId, raw);
    } catch (error) {
      return disposeAndRethrow(raw, asError(error));
    }
    const driverRegistry = this.drivers;
    const publishPreview = (capture: CaptureResult | null): void => {
      try {
        this.options.onBrowserPreviewChanged?.({ helperBuddyId, capture });
      } catch (error) {
        this.report(error);
      }
    };
    let previewOpen = false;
    let previewClosed = false;
    let disposal: Promise<void> | null = null;
    const managed = new Proxy(registered, {
      get(target, property) {
        if (property === 'capture') {
          return async (): Promise<CaptureResult[]> => {
            const captures = await target.capture();
            if (previewClosed || driverRegistry.get(helperBuddyId) !== managed) return captures;
            const capture = captures.length === 1 ? captures[0] : undefined;
            if (capture) {
              previewOpen = true;
              publishPreview(capture);
            }
            return captures;
          };
        }
        if (property === 'dispose') {
          return (): Promise<void> => {
            if (disposal) return disposal;
            previewClosed = true;
            if (previewOpen) {
              previewOpen = false;
              publishPreview(null);
            }
            disposal = Promise.resolve(target.dispose()).then(
              () => {
                if (driverRegistry.get(helperBuddyId) === managed) {
                  driverRegistry.delete(helperBuddyId);
                }
              },
              (error: unknown) => {
                // The window-service adapter unregisters only after successful
                // disposal, so a failed release remains safe to retry.
                disposal = null;
                throw error;
              },
            );
            return disposal;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as OffscreenBrowserDriver;
    this.drivers.set(helperBuddyId, managed);
    return managed;
  }

  private assertDriverCreationCurrent(
    helperBuddyId: string,
    cancellationEpoch: number,
    lifecycleEpoch: number,
  ): void {
    if (
      this.disposed ||
      this.suspended ||
      this.lifecycleEpoch !== lifecycleEpoch ||
      (this.helperBuddyCancellationEpochs.get(helperBuddyId) ?? 0) !== cancellationEpoch
    ) {
      throw new DriverCreationCancelledError();
    }
  }

  private async requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<HelperBuddyApprovalResolution> {
    assertCanonicalHelperBuddyId(request.helperBuddyId);
    // A cancelled request has no authority to initialize the persistent
    // browser profile or window service.
    if (signal.aborted) {
      return this.wrapResolution(await this.coordinator.request(request, signal), request);
    }
    const admissionEpoch = this.lifecycleEpoch;
    const state = await this.ensureState();
    // Initialization may outlive either the run or a suspension boundary.
    // A resume deliberately cannot revive approval work admitted before the
    // corresponding suspend, even though the caller's signal remains live.
    if (signal.aborted || this.suspended || this.lifecycleEpoch !== admissionEpoch) {
      return this.cancelledApprovalResolution(request, signal);
    }
    // A rejected downstream acknowledgment leaves the same immutable request
    // pending for retry. Reuse its existing takeover binding; rebinding would
    // either fail in production or detach the runtime from the visible surface.
    if (this.coordinator.get(request.approvalId)) {
      return this.wrapResolution(await this.coordinator.request(request, signal), request);
    }
    let binding: ApprovalBinding | null = null;
    if (request.allowTakeover) {
      const release = state.windows.bindApproval(request.helperBuddyId, request.approvalId);
      binding = { helperBuddyId: request.helperBuddyId, release, releasing: null };
      this.approvalBindings.set(request.approvalId, binding);
    }
    try {
      return this.wrapResolution(await this.coordinator.request(request, signal), request);
    } catch (error) {
      if (binding) await this.releaseApproval(request.approvalId, binding);
      throw error;
    }
  }

  private async cancelledApprovalResolution(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<HelperBuddyApprovalResolution> {
    const cancelledSignal = signal.aborted ? signal : AbortSignal.abort();
    return this.wrapResolution(await this.coordinator.request(request, cancelledSignal), request);
  }

  private wrapResolution(
    resolution: HelperBuddyApprovalResolution,
    request: ApprovalRequest,
  ): HelperBuddyApprovalResolution {
    return {
      verdict: resolution.verdict,
      acknowledge: () => resolution.acknowledge(),
      reject: (error) => resolution.reject(error),
      replace: (next) => this.replaceApprovalResolution(resolution, request, next),
    };
  }

  private async replaceApprovalResolution(
    resolution: HelperBuddyApprovalResolution,
    current: ApprovalRequest,
    next: ApprovalRequest,
  ): Promise<HelperBuddyApprovalResolution> {
    if (next.helperBuddyId !== current.helperBuddyId) {
      throw new Error('replacement approval must belong to the same helper buddy');
    }
    const state = await this.ensureState();
    let binding: ApprovalBinding | null = null;
    if (next.allowTakeover) {
      const release = state.windows.bindApproval(next.helperBuddyId, next.approvalId);
      binding = { helperBuddyId: next.helperBuddyId, release, releasing: null };
      this.approvalBindings.set(next.approvalId, binding);
    }
    try {
      const replaced = await resolution.replace(next);
      return this.wrapResolution(replaced, next);
    } catch (error) {
      if (binding) await this.releaseApproval(next.approvalId, binding);
      throw error;
    }
  }

  private async deliverApproval(
    helperBuddyId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void> {
    const request = this.requireApproval(helperBuddyId, approvalId);
    if (verdict === 'always' && !request.allowAlways) {
      throw new Error('approval does not allow a standing grant');
    }
    const isLive = request.kind === 'live-action';
    try {
      if (isLive) await this.options.beforeLiveApprovalResolution?.(request);
      await this.coordinator.resolve(approvalId, verdict);
    } catch (error) {
      const failure = asError(error);
      if (isLive) {
        try {
          await this.options.onLiveApprovalResolutionFailed?.(request, failure);
        } catch (restoreError) {
          this.report(restoreError);
        }
      }
      throw failure;
    }
  }

  private async resolveThroughController(
    state: RuntimeState,
    helperBuddyId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void> {
    assertApprovalVerdict(verdict);
    const request = this.requireApproval(helperBuddyId, approvalId);
    if (!request.allowTakeover) {
      await this.deliverApproval(helperBuddyId, approvalId, verdict);
      return;
    }
    if (this.controllerOwnedReleases.has(approvalId)) {
      throw new Error(`approval ${approvalId} is already resolving through the window controller`);
    }
    this.controllerOwnedReleases.add(approvalId);
    try {
      await state.ipc.resolveApproval(helperBuddyId, approvalId, verdict);
    } finally {
      this.controllerOwnedReleases.delete(approvalId);
      const binding = this.approvalBindings.get(approvalId);
      if (binding && this.coordinator.get(approvalId) === null) {
        await this.releaseApproval(approvalId, binding);
      }
    }
  }

  private async handleTakeoverDone(helperBuddyId: string, approvalId: string): Promise<void> {
    const request = this.requireApproval(helperBuddyId, approvalId);
    if (this.controllerOwnedReleases.has(approvalId)) {
      throw new Error(`approval ${approvalId} is already resolving through the window controller`);
    }
    this.controllerOwnedReleases.add(approvalId);
    try {
      await this.options.onTakeoverWindowHidden?.(request);
      await this.coordinator.resolve(approvalId, 'handled');
    } finally {
      this.controllerOwnedReleases.delete(approvalId);
      const binding = this.approvalBindings.get(approvalId);
      if (binding && this.coordinator.get(approvalId) === null) {
        await this.releaseApproval(approvalId, binding);
      }
    }
  }

  private requireApproval(helperBuddyId: string, approvalId: string): ApprovalRequest {
    assertCanonicalHelperBuddyId(helperBuddyId);
    assertId(approvalId, 'approval');
    const request = this.coordinator.get(approvalId);
    if (!request || request.helperBuddyId !== helperBuddyId) {
      throw new Error(`stale or mismatched computer-use approval: ${approvalId}`);
    }
    return request;
  }

  private releaseApproval(approvalId: string, expected: ApprovalBinding): Promise<void> {
    if (expected.releasing) return expected.releasing;
    expected.releasing = expected.release().then(
      () => {
        if (this.approvalBindings.get(approvalId) === expected) {
          this.approvalBindings.delete(approvalId);
        }
      },
      (error: unknown) => {
        expected.releasing = null;
        throw error;
      },
    );
    return expected.releasing;
  }

  /**
   * Approval publication is the source of truth for takeover bindings. This
   * closes both removal paths that do not flow through the IPC controller:
   * signal cancellation and atomic fresh-evidence replacement.
   */
  private releaseBindingsMissingFrom(requests: readonly ApprovalRequest[]): void {
    const pendingIds = new Set(requests.map((request) => request.approvalId));
    for (const [approvalId, binding] of this.approvalBindings) {
      if (pendingIds.has(approvalId) || this.controllerOwnedReleases.has(approvalId)) continue;
      void this.releaseApproval(approvalId, binding).catch((error: unknown) => this.report(error));
    }
  }

  private async signOutSite(state: RuntimeState, domain: string): Promise<void> {
    // Conservatively stop every browser run. Shared cookies mean another page
    // can hold or rewrite credentials for the domain being cleared.
    await this.cancelAllBrowserHelpers();
    await state.ipc.signOutSite(domain);
  }

  private async clearAll(state: RuntimeState): Promise<void> {
    await this.cancelAllBrowserHelpers();
    this.cancelCoordinatorAll();
    await state.ipc.clearAll();
    state.followThrough.clear();
    state.grants.clear();
  }

  private async cancelAllBrowserHelpers(): Promise<void> {
    const ids = new Set([
      ...this.drivers.keys(),
      ...this.driverOpenings.keys(),
      ...this.coordinator.list().map((request) => request.helperBuddyId),
    ]);
    const openings = [...this.driverOpenings.values()];
    await Promise.all([...ids].map((helperBuddyId) => this.cancelHelperBuddy(helperBuddyId)));
    // Shared-profile mutations must not overtake a driver that was already
    // admitted and is still being created. Cancellation invalidates each
    // opening; joining here proves its raw surface has been disposed before
    // cookies, storage, or the profile are mutated.
    await Promise.all(
      openings.map((opening) =>
        opening.then(
          (driver) => driver.dispose(),
          (error: unknown) => {
            if (!isDriverCreationCancellation(error)) throw error;
          },
        ),
      ),
    );
  }

  private async releaseAllApprovals(): Promise<void> {
    await Promise.all(
      [...this.approvalBindings.entries()].map(([approvalId, binding]) =>
        this.releaseApproval(approvalId, binding),
      ),
    );
  }

  private releaseAllApprovalsSettled(): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      [...this.approvalBindings.entries()].map(([approvalId, binding]) =>
        this.releaseApproval(approvalId, binding),
      ),
    );
  }

  private async releaseHelperBuddyApprovals(helperBuddyId: string): Promise<void> {
    await Promise.all(
      [...this.approvalBindings.entries()]
        .filter(([, binding]) => binding.helperBuddyId === helperBuddyId)
        .map(([approvalId, binding]) => this.releaseApproval(approvalId, binding)),
    );
  }

  private async withState<T>(run: (state: RuntimeState) => T | Promise<T>): Promise<T> {
    return run(await this.ensureState());
  }

  private cancelCoordinatorHelperBuddy(helperBuddyId: string): void {
    try {
      this.coordinator.cancelHelperBuddy(helperBuddyId);
    } catch (error) {
      this.report(error);
    }
  }

  private cancelCoordinatorAll(): void {
    try {
      this.coordinator.cancelAll();
    } catch (error) {
      this.report(error);
    }
  }

  private async ensureState(): Promise<RuntimeState> {
    if (this.disposed) throw new Error('computer-use runtime is disposed');
    if (this.state) return this.state;
    if (this.stateOpening) return this.stateOpening;
    const opening = this.openState();
    this.stateOpening = opening;
    try {
      const state = await opening;
      if (this.disposed) {
        const results = await disposeStateResources(state.windows, state.profile);
        for (const result of results) {
          if (result.status === 'rejected') this.report(result.reason);
        }
        throw new Error('computer-use runtime was disposed during initialization');
      }
      this.state = state;
      return state;
    } finally {
      if (this.stateOpening === opening) this.stateOpening = null;
    }
  }

  private async openState(): Promise<RuntimeState> {
    await this.options.whenAppReady();
    if (this.disposed) throw new Error('computer-use runtime is disposed');
    const profile = this.options.createProfile
      ? await this.options.createProfile()
      : await defaultProfile();
    let windows: BuddyBrowserWindowService | null = null;
    try {
      if (this.disposed) {
        throw new Error('computer-use runtime was disposed during profile initialization');
      }
      const grants = new ApprovalGrantStore({
        persistence: createApprovalGrantFilePersistence(
          join(this.options.userDataPath(), GRANTS_FILE),
        ),
        onPersistenceError: (error) => this.report(error),
      });
      const followThrough = new ApprovalFollowThroughTracker();
      const reviewer: ActionReviewer = {
        review: async (evidence) => {
          const auth = await this.resolveReviewerAuth();
          const instance = this.options.createReviewer?.(auth) ?? new CodexActionReviewer({ auth });
          return instance.review(evidence);
        },
      };
      const base = new ActionGate<void>({
        reviewer,
        journal: this.options.journal,
        grantStore: grants,
        followThrough,
        onApprovalMemoryError: (error) => this.report(error),
      });
      const callbacks = {
        ...(this.options.onEnrollmentClosed
          ? { onEnrollmentClosed: this.options.onEnrollmentClosed }
          : {}),
        onTakeoverDone: (helperBuddyId: string, approvalId: string) =>
          this.handleTakeoverDone(helperBuddyId, approvalId),
        onTakeoverClosed: (helperBuddyId: string, approvalId: string) =>
          this.handleTakeoverDone(helperBuddyId, approvalId).catch((error: unknown) => {
            this.report(error);
          }),
        onBackgroundError: (error: Error) => this.report(error),
      };
      windows = this.options.createWindowService
        ? await this.options.createWindowService(profile, callbacks)
        : await defaultWindowService(profile, callbacks);
      if (this.disposed) {
        throw new Error('computer-use runtime was disposed during window initialization');
      }
      const operations: ApprovalOperations = {
        resolve: (helperBuddyId, approvalId, verdict) =>
          this.deliverApproval(helperBuddyId, approvalId, verdict),
        listApprovals: () => this.coordinator.list(),
        listGrants: () => grants.list(),
        revokeGrant: (id) => {
          assertId(id, 'grant');
          if (!grants.revoke(id)) throw new Error(`unknown approval grant: ${id}`);
        },
      };
      const ipc = await defaultIpcController(windows, operations);
      if (this.suspended) {
        await windows.suspend();
        // Resume can arrive while a lazily-created window service is still
        // destroying its surfaces. At that point `this.state` is not yet
        // published, so `resume()` cannot reach the service itself. Reconcile
        // the final lifecycle state here before making it reusable.
        if (!this.disposed && !this.suspended) windows.resume();
      }
      return { profile, windows, grants, followThrough, gate: base, ipc };
    } catch (error) {
      const results = windows
        ? await disposeStateResources(windows, profile)
        : await Promise.allSettled([profile.dispose()]);
      for (const result of results) {
        if (result.status === 'rejected') this.report(result.reason);
      }
      throw error;
    }
  }

  private async resolveReviewerAuth(): Promise<ChatGptCodexAuthSource> {
    try {
      const provider = this.options.codexProvider();
      const bearer = await provider.getBearer();
      const info = provider.getCodexAuth();
      if (!info || !bearer) throw new Error('codex sub not signed in');
      return {
        kind: 'chatgptCodex',
        getBearer: async () => bearer,
        accountId: info.accountId,
        planType: info.planType,
      };
    } catch (error) {
      const failure = asError(error);
      return {
        kind: 'chatgptCodex',
        getBearer: async () => Promise.reject(failure),
        accountId: '',
        planType: '',
      };
    }
  }

  private report(error: unknown): void {
    this.options.onError(asError(error));
  }

  private reportRejected(results: readonly PromiseSettledResult<unknown>[]): void {
    for (const result of results) {
      if (result.status === 'rejected') this.report(result.reason);
    }
  }
}

async function defaultProfile(): Promise<BuddyBrowserProfile> {
  const { getBuddyBrowserProfile } = await import('../computer/browser-profile');
  return getBuddyBrowserProfile();
}

async function defaultWindowService(
  profile: BuddyBrowserProfile,
  callbacks: {
    onEnrollmentClosed?: () => void | Promise<void>;
    onTakeoverDone(helperBuddyId: string, approvalId: string): void | Promise<void>;
    onTakeoverClosed(helperBuddyId: string, approvalId: string): void | Promise<void>;
    onBackgroundError(error: Error): void;
  },
): Promise<BuddyBrowserWindowService> {
  const { BuddyBrowserWindowService } = await import('../windows/buddy-browser');
  return new BuddyBrowserWindowService({ profile, ...callbacks });
}

async function defaultIpcController(
  windows: BuddyBrowserWindowService,
  approvals: ApprovalOperations,
): Promise<BuddyBrowserIpcController> {
  const { BuddyBrowserIpcController } = await import('../windows/buddy-browser');
  return new BuddyBrowserIpcController(windows, approvals);
}

async function defaultOffscreenDriver(
  profile: BuddyBrowserProfile,
): Promise<OffscreenBrowserDriver> {
  const { OffscreenBrowserDriver } = await import('../computer/browser-driver');
  return new OffscreenBrowserDriver({ profile });
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error(`invalid ${label} id`);
  }
}

function assertCanonicalHelperBuddyId(value: string): void {
  requireCanonicalHelperBuddyId(value);
}

function assertApprovalVerdict(value: unknown): asserts value is 'once' | 'always' | 'deny' {
  if (value !== 'once' && value !== 'always' && value !== 'deny') {
    throw new Error('invalid approval verdict');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class DriverCreationCancelledError extends Error {
  constructor() {
    super('computer-use driver creation was cancelled');
  }
}

function isDriverCreationCancellation(error: unknown): boolean {
  return error instanceof DriverCreationCancelledError;
}

async function disposeAndRethrow(driver: ComputerDriver, failure: Error): Promise<never> {
  try {
    await driver.dispose();
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, asError(cleanupError)],
      `${failure.message}; browser driver cleanup also failed`,
      { cause: cleanupError },
    );
  }
  throw failure;
}

async function disposeStateResources(
  windows: BuddyBrowserWindowService,
  profile: BuddyBrowserProfile,
): Promise<PromiseSettledResult<void>[]> {
  // Browser surfaces may still be using the profile. Dispose them completely
  // before closing the shared session/proxy owned by the profile.
  const windowResults = await Promise.allSettled([windows.dispose()]);
  const profileResults = await Promise.allSettled([profile.dispose()]);
  return [...windowResults, ...profileResults];
}
