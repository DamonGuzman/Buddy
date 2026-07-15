/**
 * macOS privacy health and explicit repair actions.
 *
 * Merely checking status never prompts. Every prompt/deep-link is reached
 * from a user-clicked action in the panel. This keeps startup usable and lets
 * the UI report whether opening System Settings actually succeeded.
 */

import { app, shell, systemPreferences } from 'electron';
import { spawnSync } from 'node:child_process';
import type { PermissionGrantState, PermissionHealth, PermissionKey } from '../../shared/types';
import {
  preflightMacInputMonitoringAccess,
  requestMacInputMonitoringAccess,
  requestMacScreenCaptureAccess,
} from './mac-screen-permission';

export type MacPermissionStatus =
  'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface MacPermissionSnapshot {
  microphone: MacPermissionStatus;
  screen: MacPermissionStatus;
  accessibility: boolean;
  /** null only when the native privacy bridge is unavailable. */
  inputMonitoring: boolean | null;
}

export interface MacPermissionRepairResult {
  ok: boolean;
  message: string;
}

const PRIVACY_URLS: Record<PermissionKey, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
};

const LABELS: Record<PermissionKey, string> = {
  microphone: 'Microphone',
  accessibility: 'Accessibility',
  inputMonitoring: 'Input Monitoring',
  screen: 'Screen Recording',
};

const BUDDY_BUNDLE_ID = 'ai.fastyr.buddy';
const TCC_SERVICES = [
  ['Microphone', 'Microphone'],
  ['Accessibility', 'Accessibility'],
  ['ListenEvent', 'Input Monitoring'],
  ['ScreenCapture', 'Screen Recording'],
] as const;

export function getMacPermissionSnapshot(promptAccessibility = false): MacPermissionSnapshot {
  if (process.platform !== 'darwin') {
    return {
      microphone: 'granted',
      screen: 'granted',
      accessibility: true,
      inputMonitoring: true,
    };
  }
  return {
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(promptAccessibility),
    inputMonitoring: preflightMacInputMonitoringAccess(),
  };
}

export function buildMacPermissionHealth(
  snapshot: MacPermissionSnapshot,
  hotkey: { hookAlive: boolean; error?: string | undefined },
  appPath = currentBuddyAppPath(),
): PermissionHealth {
  const grants: PermissionHealth['grants'] = {
    microphone: mediaState(snapshot.microphone),
    accessibility: snapshot.accessibility ? 'granted' : 'missing',
    inputMonitoring:
      snapshot.inputMonitoring === null
        ? 'unknown'
        : snapshot.inputMonitoring
          ? 'granted'
          : 'missing',
    screen: mediaState(snapshot.screen),
  };
  const nextPermission = firstUnhealthyGrant(grants);
  const hotkeyGrantsReady =
    grants.accessibility === 'granted' && grants.inputMonitoring === 'granted';
  return {
    supported: process.platform === 'darwin',
    checkedAt: Date.now(),
    grants,
    hotkeyAlive: hotkey.hookAlive,
    hotkeyError: hotkey.error ?? null,
    nextPermission,
    restartRecommended: hotkeyGrantsReady && !hotkey.hookAlive,
    appPath,
  };
}

/**
 * Run the native request API where one exists, then open the exact Settings
 * pane when access still needs a toggle. Called only from explicit UI clicks.
 */
