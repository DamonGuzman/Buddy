import { describe, expect, it } from 'vitest';
import {
  actionableErrorIdentity,
  mergeActionableErrorState,
} from '../src/renderer/panel/actionable-error-state';
import {
  settingsTargetForPatch,
  visibleSettingsSection,
} from '../src/renderer/panel/components/settings/error-routing';
import type { ActionableErrorState } from '../src/shared/types';

const state = (revision: number, kind: 'no_api_key' | 'mic_unavailable'): ActionableErrorState => ({
  revision,
  notice: {
    kind,
    message: 'repair this',
    target: kind === 'no_api_key' ? 'openai' : 'microphone',
    occurredAt: 1,
  },
});

describe('actionable Settings error state', () => {
  it('does not let a delayed bootstrap snapshot overwrite a newer push', () => {
    expect(mergeActionableErrorState(state(4, 'mic_unavailable'), state(3, 'no_api_key'))).toEqual(
      state(4, 'mic_unavailable'),
    );
    expect(mergeActionableErrorState(state(3, 'no_api_key'), state(4, 'mic_unavailable'))).toEqual(
      state(4, 'mic_unavailable'),
    );
  });

  it('creates an identity for one exact actionable revision', () => {
    expect(actionableErrorIdentity(state(4, 'mic_unavailable'))).toEqual({
      revision: 4,
      kind: 'mic_unavailable',
    });
    expect(actionableErrorIdentity(state(4, 'mic_unavailable'), ['no_api_key'])).toBeNull();
  });

  it('routes every failed settings patch to the card containing its control', () => {
    expect(settingsTargetForPatch({ apiKey: 'sk-example-credential-123456' })).toBe('openai');
    expect(settingsTargetForPatch({ micDeviceId: 'device-1' })).toBe('microphone');
    expect(settingsTargetForPatch({ captionsEnabled: false })).toBe('voice');
    expect(settingsTargetForPatch({ computerUseEnabled: true })).toBe('chatgpt');
  });

  it('never routes the banner button to a section absent on this platform', () => {
    expect(visibleSettingsSection('permissions', true)).toBe('permissions');
    expect(visibleSettingsSection('permissions', false)).toBeNull();
    expect(visibleSettingsSection('permissions', false, 'mic_unavailable')).toBe('microphone');
    expect(visibleSettingsSection('settings', true)).toBeNull();
    expect(visibleSettingsSection('openai', false)).toBe('openai');
  });
});
