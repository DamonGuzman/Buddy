/**
 * F1 fix (M2): playback epoch gate — pure-logic tests for the renderer's
 * stale-audio dropping. The scenario under test: a response is cancelled
 * before its FIRST audio chunk reached the renderer; the flush finds an
 * empty queue and no itemId to mark stale, then the server's pre-cancel
 * burst arrives under a fresh itemId. The epoch gate must silence it.
 */

import { describe, expect, it } from 'vitest';
import { PlaybackEpochGate } from '../src/renderer/panel/audio/epoch-gate';

describe('PlaybackEpochGate', () => {
  it('admits deltas at or above the flush floor', () => {
    const gate = new PlaybackEpochGate();
    expect(gate.admitDelta(0)).toBe(true);
    gate.flush(1);
    expect(gate.admitDelta(1)).toBe(true);
    expect(gate.admitDelta(2)).toBe(true);
  });

  it("drops a cancelled response's burst that arrives after the flush", () => {
    const gate = new PlaybackEpochGate();
    // Response A (epoch 0) starts; user barges in before any chunk arrived.
    gate.flush(1); // cancel bumps the epoch and flushes
    // The pre-cancel burst lands late, tagged with the old epoch.
    expect(gate.admitDelta(0)).toBe(false);
    expect(gate.admitDelta(0)).toBe(false);
    // The new turn's response (epoch 1) plays normally.
    expect(gate.admitDelta(1)).toBe(true);
  });

  it('a newer-epoch delta raises the floor even if the flush was missed', () => {
    const gate = new PlaybackEpochGate();
    expect(gate.admitDelta(3)).toBe(true); // response of epoch 3 starts
    expect(gate.admitDelta(2)).toBe(false); // straggler from an older response
    expect(gate.currentFloor()).toBe(3);
  });

  it('untagged deltas (dev/QA tones) always play', () => {
    const gate = new PlaybackEpochGate();
    gate.flush(5);
    expect(gate.admitDelta(undefined)).toBe(true);
    expect(gate.currentFloor()).toBe(5); // and do not disturb the floor
  });

  it('flushes never lower the floor', () => {
    const gate = new PlaybackEpochGate();
    gate.flush(4);
    gate.flush(2);
    expect(gate.admitDelta(3)).toBe(false);
    expect(gate.admitDelta(4)).toBe(true);
  });
});
