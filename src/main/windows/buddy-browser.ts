/**
 * Main-process lifecycle for the visible faces of the shared buddy browser.
 *
 * The browser profile and low-level offscreen window belong to
 * `computer/browser-profile.ts` and `OffscreenBrowserDriver`. This service
 * deliberately talks to drivers through a tiny lifecycle port: it owns
 * enrollment, stale-safe approval bindings, and destructive profile clears
 * without learning anything about CDP or browser actuation.
 */

import type { BrowserWindow } from 'electron';
import type { ApprovalGrant, ApprovalRequest, EnrolledSite } from '../../shared/types';
import type { OffscreenBrowserDriver } from '../computer/browser-driver';
import {
  getBuddyBrowserProfile,
  normalizeBrowserUrl,
  type BuddyBrowserProfile,
} from '../computer/browser-profile';

export type ApprovalResolution = 'once' | 'always' | 'deny';

/** The visible-takeover seam implemented by an agent's offscreen driver. */
export interface BuddyBrowserSurface {
  /** Show and invoke `onDone` if the user closes the visible window. */
  showForUser(onDone: () => void): void | Promise<void>;
  hideFromUser(): void | Promise<void>;
  /** Current page, used to stop a page before its site data is cleared. */
  currentUrl(): string;
  dispose(): void | Promise<void>;
}

/** The one naming adapter between window lifecycle and the CDP driver. */
function surfaceForOffscreenBrowser(driver: OffscreenBrowserDriver): BuddyBrowserSurface {
  return {
    showForUser: (onDone) => driver.showForTakeover(onDone),
    hideFromUser: () => driver.hideAfterTakeover(),
    currentUrl: () => driver.getCurrentUrl(),
    dispose: () => driver.dispose(),
  };
}

export interface BuddyBrowserWindowServiceOptions {
  profile?: BuddyBrowserProfile;
  /** Root uses this to restore Settings after the enrollment window closes. */
  onEnrollmentClosed?(): void | Promise<void>;
  /** Explicit Done path. Rejection must propagate to IPC so the card remains retryable. */
  onTakeoverDone?(agentId: string, approvalId: string): void | Promise<void>;
  /** OS-close path is fire-and-forget and reports failures without lying to a renderer. */
  onTakeoverClosed?(agentId: string, approvalId: string): void | Promise<void>;
  onBackgroundError?(error: Error): void;
}

interface RegisteredSurface {
  surface: BuddyBrowserSurface;
  approvalIds: Set<string>;
  visibleApprovalId: string | null;
}

interface ApprovalBinding {
  agentId: string;
  surface: RegisteredSurface;
  takeoverShown: boolean;
}

/**
 * Owns enrollment and visible-takeover lifecycle for the buddy browser.
 *
 * Approval windows are always resolved by the globally unique approval ID
 * first and only then checked against the supplied agent ID. A stale card can
 * therefore never reveal whatever browser happens to belong to that agent
 * now.
 */
export class BuddyBrowserWindowService {
  private readonly profile: BuddyBrowserProfile;
  private readonly onEnrollmentClosed: (() => void | Promise<void>) | undefined;
  private readonly onTakeoverDone:
    ((agentId: string, approvalId: string) => void | Promise<void>) | undefined;
  private readonly onTakeoverClosed:
    ((agentId: string, approvalId: string) => void | Promise<void>) | undefined;
  private readonly onBackgroundError: ((error: Error) => void) | undefined;
  private readonly surfaces = new Map<string, RegisteredSurface>();
  private readonly approvals = new Map<string, ApprovalBinding>();
  private enrollmentWindow: BrowserWindow | null = null;
  private enrollmentOpening: Promise<void> | null = null;
  private disposed = false;

  constructor(options: BuddyBrowserWindowServiceOptions = {}) {
    this.profile = options.profile ?? getBuddyBrowserProfile();
    this.onEnrollmentClosed = options.onEnrollmentClosed;
    this.onTakeoverDone = options.onTakeoverDone;
    this.onTakeoverClosed = options.onTakeoverClosed;
    this.onBackgroundError = options.onBackgroundError;
  }

