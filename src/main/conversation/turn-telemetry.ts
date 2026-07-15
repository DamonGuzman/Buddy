/**
 * Per-turn telemetry (M8.5 audio-experience eval): the active TurnTimings
 * record, its bounded history, per-item playback stats from the panel's
 * playback tap, the played-audio ring, and the barge-in stop-time watch.
 *
 * State + pure accumulation only. The recorder mirror (turn_started /
 * turn_discarded / playback_stats journal events) is the single side effect,
 * injected as a port so this stays unit-testable.
 */

import { AUDIO_SAMPLE_RATE } from '../../shared/constants';
import type { PlaybackStatsUpdate, TurnTimings, TurnUsage } from '../../shared/types';
import type { ResponseUsage } from '../realtime/protocol';
import { pushCapped } from '../util/guards';
import { OUTPUT_STATS_LIMIT, TIMINGS_HISTORY_LIMIT } from './constants';
import type { RecorderPort } from './ports';

/** Barge-in in flight: cancel requested, waiting for playback to stop. */
interface BargeWatch {
  t0: number;
  itemIds: Set<string>;
  turn: TurnTimings;
}

/**
 * M8.5 live eval: accumulate one response.done usage block onto the turn
 * (a tool-call continuation is a second response, so a turn can have many).
 */
export function accumulateUsage(turn: TurnTimings, usage: ResponseUsage): void {
  const u: TurnUsage = (turn.usage ??= {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTextTokens: 0,
    inputAudioTokens: 0,
    inputImageTokens: 0,
    cachedTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
    responses: 0,
  });
  u.inputTokens += usage.input_tokens ?? 0;
  u.outputTokens += usage.output_tokens ?? 0;
  u.totalTokens += usage.total_tokens ?? 0;
  u.inputTextTokens += usage.input_token_details?.text_tokens ?? 0;
  u.inputAudioTokens += usage.input_token_details?.audio_tokens ?? 0;
  u.inputImageTokens += usage.input_token_details?.image_tokens ?? 0;
  u.cachedTokens += usage.input_token_details?.cached_tokens ?? 0;
  u.outputTextTokens += usage.output_token_details?.text_tokens ?? 0;
  u.outputAudioTokens += usage.output_token_details?.audio_tokens ?? 0;
  u.responses += 1;
}

export class TurnTelemetry {
  /** The turn currently accumulating timings (stays set until the next turn). */
  private activeTurn: TurnTimings | null = null;
  private turnSeq = 0;
  private timingsHistory: TurnTimings[] = [];
  /** Response item ids whose audio belongs to the active turn. */
  private turnAudioItems = new Set<string>();
  private bargeWatch: BargeWatch | null = null;
  /** Latest per-item playback stats from the panel's playback tap. */
  private outputStatsList: PlaybackStatsUpdate[] = [];
  /** Last ~15s of PLAYED audio (Int16 PCM 24kHz mono) from the panel. */
  private outputRing: ArrayBuffer | null = null;

  constructor(private readonly recorder: RecorderPort | null) {}

  /** The live (mutable) active turn record, or null. */
  active(): TurnTimings | null {
    return this.activeTurn;
  }

  /** Timings of the most recent turn (may still be filling in). */
  lastTurnTimings(): TurnTimings | null {
    return this.activeTurn ? { ...this.activeTurn } : null;
  }

  /** Recent turn timings, oldest first (includes the active turn). */
  history(): TurnTimings[] {
    return this.timingsHistory.map((t) => ({ ...t }));
  }

  /** Latest per-item playback stats reported by the panel's playback tap. */
  outputStats(): PlaybackStatsUpdate[] {
    return this.outputStatsList.map((s) => ({ ...s }));
  }

  /** Last ~15s of played audio (Int16 PCM 24kHz mono), if reported yet. */
  lastOutputRing(): ArrayBuffer | null {
    return this.outputRing;
  }

  setOutputRing(ring: ArrayBuffer): void {
    this.outputRing = ring;
  }

  /** Start a new TurnTimings record and make it the active turn. */
  beginTurn(kind: TurnTimings['kind']): TurnTimings {
    this.turnSeq += 1;
    const turn: TurnTimings = {
      turnId: `turn_${this.turnSeq}`,
      kind,
      chunksIn: 0,
      chunksOut: 0,
    };
    this.activeTurn = turn;
    this.turnAudioItems = new Set();
    this.timingsHistory = pushCapped(this.timingsHistory, turn, TIMINGS_HISTORY_LIMIT);
    this.recorder?.record('turn_started', turn);
    return turn;
  }

