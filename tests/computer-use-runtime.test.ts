import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../src/shared/types';
import { ComputerUseRuntime } from '../src/main/agents/computer-use-runtime';
import type { ActionReviewer } from '../src/main/agents/gate/reviewer';
import type { CaptureResult } from '../src/main/capture';
import type { OffscreenBrowserDriver } from '../src/main/computer/browser-driver';
import type { BuddyBrowserProfile } from '../src/main/computer/browser-profile';
import type { BuddyBrowserWindowService } from '../src/main/windows/buddy-browser';

function capture(): CaptureResult {
  return {
    meta: {
      screenIndex: 0,
      displayId: -1,
      imageW: 100,
      imageH: 100,
      displayBounds: { x: 0, y: 0, width: 100, height: 100 },
      scaleFactor: 1,
      isActive: true,
    },
    jpegBase64: Buffer.from('browser capture').toString('base64'),
  };
}

function driverFixture(): OffscreenBrowserDriver {
  return {
    capture: vi.fn(async () => [capture()]),
    click: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    pressKeys: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    inspect: vi.fn(async () => null),
    inspectFocused: vi.fn(async () => null),
    readPendingPayload: vi.fn(async () => []),
    inspectDetailed: vi.fn(async () => ({
      facts: null,
      payloadFields: [],
      fingerprint: 'fixture',
      pageRevision: 1,
    })),
    dispose: vi.fn(async () => undefined),
  } as unknown as OffscreenBrowserDriver;
}

