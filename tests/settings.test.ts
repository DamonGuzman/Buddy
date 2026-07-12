/**
 * Settings schema unit tests (pure shared logic — no Electron needed).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, applySettingsPatch } from '../src/shared/types';
import type { Settings, SettingsPatch } from '../src/shared/types';

describe('settings schema', () => {
  it('has safe defaults (no api key, full model for pointing accuracy, captions on)', () => {
    expect(DEFAULT_SETTINGS.apiKeyPresent).toBe(false);
    // M8.6: full model is the default — mini's pointing accuracy failed the
    // live eval gates by a wide margin (docs/EVAL.md §8).
    expect(DEFAULT_SETTINGS.model).toBe('gpt-realtime-2.1');
    expect(DEFAULT_SETTINGS.captionsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.micDeviceId).toBe('');
    // F1 (AltGr): only LEFT Alt participates, and the label says so.
    expect(DEFAULT_SETTINGS.hotkeyLabel).toBe('Ctrl+Alt (left alt)');
  });

  it('round-trips defaults through JSON unchanged', () => {
    const roundTripped = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
    expect(roundTripped).toEqual(DEFAULT_SETTINGS);
  });

  it('applies a full patch and never leaks a raw key', () => {
    const patch: SettingsPatch = {
      apiKey: 'sk-secret',
      model: 'gpt-realtime-2.1',
      voice: 'cedar',
      captionsEnabled: false,
      micDeviceId: 'mic-42',
    };
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expect(next).toEqual({
      apiKeyPresent: true,
      apiKeyUnreadable: false, // M11: a stored key always resolves an unreadable blob
      model: 'gpt-realtime-2.1',
      voice: 'cedar',
      captionsEnabled: false,
      micDeviceId: 'mic-42',
      hotkeyLabel: 'Ctrl+Alt (left alt)',
      // M15 addition (orchestrator-approved): buddyRest rides along untouched.
      buddyRest: null,
    });
    // the renderer-safe view must never contain the key itself
    expect(JSON.stringify(next)).not.toContain('sk-secret');
  });

  it('clears the key presence flag when apiKey is null', () => {
    const withKey = applySettingsPatch(DEFAULT_SETTINGS, { apiKey: 'sk-x' });
    const cleared = applySettingsPatch(withKey, { apiKey: null });
    expect(cleared.apiKeyPresent).toBe(false);
  });

  it('leaves untouched fields alone on partial patches', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { voice: 'cedar' });
    expect(next.model).toBe(DEFAULT_SETTINGS.model);
    expect(next.captionsEnabled).toBe(DEFAULT_SETTINGS.captionsEnabled);
    expect(next.apiKeyPresent).toBe(false);
    expect(next.voice).toBe('cedar');
  });

  it('does not mutate the input object', () => {
    const before = { ...DEFAULT_SETTINGS };
    applySettingsPatch(DEFAULT_SETTINGS, { captionsEnabled: false });
    expect(DEFAULT_SETTINGS).toEqual(before);
  });
});
