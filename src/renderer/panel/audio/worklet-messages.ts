/**
 * Typed message contracts for the two audio worklets. The worklet files are
 * plain JS loaded standalone via `audioWorklet.addModule` (they cannot import
 * this module), so these types mirror — by hand — the shapes documented in
 * `../worklets/*.worklet.js`, and `parsePlayerWorkletMessage` is the single
 * owner of the narrowing that used to be an `e.data as PlayedBlock` cast.
 */

// ---- pcm-capture worklet ---------------------------------------------------

/**
 * Sent TO the capture worklet at the start of each hold: drop any partial
 * chunk left over from the previous turn.
 */
export interface CaptureWorkletReset {
  type: 'reset';
}

// The capture worklet posts raw `ArrayBuffer` chunks (Int16 PCM LE) back to
// the main thread — no envelope, so its output needs no narrowing.

// ---- pcm-player worklet ----------------------------------------------------

/** Sent TO the player worklet: append Float32 samples for a response item. */
export interface PlayerWorkletChunk {
  type: 'chunk';
  /** Float32 samples (transferred). */
  samples: ArrayBuffer;
  itemId: string;
}

/** Sent TO the player worklet: drop everything queued, immediately. */
export interface PlayerWorkletClear {
  type: 'clear';
}

export type PlayerWorkletCommand = PlayerWorkletChunk | PlayerWorkletClear;

/** M8.5 playback tap: samples the worklet ACTUALLY rendered for an item. */
export interface PlayedBlock {
  type: 'played';
  itemId: string;
  /** Float32 samples as rendered. */
  samples: ArrayBuffer;
  /** Mid-item silence gaps that later resumed (queue starvation). */
  underruns: number;
  /** Epoch ms when the item's first sample hit the output. */
  firstPlayedAt: number;
  /** Final block: item drained, was superseded, or was cleared. */
  done: boolean;
}

/** The player worklet's queue just ran empty (playback ended). */
export interface PlayerWorkletDrained {
  type: 'drained';
}

export type PlayerWorkletMessage = PlayedBlock | PlayerWorkletDrained;

/** Narrow an untyped player-worklet port message; null when unrecognized. */
export function parsePlayerWorkletMessage(data: unknown): PlayerWorkletMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const tag = (data as { type?: unknown }).type;
  if (tag === 'drained') return { type: 'drained' };
  if (tag === 'played') {
    const block = data as Partial<PlayedBlock>;
    if (typeof block.itemId === 'string' && block.samples instanceof ArrayBuffer) {
      return data as PlayedBlock;
    }
  }
  return null;
}
