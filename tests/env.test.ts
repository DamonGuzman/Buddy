import { describe, expect, it } from 'vitest';
import {
  helperBuddyModelOverride,
  bobIdleMsOverride,
  captureTestOutDir,
  debugPortOverride,
  debugTokenOverride,
  devChipFlags,
  fakeMicWavPath,
  isHelperBuddyMockEnabled,
  isCaptureSelfTestEnabled,
  isCodexSubDisabled,
  isDebugEnabled,
  isPanelCaptureTestEnabled,
  isRestGroundDisabled,
  isSnapDisabled,
  keepPanelOpen,
  mockRealtimeUrl,
  phoneAudioAutostart,
  phoneAudioUrl,
  setClickyFlagNames,
  shouldImportApiKeyFromEnv,
  showPanelOnLaunch,
  testMicLabelSubstring,
  testThrowKind,
  userDataDirOverride,
} from '../src/main/env';

describe("'=== 1' boolean flags", () => {
  const cases: Array<[string, (env: NodeJS.ProcessEnv) => boolean]> = [
    ['CLICKY_NO_SNAP', isSnapDisabled],
    ['CLICKY_NO_REST_GROUND', isRestGroundDisabled],
    ['CLICKY_NO_CODEX_SUB', isCodexSubDisabled],
    ['CLICKY_DEBUG', isDebugEnabled],
    ['CLICKY_IMPORT_API_KEY_FROM_ENV', shouldImportApiKeyFromEnv],
    ['CLICKY_HELPER_BUDDY_MOCK', isHelperBuddyMockEnabled],
    ['CLICKY_SHOW_PANEL', showPanelOnLaunch],
    ['CLICKY_KEEP_PANEL_OPEN', keepPanelOpen],
    ['CLICKY_TEST_CAPTURE', isPanelCaptureTestEnabled],
    ['CLICKY_CAPTURE_TEST', isCaptureSelfTestEnabled],
  ];

  it.each(cases)("%s: only the literal '1' enables it", (name, accessor) => {
    expect(accessor({ [name]: '1' })).toBe(true);
    // Exactly the current call sites' `=== '1'`: truthy-looking values do NOT count.
    expect(accessor({ [name]: 'true' })).toBe(false);
    expect(accessor({ [name]: '0' })).toBe(false);
    expect(accessor({ [name]: '' })).toBe(false);
    expect(accessor({})).toBe(false);
  });
});

describe('set-and-non-empty string flags', () => {
  const cases: Array<[string, (env: NodeJS.ProcessEnv) => string | null]> = [
    ['CLICKY_USER_DATA', userDataDirOverride],
    ['CLICKY_FAKE_MIC', fakeMicWavPath],
    ['CLICKY_TEST_MIC', testMicLabelSubstring],
    ['CLICKY_TEST_THROW', testThrowKind],
    ['CLICKY_HELPER_BUDDY_MODEL', helperBuddyModelOverride],
    ['CLICKY_MOCK_URL', mockRealtimeUrl],
    ['CLICKY_DEBUG_TOKEN', debugTokenOverride],
  ];

  it.each(cases)('%s: value when set, null when unset or empty', (name, accessor) => {
    expect(accessor({ [name]: 'some-value' })).toBe('some-value');
    expect(accessor({ [name]: '' })).toBeNull();
    expect(accessor({})).toBeNull();
  });
});

describe('debugPortOverride', () => {
  it('accepts positive integers only', () => {
    expect(debugPortOverride({ CLICKY_DEBUG_PORT: '8123' })).toBe(8123);
    expect(debugPortOverride({ CLICKY_DEBUG_PORT: '0' })).toBeNull();
    expect(debugPortOverride({ CLICKY_DEBUG_PORT: '-1' })).toBeNull();
    expect(debugPortOverride({ CLICKY_DEBUG_PORT: '81.5' })).toBeNull();
    expect(debugPortOverride({ CLICKY_DEBUG_PORT: 'nope' })).toBeNull();
    // Number('') === 0 — falls back like the current debug-server.ts read.
    expect(debugPortOverride({ CLICKY_DEBUG_PORT: '' })).toBeNull();
    expect(debugPortOverride({})).toBeNull();
  });
});

describe('bobIdleMsOverride', () => {
  it('accepts finite values > 0 (non-integers allowed, matching Number())', () => {
    expect(bobIdleMsOverride({ CLICKY_BOB_IDLE_MS: '500' })).toBe(500);
    expect(bobIdleMsOverride({ CLICKY_BOB_IDLE_MS: '0.5' })).toBe(0.5);
    expect(bobIdleMsOverride({ CLICKY_BOB_IDLE_MS: '0' })).toBeNull();
    expect(bobIdleMsOverride({ CLICKY_BOB_IDLE_MS: '-5' })).toBeNull();
    expect(bobIdleMsOverride({ CLICKY_BOB_IDLE_MS: 'soon' })).toBeNull();
    expect(bobIdleMsOverride({})).toBeNull();
  });
});

describe('captureTestOutDir', () => {
  it('returns the RAW value: an explicit empty string is respected', () => {
    // Documented inconsistency — the call site applies `??`, not truthiness.
    expect(captureTestOutDir({ CLICKY_CAPTURE_OUT: 'C:\\out' })).toBe('C:\\out');
    expect(captureTestOutDir({ CLICKY_CAPTURE_OUT: '' })).toBe('');
    expect(captureTestOutDir({})).toBeUndefined();
  });
});

describe('phoneAudioUrl', () => {
  it("trims and defaults to ''", () => {
    expect(phoneAudioUrl({ CLICKY_PHONE_AUDIO_URL: ' ws://127.0.0.1:3211/clicky ' })).toBe(
      'ws://127.0.0.1:3211/clicky',
    );
    expect(phoneAudioUrl({ CLICKY_PHONE_AUDIO_URL: '   ' })).toBe('');
    expect(phoneAudioUrl({})).toBe('');
  });
});

describe('phoneAudioAutostart', () => {
  it("is an exact '1' opt-in and defaults off", () => {
    expect(phoneAudioAutostart({ CLICKY_PHONE_AUDIO_AUTOSTART: '1' })).toBe(true);
    expect(phoneAudioAutostart({ CLICKY_PHONE_AUDIO_AUTOSTART: '0' })).toBe(false);
    expect(phoneAudioAutostart({ CLICKY_PHONE_AUDIO_AUTOSTART: 'yes' })).toBe(false);
    expect(phoneAudioAutostart({ CLICKY_PHONE_AUDIO_AUTOSTART: '' })).toBe(false);
    expect(phoneAudioAutostart({})).toBe(false);
  });
});

describe('dev-flag inventories', () => {
  const env: NodeJS.ProcessEnv = {
    CLICKY_MOCK_URL: 'ws://127.0.0.1:8123',
    CLICKY_DEBUG: '1',
    CLICKY_NO_SNAP: '1',
    CLICKY_EMPTY: '',
    PATH: 'C:\\Windows',
  };

  it('setClickyFlagNames: full names of set (non-empty) flags, sorted', () => {
    expect(setClickyFlagNames(env)).toEqual(['CLICKY_DEBUG', 'CLICKY_MOCK_URL', 'CLICKY_NO_SNAP']);
  });

  it('devChipFlags: excludes CLICKY_DEBUG, strips prefix, lowercases, sorts', () => {
    expect(devChipFlags(env)).toEqual(['mock_url', 'no_snap']);
  });

  it('both return [] when nothing is set', () => {
    expect(setClickyFlagNames({ PATH: 'x' })).toEqual([]);
    expect(devChipFlags({ PATH: 'x' })).toEqual([]);
  });
});
