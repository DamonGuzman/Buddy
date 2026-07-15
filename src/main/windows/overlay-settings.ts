import type { ActionableErrorNotice, BuddyRest, SettingsPatch } from '../../shared/types';
import { actionableErrorNotice, describeKind } from '../errors';

interface SettingsWriter {
  set(patch: SettingsPatch): unknown;
}

/**
 * Persist a drag-completed rest position without allowing a filesystem error
 * to escape an `ipcMain.on` listener. `SettingsStore.set` commits disk first,
 * so `false` also guarantees the previous in-memory value is still current.
 */
export function persistBuddyRest(settings: SettingsWriter, buddyRest: BuddyRest): boolean {
  try {
    settings.set({ buddyRest });
    return true;
  } catch {
    return false;
  }
}

/** Fixed, renderer-safe repair state for a failed Buddy-position write. */
export function settingsSaveFailureNotice(occurredAt: number): ActionableErrorNotice {
  const notice = actionableErrorNotice(describeKind('settings_save_failed'), occurredAt);
  if (notice === null) throw new Error('settings_save_failed must remain actionable');
  return notice;
}
