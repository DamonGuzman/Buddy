/**
 * TurnGuard unit tests: episode tokens (F1 M1/m1), the activity epoch
 * (M3/M5 idle-grace guard), the playback/delta epoch pair (F1 M2), and the
 * closed-vs-token-only staleness distinction failure paths rely on.
 */

import { describe, expect, it } from 'vitest';
import { TurnGuard } from '../src/main/conversation/turn-guard';

describe('TurnGuard', () => {
  it('a new episode supersedes captured tokens', () => {
    const guard = new TurnGuard();
    const token = guard.beginEpisode();
    expect(guard.isStale(token)).toBe(false);
    expect(guard.isCurrent(token)).toBe(true);

    guard.beginEpisode();
    expect(guard.isStale(token)).toBe(true);
    expect(guard.isCurrent(token)).toBe(false);
  });

  it('close() makes every token stale, but isCurrent stays token-only', () => {
    const guard = new TurnGuard();
    const token = guard.beginEpisode();
    guard.close();
    expect(guard.closed).toBe(true);
    // Fail-soft paths still surface for the current turn during shutdown.
    expect(guard.isStale(token)).toBe(true);
    expect(guard.isCurrent(token)).toBe(true);
  });

  it('epoch bumps invalidate an idle-grace snapshot', () => {
    const guard = new TurnGuard();
    const snapshot = guard.epoch();
    expect(guard.epoch()).toBe(snapshot);
    guard.bumpEpoch();
    expect(guard.epoch()).not.toBe(snapshot);
  });

  it('deltaEpoch locks to the playback epoch current at response-request time', () => {
    const guard = new TurnGuard();
    guard.bumpPlaybackEpoch();
    guard.lockDeltaEpoch();
    expect(guard.deltaEpoch()).toBe(guard.playbackEpoch());

    // A later cancel bumps playback; already-locked deltas stay stale.
    guard.bumpPlaybackEpoch();
    expect(guard.deltaEpoch()).toBe(guard.playbackEpoch() - 1);
  });
});
