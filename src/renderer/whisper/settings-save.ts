import type { Settings, SettingsPatch } from '../../shared/types';

export const WHISPER_SETTINGS_SAVE_ERROR =
  "buddy couldn't save quiet mode — your previous voice setting is unchanged. try again, or " +
  'open settings if it keeps happening.';

/** Resolve with the committed snapshot, or `null` after containing the IPC rejection. */
export async function saveWhisperSettings(
  setSettings: (patch: SettingsPatch) => Promise<Settings>,
  patch: SettingsPatch,
): Promise<Settings | null> {
  try {
    return await setSettings(patch);
  } catch {
    return null;
  }
}