  /**
   * Open a user-chosen http(s) URL in the persistent buddy profile.
   *
   * There is intentionally no default URL: Electron windows have no address
   * bar, so a blank/default-search implementation leaves enrollment ambiguous
   * and makes it too easy to sign into the wrong site.
   */
  async openEnrollment(url: string): Promise<void> {
    this.assertAlive();
    const normalizedUrl = normalizeBrowserUrl(url);
    if (this.enrollmentOpening) return this.enrollmentOpening;
    if (this.enrollmentWindow && !this.enrollmentWindow.isDestroyed()) {
      await this.enrollmentWindow.loadURL(normalizedUrl);
      this.enrollmentWindow.show();
      this.enrollmentWindow.focus();
      return;
    }

    this.enrollmentOpening = this.openNewEnrollmentWindow(normalizedUrl).finally(() => {
      this.enrollmentOpening = null;
    });
    return this.enrollmentOpening;
  }

  /** Register one active offscreen browser. Duplicate agent IDs fail fast. */
  registerSurface(agentId: string, surface: BuddyBrowserSurface): () => void {
    this.assertAlive();
    assertOpaqueId(agentId, 'agent');
    if (this.surfaces.has(agentId)) {
      throw new Error(`buddy browser surface already registered for agent: ${agentId}`);
    }
    const record: RegisteredSurface = {
      surface,
      approvalIds: new Set(),
      visibleApprovalId: null,
    };
    this.surfaces.set(agentId, record);
    return () => this.unregisterSurface(agentId, record);
  }