  /** Short/silent hold produced no turn: drop the record entirely. */
  discardActiveTurn(): void {
    if (!this.activeTurn) return;
    this.recorder?.record('turn_discarded', this.activeTurn);
    this.recorder?.flush();
    const idx = this.timingsHistory.indexOf(this.activeTurn);
    if (idx !== -1) this.timingsHistory.splice(idx, 1);
    this.activeTurn = null;
    this.turnAudioItems = new Set();
  }

  /** An audio delta arrived for the active turn: stamps + item ownership. */
  noteAudioDelta(itemId: string): void {
    if (!this.activeTurn) return;
    if (this.activeTurn.tFirstAudioDelta === undefined) {
      this.activeTurn.tFirstAudioDelta = Date.now();
    }
    this.activeTurn.chunksOut += 1;
    this.turnAudioItems.add(itemId);
  }

  /**
   * M8.5: arm the barge-in watch — measure cancel -> playback-actually-stopped
   * on the turn being cancelled (only when it has audible items).
   */
  armBargeWatch(): void {
    if (this.activeTurn && this.turnAudioItems.size > 0) {
      this.bargeWatch = {
        t0: Date.now(),
        itemIds: new Set(this.turnAudioItems),
        turn: this.activeTurn,
      };
    }
  }

  /**
   * Live-eval fix (M8.5): the residual-playback variant — arm the watch only
   * when the old turn's audio is genuinely still mid-play.
   */
  armBargeWatchIfStillPlaying(): void {
    const stillPlaying = this.outputStatsList.some(
      (s) => this.turnAudioItems.has(s.itemId) && !s.done,
    );
    if (stillPlaying && this.activeTurn) {
      this.bargeWatch = {
        t0: Date.now(),
        itemIds: new Set(this.turnAudioItems),
        turn: this.activeTurn,
      };
    }
  }

  /** The newest still-playing item of the active turn (VAD barge-in truncate). */
  findInterruptedPlayback(): PlaybackStatsUpdate | undefined {
    return this.outputStatsList
      .slice()
      .reverse()
      .find((stats) => this.turnAudioItems.has(stats.itemId) && !stats.done);
  }

  /** 'audio:playback-stats' payload from the panel renderer. */
  recordPlaybackStats(stats: PlaybackStatsUpdate): void {
    const idx = this.outputStatsList.findIndex((s) => s.itemId === stats.itemId);
    if (idx === -1) {
      this.outputStatsList = pushCapped(this.outputStatsList, stats, OUTPUT_STATS_LIMIT);
    } else {
      this.outputStatsList[idx] = stats;
    }
    // First actually-played audio of the active turn.
    if (
      this.activeTurn &&
      this.activeTurn.tFirstAudioPlayed === undefined &&
      this.turnAudioItems.has(stats.itemId) &&
      stats.samplesPlayed > 0
    ) {
      this.activeTurn.tFirstAudioPlayed = stats.firstPlayedAt || Date.now();
    }
    // Barge-in: playback of the cancelled turn's item actually stopped.
    // Release-QA fix: derive the stop moment from the playback tap (wall time
    // of the last rendered sample) instead of Date.now() here — the hotkey
    // press also kicks the screenshot resize/JPEG crunch in main, which
    // delays THIS handler by 100-300ms on a 4K display and used to inflate
    // the metric with pure main-loop congestion (renderer stops in ~10-20ms).
    // firstPlayedAt + samples/rate is exact when underruns == 0 (barge-in
    // items in practice); with underruns it undercounts, so fall back.
    if (this.bargeWatch && stats.done && this.bargeWatch.itemIds.has(stats.itemId)) {
      const renderedStopAt = stats.firstPlayedAt + (stats.samplesPlayed / AUDIO_SAMPLE_RATE) * 1000;
      this.bargeWatch.turn.bargeInStopMs =
        stats.underruns === 0 && stats.firstPlayedAt > 0
          ? Math.max(0, Math.round(renderedStopAt - this.bargeWatch.t0))
          : Date.now() - this.bargeWatch.t0;
      this.bargeWatch = null;
    }
    if (stats.done) this.recorder?.record('playback_stats', stats);
  }
}
