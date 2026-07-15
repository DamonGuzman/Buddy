/** Small, main-process-only platform presentation and capability helpers. */

export type BuddyPlatform = NodeJS.Platform;

/** Native wording for the fixed physical push-to-talk chord. */
export function hotkeyLabelForPlatform(platform: BuddyPlatform = process.platform): string {
  return platform === 'darwin' ? 'Control+Option (left option)' : 'Ctrl+Alt (left alt)';
}

/** Human-readable chord used in tray copy. */
export function hotkeyTooltipForPlatform(platform: BuddyPlatform = process.platform): string {
  return platform === 'darwin' ? 'Control + left Option' : 'Ctrl + left Alt';
}

/** Platforms with an implemented, permission-gated computer-input controller. */
export function supportsComputerUse(platform: BuddyPlatform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}
