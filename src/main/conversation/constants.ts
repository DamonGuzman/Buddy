/**
 * Conversation-package tuning constants and user-facing context copy. Values
 * are part of observed behavior (timings, ring sizes, exact prompt strings) —
 * do not change without an explicit behavior-change task.
 */

import { AUDIO_SAMPLE_RATE, AUDIO_BYTES_PER_SAMPLE } from '../../shared/constants';

/** Holds shorter than this are treated as accidental taps (no turn). */
export const MIN_HOLD_MS = 250;
/**
 * M9 fix: minimum APPENDED mic audio for a commit. The live API rejects
 * commits under 100ms ("buffer too small") and the rejected turn used to
 * wedge the session. A hold can pass the 250ms guard yet carry almost no
 * audio (mic spin-up after a barge-in tap), so the commit itself is gated on
 * what was actually appended. 200ms = 2x the server minimum.
 */
export const MIN_COMMIT_AUDIO_MS = 200;
/** PCM16 mono bytes per millisecond (24kHz * 2 bytes / 1000). */
export const AUDIO_BYTES_PER_MS = (AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE) / 1000;
/** Grace after response.done before dropping back to idle. */
export const IDLE_GRACE_MS = 300;
/** Error state auto-recovers to idle after this long. */
export const ERROR_RECOVERY_MS = 4_000;
/**
 * State-machine safety net: 'thinking'/'speaking' held this long with no open
 * response and no foreground work is a leak (lost response.done, dropped
 * socket without an error event) — force-land back to the base state. Kept
 * far above any legitimate wait (captures take ~2s; real long turns keep
 * pendingResponses > 0 or an active text run, which re-arms the watchdog).
 */
export const STUCK_STATE_RECOVERY_MS = 20_000;
/** Transcript ring buffer size (also what GET /transcript returns). */
export const TRANSCRIPT_LIMIT = 50;
/** Pointer commands kept for the debug harness. */
export const POINTER_HISTORY_LIMIT = 10;
// M8.5 additions (orchestrator-approved): audio-experience eval instrumentation.
/** Turn timings kept for GET /timings. */
export const TIMINGS_HISTORY_LIMIT = 20;
/** Per-item playback stats kept for GET /audio/output-stats. */
export const OUTPUT_STATS_LIMIT = 20;
// M11 additions: error-catalog surfacing.
/**
 * One failure often fires two surfacing paths within milliseconds (a server
 * `error` event followed by the synthesized failed response-done). Error
 * (pill-grade) transcript entries within this window collapse into the FIRST
 * one — which carries the more specific classification.
 */
export const ERROR_DEDUPE_MS = 1_500;
/** Factual context sent with a turn whose screenshot capture failed. */
export const CAPTURE_FAILED_CONTEXT =
  'screen capture failed for this turn — you have NO screenshots. answer from the words ' +
  'alone, say you could not see the screen if it matters, and never call point_at.';
/** Guard on the tool-output continue loop of a single text turn. */
export const MAX_CODEX_CONTINUES = 8;