export async function repairMacPermission(
  permission: PermissionKey,
): Promise<MacPermissionRepairResult> {
  if (process.platform !== 'darwin') {
    return { ok: true, message: 'No macOS permission repair is needed on this system.' };
  }

  try {
    if (permission === 'microphone') {
      const before = systemPreferences.getMediaAccessStatus('microphone');
      if (before === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
    } else if (permission === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true);
    } else if (permission === 'inputMonitoring') {
      requestMacInputMonitoringAccess();
    } else {
      requestMacScreenCaptureAccess();
    }
  } catch (err) {
    console.warn(
      `[permissions] ${permission} native request failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (grantState(permission, getMacPermissionSnapshot(false)) === 'granted') {
    return {
      ok: true,
      message: `${LABELS[permission]} is allowed. Buddy is checking the live feature now.`,
    };
  }

  return openMacPermissionSettings(permission);
}

/** Deep-link with an explicit fallback; callers always receive visible copy. */
export async function openMacPermissionSettings(
  permission: PermissionKey,
): Promise<MacPermissionRepairResult> {
  try {
    await shell.openExternal(PRIVACY_URLS[permission]);
    return {
      ok: true,
      message:
        `Opened ${LABELS[permission]}. Turn Buddy on, then return here — ` +
        'it will check automatically.',
    };
  } catch (deepLinkError) {
    console.warn(
      `[permissions] failed to open ${permission} settings link:`,
      deepLinkError instanceof Error ? deepLinkError.message : String(deepLinkError),
    );
    try {
      const fallbackError = await shell.openPath('/System/Applications/System Settings.app');
      if (fallbackError) throw new Error(fallbackError, { cause: deepLinkError });
      return {
        ok: true,
        message:
          'Opened System Settings. Choose Privacy & Security, then ' +
          `${LABELS[permission]}, and turn Buddy on.`,
      };
    } catch (fallbackError) {
      return {
        ok: false,
        message:
          `Buddy couldn't open System Settings (${errorMessage(fallbackError)}). ` +
          `Open it manually: Privacy & Security → ${LABELS[permission]}.`,
      };
    }
  }
}

export function revealCurrentBuddy(): MacPermissionRepairResult {
  try {
    shell.showItemInFolder(currentBuddyAppPath());
    return {
      ok: true,
      message:
        'Revealed the current Buddy. Remove the old entry in System Settings, then add this app.',
    };
  } catch (err) {
    return {
      ok: false,
      message: `Buddy couldn't reveal the app (${errorMessage(err)}). It should be in /Applications.`,
    };
  }
}

/**
 * Clear only Buddy's saved decisions so a stale code-identity entry cannot
 * keep winning over the current build. This is destructive by design and is
 * exposed behind a two-click confirmation in the Permissions card.
 */
export function resetMacPermissionGrants(): MacPermissionRepairResult {
  if (process.platform !== 'darwin') {
    return { ok: true, message: 'No macOS privacy decisions need to be reset.' };
  }

  const failures: string[] = [];
  for (const [service, label] of TCC_SERVICES) {
    const result = spawnSync('/usr/bin/tccutil', ['reset', service, BUDDY_BUNDLE_ID], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join(' ').trim();
      failures.push(`${label}${detail ? ` (${detail})` : ''}`);
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      message:
        `Buddy couldn't reset ${failures.join(', ')}. Quit Buddy, remove its old entries ` +
        'in System Settings → Privacy & Security, then add /Applications/Buddy.app again.',
    };
  }

  return {
    ok: true,
    message:
      "Cleared this Buddy's saved privacy decisions. Use the Allow/Fix buttons from top to " +
      'bottom; macOS will ask again, and Buddy will reconnect automatically.',
  };
}

export function firstMissingPermission(snapshot: MacPermissionSnapshot): PermissionKey | null {
  return firstUnhealthyGrant({
    microphone: mediaState(snapshot.microphone),
    accessibility: snapshot.accessibility ? 'granted' : 'missing',
    inputMonitoring:
      snapshot.inputMonitoring === null
        ? 'unknown'
        : snapshot.inputMonitoring
          ? 'granted'
          : 'missing',
    screen: mediaState(snapshot.screen),
  });
}

function firstUnhealthyGrant(
  grants: Record<PermissionKey, PermissionGrantState>,
): PermissionKey | null {
  for (const key of ['microphone', 'accessibility', 'inputMonitoring', 'screen'] as const) {
    if (grants[key] !== 'granted') return key;
  }
  return null;
}

function grantState(
  permission: PermissionKey,
  snapshot: MacPermissionSnapshot,
): PermissionGrantState {
  if (permission === 'microphone' || permission === 'screen') {
    return mediaState(snapshot[permission]);
  }
  if (permission === 'accessibility') return snapshot.accessibility ? 'granted' : 'missing';
  return snapshot.inputMonitoring === null
    ? 'unknown'
    : snapshot.inputMonitoring
      ? 'granted'
      : 'missing';
}

function mediaState(status: MacPermissionStatus): PermissionGrantState {
  if (status === 'granted') return 'granted';
  if (status === 'not-determined') return 'not-determined';
  if (status === 'unknown') return 'unknown';
  return 'missing';
}

function currentBuddyAppPath(): string {
  const executable = app.getPath('exe');
  const match = /^(.*\.app)\/Contents\/MacOS\//.exec(executable);
  return match?.[1] ?? executable;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