  /**
   * Production driver factory seam. The returned proxy preserves every
   * OffscreenBrowserDriver method (bound to the real instance) and unregisters
   * the lifecycle surface only after driver disposal succeeds.
   */
  registerOffscreenDriver(agentId: string, driver: OffscreenBrowserDriver): OffscreenBrowserDriver {
    const unregister = this.registerSurface(agentId, surfaceForOffscreenBrowser(driver));
    return new Proxy(driver, {
      get(target, property) {
        if (property === 'dispose') {
          return async (): Promise<void> => {
            await target.dispose();
            unregister();
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** Bind one concrete pending approval to the agent's current browser. */
  bindApproval(agentId: string, approvalId: string): () => Promise<void> {
    this.assertAlive();
    assertOpaqueId(agentId, 'agent');
    assertOpaqueId(approvalId, 'approval');
    if (this.approvals.has(approvalId)) {
      throw new Error(`buddy browser approval is already bound: ${approvalId}`);
    }
    const surface = this.surfaces.get(agentId);
    if (!surface) throw new Error(`no buddy browser surface for agent: ${agentId}`);
    surface.approvalIds.add(approvalId);
    this.approvals.set(approvalId, { agentId, surface, takeoverShown: false });
    return () => this.releaseApproval(agentId, approvalId);
  }

  async showApprovalWindow(agentId: string, approvalId: string): Promise<void> {
    const binding = this.requireApproval(agentId, approvalId);
    const visible = binding.surface.visibleApprovalId;
    if (visible !== null && visible !== approvalId) {
      throw new Error(`buddy browser is already visible for approval: ${visible}`);
    }
    await binding.surface.surface.showForUser(() => {
      void this.handleUserClosedTakeover(agentId, approvalId).catch((error: unknown) => {
        this.onBackgroundError?.(asError(error));
      });
    });
    binding.takeoverShown = true;
    binding.surface.visibleApprovalId = approvalId;
  }

  async hideApprovalWindow(agentId: string, approvalId: string): Promise<void> {
    const binding = this.requireApproval(agentId, approvalId);
    if (!binding.takeoverShown) {
      throw new Error(`buddy browser approval was never shown: ${approvalId}`);
    }
    const visible = binding.surface.visibleApprovalId;
    if (visible !== null && visible !== approvalId) {
      throw new Error(`buddy browser approval is not visible: ${approvalId}`);
    }
    if (visible === approvalId) {
      await binding.surface.surface.hideFromUser();
      binding.surface.visibleApprovalId = null;
    }
    await this.onTakeoverDone?.(agentId, approvalId);
  }

  /** Release a resolved/denied approval and ensure its window is hidden. */
  async completeApproval(agentId: string, approvalId: string): Promise<void> {
    const binding = this.requireApproval(agentId, approvalId);
    if (binding.surface.visibleApprovalId === approvalId) {
      await binding.surface.surface.hideFromUser();
      binding.surface.visibleApprovalId = null;
    }
    this.removeApproval(approvalId, binding);
  }

  /**
   * Freeze the exact surface before an approval can resume its parked agent.
   * The binding intentionally remains live until the approval write succeeds.
   */
  async freezeApproval(agentId: string, approvalId: string): Promise<void> {
    const binding = this.requireApproval(agentId, approvalId);
    if (binding.surface.visibleApprovalId === approvalId) {
      await binding.surface.surface.hideFromUser();
      binding.surface.visibleApprovalId = null;
    }
  }

  async listEnrolledSites(): Promise<EnrolledSite[]> {
    this.assertAlive();
    const sites = await this.profile.listEnrolledSites();
    const cookies = await this.profile.session.cookies.get({});
    const counts = new Map<string, number>();
    for (const cookie of cookies) {
      if (!cookie.domain) continue;
      const domain = normalizeCookieDomain(cookie.domain);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return sites.map((domain) => ({ domain, cookieCount: counts.get(domain) ?? 0 }));
  }

  async signOutSite(domain: string): Promise<void> {
    this.assertAlive();
    const normalized = normalizeRequestedDomain(domain);
    const enrolled = await this.profile.listEnrolledSites();
    if (!enrolled.includes(normalized)) {
      throw new Error(`buddy browser site is not enrolled: ${normalized}`);
    }
    await this.disposeSurfacesOnDomain(normalized);
    await this.profile.clearEnrolledSite(normalized);
  }

  /**
   * Destructive reset. Active drivers are disposed before storage is cleared
   * so a still-running page cannot immediately write profile state back.
   */
  async clearAll(): Promise<void> {
    this.assertAlive();
    await this.destroyAllWindows();
    await this.profile.clearAllData();
  }

  /** Machine lock/suspend seam: logged-in browser work is cancelled, not parked. */
  async suspend(): Promise<void> {
    this.assertAlive();
    this.profile.setSuspended(true);
    await this.destroyAllWindows();
  }

  /** Unlock/resume allows future explicit browser tasks; old tasks stay cancelled. */
  resume(): void {
    this.assertAlive();
    this.profile.setSuspended(false);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.destroyAllWindows();
  }

  private async openNewEnrollmentWindow(url: string): Promise<void> {
    const win = await this.profile.createEnrollmentWindow(url);
    if (this.disposed) {
      if (!win.isDestroyed()) win.destroy();
      throw new Error('buddy browser window service was disposed during enrollment');
    }
    this.enrollmentWindow = win;
    win.once('closed', () => {
      if (this.enrollmentWindow === win) this.enrollmentWindow = null;
      if (this.disposed || this.profile.isSuspended()) return;
      void Promise.resolve(this.onEnrollmentClosed?.()).catch((error: unknown) => {
        console.error('[buddy-browser] failed to restore settings after enrollment', error);
      });
    });
  }

  private requireApproval(agentId: string, approvalId: string): ApprovalBinding {
    this.assertAlive();
    assertOpaqueId(agentId, 'agent');
    assertOpaqueId(approvalId, 'approval');
    const binding = this.approvals.get(approvalId);
    if (!binding || binding.agentId !== agentId) {
      throw new Error(`stale or mismatched buddy browser approval: ${approvalId}`);
    }
    return binding;
  }

  private async handleUserClosedTakeover(agentId: string, approvalId: string): Promise<void> {
    const binding = this.approvals.get(approvalId);
    if (!binding || binding.agentId !== agentId) return;
    if (binding.surface.visibleApprovalId !== approvalId) return;
    await binding.surface.surface.hideFromUser();
    binding.surface.visibleApprovalId = null;
    await (this.onTakeoverClosed ?? this.onTakeoverDone)?.(agentId, approvalId);
  }

  private async releaseApproval(agentId: string, approvalId: string): Promise<void> {
    const binding = this.approvals.get(approvalId);
    if (!binding || binding.agentId !== agentId) return;
    if (binding.surface.visibleApprovalId === approvalId) {
      await binding.surface.surface.hideFromUser();
      binding.surface.visibleApprovalId = null;
    }
    this.removeApproval(approvalId, binding);
  }

  private removeApproval(approvalId: string, binding: ApprovalBinding): void {
    binding.surface.approvalIds.delete(approvalId);
    this.approvals.delete(approvalId);
  }

  private unregisterSurface(agentId: string, expected: RegisteredSurface): void {
    if (this.surfaces.get(agentId) !== expected) return;
    for (const approvalId of expected.approvalIds) this.approvals.delete(approvalId);
    expected.approvalIds.clear();
    this.surfaces.delete(agentId);
  }

  private async destroyAllWindows(): Promise<void> {
    const enrollment = this.enrollmentWindow;
    this.enrollmentWindow = null;
    if (enrollment && !enrollment.isDestroyed()) enrollment.destroy();

    const records = [...this.surfaces.values()];
    this.approvals.clear();
    this.surfaces.clear();
    for (const record of records) record.approvalIds.clear();
    const results = await Promise.allSettled(records.map((record) => record.surface.dispose()));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  private async disposeSurfacesOnDomain(domain: string): Promise<void> {
    const affected = [...this.surfaces.entries()].filter(([, record]) => {
      try {
        const hostname = new URL(record.surface.currentUrl()).hostname.toLowerCase();
        return hostname === domain || hostname.endsWith(`.${domain}`);
      } catch {
        // An unparseable current page is not safe to leave running across a
        // credential clear. Dispose it conservatively.
        return true;
      }
    });
    const results = await Promise.allSettled(
      affected.map(async ([agentId, record]) => {
        this.unregisterSurface(agentId, record);
        await record.surface.dispose();
      }),
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('buddy browser window service is disposed');
  }
}

export interface ApprovalOperations {
  resolve(agentId: string, approvalId: string, verdict: ApprovalResolution): void | Promise<void>;
  listApprovals(): ApprovalRequest[] | Promise<ApprovalRequest[]>;
  listGrants(): ApprovalGrant[] | Promise<ApprovalGrant[]>;
  revokeGrant(id: string): void | Promise<void>;
}

/** IPC-facing façade; index.ts owns the actual typed ipcMain.handle calls. */
export class BuddyBrowserIpcController {
  constructor(
    private readonly windows: BuddyBrowserWindowService,
    private readonly approvals: ApprovalOperations,
  ) {}

  async resolveApproval(
    agentId: string,
    approvalId: string,
    verdict: ApprovalResolution,
  ): Promise<void> {
    assertApprovalResolution(verdict);
    // Freeze first. Resolving the coordinator resumes the parked gate, so it
    // must never happen while the user can still operate the same surface.
    await this.windows.freezeApproval(agentId, approvalId);
    await this.approvals.resolve(agentId, approvalId, verdict);
    await this.windows.completeApproval(agentId, approvalId);
  }

  showApprovalWindow(agentId: string, approvalId: string): Promise<void> {
    return this.windows.showApprovalWindow(agentId, approvalId);
  }

  hideApprovalWindow(agentId: string, approvalId: string): Promise<void> {
    return this.windows.hideApprovalWindow(agentId, approvalId);
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return this.approvals.listApprovals();
  }

  async listGrants(): Promise<ApprovalGrant[]> {
    return this.approvals.listGrants();
  }

  async revokeGrant(id: string): Promise<void> {
    assertOpaqueId(id, 'grant');
    await this.approvals.revokeGrant(id);
  }

  openEnrollment(url: string): Promise<void> {
    return this.windows.openEnrollment(url);
  }

  listEnrolledSites(): Promise<EnrolledSite[]> {
    return this.windows.listEnrolledSites();
  }

  signOutSite(domain: string): Promise<void> {
    return this.windows.signOutSite(domain);
  }

  clearAll(): Promise<void> {
    return this.windows.clearAll();
  }
}

function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

function normalizeRequestedDomain(domain: string): string {
  if (typeof domain !== 'string') throw new Error('buddy browser domain must be a string');
  const normalized = normalizeCookieDomain(domain);
  if (
    normalized.length === 0 ||
    normalized.length > 253 ||
    normalized.includes('..') ||
    !normalized.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    throw new Error(`invalid buddy browser domain: ${domain}`);
  }
  return normalized;
}

function assertOpaqueId(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new Error(`invalid ${label} id`);
  }
}

function assertApprovalResolution(value: string): asserts value is ApprovalResolution {
  if (value !== 'once' && value !== 'always' && value !== 'deny') {
    throw new Error('invalid approval resolution');
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
