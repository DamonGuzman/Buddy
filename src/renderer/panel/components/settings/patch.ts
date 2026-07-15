import type { Settings, SettingsPatch } from '../../../../shared/types';

/**
 * The typed patch seam every settings card writes through: SettingsView
 * forwards the patch to `clicky.setSettings`, resolving with the merged
 * renderer-safe settings. Toggles fire-and-forget (`void onPatch(...)`);
 * the key save awaits it to drive its saved/saving affordances.
 */
export type PatchSettings = (patch: SettingsPatch) => Promise<Settings>;
