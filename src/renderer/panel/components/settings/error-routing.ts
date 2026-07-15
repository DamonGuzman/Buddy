import type {
  ActionableErrorKind,
  ActionableErrorTarget,
  SettingsPatch,
} from '../../../../shared/types';

export const SETTINGS_TARGET_LABEL: Record<ActionableErrorTarget, string> = {
  permissions: 'permissions',
  openai: 'openai',
  chatgpt: 'chatgpt',
  voice: 'voice & captions',
  microphone: 'microphone',
  settings: 'settings',
};

/** Return only destinations that are actually rendered on this platform. */
export function visibleSettingsSection(
  target: ActionableErrorTarget,
  permissionsSupported: boolean,
  kind?: ActionableErrorKind,
): ActionableErrorTarget | null {
  if (target === 'settings') return null;
  if (target === 'permissions' && !permissionsSupported) {
    return kind === 'mic_unavailable' ? 'microphone' : null;
  }
  return target;
}

/** Route a failed settings write to the card containing the attempted control. */
export function settingsTargetForPatch(patch: SettingsPatch): ActionableErrorTarget {
  if (patch.apiKey !== undefined || patch.model !== undefined) return 'openai';
  if (patch.micDeviceId !== undefined || patch.fullRealtimeMode !== undefined) return 'microphone';
  if (patch.voice !== undefined || patch.captionsEnabled !== undefined) return 'voice';
  if (patch.preferApiKeyGrounding !== undefined || patch.computerUseEnabled !== undefined) {
    return 'chatgpt';
  }
  return 'settings';
}
