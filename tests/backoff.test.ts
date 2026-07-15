import { afterEach, describe, expect, it, vi } from 'vitest';
import { Backoff, RetryTimer } from '../src/main/util/backoff';

describe('Backoff', () => {
  it('doubles from min and caps at max', () => {
    const backoff = new Backoff({ minMs: 250, maxMs: 4_000 });
    const delays = [
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ];
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it('matches the attempt-counter shape in realtime/session.ts (base 1s, cap 30s)', () => {
    const backoff = new Backoff({ minMs: 1_000, maxMs: 30_000 });
    // Reference: Math.min(1000 * 2 ** attempt, 30000) for attempt = 0, 1, 2, ...
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(backoff.next()).toBe(Math.min(1_000 * 2 ** attempt, 30_000));
    }
  });

  it('reset() returns to the first delay', () => {
    const backoff = new Backoff({ minMs: 20, maxMs: 40 });
    expect(backoff.next()).toBe(20);
    expect(backoff.next()).toBe(40);
    backoff.reset();
    expect(backoff.next()).toBe(20);
    expect(backoff.next()).toBe(40);
  });
});

describe('RetryTimer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback after the delay and clears pending first', () => {
    vi.useFakeTimers();
    const timer = new RetryTimer();
    let pendingDuringCallback: boolean | null = null;
    timer.schedule(100, () => {
      pendingDuringCallback = timer.isPending();
    });

    expect(timer.isPending()).toBe(true);
    vi.advanceTimersByTime(99);
    expect(pendingDuringCallback).toBeNull();
    vi.advanceTimersByTime(1);
    // The slot frees BEFORE the callback runs, so callbacks may re-schedule.
    expect(pendingDuringCallback).toBe(false);
    expect(timer.isPending()).toBe(false);
  });

  it('clear() cancels a pending callback', () => {
    vi.useFakeTimers();
    const timer = new RetryTimer();
    const fn = vi.fn();
    timer.schedule(50, fn);
    timer.clear();
    expect(timer.isPending()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('schedule() replaces a pending schedule (supervisor semantics)', () => {
    vi.useFakeTimers();
    const timer = new RetryTimer();
    const first = vi.fn();
    const second = vi.fn();
    timer.schedule(50, first);
    timer.schedule(200, second);
    vi.advanceTimersByTime(100);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a callback can re-schedule itself (reconnect loop shape)', () => {
    vi.useFakeTimers();
    const timer = new RetryTimer();
    const backoff = new Backoff({ minMs: 10, maxMs: 40 });
    const fired: number[] = [];
    const connectAndFail = (): void => {
      fired.push(Date.now());
      timer.schedule(backoff.next(), connectAndFail);
    };
    timer.schedule(backoff.next(), connectAndFail);

    vi.advanceTimersByTime(10 + 20 + 40 + 40);
    expect(fired).toHaveLength(4);
    expect(timer.isPending()).toBe(true);
    timer.clear();
  });
});
