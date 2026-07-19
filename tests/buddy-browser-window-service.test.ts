import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BuddyBrowserProfile } from '../src/main/computer/browser-profile';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));

const { BuddyBrowserIpcController, BuddyBrowserWindowService } =
  await import('../src/main/windows/buddy-browser');

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly loadURL = vi.fn(async (_url: string) => undefined);
  readonly show = vi.fn();
  readonly focus = vi.fn();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

function profileFixture(options?: {
  sites?: string[];
  cookies?: { domain?: string; name: string }[];
}) {
  const enrollment = new FakeWindow();
  const sequence: string[] = [];
  const profile = {
    createEnrollmentWindow: vi.fn(async (_url: string) => enrollment),
    listEnrolledSites: vi.fn(async () => options?.sites ?? []),
    clearEnrolledSite: vi.fn(async (domain: string) => {
      sequence.push(`clear:${domain}`);
    }),
    clearAllData: vi.fn(async () => {
      sequence.push('clear-all');
    }),
    isSuspended: vi.fn(() => false),
    setSuspended: vi.fn(),
    session: {
      cookies: { get: vi.fn(async () => options?.cookies ?? []) },
    },
  } as unknown as BuddyBrowserProfile;
  return { profile, enrollment, sequence };
}

function surfaceFixture(url = 'https://linear.app/acme') {
  let closeByUser: (() => void) | null = null;
  const sequence: string[] = [];
  const surface = {
    showForUser: vi.fn(async (onDone: () => void) => {
      closeByUser = onDone;
      sequence.push('show');
    }),
    hideFromUser: vi.fn(async () => {
      sequence.push('hide');
    }),
    currentUrl: vi.fn(() => url),
    dispose: vi.fn(async () => {
      sequence.push('dispose');
    }),
  };
  return {
    surface,
    sequence,
    closeByUser: () => {
      if (!closeByUser) throw new Error('surface was not shown');
      closeByUser();
    },
  };
}