function windowFixture(sequence: string[] = []) {
  let onTakeoverDone: ((helperBuddyId: string, approvalId: string) => void | Promise<void>) | null =
    null;
  let onTakeoverClosed:
    ((helperBuddyId: string, approvalId: string) => void | Promise<void>) | null = null;
  const releases = new Map<string, () => Promise<void>>();
  const service = {
    registerOffscreenDriver: vi.fn(
      (_helperBuddyId: string, driver: OffscreenBrowserDriver) => driver,
    ),
    bindApproval: vi.fn((helperBuddyId: string, approvalId: string) => {
      const release = vi.fn(async () => {
        sequence.push(`release:${helperBuddyId}:${approvalId}`);
      });
      releases.set(approvalId, release);
      return release;
    }),
    showApprovalWindow: vi.fn(async () => undefined),
    freezeApproval: vi.fn(async (helperBuddyId: string, approvalId: string) => {
      sequence.push(`freeze:${helperBuddyId}:${approvalId}`);
    }),
    completeApproval: vi.fn(async (helperBuddyId: string, approvalId: string) => {
      sequence.push(`complete:${helperBuddyId}:${approvalId}`);
    }),
    hideApprovalWindow: vi.fn(async (helperBuddyId: string, approvalId: string) => {
      await onTakeoverDone?.(helperBuddyId, approvalId);
    }),
    openEnrollment: vi.fn(async () => undefined),
    listEnrolledSites: vi.fn(async () => []),
    signOutSite: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  return {
    service: service as unknown as BuddyBrowserWindowService,
    setCallbacks(callbacks: {
      onTakeoverDone(helperBuddyId: string, approvalId: string): void | Promise<void>;
      onTakeoverClosed(helperBuddyId: string, approvalId: string): void | Promise<void>;
    }) {
      onTakeoverDone = callbacks.onTakeoverDone;
      onTakeoverClosed = callbacks.onTakeoverClosed;
    },
    async triggerOsClose(helperBuddyId: string, approvalId: string): Promise<void> {
      await onTakeoverClosed?.(helperBuddyId, approvalId);
    },
    releases,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    helperBuddyId: 'helper-buddy-1',
    approvalId: 'approval-1',
    kind: 'browser-action',
    userRequest: 'publish the weekly report',
    allowAlways: true,
    grantScope: 'publish weekly report on example.com',
    allowTakeover: true,
    browserDomain: null,
    actionText: 'publish the report',
    concern: 'this changes shared data',
    screenshotPng: '',
    payloadDigest: [],
    ...overrides,
  };
}

function runtimeFixture(options: { sequence?: string[] } = {}) {
  const ready = vi.fn(async () => undefined);
  const profile = { dispose: vi.fn(async () => undefined) } as unknown as BuddyBrowserProfile;
  const windows = windowFixture(options.sequence);
  const drivers: OffscreenBrowserDriver[] = [];
  const queue: ApprovalRequest[][] = [];
  const errors: Error[] = [];
  const takeoverWindowHidden = vi.fn((request: ApprovalRequest) => {
    options.sequence?.push(`restore-takeover:${request.approvalId}`);
  });
  const liveResolutionFailed = vi.fn((request: ApprovalRequest, error: Error) => {
    options.sequence?.push(`restore:${request.approvalId}:${error.message}`);
  });
  const runtime = new ComputerUseRuntime({
    whenAppReady: ready,
    userDataPath: () => mkdtempSync(join(tmpdir(), 'buddy-runtime-')),
    codexProvider: () => ({
      getCodexAuth: () => ({
        accessToken: 'token',
        accountId: 'account',
        planType: 'plus',
        expiresAt: Date.now() + 60_000,
      }),
      getBearer: async () => 'token',
    }),
    onApprovalsChanged: (requests) => queue.push(requests),
    journal: {
      recordActionGateAssessment: vi.fn(),
      recordComputerActionOutcome: vi.fn(),
    },
    onError: (error) => errors.push(error),
    onTakeoverWindowHidden: takeoverWindowHidden,
    beforeLiveApprovalResolution: () => {
      options.sequence?.push('hide-buddy-surfaces');
    },
    onLiveApprovalResolutionFailed: liveResolutionFailed,
    createReviewer: () =>
      ({
        review: vi.fn(),
      }) as unknown as ActionReviewer,
    createProfile: () => profile,
    createWindowService: (_profile, callbacks) => {
      windows.setCallbacks(callbacks);
      return windows.service;
    },
    createOffscreenDriver: () => {
      const driver = driverFixture();
      drivers.push(driver);
      return driver;
    },
  });
  return {
    runtime,
    ready,
    profile,
    windows,
    drivers,
    queue,
    errors,
    liveResolutionFailed,
    takeoverWindowHidden,
  };
}

describe('ComputerUseRuntime composition', () => {
  it('does not create Electron/profile resources until the first operation reaches app-ready', async () => {
    const fixture = runtimeFixture();
    expect(fixture.ready).not.toHaveBeenCalled();

    const driver = await fixture.runtime.browser.createDriver('helper-buddy-1');

    expect(fixture.ready).toHaveBeenCalledOnce();
    expect(fixture.windows.service.registerOffscreenDriver).toHaveBeenCalledWith(
      'helper-buddy-1',
      expect.anything(),
    );
    expect(driver).toHaveProperty('inspectDetailed');
    await fixture.runtime.dispose();
  });

  it('publishes the full queue, binds takeover before publishing, and resolves OS-close as handled', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const signal = new AbortController().signal;
    const pending = fixture.runtime.approvals.request(approval(), signal);

    await vi.waitFor(() => expect(fixture.queue).toHaveLength(1));
    expect(fixture.windows.service.bindApproval).toHaveBeenCalledOnce();
    expect(fixture.queue[0]).toEqual([approval()]);

    await fixture.runtime.controller.showApprovalWindow('helper-buddy-1', 'approval-1');
    const hiding = fixture.runtime.controller.hideApprovalWindow('helper-buddy-1', 'approval-1');
    const resolution = await pending;
    expect(resolution.verdict).toBe('handled');
    resolution.acknowledge();
    await hiding;

    expect(fixture.queue.at(-1)).toEqual([]);
    expect(fixture.windows.releases.get('approval-1')).toHaveBeenCalledOnce();
    await fixture.runtime.dispose();
  });

  it('keeps explicit Done rejected and retryable when handled acknowledgment fails', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const signal = new AbortController().signal;
    const request = approval();
    const pending = fixture.runtime.approvals.request(request, signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toEqual([request]));
    await fixture.runtime.controller.showApprovalWindow('helper-buddy-1', 'approval-1');

    const firstDone = fixture.runtime.controller.hideApprovalWindow('helper-buddy-1', 'approval-1');
    const firstResolution = await pending;
    firstResolution.reject(new Error('fresh browser observation failed'));
    await expect(firstDone).rejects.toThrow('fresh browser observation failed');
    expect(fixture.runtime.controller.listApprovals()).toEqual([request]);
    expect(fixture.takeoverWindowHidden).toHaveBeenCalledWith(request);

    const retryPending = fixture.runtime.approvals.request(request, signal);
    const retryDone = fixture.runtime.controller.hideApprovalWindow('helper-buddy-1', 'approval-1');
    const retryResolution = await retryPending;
    expect(retryResolution.verdict).toBe('handled');
    retryResolution.acknowledge();
    await retryDone;

    expect(fixture.runtime.controller.listApprovals()).toEqual([]);
    expect(fixture.errors).toEqual([]);
    await fixture.runtime.dispose();
  });

  it('reports OS-close handled failures without creating an unhandled rejection', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const request = approval();
    const pending = fixture.runtime.approvals.request(request, new AbortController().signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toEqual([request]));

    const closing = fixture.windows.triggerOsClose('helper-buddy-1', 'approval-1');
    const resolution = await pending;
    resolution.reject(new Error('OS-close re-observation failed'));
    await expect(closing).resolves.toBeUndefined();

    expect(fixture.errors).toEqual([
      expect.objectContaining({ message: 'OS-close re-observation failed' }),
    ]);
    expect(fixture.runtime.controller.listApprovals()).toEqual([request]);
    await fixture.runtime.cancelHelperBuddy('helper-buddy-1');
    await fixture.runtime.dispose();
  });

  it('freezes a visible-capable surface before waking an approved run and rejects stale identity', async () => {
    const sequence: string[] = [];
    const fixture = runtimeFixture({ sequence });
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const pending = fixture.runtime.approvals.request(approval(), new AbortController().signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toHaveLength(1));

    await expect(
      fixture.runtime.controller.resolveApproval('other-helper-buddy', 'approval-1', 'once'),
    ).rejects.toThrow('stale or mismatched');
    const resolving = fixture.runtime.controller.resolveApproval(
      'helper-buddy-1',
      'approval-1',
      'once',
    );
    const resolution = await pending;
    sequence.push(`verdict:${resolution.verdict}`);
    expect(fixture.runtime.controller.listApprovals()).toHaveLength(1);
    resolution.acknowledge();
    await resolving;

    expect(sequence).toEqual([
      'freeze:helper-buddy-1:approval-1',
      'verdict:once',
      'complete:helper-buddy-1:approval-1',
      'release:helper-buddy-1:approval-1',
    ]);
    await fixture.runtime.dispose();
  });

  it('rejects an untrusted renderer verdict before hiding or delivering it', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const pending = fixture.runtime.approvals.request(approval(), new AbortController().signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toHaveLength(1));

    await expect(
      fixture.runtime.controller.resolveApproval(
        'helper-buddy-1',
        'approval-1',
        'handled' as never,
      ),
    ).rejects.toThrow('invalid approval verdict');

    expect(fixture.windows.service.freezeApproval).not.toHaveBeenCalled();
    expect(fixture.runtime.controller.listApprovals()).toEqual([approval()]);
    await fixture.runtime.cancelHelperBuddy('helper-buddy-1');
    expect((await pending).verdict).toBe('deny');
    await fixture.runtime.dispose();
  });

  it('binds a stale replacement before publication and keeps its takeover/approval usable', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const initial = fixture.runtime.approvals.request(approval(), new AbortController().signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toHaveLength(1));

    const resolvingInitial = fixture.runtime.controller.resolveApproval(
      'helper-buddy-1',
      'approval-1',
      'once',
    );
    const firstResolution = await initial;
    const replacement = approval({
      approvalId: 'approval-2',
      actionText: 'publish the fresh report',
    });
    const replacementDelivery = firstResolution.replace(replacement);

    await vi.waitFor(() =>
      expect(fixture.runtime.controller.listApprovals()).toEqual([replacement]),
    );
    expect(fixture.windows.service.bindApproval).toHaveBeenCalledWith(
      'helper-buddy-1',
      'approval-2',
    );
    await resolvingInitial;

    await fixture.runtime.controller.showApprovalWindow('helper-buddy-1', 'approval-2');
    const resolvingReplacement = fixture.runtime.controller.resolveApproval(
      'helper-buddy-1',
      'approval-2',
      'once',
    );
    const secondResolution = await replacementDelivery;
    expect(secondResolution.verdict).toBe('once');
    secondResolution.acknowledge();
    await resolvingReplacement;

    expect(fixture.windows.service.showApprovalWindow).toHaveBeenCalledWith(
      'helper-buddy-1',
      'approval-2',
    );
    expect(fixture.runtime.controller.listApprovals()).toEqual([]);
    await fixture.runtime.dispose();
  });

  it('hides Buddy surfaces before delivering a live-desktop verdict', async () => {
    const sequence: string[] = [];
    const fixture = runtimeFixture({ sequence });
    const pending = fixture.runtime.approvals.request(
      approval({
        approvalId: 'live-approval',
        helperBuddyId: 'live-1',
        kind: 'live-action',
        allowAlways: false,
        grantScope: null,
        allowTakeover: false,
      }),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toHaveLength(1));

    const resolving = fixture.runtime.controller.resolveApproval('live-1', 'live-approval', 'once');
    const resolution = await pending;
    sequence.push(`verdict:${resolution.verdict}`);
    resolution.acknowledge();
    await resolving;

    expect(sequence).toEqual(['hide-buddy-surfaces', 'verdict:once']);
    await fixture.runtime.dispose();
  });

  it('re-presents a retryable live approval after downstream reinspection rejects', async () => {
    const sequence: string[] = [];
    const fixture = runtimeFixture({ sequence });
    const request = approval({
      approvalId: 'live-approval',
      helperBuddyId: 'live-1',
      kind: 'live-action',
      allowAlways: false,
      grantScope: null,
      allowTakeover: false,
    });
    const signal = new AbortController().signal;
    const pending = fixture.runtime.approvals.request(request, signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toEqual([request]));

    const firstAttempt = fixture.runtime.controller.resolveApproval(
      'live-1',
      'live-approval',
      'once',
    );
    const firstResolution = await pending;
    firstResolution.reject(new Error('receiver changed before dispatch'));
    await expect(firstAttempt).rejects.toThrow('receiver changed before dispatch');

    expect(fixture.runtime.controller.listApprovals()).toEqual([request]);
    expect(fixture.liveResolutionFailed).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ message: 'receiver changed before dispatch' }),
    );
    expect(sequence).toEqual([
      'hide-buddy-surfaces',
      'restore:live-approval:receiver changed before dispatch',
    ]);

    const retryPending = fixture.runtime.approvals.request(request, signal);
    const retry = fixture.runtime.controller.resolveApproval('live-1', 'live-approval', 'once');
    const retryResolution = await retryPending;
    retryResolution.acknowledge();
    await retry;
    expect(fixture.runtime.controller.listApprovals()).toEqual([]);
    await fixture.runtime.dispose();
  });

  it('cancels queued approvals and authenticated drivers on suspend, then requires resume', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const pending = fixture.runtime.approvals.request(approval(), new AbortController().signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toHaveLength(1));

    await fixture.runtime.suspend();

    const cancellation = await pending;
    expect(cancellation.verdict).toBe('deny');
    cancellation.acknowledge();
    expect(fixture.drivers[0]?.dispose).toHaveBeenCalled();
    expect(fixture.windows.service.suspend).toHaveBeenCalledOnce();
    await expect(fixture.runtime.browser.createDriver('helper-buddy-2')).rejects.toThrow(
      'suspended',
    );
    fixture.runtime.resume();
    await expect(fixture.runtime.browser.createDriver('helper-buddy-2')).resolves.toBeTruthy();
    await fixture.runtime.dispose();
  });

  it('does not let a stale asynchronous suspend overwrite a newer resume', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    let finishDispose!: () => void;
    fixture.drivers[0]!.dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve;
        }),
    );

    const suspending = fixture.runtime.suspend();
    await vi.waitFor(() => expect(fixture.drivers[0]!.dispose).toHaveBeenCalled());
    fixture.runtime.resume();
    finishDispose();
    await suspending;

    expect(fixture.windows.service.suspend).not.toHaveBeenCalled();
    expect(fixture.windows.service.resume).toHaveBeenCalledOnce();
    await expect(fixture.runtime.browser.createDriver('helper-buddy-2')).resolves.toBeTruthy();
    await fixture.runtime.dispose();
  });

  it('cancels browser runs before site-data mutation and disposes the profile on shutdown', async () => {
    const fixture = runtimeFixture();
    await fixture.runtime.browser.createDriver('helper-buddy-1');
    const pending = fixture.runtime.approvals.request(approval(), new AbortController().signal);
    await vi.waitFor(() => expect(fixture.runtime.controller.listApprovals()).toHaveLength(1));

    await fixture.runtime.controller.signOutSite('example.com');

    const cancellation = await pending;
    expect(cancellation.verdict).toBe('deny');
    cancellation.acknowledge();
    expect(fixture.drivers[0]?.dispose).toHaveBeenCalled();
    expect(fixture.windows.service.signOutSite).toHaveBeenCalledWith('example.com');

    await fixture.runtime.browser.createDriver('helper-buddy-2');
    await fixture.runtime.controller.clearAll();
    expect(fixture.drivers[1]?.dispose).toHaveBeenCalled();
    expect(fixture.windows.service.clearAll).toHaveBeenCalledOnce();
    await expect(fixture.runtime.controller.listGrants()).resolves.toEqual([]);

    await fixture.runtime.dispose();
    expect(fixture.profile.dispose).toHaveBeenCalledOnce();
  });
});
