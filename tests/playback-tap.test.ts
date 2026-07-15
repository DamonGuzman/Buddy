/**
 * M8.5 playback tap (src/renderer/panel/audio/playback-tap.ts): per-item
 * stats accumulation + the played-audio ring buffer, extracted from
 * AudioPlayer so the cadence rules that feed the voice eval and the session
 * journal are provable in node:
 *  - stats go out on an item's FIRST block, then at most once per second,
 *    and always on done;
 *  - the ring ships (Int16-re-encoded, oldest→newest) only on item done;
 *  - the per-item map stays bounded.
 */

import { describe, expect, it } from 'vitest';
import { PlaybackTap, STATS_INTERVAL_MS } from '../src/renderer/panel/audio/playback-tap';
import type { PlayedBlock } from '../src/renderer/panel/audio/worklet-messages';
import type { PlaybackStatsUpdate } from '../src/shared/types';

class FakePort {
  stats: PlaybackStatsUpdate[] = [];
  rings: Int16Array[] = [];
  sendPlaybackStats = (update: PlaybackStatsUpdate): void => {
    this.stats.push(update);
  };
  sendPlaybackRing = (ring: ArrayBuffer): void => {
    this.rings.push(new Int16Array(ring));
  };
}

function makeTap(opts: { ringSamples?: number } = {}): {
  tap: PlaybackTap;
  port: FakePort;
  clock: { now: number };
} {
  const port = new FakePort();
  const clock = { now: 0 };
  const tap = new PlaybackTap(port, { ...opts, now: () => clock.now });
  return { tap, port, clock };
}

function block(
  itemId: string,
  samples: number[],
  overrides: Partial<Omit<PlayedBlock, 'type' | 'itemId' | 'samples'>> = {},
): PlayedBlock {
  return {
    type: 'played',
    itemId,
    samples: new Float32Array(samples).buffer,
    underruns: 0,
    firstPlayedAt: 1_000,
    done: false,
    ...overrides,
  };
}

describe('PlaybackTap stats cadence', () => {
  it("sends an item's first block immediately", () => {
    const { tap, port } = makeTap();
    tap.onPlayedBlock(block('a', [0.5, -0.5], { firstPlayedAt: 42 }));
    expect(port.stats).toEqual([
      {
        itemId: 'a',
        samplesPlayed: 2,
        rms: 0.5,
        peak: 0.5,
        underruns: 0,
        firstPlayedAt: 42,
        done: false,
      },
    ]);
    expect(port.rings).toHaveLength(0); // ring ships only on done
  });

  it('throttles non-final sends to one per STATS_INTERVAL_MS', () => {
    const { tap, port, clock } = makeTap();
    tap.onPlayedBlock(block('a', [0.1]));
    clock.now += STATS_INTERVAL_MS - 1;
    tap.onPlayedBlock(block('a', [0.2])); // inside the window → suppressed
    expect(port.stats).toHaveLength(1);
    clock.now += 1;
    tap.onPlayedBlock(block('a', [0.3])); // window elapsed → sent
    expect(port.stats).toHaveLength(2);
    expect(port.stats[1]!.samplesPlayed).toBe(3); // suppressed block still accumulated
  });

  it('always sends on done, ships the ring, and forgets the item', () => {
    const { tap, port } = makeTap();
    tap.onPlayedBlock(block('a', [0.5]));
    tap.onPlayedBlock(block('a', [0.5], { done: true })); // same ms as first send
    expect(port.stats).toHaveLength(2);
    expect(port.stats[1]!.done).toBe(true);
    expect(port.rings).toHaveLength(1);
    expect(tap.trackedItemCount()).toBe(0);
    // The forgotten item starts fresh: its next block counts as a first.
    tap.onPlayedBlock(block('a', [0.5]));
    expect(port.stats).toHaveLength(3);
    expect(port.stats[2]!.samplesPlayed).toBe(1);
  });

  it('accumulates rms/peak across blocks and tracks worklet underruns', () => {
    const { tap, port, clock } = makeTap();
    tap.onPlayedBlock(block('a', [0.6]));
    clock.now += STATS_INTERVAL_MS;
    tap.onPlayedBlock(block('a', [-0.8], { underruns: 2 }));
    const last = port.stats[1]!;
    // Float32 storage quantizes 0.6/0.8 — compare at float32 precision.
    expect(last.rms).toBeCloseTo(Math.sqrt((0.36 + 0.64) / 2), 6);
    expect(last.peak).toBeCloseTo(0.8, 6);
    expect(last.underruns).toBe(2); // worklet-reported, not accumulated
  });

  it('bounds the per-item map by evicting the oldest item', () => {
    const { tap } = makeTap();
    for (let i = 0; i < 65; i++) tap.onPlayedBlock(block(`item-${i}`, [0.1]));
    expect(tap.trackedItemCount()).toBe(64);
  });
});

describe('PlaybackTap ring buffer', () => {
  it('re-encodes played audio as Int16, clamping at full scale', () => {
    const { tap, port } = makeTap();
    tap.onPlayedBlock(block('a', [0, 0.5, 1.0, -1.0], { done: true }));
    expect([...port.rings[0]!]).toEqual([0, 16384, 32767, -32768]);
  });

  it('keeps only the newest samples, oldest→newest, across wraparound', () => {
    const { tap, port } = makeTap({ ringSamples: 4 });
    tap.onPlayedBlock(block('a', [0.1, 0.2, 0.3]));
    tap.onPlayedBlock(block('a', [0.4, 0.5, 0.6], { done: true }));
    const ring = port.rings[0]!;
    const expected = [0.3, 0.4, 0.5, 0.6].map((s) => Math.round(s * 32768));
    expect([...ring]).toEqual(expected);
  });

  it('spans items: the ring is a global last-N window, shipped on each done', () => {
    const { tap, port } = makeTap({ ringSamples: 8 });
    tap.onPlayedBlock(block('a', [0.1, 0.2], { done: true }));
    tap.onPlayedBlock(block('b', [0.3], { done: true }));
    expect(port.rings).toHaveLength(2);
    expect(port.rings[0]!.length).toBe(2);
    expect([...port.rings[1]!]).toEqual([0.1, 0.2, 0.3].map((s) => Math.round(s * 32768)));
  });

  it('sends nothing when no audio was ever played', () => {
    const { tap, port } = makeTap();
    tap.onPlayedBlock(block('a', [], { done: true }));
    expect(port.rings).toHaveLength(0);
    expect(port.stats).toHaveLength(1); // stats still report the empty done
  });
});
