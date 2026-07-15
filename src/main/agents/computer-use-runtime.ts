import { join } from 'node:path';
import type { ApprovalGrant, ApprovalRequest, EnrolledSite } from '../../shared/types';
import type { ChatGptCodexAuthSource, CodexProvider } from '../auth/auth-source';
import type { ComputerDriver } from '../computer/driver';
import type { OffscreenBrowserDriver } from '../computer/browser-driver';
import type { BuddyBrowserProfile } from '../computer/browser-profile';
import type {
  ApprovalOperations,
  BuddyBrowserIpcController,
  BuddyBrowserWindowService,
} from '../windows/buddy-browser';
import { AgentApprovalCoordinator } from './approvals';
import { ActionGate, type ActionGateJournalPort, type GateDriverPort } from './gate/action-gate';
import {
  ApprovalFollowThroughTracker,
  ApprovalGrantStore,
  createApprovalGrantFilePersistence,
} from './gate/grants';
import { CodexActionReviewer, type ActionReviewer } from './gate/reviewer';
import type {
  AgentActionGatePort,
  AgentApprovalPort,
  AgentApprovalResolution,
  AgentBrowserDeps,
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
  journal: ActionGateJournalPort;
  /** Lifecycle/callback failures are never discarded into an empty catch. */
  onError(error: Error): void;
  onEnrollmentClosed?(): void | Promise<void>;
  /** Restore Settings/approval UI immediately after the takeover surface is hidden. */
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
      onTakeoverDone(agentId: string, approvalId: string): void | Promise<void>;
      onTakeoverClosed(agentId: string, approvalId: string): void | Promise<void>;
      onBackgroundError(error: Error): void;
    },
  ): BuddyBrowserWindowService | Promise<BuddyBrowserWindowService>;
  createOffscreenDriver?(profile: BuddyBrowserProfile): OffscreenBrowserDriver;
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
  agentId: string;
  release: () => Promise<void>;
  releasing: Promise<void> | null;
}

