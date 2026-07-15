import { describe, expect, it } from 'vitest';
import { resolvePhoneAudioConfiguration } from '../src/main/phone-audio-config';
import { DEFAULT_PHONE_AUDIO_URL } from '../src/main/phone-audio-bridge-supervisor';

describe('resolvePhoneAudioConfiguration', () => {
  it.each<NodeJS.Platform>(['darwin', 'win32'])(
    'uses the production panel mic by default on %s',
    (platform) => {
      expect(
        resolvePhoneAudioConfiguration({
          explicitUrl: '',
          autostartBundledBridge: false,
          platform,
        }),
      ).toEqual({ kind: 'panel' });
    },
  );

  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])(
    'preserves an explicitly managed remote bridge on %s',
    (platform) => {
      expect(
        resolvePhoneAudioConfiguration({
          explicitUrl: 'wss://phone-audio.example.test/buddy',
          autostartBundledBridge: true,
          platform,
        }),
      ).toEqual({ kind: 'remote', url: 'wss://phone-audio.example.test/buddy' });
    },
  );

  it('allows explicit bundled-bridge autostart on Windows', () => {
    expect(
      resolvePhoneAudioConfiguration({
        explicitUrl: '',
        autostartBundledBridge: true,
        platform: 'win32',
      }),
    ).toEqual({ kind: 'bundled', url: DEFAULT_PHONE_AUDIO_URL });
  });

  it.each<NodeJS.Platform>(['darwin', 'linux'])(
    'fails fast when bundled-bridge autostart is requested on %s',
    (platform) => {
      expect(() =>
        resolvePhoneAudioConfiguration({
          explicitUrl: '',
          autostartBundledBridge: true,
          platform,
        }),
      ).toThrow(/supports Windows only/);
    },
  );
});
