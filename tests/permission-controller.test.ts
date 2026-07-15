import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionHealth } from '../src/shared/types';
import type { MacPermissionSnapshot } from '../src/main/windows/mac-permissions';

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), exit: vi.fn(), getPath: vi.fn(() => '/Applications/Buddy.app') },
  shell: {},
  systemPreferences: {},
}));

vi.mock('../src/main/windows/mac-permissions', () => ({
  buildMacPermissionHealth: vi.fn(),
  getMacPermissionSnapshot: vi.fn(),
  repairMacPermission: vi.fn(),
  resetMacPermissionGrants: vi.fn(),
  revealCurrentBuddy: vi.fn(),
}));

import { PermissionController } from '../src/main/windows/permission-controller';

const granted: MacPermissionSnapshot = {
  microphone: 'granted',
  screen: 'granted',
  accessibility: true,
  inputMonitoring: true,
};

function health(snapshot: MacPermissionSnapshot, alive: boolean, error?: string): PermissionHealth {
  const grants: PermissionHealth['grants'] = {
    microphone: snapshot.microphone === 'granted' ? 'granted' : 'missing',
    accessibility: snapshot.accessibility ? 'granted' : 'missing',
    inputMonitoring:
      snapshot.inputMonitoring === null
        ? 'unknown'
        : snapshot.inputMonitoring
          ? 'granted'
          : 'missing',
    screen: snapshot.screen === 'granted' ? 'granted' : 'missing',
  };
  const nextPermission =
    (Object.keys(grants) as Array<keyof typeof grants>).find((key) => grants[key] !== 'granted') ??
    null;
  return {
    supported: true,
    checkedAt: 1,
    grants,
    hotkeyAlive: alive,
    hotkeyError: error ?? null,
    nextPermission,
    restartRecommended:
      grants.accessibility === 'granted' && grants.inputMonitoring === 'granted' && !alive,
    appPath: '/Applications/Buddy.app',
  };
}

describe('PermissionController reconciliation', () => {
  let snapshot: MacPermissionSnapshot;
  let alive: boolean;
  let startSucceeds: boolean;
  let error: string | undefined;
  let start: ReturnType<typeof vi.fn<() => void>>;
  let stop: ReturnType<typeof vi.fn<() => void>>;
  let unavailable: ReturnType<typeof vi.fn<(error: Error, health: PermissionHealth) => void>>;
  let recovered: ReturnType<typeof vi.fn<(health: PermissionHealth) => void>>;

  beforeEach(() => {
    snapshot = { ...granted };
    alive = false;
    startSucceeds = true;
    error = undefined;
    start = vi.fn(() => {
      alive = startSucceeds;
      error = startSucceeds ? undefined : 'event tap blocked';
    });
    stop = vi.fn(() => {
      alive = false;
    });
    unavailable = vi.fn();
    recovered = vi.fn();
  });

  function controller(): PermissionController {
    return new PermissionController({
      hotkey: {
        start,
        stop,
        status: () => ({ hookAlive: alive, holding: false, error }),
      },
      isMacOS: () => true,
      readSnapshot: () => snapshot,
      buildHealth: (s, status) => health(s, status.hookAlive, status.error),
      repair: vi.fn(async () => ({ ok: true, message: 'opened' })),
      reset: vi.fn(() => ({ ok: true, message: 'reset' })),
      reveal: vi.fn(() => ({ ok: true, message: 'revealed' })),
      restart: vi.fn(),
      onUnavailable: unavailable,
      onRecovered: recovered,
    });
  }

  it('stops on revocation and retries once when the grants are restored', () => {
    alive = true;
    snapshot = { ...granted, accessibility: false, inputMonitoring: false };
    const permissions = controller();
    permissions.refresh();
    expect(stop).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledOnce();

    snapshot = { ...granted };
    permissions.refresh();
    permissions.refresh();
    expect(start).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalled();
  });

  it('does not retry-loop a failing native hook, but explicit retry tries again', () => {
    startSucceeds = false;
    const permissions = controller();
    permissions.refresh();
    permissions.refresh();
    expect(start).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledOnce();

    void permissions.act({ type: 'retry-hotkey' });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('returns repair feedback together with the refreshed health snapshot', async () => {
    snapshot = { ...granted, screen: 'denied' };
    const result = await controller().act({ type: 'open', permission: 'screen' });
    expect(result).toMatchObject({
      ok: true,
      message: 'opened',
      health: { nextPermission: 'screen' },
    });
  });

  it('returns visible feedback after a confirmed stale-grant reset', async () => {
    snapshot = { ...granted, accessibility: false, inputMonitoring: false };
    const result = await controller().act({ type: 'reset-grants' });
    expect(result).toMatchObject({
      ok: true,
      message: 'reset',
      health: { nextPermission: 'accessibility' },
    });
  });
});
