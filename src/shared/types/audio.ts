/**
 * Audio pipeline types: model audio output, playback control/stats, mic
 * capture control, and audio device reporting (docs/ARCHITECTURE.md §3, §7).
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

/** A chunk of model audio output for the renderer playback queue. */
export interface AudioOutputDelta {
  /** Raw PCM16 (24kHz mono) bytes. */
  chunk: ArrayBuffer;
  /** Id of the response item, so stale chunks can be dropped after a flush. */
  itemId: string;
  /**
   * F1 fix, M2: main-owned playback epoch of the response this delta belongs
   * to. The renderer drops any delta whose epoch is older than the newest
   * 'audio:playback' flush epoch — this silences a cancelled response whose
   * first chunk never reached the renderer (no itemId to mark stale).
   * Absent on dev/QA tones (always played).
   */
  epoch?: number;
}

export type PlaybackCommand = 'stop' | 'flush';

/**
 * Playback control payload ('audio:playback'): 'stop' halts immediately;
 * 'flush' drops queued audio. F1 fix, M2: `epoch` is the new playback-epoch
 * floor — subsequent audio:output deltas tagged with an older epoch are stale
 * (they belong to a cancelled/superseded response) and are dropped.
 */
export interface PlaybackControl {
  command: PlaybackCommand;
  epoch?: number;
}

/** M5: push-to-talk mic capture command. */
export type CaptureCommand = 'start' | 'stop';

/**
 * M5: mic capture control payload ('audio:capture') — main tells the panel
 * renderer to start/stop mic capture when the hotkey goes down/up.
 */
export interface CaptureControl {
  command: CaptureCommand;
}

/**
 * M8.5: per-item playback stats reported by the panel renderer's player
 * worklet — proof that model audio was actually scheduled into the output
 * device, not just queued.
 */
export interface PlaybackStatsUpdate {
  /** Response item this audio belongs to. */
  itemId: string;
  /** Samples actually rendered to the output so far (24kHz mono). */
  samplesPlayed: number;
  /** RMS (0..1) over all samples played so far for this item. */
  rms: number;
  /** Peak |sample| (0..1) seen so far for this item. */
  peak: number;
  /** Silence gaps mid-item that later resumed (queue starvation). */
  underruns: number;
  /** Epoch ms when the first sample of this item hit the output. */
  firstPlayedAt: number;
  /** Final update: item drained, was superseded, or was cleared (barge-in). */
  done: boolean;
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

/**
 * M11: an audio device failure reported by the panel renderer — mic capture
 * failed to start ('mic') or the playback worklet/context failed to
 * initialize ('playback'). Main classifies these into mic_unavailable /
 * audio_output_failed catalog entries.
 */
export interface AudioDeviceError {
  source: 'mic' | 'playback';
  /** DOMException name when available (e.g. 'NotAllowedError'), else 'Error'. */
  name: string;
  message: string;
}
