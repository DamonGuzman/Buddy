/**
 * The narrow seam between the panel audio engines and the preload-exposed
 * `window.clicky` PanelApi: the engines only ever REPORT through these
 * fire-and-forget calls, so tests can inject a plain object and the engines
 * stay node-testable (no Electron/preload import at module scope).
 *
 * `clicky` satisfies this structurally — the production singletons in
 * `./engines.ts` are constructed with it.
 */

import type { AudioDeviceError, PlaybackStatsUpdate } from '../../../shared/types';

export interface PanelAudioPort {
  /** Stream a mic PCM16 chunk to main (fire-and-forget). */
  sendAudioChunk(chunk: ArrayBuffer): void;
  /** M8.5: report played-audio stats for a response item. */
  sendPlaybackStats(stats: PlaybackStatsUpdate): void;
  /** M8.5: ship the last ~15s of played audio (Int16 PCM 24kHz mono). */
  sendPlaybackRing(ring: ArrayBuffer): void;
  /** M11: report a mic/playback device failure for error-catalog classification. */
  reportAudioError(payload: AudioDeviceError): void;
}

/** The slice mic capture reports through. */
export type MicCapturePort = Pick<PanelAudioPort, 'sendAudioChunk' | 'reportAudioError'>;

/** The slice model-voice playback reports through. */
export type PlaybackPort = Pick<
  PanelAudioPort,
  'sendPlaybackStats' | 'sendPlaybackRing' | 'reportAudioError'
>;

/** The slice the playback tap reports through. */
export type PlaybackTapPort = Pick<PanelAudioPort, 'sendPlaybackStats' | 'sendPlaybackRing'>;
