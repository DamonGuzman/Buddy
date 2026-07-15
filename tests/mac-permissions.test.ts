import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  openExternal: vi.fn<() => Promise<void>>(),
  openPath: vi.fn<() => Promise<string>>(),
  showItemInFolder: vi.fn(),
  getMediaAccessStatus: vi.fn(() => 'granted'),
  askForMediaAccess: vi.fn<() => Promise<boolean>>(),
  isTrustedAccessibilityClient: vi.fn(() => true),
}));

const native = vi.hoisted(() => ({
  preflightInput: vi.fn(() => true as boolean | null),
  requestInput: vi.fn(() => true as boolean | null),
  requestScreen: vi.fn(() => true),
}));

const childProcess = vi.hoisted(() => ({
  spawnSync: vi.fn((_command: string, _args: readonly string[]) => ({
    status: 0,
    stdout: '',
    stderr: '',
  })),
}));

vi.mock('node:child_process', () => ({ spawnSync: childProcess.spawnSync }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/Applications/Buddy.app/Contents/MacOS/Buddy') },
  shell: {
    openExternal: electron.openExternal,
    openPath: electron.openPath,
    showItemInFolder: electron.showItemInFolder,
  },
  systemPreferences: {
    getMediaAccessStatus: electron.getMediaAccessStatus,
    askForMediaAccess: electron.askForMediaAccess,
    isTrustedAccessibilityClient: electron.isTrustedAccessibilityClient,
  },
}));

vi.mock('../src/main/windows/mac-screen-permission', () => ({
  preflightMacInputMonitoringAccess: native.preflightInput,
  requestMacInputMonitoringAccess: native.requestInput,
  requestMacScreenCaptureAccess: native.requestScreen,
}));

import {
  buildMacPermissionHealth,
  firstMissingPermission,
  openMacPermissionSettings,
  repairMacPermission,
  resetMacPermissionGrants,
} from '../src/main/windows/mac-permissions';
import type { MacPermissionSnapshot } from '../src/main/windows/mac-permissions';

const granted: MacPermissionSnapshot = {
  microphone: 'granted',
  screen: 'granted',
  accessibility: true,
  inputMonitoring: true,
};

describe('macOS permission routing', () => {
  const hostPlatform = process.platform;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    electron.openExternal.mockResolvedValue(undefined);
    electron.openPath.mockResolvedValue('');
    electron.getMediaAccessStatus.mockReturnValue('granted');
    electron.askForMediaAccess.mockResolvedValue(true);
    electron.isTrustedAccessibilityClient.mockReturnValue(true);
    native.preflightInput.mockReturnValue(true);
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });

  it('requires both Accessibility and Input Monitoring for the global hotkey', () => {
    expect(firstMissingPermission({ ...granted, accessibility: false })).toBe('accessibility');
    expect(firstMissingPermission({ ...granted, inputMonitoring: false })).toBe(
      'inputMonitoring',
    );
    expect(firstMissingPermission({ ...granted, inputMonitoring: null })).toBe('inputMonitoring');
  });

  it('prioritizes core voice permissions before deferred Screen Recording', () => {
    expect(
      firstMissingPermission({
        ...granted,
        screen: 'denied',
        accessibility: false,
        inputMonitoring: false,
      }),
    ).toBe('accessibility');
    expect(firstMissingPermission({ ...granted, microphone: 'denied' })).toBe('microphone');
    expect(firstMissingPermission({ ...granted, screen: 'denied' })).toBe('screen');
    expect(firstMissingPermission(granted)).toBeNull();
  });

  it('distinguishes a missing grant from stale-looking grants that need restart/retry', () => {
    const missing = buildMacPermissionHealth(
      { ...granted, inputMonitoring: false },
      { hookAlive: false, error: 'blocked' },
      '/Applications/Buddy.app',
    );
    expect(missing).toMatchObject({
      nextPermission: 'inputMonitoring',
      restartRecommended: false,
      hotkeyAlive: false,
    });

    const stale = buildMacPermissionHealth(
      granted,
      { hookAlive: false, error: 'event tap failed' },
      '/Applications/Buddy.app',
    );
    expect(stale).toMatchObject({
      nextPermission: null,
      restartRecommended: true,
      appPath: '/Applications/Buddy.app',
    });
  });

  it('opens the exact privacy pane and returns user-visible confirmation', async () => {
    const result = await openMacPermissionSettings('accessibility');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Opened Accessibility');
    expect(electron.openExternal).toHaveBeenCalledWith(
      expect.stringContaining('Privacy_Accessibility'),
    );
  });

  it('falls back to the System Settings app when the deep link fails', async () => {
    electron.openExternal.mockRejectedValue(new Error('no URL handler'));
    const result = await openMacPermissionSettings('inputMonitoring');
    expect(result).toEqual({
      ok: true,
      message: expect.stringContaining('Privacy & Security'),
    });
    expect(electron.openPath).toHaveBeenCalledWith('/System/Applications/System Settings.app');
  });

  it('returns manual recovery copy when both Settings launch paths fail', async () => {
    electron.openExternal.mockRejectedValue(new Error('no URL handler'));
    electron.openPath.mockResolvedValue('launch services unavailable');
    const result = await openMacPermissionSettings('screen');
    expect(result.ok).toBe(false);
    expect(result.message).toContain("couldn't open System Settings");
    expect(result.message).toContain('Privacy & Security → Screen Recording');
  });

  it('requests an undetermined microphone only after the explicit repair action', async () => {
    electron.getMediaAccessStatus
      .mockReturnValueOnce('not-determined')
      .mockReturnValue('granted');
    const result = await repairMacPermission('microphone');
    expect(electron.askForMediaAccess).toHaveBeenCalledOnce();
    expect(electron.openExternal).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, message: expect.stringContaining('is allowed') });
  });

  it('resets only Buddy decisions for every permission used by the app', () => {
    const result = resetMacPermissionGrants();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('saved privacy decisions');
    expect(childProcess.spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ['reset', 'Microphone', 'ai.fastyr.buddy'],
      ['reset', 'Accessibility', 'ai.fastyr.buddy'],
      ['reset', 'ListenEvent', 'ai.fastyr.buddy'],
      ['reset', 'ScreenCapture', 'ai.fastyr.buddy'],
    ]);
  });

  it('reports a visible manual fallback when a reset service fails', () => {
    childProcess.spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'operation not permitted',
    });
    const result = resetMacPermissionGrants();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("couldn't reset Microphone");
    expect(result.message).toContain('/Applications/Buddy.app');
  });
});