export interface ComputerUseController {
  resolveApproval(
    agentId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void>;
  showApprovalWindow(agentId: string, approvalId: string): Promise<void>;
  hideApprovalWindow(agentId: string, approvalId: string): Promise<void>;
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
 * service. Browser-enabled AgentManager runs receive `browser`; foreground
 * ComputerUseRunner receives the same `gate` and `approvals` ports.
 */
export class ComputerUseRuntime {
  readonly browser: AgentBrowserDeps;
  readonly gate: AgentActionGatePort;
  readonly approvals: AgentApprovalPort;
  readonly controller: ComputerUseController;

  private readonly coordinator: AgentApprovalCoordinator;
  private readonly approvalBindings = new Map<string, ApprovalBinding>();
  private readonly drivers = new Map<string, ComputerDriver>();
  private state: RuntimeState | null = null;
  private stateOpening: Promise<RuntimeState> | null = null;
  private disposed = false;
  private suspended = false;
  private lifecycleEpoch = 0;

  constructor(private readonly options: ComputerUseRuntimeOptions) {
    this.coordinator = new AgentApprovalCoordinator({
      onChanged: (requests) => options.onApprovalsChanged(requests),
    });

    this.gate = {
      execute: (input, dispatch) => this.withState((state) => state.gate.execute(input, dispatch)),
      resolveEscalation: (approvalId, verdict) =>
        this.withState((state) => state.gate.resolveEscalation(approvalId, verdict)),
      cancelAgent: (agentId) => this.state?.gate.cancelAgent(agentId),
    };

    this.approvals = {
      request: (request, signal) => this.requestApproval(request, signal),
      cancelAgent: (agentId) => {
        this.coordinator.cancelAgent(agentId);
        void this.releaseAgentApprovals(agentId).catch((error: unknown) => this.report(error));
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
      createDriver: (agentId) => this.createDriver(agentId),
      gate: this.gate,
      approvals: this.approvals,
    };

    this.controller = {
      resolveApproval: (agentId, approvalId, verdict) =>
        this.withState((state) =>
          this.resolveThroughController(state, agentId, approvalId, verdict),
        ),
      showApprovalWindow: (agentId, approvalId) =>
        this.withState((state) => state.ipc.showApprovalWindow(agentId, approvalId)),
      hideApprovalWindow: (agentId, approvalId) =>
        this.withState((state) => state.ipc.hideApprovalWindow(agentId, approvalId)),
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
  async cancelAgent(agentId: string): Promise<void> {
    this.coordinator.cancelAgent(agentId);
    const state = this.state;
    state?.gate.cancelAgent(agentId);
    state?.followThrough.deactivate(agentId);
    const driver = this.drivers.get(agentId);
    const releases = [...this.approvalBindings.entries()]
      .filter(([, binding]) => binding.agentId === agentId)
      .map(([approvalId, binding]) => this.releaseApproval(approvalId, binding));
    await Promise.all([...(driver ? [driver.dispose()] : []), ...releases]);
  }

  async cancelAll(): Promise<void> {
    await this.cancelAllBrowserAgents();
    this.coordinator.cancelAll();
    this.state?.followThrough.clear();
  }

  /** Lock/suspend is destructive: no authenticated page or parked action survives it. */
  async suspend(): Promise<void> {
    if (this.disposed) return;
    const epoch = (this.lifecycleEpoch += 1);
    this.suspended = true;
    const agentIds = new Set([
      ...this.drivers.keys(),
      ...this.coordinator.list().map((request) => request.agentId),
    ]);
    await Promise.all([...agentIds].map((agentId) => this.cancelAgent(agentId)));
    if (this.disposed || epoch !== this.lifecycleEpoch || !this.suspended) return;
    this.coordinator.cancelAll();
    await this.releaseAllApprovals();
    if (this.state) {
      this.state.followThrough.clear();
      await this.state.windows.suspend();
      // A resume can land while surface disposal is in flight. Restore the
      // profile if this transition was superseded before it completed.
      if (!this.disposed && (epoch !== this.lifecycleEpoch || !this.suspended)) {
        this.state.windows.resume();
      }
    }
    this.drivers.clear();
  }

  resume(): void {
    if (this.disposed) throw new Error('computer-use runtime is disposed');
    this.lifecycleEpoch += 1;
    this.suspended = false;
    this.state?.windows.resume();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleEpoch += 1;
    this.coordinator.cancelAll();
    await this.releaseAllApprovals();
    const state =
      this.state ??
      (await this.stateOpening?.catch((error: unknown) => {
        this.report(error);
        return null;
      }));
    this.stateOpening = null;
    const results = await Promise.allSettled([
      ...[...this.drivers.values()].map((driver) => driver.dispose()),
    ]);
    this.drivers.clear();
    this.approvalBindings.clear();
    state?.followThrough.clear();
    if (state) {
      results.push(
        ...(await Promise.allSettled([state.windows.dispose(), state.profile.dispose()])),
      );
    }
    for (const result of results) {
      if (result.status === 'rejected') this.report(result.reason);
    }
  }

  private async createDriver(agentId: string): Promise<ComputerDriver & GateDriverPort> {
    assertId(agentId, 'agent');
    if (this.suspended) throw new Error('computer-use runtime is suspended');
    if (this.drivers.has(agentId)) {
      throw new Error(`computer-use driver already exists for agent: ${agentId}`);
    }
    const state = await this.ensureState();
    if (this.suspended) throw new Error('computer-use runtime is suspended');
    const raw = this.options.createOffscreenDriver
      ? this.options.createOffscreenDriver(state.profile)
      : await defaultOffscreenDriver(state.profile);
    let registered: OffscreenBrowserDriver;
    try {
      registered = state.windows.registerOffscreenDriver(agentId, raw);
    } catch (error) {
      await raw.dispose();
      throw error;
    }
    const driverRegistry = this.drivers;
    const managed = new Proxy(registered, {
      get(target, property) {
        if (property === 'dispose') {
          return async (): Promise<void> => {
            await target.dispose();
            if (driverRegistry.get(agentId) === managed) driverRegistry.delete(agentId);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as OffscreenBrowserDriver;
    this.drivers.set(agentId, managed);
    return managed;
  }

  private async requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal,
  ): Promise<AgentApprovalResolution> {
    const state = await this.ensureState();
    let binding: ApprovalBinding | null = null;
    if (request.allowTakeover) {
      const release = state.windows.bindApproval(request.agentId, request.approvalId);
      binding = { agentId: request.agentId, release, releasing: null };
      this.approvalBindings.set(request.approvalId, binding);
    }
    try {
      return this.wrapResolution(await this.coordinator.request(request, signal), request);
    } catch (error) {
      if (binding) await this.releaseApproval(request.approvalId, binding);
      throw error;
    }
  }

  private wrapResolution(
    resolution: AgentApprovalResolution,
    request: ApprovalRequest,
  ): AgentApprovalResolution {
    return {
      verdict: resolution.verdict,
      acknowledge: () => resolution.acknowledge(),
      reject: (error) => resolution.reject(error),
      replace: (next) => this.replaceApprovalResolution(resolution, request, next),
    };
  }

  private async replaceApprovalResolution(
    resolution: AgentApprovalResolution,
    current: ApprovalRequest,
    next: ApprovalRequest,
  ): Promise<AgentApprovalResolution> {
    if (next.agentId !== current.agentId) {
      throw new Error('replacement approval must belong to the same agent');
    }
    const state = await this.ensureState();
    let binding: ApprovalBinding | null = null;
    if (next.allowTakeover) {
      const release = state.windows.bindApproval(next.agentId, next.approvalId);
      binding = { agentId: next.agentId, release, releasing: null };
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
    agentId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void> {
    const request = this.requireApproval(agentId, approvalId);
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
    agentId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void> {
    assertApprovalVerdict(verdict);
    const request = this.requireApproval(agentId, approvalId);
    if (!request.allowTakeover) {
      await this.deliverApproval(agentId, approvalId, verdict);
      return;
    }
    await state.ipc.resolveApproval(agentId, approvalId, verdict);
    const binding = this.approvalBindings.get(approvalId);
    if (binding) await this.releaseApproval(approvalId, binding);
  }

  private async handleTakeoverDone(agentId: string, approvalId: string): Promise<void> {
    const request = this.requireApproval(agentId, approvalId);
    await this.options.onTakeoverWindowHidden?.(request);
    await this.coordinator.resolve(approvalId, 'handled');
    const binding = this.approvalBindings.get(approvalId);
    if (binding) await this.releaseApproval(approvalId, binding);
  }

  private requireApproval(agentId: string, approvalId: string): ApprovalRequest {
    assertId(agentId, 'agent');
    assertId(approvalId, 'approval');
    const request = this.coordinator.get(approvalId);
    if (!request || request.agentId !== agentId) {
      throw new Error(`stale or mismatched computer-use approval: ${approvalId}`);
    }
    return request;
  }

  private releaseApproval(approvalId: string, expected: ApprovalBinding): Promise<void> {
    if (expected.releasing) return expected.releasing;
    expected.releasing = expected.release().finally(() => {
      if (this.approvalBindings.get(approvalId) === expected) {
        this.approvalBindings.delete(approvalId);
      }
    });
    return expected.releasing;
  }

  private async signOutSite(state: RuntimeState, domain: string): Promise<void> {
    // Conservatively stop every browser run. Shared cookies mean another page
    // can hold or rewrite credentials for the domain being cleared.
    await this.cancelAllBrowserAgents();
    await state.ipc.signOutSite(domain);
  }

  private async clearAll(state: RuntimeState): Promise<void> {
    await this.cancelAllBrowserAgents();
    this.coordinator.cancelAll();
    await state.ipc.clearAll();
    state.followThrough.clear();
    state.grants.clear();
  }

  private async cancelAllBrowserAgents(): Promise<void> {
    const ids = new Set([
      ...this.drivers.keys(),
      ...this.coordinator.list().map((request) => request.agentId),
    ]);
    await Promise.all([...ids].map((agentId) => this.cancelAgent(agentId)));
  }

  private async releaseAllApprovals(): Promise<void> {
    await Promise.all(
      [...this.approvalBindings.entries()].map(([approvalId, binding]) =>
        this.releaseApproval(approvalId, binding),
      ),
    );
  }

  private async releaseAgentApprovals(agentId: string): Promise<void> {
    await Promise.all(
      [...this.approvalBindings.entries()]
        .filter(([, binding]) => binding.agentId === agentId)
        .map(([approvalId, binding]) => this.releaseApproval(approvalId, binding)),
    );
  }

  private async withState<T>(run: (state: RuntimeState) => T | Promise<T>): Promise<T> {
    return run(await this.ensureState());
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
        const results = await Promise.allSettled([
          state.windows.dispose(),
          state.profile.dispose(),
        ]);
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
        onTakeoverDone: (agentId: string, approvalId: string) =>
          this.handleTakeoverDone(agentId, approvalId),
        onTakeoverClosed: (agentId: string, approvalId: string) =>
          this.handleTakeoverDone(agentId, approvalId).catch((error: unknown) => {
            this.report(error);
          }),
        onBackgroundError: (error: Error) => this.report(error),
      };
      windows = this.options.createWindowService
        ? await this.options.createWindowService(profile, callbacks)
        : await defaultWindowService(profile, callbacks);
      const operations: ApprovalOperations = {
        resolve: (agentId, approvalId, verdict) =>
          this.deliverApproval(agentId, approvalId, verdict),
        listApprovals: () => this.coordinator.list(),
        listGrants: () => grants.list(),
        revokeGrant: (id) => {
          assertId(id, 'grant');
          if (!grants.revoke(id)) throw new Error(`unknown approval grant: ${id}`);
        },
      };
      const ipc = await defaultIpcController(windows, operations);
      if (this.suspended) await windows.suspend();
      return { profile, windows, grants, followThrough, gate: base, ipc };
    } catch (error) {
      const results = await Promise.allSettled([
        ...(windows ? [windows.dispose()] : []),
        profile.dispose(),
      ]);
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
}

async function defaultProfile(): Promise<BuddyBrowserProfile> {
  const { getBuddyBrowserProfile } = await import('../computer/browser-profile');
  return getBuddyBrowserProfile();
}

async function defaultWindowService(
  profile: BuddyBrowserProfile,
  callbacks: {
    onEnrollmentClosed?: () => void | Promise<void>;
    onTakeoverDone(agentId: string, approvalId: string): void | Promise<void>;
    onTakeoverClosed(agentId: string, approvalId: string): void | Promise<void>;
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
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error(`invalid ${label} id`);
  }
}

function assertApprovalVerdict(value: unknown): asserts value is 'once' | 'always' | 'deny' {
  if (value !== 'once' && value !== 'always' && value !== 'deny') {
    throw new Error('invalid approval verdict');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