describe('BuddyBrowserWindowService', () => {
  it('rejects helper buddy ids beyond the shared 200-character boundary', () => {
    const { profile } = profileFixture();
    const service = new BuddyBrowserWindowService({ profile });
    const { surface } = surfaceFixture();

    expect(() => service.registerSurface('h'.repeat(201), surface)).toThrow(
      'helper buddy id exceeds the size limit',
    );
    expect(() => service.registerSurface(' helper-buddy-1', surface)).toThrow('canonical');
    expect(() => service.registerSurface('helper-buddy-1\0', surface)).toThrow('invalid');
  });

  it('uses one registered adapter for the offscreen driver lifecycle API', async () => {
    const { profile } = profileFixture();
    const service = new BuddyBrowserWindowService({ profile });
    const driver = {
      showForTakeover: vi.fn(async (_callback: () => void) => undefined),
      hideAfterTakeover: vi.fn(),
      getCurrentUrl: vi.fn(() => 'https://linear.app/acme'),
      dispose: vi.fn(async () => undefined),
    };
    const managed = service.registerOffscreenDriver('helper-buddy-1', driver as never);
    service.bindApproval('helper-buddy-1', 'approval-1');

    await service.showApprovalWindow('helper-buddy-1', 'approval-1');
    await service.hideApprovalWindow('helper-buddy-1', 'approval-1');
    await managed.dispose();

    expect(driver.showForTakeover).toHaveBeenCalledWith(expect.any(Function));
    expect(driver.hideAfterTakeover).toHaveBeenCalledOnce();
    expect(driver.dispose).toHaveBeenCalledOnce();
    await expect(service.showApprovalWindow('helper-buddy-1', 'approval-1')).rejects.toThrow(
      'stale or mismatched',
    );
  });

  it('requires an explicit http(s) enrollment URL and reuses the visible profile window', async () => {
    const { profile, enrollment } = profileFixture();
    const service = new BuddyBrowserWindowService({ profile });

    await expect(service.openEnrollment('about:blank')).rejects.toThrow(
      'browser URL scheme is not allowed',
    );
    await service.openEnrollment('https://linear.app/login');
    await service.openEnrollment('https://notion.so/login');

    expect(profile.createEnrollmentWindow).toHaveBeenCalledOnce();
    expect(profile.createEnrollmentWindow).toHaveBeenCalledWith('https://linear.app/login');
    expect(enrollment.loadURL).toHaveBeenCalledWith('https://notion.so/login');
    expect(enrollment.show).toHaveBeenCalledOnce();
    expect(enrollment.focus).toHaveBeenCalledOnce();
  });

  it('restores Settings when the user closes enrollment', async () => {
    const { profile, enrollment } = profileFixture();
    const onEnrollmentClosed = vi.fn();
    const service = new BuddyBrowserWindowService({ profile, onEnrollmentClosed });
    await service.openEnrollment('https://linear.app/login');

    enrollment.destroy();

    await vi.waitFor(() => expect(onEnrollmentClosed).toHaveBeenCalledOnce());
  });

  it('counts enrolled cookie domains and rejects a broad/non-enrolled clear', async () => {
    const { profile } = profileFixture({
      sites: ['linear.app', 'notion.so'],
      cookies: [
        { domain: '.linear.app', name: 'a' },
        { domain: 'linear.app', name: 'b' },
        { domain: '.notion.so', name: 'c' },
        { name: 'hostless' },
      ],
    });
    const service = new BuddyBrowserWindowService({ profile });

    await expect(service.listEnrolledSites()).resolves.toEqual([
      { domain: 'linear.app', cookieCount: 2 },
      { domain: 'notion.so', cookieCount: 1 },
    ]);
    await expect(service.signOutSite('com')).rejects.toThrow('site is not enrolled');
    expect(profile.clearEnrolledSite).not.toHaveBeenCalled();
  });

  it('disposes an active page before clearing credentials for its domain', async () => {
    const { profile, sequence } = profileFixture({ sites: ['linear.app'] });
    const service = new BuddyBrowserWindowService({ profile });
    const affected = surfaceFixture('https://app.linear.app/acme');
    const unrelated = surfaceFixture('https://notion.so/acme');
    affected.surface.dispose.mockImplementation(async () => {
      sequence.push('dispose-linear');
    });
    unrelated.surface.dispose.mockImplementation(async () => {
      sequence.push('dispose-notion');
    });
    service.registerSurface('helper-buddy-linear', affected.surface);
    service.registerSurface('helper-buddy-notion', unrelated.surface);

    await service.signOutSite('.LINEAR.APP');

    expect(sequence).toEqual(['dispose-linear', 'clear:linear.app']);
    expect(unrelated.surface.dispose).not.toHaveBeenCalled();
  });

  it('binds takeover by approval ID and rejects stale or mismatched cards', async () => {
    const { profile } = profileFixture();
    const done = vi.fn();
    const service = new BuddyBrowserWindowService({ profile, onTakeoverDone: done });
    const { surface, closeByUser } = surfaceFixture();
    service.registerSurface('helper-buddy-1', surface);
    service.bindApproval('helper-buddy-1', 'approval-1');

    await expect(service.showApprovalWindow('helper-buddy-2', 'approval-1')).rejects.toThrow(
      'stale or mismatched',
    );
    await expect(service.showApprovalWindow('helper-buddy-1', 'approval-old')).rejects.toThrow(
      'stale or mismatched',
    );
    await service.showApprovalWindow('helper-buddy-1', 'approval-1');
    closeByUser();
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith('helper-buddy-1', 'approval-1'));
    expect(surface.hideFromUser).toHaveBeenCalledOnce();
  });

  it('hides a takeover before reporting user handling', async () => {
    const { profile } = profileFixture();
    const sequence: string[] = [];
    const service = new BuddyBrowserWindowService({
      profile,
      onTakeoverDone: () => {
        sequence.push('handled');
      },
    });
    const { surface } = surfaceFixture();
    surface.hideFromUser.mockImplementation(async () => {
      sequence.push('hide');
    });
    service.registerSurface('helper-buddy-1', surface);
    service.bindApproval('helper-buddy-1', 'approval-1');
    await service.showApprovalWindow('helper-buddy-1', 'approval-1');

    await service.hideApprovalWindow('helper-buddy-1', 'approval-1');

    expect(sequence).toEqual(['hide', 'handled']);
  });

  it('keeps a hidden takeover retryable when handled resolution fails', async () => {
    const { profile } = profileFixture();
    const onTakeoverDone = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('coordinator unavailable'))
      .mockResolvedValueOnce();
    const service = new BuddyBrowserWindowService({ profile, onTakeoverDone });
    const { surface } = surfaceFixture();
    service.registerSurface('helper-buddy-1', surface);
    service.bindApproval('helper-buddy-1', 'approval-1');
    await service.showApprovalWindow('helper-buddy-1', 'approval-1');

    await expect(service.hideApprovalWindow('helper-buddy-1', 'approval-1')).rejects.toThrow(
      'coordinator unavailable',
    );
    await expect(
      service.hideApprovalWindow('helper-buddy-1', 'approval-1'),
    ).resolves.toBeUndefined();

    expect(surface.hideFromUser).toHaveBeenCalledOnce();
    expect(onTakeoverDone).toHaveBeenCalledTimes(2);
  });

  it('routes explicit Done rejection separately from fire-and-forget OS close', async () => {
    const { profile } = profileFixture();
    const explicitDone = vi.fn(async () => {
      throw new Error('handled acknowledgment failed');
    });
    const osClosed = vi.fn(async () => undefined);
    const service = new BuddyBrowserWindowService({
      profile,
      onTakeoverDone: explicitDone,
      onTakeoverClosed: osClosed,
    });
    const takeover = surfaceFixture();
    service.registerSurface('helper-buddy-1', takeover.surface);
    service.bindApproval('helper-buddy-1', 'approval-1');
    await service.showApprovalWindow('helper-buddy-1', 'approval-1');

    await expect(service.hideApprovalWindow('helper-buddy-1', 'approval-1')).rejects.toThrow(
      'handled acknowledgment failed',
    );
    expect(osClosed).not.toHaveBeenCalled();

    await service.showApprovalWindow('helper-buddy-1', 'approval-1');
    takeover.closeByUser();
    await vi.waitFor(() => expect(osClosed).toHaveBeenCalledWith('helper-buddy-1', 'approval-1'));
    expect(explicitDone).toHaveBeenCalledOnce();
  });

  it('disposes every active surface before clearing the whole profile', async () => {
    const { profile, enrollment, sequence } = profileFixture();
    const service = new BuddyBrowserWindowService({ profile });
    const first = surfaceFixture();
    const second = surfaceFixture('https://notion.so');
    first.surface.dispose.mockImplementation(async () => {
      sequence.push('dispose-1');
    });
    second.surface.dispose.mockImplementation(async () => {
      sequence.push('dispose-2');
    });
    await service.openEnrollment('https://linear.app');
    service.registerSurface('helper-buddy-1', first.surface);
    service.registerSurface('helper-buddy-2', second.surface);

    await service.clearAll();

    expect(enrollment.destroyed).toBe(true);
    expect(sequence.slice(-1)).toEqual(['clear-all']);
    expect(sequence.slice(0, 2).sort()).toEqual(['dispose-1', 'dispose-2']);
  });

  it('joins and destroys a late enrollment window before clearing profile storage', async () => {
    const { profile, enrollment, sequence } = profileFixture();
    let releaseEnrollment!: () => void;
    const enrollmentFactory = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    profile.createEnrollmentWindow = vi.fn(async () => {
      await enrollmentFactory;
      return enrollment as never;
    });
    const service = new BuddyBrowserWindowService({ profile });

    const opening = service.openEnrollment('https://linear.app');
    await vi.waitFor(() => expect(profile.createEnrollmentWindow).toHaveBeenCalledOnce());
    const clearing = service.clearAll();
    await Promise.resolve();
    expect(profile.clearAllData).not.toHaveBeenCalled();

    releaseEnrollment();
    await expect(opening).rejects.toThrow('cancelled by a lifecycle transition');
    await clearing;

    expect(enrollment.destroyed).toBe(true);
    expect(sequence).toEqual(['clear-all']);
  });

  it('rejects new browser surfaces while a destructive profile mutation is in progress', async () => {
    const { profile } = profileFixture();
    let finishClear!: () => void;
    profile.clearAllData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClear = resolve;
        }),
    );
    const service = new BuddyBrowserWindowService({ profile });
    const clearing = service.clearAll();
    await vi.waitFor(() => expect(profile.clearAllData).toHaveBeenCalledOnce());

    expect(() => service.registerSurface('helper-buddy-late', surfaceFixture().surface)).toThrow(
      'profile mutation is already in progress',
    );
    await expect(service.openEnrollment('https://linear.app')).rejects.toThrow(
      'profile mutation is already in progress',
    );

    finishClear();
    await clearing;
  });

  it('cancels logged-in browser surfaces across lock and resumes only future work', async () => {
    const { profile } = profileFixture();
    const service = new BuddyBrowserWindowService({ profile });
    const active = surfaceFixture();
    service.registerSurface('helper-buddy-1', active.surface);

    await service.suspend();

    expect(profile.setSuspended).toHaveBeenCalledWith(true);
    expect(active.surface.dispose).toHaveBeenCalledOnce();
    service.resume();
    expect(profile.setSuspended).toHaveBeenLastCalledWith(false);
  });
});

