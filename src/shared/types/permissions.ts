/** Renderer-safe macOS privacy and hotkey recovery contracts. */

export type PermissionKey = 'microphone' | 'accessibility' | 'inputMonitoring' | 'screen';

export type PermissionGrantState = 'granted' | 'missing' | 'not-determined' | 'unknown';

export interface PermissionHealth {
  /** False on platforms where the macOS recovery UI is not applicable. */
  supported: boolean;
  checkedAt: number;
  grants: Record<PermissionKey, PermissionGrantState>;
  /** The actual native hotkey-hook result, not an inference from OS toggles. */
  hotkeyAlive: boolean;
  hotkeyError: string | null;
  nextPermission: PermissionKey | null;
  restartRecommended: boolean;
  appPath: string;
}

export type PermissionAction =
  | { type: 'open'; permission: PermissionKey }
  | { type: 'recheck' }
  | { type: 'retry-hotkey' }
  | { type: 'reset-grants' }
  | { type: 'reveal-app' }
  | { type: 'restart' };

export interface PermissionActionResult {
  ok: boolean;
  message: string;
  health: PermissionHealth;
}
