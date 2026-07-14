/**
 * macOS privacy-permission preflight and recovery UI.
 *
 * Screen Recording is intentionally status-only here. Asking macOS for it
 * requires starting a screen capture, and Buddy's privacy contract forbids a
 * capture until the user presses the hotkey or submits a typed request.
 */

import { dialog, shell, systemPreferences } from 'electron';

export type MacPermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

export interface MacPermissionSnapshot {
  microphone: MacPermissionStatus;
  screen: MacPermissionStatus;
  accessibility: boolean;
}

const PRIVACY_URLS = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const;

export function getMacPermissionSnapshot(promptAccessibility = false): MacPermissionSnapshot {
  if (process.platform !== 'darwin') {
    return { microphone: 'granted', screen: 'granted', accessibility: true };
  }
  return {
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(promptAccessibility),
  };
}

/**
 * Ask only for permissions Electron can request without capturing anything.
 * The result is logged without opening custom windows over Apple's prompts.
 */
export async function preflightMacPermissions(): Promise<MacPermissionSnapshot> {
  if (process.platform !== 'darwin') return getMacPermissionSnapshot();

  if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch (err) {
      console.warn(
        '[permissions] microphone request failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // libuiohook uses the macOS Accessibility event tap. Passing true asks the
  // OS to show its standard trust prompt when Buddy has not been approved.
  const snapshot = getMacPermissionSnapshot(true);
  console.log('[permissions] macOS status:', snapshot);
  return snapshot;
}

/** Show current status and deep-link to the first missing System Setting. */
export async function showMacPermissionGuide(): Promise<void> {
  if (process.platform !== 'darwin') return;

  const snapshot = getMacPermissionSnapshot(false);
  const rows = [
    `Microphone: ${formatStatus(snapshot.microphone)}`,
    `Screen Recording: ${formatStatus(snapshot.screen)}`,
    `Accessibility: ${snapshot.accessibility ? 'Allowed' : 'Needs permission'}`,
  ];
  const missing = firstMissingPermission(snapshot);
  const allGranted = missing === null;
  const result = await dialog.showMessageBox({
    type: allGranted ? 'info' : 'warning',
    title: 'Buddy permissions',
    message: allGranted ? 'Buddy has the macOS permissions it needs.' : 'Buddy needs permission',
    detail:
      `${rows.join('\n')}\n\n` +
      (allGranted
        ? 'You can close this window and use Buddy.'
        : 'After changing Accessibility or Screen Recording, quit and reopen Buddy.'),
    buttons: allGranted ? ['Done'] : ['Open System Settings', 'Not Now'],
    defaultId: 0,
    cancelId: allGranted ? 0 : 1,
    noLink: true,
  });

  if (!allGranted && result.response === 0 && missing !== null) {
    await shell.openExternal(PRIVACY_URLS[missing]);
  }
}

export function firstMissingPermission(
  snapshot: MacPermissionSnapshot,
): keyof typeof PRIVACY_URLS | null {
  if (snapshot.microphone !== 'granted') return 'microphone';
  if (snapshot.screen !== 'granted') return 'screen';
  if (!snapshot.accessibility) return 'accessibility';
  return null;
}

function formatStatus(status: MacPermissionStatus): string {
  if (status === 'granted') return 'Allowed';
  if (status === 'not-determined') return 'Will ask when first used';
  if (status === 'denied') return 'Denied';
  if (status === 'restricted') return 'Restricted';
  return 'Unknown';
}