describe('BuddyBrowserIpcController', () => {
  it('freezes the exact visible surface before resolving and releasing approval', async () => {
    const { profile } = profileFixture();
    const windows = new BuddyBrowserWindowService({ profile });
    const surface = surfaceFixture();
    const sequence: string[] = [];
    surface.surface.hideFromUser.mockImplementation(async () => {
      sequence.push('hide');
    });
    windows.registerSurface('helper-buddy-1', surface.surface);
    windows.bindApproval('helper-buddy-1', 'approval-1');
    await windows.showApprovalWindow('helper-buddy-1', 'approval-1');
    const resolve = vi.fn(async () => {
      sequence.push('resolve');
    });
    const controller = new BuddyBrowserIpcController(windows, {
      resolve,
      listApprovals: () => [],
      listGrants: () => [],
      revokeGrant: () => undefined,
    });

    await controller.resolveApproval('helper-buddy-1', 'approval-1', 'always');

    expect(sequence).toEqual(['hide', 'resolve']);
    expect(resolve).toHaveBeenCalledWith('helper-buddy-1', 'approval-1', 'always');
    await expect(windows.showApprovalWindow('helper-buddy-1', 'approval-1')).rejects.toThrow(
      'stale or mismatched',
    );
  });

  it('does not resolve or release when freezing the visible surface fails', async () => {
    const { profile } = profileFixture();
    const windows = new BuddyBrowserWindowService({ profile });
    const surface = surfaceFixture();
    surface.surface.hideFromUser.mockRejectedValueOnce(new Error('window would not hide'));
    windows.registerSurface('helper-buddy-1', surface.surface);
    windows.bindApproval('helper-buddy-1', 'approval-1');
    await windows.showApprovalWindow('helper-buddy-1', 'approval-1');
    const resolve = vi.fn(async () => undefined);
    const controller = new BuddyBrowserIpcController(windows, {
      resolve,
      listApprovals: () => [],
      listGrants: () => [],
      revokeGrant: () => undefined,
    });

    await expect(
      controller.resolveApproval('helper-buddy-1', 'approval-1', 'once'),
    ).rejects.toThrow('window would not hide');

    expect(resolve).not.toHaveBeenCalled();
    await expect(
      windows.showApprovalWindow('helper-buddy-1', 'approval-1'),
    ).resolves.toBeUndefined();
  });
});
