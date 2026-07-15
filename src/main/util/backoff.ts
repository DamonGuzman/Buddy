/**
 * Doubling backoff + unref'd retry timer — one owner for the min/max-doubling
 * reconnect/restart pattern hand-rolled in phone-audio-bridge.ts,
 * phone-audio-bridge-supervisor.ts, and realtime/session.ts.
 *
 * Both hand-rolled shapes produce the same delay sequence
 * (min, 2·min, 4·min, …, capped at max):
 * - stored-delay doubling: `delay = ms; ms = Math.min(max, ms * 2)`
 * - attempt counter: `delay = Math.min(base * 2 ** attempt, cap); attempt++`
 *
 * Adoption note: the pending-timer guards differ per site. The bridge and the
 * realtime session SKIP a schedule while one is pending; the supervisor
 * REPLACES it. `RetryTimer.schedule` replaces — skip-if-pending callers guard
 * with `isPending()` first.
 */

export interface BackoffOptions {
  /** First delay, ms. */
  minMs: number;
  /** Ceiling, ms. */
  maxMs: number;
}

/** Pure doubling-delay state: min, 2·min, 4·min, …, capped at max. */
export class Backoff {
  private readonly minMs: number;
  private readonly maxMs: number;
  private nextMs: number;

  constructor(options: BackoffOptions) {
    this.minMs = options.minMs;
    this.maxMs = options.maxMs;
    this.nextMs = options.minMs;
  }

  /** Consume and return the next delay, doubling (capped) for the one after. */
  next(): number {
    const delay = this.nextMs;
    this.nextMs = Math.min(this.maxMs, this.nextMs * 2);
    return delay;
  }

  /** Back to the first delay (call on success, e.g. connect/healthy). */
  reset(): void {
    this.nextMs = this.minMs;
  }
}

/**
 * A single-slot unref'd setTimeout: never keeps the process alive, and the
 * pending flag clears BEFORE the callback runs (so a callback may re-schedule),
 * matching every hand-rolled site.
 */
export class RetryTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** True while a scheduled callback has not yet fired or been cleared. */
  isPending(): boolean {
    return this.timer !== null;
  }

  /** Schedule `fn` after `delayMs`, replacing any pending schedule. */
  schedule(delayMs: number, fn: () => void): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, delayMs);
    this.timer.unref?.();
  }

  /** Cancel the pending callback, if any. */
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
