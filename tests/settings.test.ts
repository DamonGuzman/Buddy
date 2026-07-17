/**
 * Settings schema unit tests (pure shared logic — no Electron needed).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PATCHABLE_KEYS, applySettingsPatch } from '../src/shared/types';
import type { Settings, SettingsPatch } from '../src/shared/types';

describe('settings schema', () => {
  it('has safe defaults (no api key, full model for pointing accuracy, captions on)', () => {
    expect(DEFAULT_SETTINGS.apiKeyPresent).toBe(false);
    expect(DEFAULT_SETTINGS.firecrawlApiKeyPresent).toBe(false);
    // M8.6: full model is the default — mini's pointing accuracy failed the
    // live eval gates by a wide margin (docs/EVAL.md §8).
    expect(DEFAULT_SETTINGS.model).toBe('gpt-realtime-2.1');
    expect(DEFAULT_SETTINGS.captionsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.micDeviceId).toBe('');
    expect(DEFAULT_SETTINGS.fullRealtimeMode).toBe(false);
    expect(DEFAULT_SETTINGS.computerUseEnabled).toBe(false);
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
      fullRealtimeMode: true,
      computerUseEnabled: true,
    };
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch);
    expect(next).toEqual({
      apiKeyPresent: true,
      apiKeyUnreadable: false, // M11: a stored key always resolves an unreadable blob
      firecrawlApiKeyPresent: false,
      firecrawlApiKeyUnreadable: false,
      model: 'gpt-realtime-2.1',
      voice: 'cedar',
      captionsEnabled: false,
      micDeviceId: 'mic-42',
      fullRealtimeMode: true,
      // M20: whisper quiet mode rides along untouched (not in this patch).
      voiceMuted: false,
      hotkeyLabel: 'Ctrl+Alt (left alt)',
      // M15 addition (orchestrator-approved): buddyRest rides along untouched.
      buddyRest: null,
      // M17 (integration): the main-owned codex* sign-in fields ride along
      // unchanged from the defaults (not patchable from the renderer).
      codexSignedIn: false,
      codexValid: false,
      codexPlanType: '',
      preferApiKeyGrounding: false,
      computerUseEnabled: true,
    });
    // the renderer-safe view must never contain the key itself
    expect(JSON.stringify(next)).not.toContain('sk-secret');
  });

  it('clears the key presence flag when apiKey is null', () => {
    const withKey = applySettingsPatch(DEFAULT_SETTINGS, { apiKey: 'sk-x' });
    const cleared = applySettingsPatch(withKey, { apiKey: null });
    expect(cleared.apiKeyPresent).toBe(false);
  });

  it('tracks the write-only Firecrawl key without leaking it', () => {
    const withKey = applySettingsPatch(DEFAULT_SETTINGS, {
      firecrawlApiKey: 'fc-secret-value',
    });
    expect(withKey.firecrawlApiKeyPresent).toBe(true);
    expect(withKey.firecrawlApiKeyUnreadable).toBe(false);
    expect(JSON.stringify(withKey)).not.toContain('fc-secret-value');
    expect(applySettingsPatch(withKey, { firecrawlApiKey: null }).firecrawlApiKeyPresent).toBe(
      false,
    );
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

  it('applies buddyRest patches, including the null reset (M15)', () => {
    const rest = { screenIndex: 1, xFrac: 0.25, yFrac: 0.75 };
    const moved = applySettingsPatch(DEFAULT_SETTINGS, { buddyRest: rest });
    expect(moved.buddyRest).toEqual(rest);
    const reset = applySettingsPatch(moved, { buddyRest: null });
    expect(reset.buddyRest).toBeNull();
  });

  it('storing a new key resolves an unreadable blob (M11)', () => {
    const unreadable: Settings = {
      ...DEFAULT_SETTINGS,
      apiKeyPresent: true,
      apiKeyUnreadable: true,
    };
    const next = applySettingsPatch(unreadable, { apiKey: 'sk-new' });
    expect(next.apiKeyPresent).toBe(true);
    expect(next.apiKeyUnreadable).toBe(false);
  });

  it('drives the merge from PATCHABLE_KEYS (no dupes, never the write-only apiKey)', () => {
    expect(new Set(PATCHABLE_KEYS).size).toBe(PATCHABLE_KEYS.length);
    expect(PATCHABLE_KEYS).not.toContain('apiKey');
    expect(PATCHABLE_KEYS).not.toContain('firecrawlApiKey');
    // main-owned codex* sign-in fields must never be renderer-patchable
    for (const key of PATCHABLE_KEYS) {
      expect(key.startsWith('codex')).toBe(false);
    }
  });
});
