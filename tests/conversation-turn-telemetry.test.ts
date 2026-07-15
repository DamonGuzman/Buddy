/**
 * TurnTelemetry unit tests: turn record lifecycle (begin/discard + capped
 * history + journal mirroring), playback-stats accumulation, the M8.5
 * barge-in stop-time derivation (playback-tap wall time when exact, wall
 * clock as fallback), and the pure usage accumulator.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { accumulateUsage, TurnTelemetry } from '../src/main/conversation/turn-telemetry';
import type { RecorderPort } from '../src/main/conversation/ports';
import type { PlaybackStatsUpdate, TurnTimings } from '../src/shared/types';

function fakeRecorder(): { recorder: RecorderPort; events: { type: string; payload: unknown }[] } {
  const events: { type: string; payload: unknown }[] = [];
  return {
    events,
    recorder: {
      record: (type, payload) => {
        events.push({ type, payload });
      },
      recordSettings: () => {},
      recordCaptures: () => {},
      appendAudio: () => {},
      flush: () => {},
    },
  };
}

function stats(over: Partial<PlaybackStatsUpdate>): PlaybackStatsUpdate {
  return {
    itemId: 'item_1',
    samplesPlayed: 0,
    rms: 0,
    peak: 0,
    underruns: 0,
    firstPlayedAt: 0,
    done: false,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TurnTelemetry', () => {
  it('beginTurn mints sequential turn ids, journals, and discardActiveTurn erases the record', () => {
    const { recorder, events } = fakeRecorder();
    const telemetry = new TurnTelemetry(recorder);
    const first = telemetry.beginTurn('voice');
    expect(first).toMatchObject({ turnId: 'turn_1', kind: 'voice', chunksIn: 0, chunksOut: 0 });
    expect(telemetry.active()).toBe(first);
    expect(events.at(-1)).toMatchObject({ type: 'turn_started' });

    telemetry.discardActiveTurn();
    expect(telemetry.active()).toBeNull();
    expect(telemetry.history()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn_discarded' });

    // The sequence keeps counting across discards.
    expect(telemetry.beginTurn('text').turnId).toBe('turn_2');
  });

  it('lastTurnTimings/history return copies, oldest first', () => {
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    turn.tHoldStart = 123;
    const copy = telemetry.lastTurnTimings();
    expect(copy).not.toBe(turn);
    expect(copy).toMatchObject({ turnId: 'turn_1', tHoldStart: 123 });
    telemetry.beginTurn('text');
    expect(telemetry.history().map((t) => t.turnId)).toEqual(['turn_1', 'turn_2']);
  });

  it('noteAudioDelta stamps first-delta time, counts chunks, and owns the item', () => {
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    telemetry.noteAudioDelta('item_a');
    telemetry.noteAudioDelta('item_a');
    expect(turn.tFirstAudioDelta).toBeTypeOf('number');
    expect(turn.chunksOut).toBe(2);
    // Ownership drives the interrupted-playback lookup.
    telemetry.recordPlaybackStats(stats({ itemId: 'item_a', samplesPlayed: 240 }));
    expect(telemetry.findInterruptedPlayback()?.itemId).toBe('item_a');
  });

  it('stamps tFirstAudioPlayed from the first actually-played stats of an owned item', () => {
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    telemetry.noteAudioDelta('item_a');
    telemetry.recordPlaybackStats(stats({ itemId: 'other', samplesPlayed: 100, firstPlayedAt: 1 }));
    expect(turn.tFirstAudioPlayed).toBeUndefined(); // not this turn's item
    telemetry.recordPlaybackStats(
      stats({ itemId: 'item_a', samplesPlayed: 100, firstPlayedAt: 7_000 }),
    );
    expect(turn.tFirstAudioPlayed).toBe(7_000);
  });

  it('bargeWatch: derives the stop moment from the playback tap when exact', () => {
    vi.useFakeTimers({ now: 10_000 });
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    telemetry.noteAudioDelta('item_a');
    telemetry.armBargeWatch(); // t0 = 10_000
    // 24_000 samples @24kHz = 1000ms rendered from firstPlayedAt 9_500.
    telemetry.recordPlaybackStats(
      stats({ itemId: 'item_a', samplesPlayed: 24_000, firstPlayedAt: 9_500, done: true }),
    );
    // renderedStopAt = 9_500 + 1_000 = 10_500 -> 500ms after the cancel.
    expect(turn.bargeInStopMs).toBe(500);
  });

  it('bargeWatch: falls back to wall time when underruns make the tap inexact', () => {
    vi.useFakeTimers({ now: 10_000 });
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    telemetry.noteAudioDelta('item_a');
    telemetry.armBargeWatch();
    vi.setSystemTime(10_240);
    telemetry.recordPlaybackStats(
      stats({
        itemId: 'item_a',
        samplesPlayed: 24_000,
        firstPlayedAt: 9_500,
        underruns: 2,
        done: true,
      }),
    );
    expect(turn.bargeInStopMs).toBe(240); // Date.now() - t0
  });

  it('armBargeWatch is a no-op for a turn with no audible items', () => {
    vi.useFakeTimers({ now: 10_000 });
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    telemetry.armBargeWatch();
    telemetry.recordPlaybackStats(stats({ itemId: 'item_a', done: true }));
    expect(turn.bargeInStopMs).toBeUndefined();
  });

  it('armBargeWatchIfStillPlaying arms only when an owned item is mid-play', () => {
    vi.useFakeTimers({ now: 10_000 });
    const telemetry = new TurnTelemetry(null);
    const turn = telemetry.beginTurn('voice');
    telemetry.noteAudioDelta('item_a');
    telemetry.recordPlaybackStats(stats({ itemId: 'item_a', samplesPlayed: 240, done: true }));
    telemetry.armBargeWatchIfStillPlaying(); // already done: no watch
    telemetry.recordPlaybackStats(stats({ itemId: 'item_a', done: true }));
    expect(turn.bargeInStopMs).toBeUndefined();

    telemetry.noteAudioDelta('item_b');
    telemetry.recordPlaybackStats(stats({ itemId: 'item_b', samplesPlayed: 240 }));
    telemetry.armBargeWatchIfStillPlaying(); // mid-play: watch armed
    vi.setSystemTime(10_100);
    telemetry.recordPlaybackStats(stats({ itemId: 'item_b', samplesPlayed: 240, done: true }));
    expect(turn.bargeInStopMs).toBe(100);
  });

  it('journals playback_stats only on final (done) updates', () => {
    const { recorder, events } = fakeRecorder();
    const telemetry = new TurnTelemetry(recorder);
    telemetry.recordPlaybackStats(stats({ itemId: 'a' }));
    expect(events.filter((e) => e.type === 'playback_stats')).toHaveLength(0);
    telemetry.recordPlaybackStats(stats({ itemId: 'a', done: true }));
    expect(events.filter((e) => e.type === 'playback_stats')).toHaveLength(1);
  });
});

describe('accumulateUsage', () => {
  it('initializes on first use and sums snake_case usage blocks per response', () => {
    const turn: TurnTimings = { turnId: 'turn_1', kind: 'voice', chunksIn: 0, chunksOut: 0 };
    accumulateUsage(turn, {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_token_details: { text_tokens: 4, audio_tokens: 5, image_tokens: 1, cached_tokens: 2 },
      output_token_details: { text_tokens: 8, audio_tokens: 12 },
    });
    accumulateUsage(turn, { input_tokens: 1, output_token_details: { audio_tokens: 3 } });

    expect(turn.usage).toEqual({
      inputTokens: 11,
      outputTokens: 20,
      totalTokens: 30,
      inputTextTokens: 4,
      inputAudioTokens: 5,
      inputImageTokens: 1,
      cachedTokens: 2,
      outputTextTokens: 8,
      outputAudioTokens: 15,
      responses: 2,
    });
  });
});
