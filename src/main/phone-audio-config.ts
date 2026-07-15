import {
  DEFAULT_PHONE_AUDIO_URL,
  unsupportedPhoneAudioBridgePlatformError,
} from './phone-audio-bridge-supervisor';

export type PhoneAudioConfiguration =
  | { kind: 'panel' }
  | { kind: 'remote'; url: string }
  | { kind: 'bundled'; url: typeof DEFAULT_PHONE_AUDIO_URL };

export interface ResolvePhoneAudioConfigurationOptions {
  explicitUrl: string;
  autostartBundledBridge: boolean;
  platform: NodeJS.Platform;
}

/**
 * Resolve the audio transport before constructing any clients or processes.
 *
 * An explicit URL always means an externally managed bridge and is valid on
 * every platform. The bundled QA bridge is a separate, exact opt-in and only
 * exists on Windows. With neither option, Buddy uses its production panel mic.
 */
export function resolvePhoneAudioConfiguration({
  explicitUrl,
  autostartBundledBridge,
  platform,
}: ResolvePhoneAudioConfigurationOptions): PhoneAudioConfiguration {
  if (explicitUrl !== '') return { kind: 'remote', url: explicitUrl };
  if (!autostartBundledBridge) return { kind: 'panel' };
  if (platform !== 'win32') throw unsupportedPhoneAudioBridgePlatformError(platform);
  return { kind: 'bundled', url: DEFAULT_PHONE_AUDIO_URL };
}
