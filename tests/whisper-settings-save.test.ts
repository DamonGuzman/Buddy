import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../src/shared/types';
import {
  saveWhisperSettings,
  WHISPER_SETTINGS_SAVE_ERROR,
} from '../src/renderer/whisper/settings-save';

describe('whisper settings persistence', () => {
  it('returns the committed snapshot', async () => {
    const committed = { voiceMuted: true } as Settings;
    const setSettings = vi.fn(async () => committed);

    await expect(saveWhisperSettings(setSettings, { voiceMuted: true })).resolves.toBe(committed);
    expect(setSettings).toHaveBeenCalledWith({ voiceMuted: true });
  });

  it('contains IPC rejection details and exposes only fixed user-safe copy', async () => {
    const setSettings = vi.fn(async () => {
      throw new Error('/private/path/settings.json contains sk-secret');
    });

    await expect(saveWhisperSettings(setSettings, { voiceMuted: true })).resolves.toBeNull();
    expect(WHISPER_SETTINGS_SAVE_ERROR).not.toContain('sk-secret');
    expect(WHISPER_SETTINGS_SAVE_ERROR).toContain('previous voice setting is unchanged');
  });
});
