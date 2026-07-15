/**
 * Named one-shot timers + injectable time for the overlay controllers.
 *
 * Every overlay controller (pointer choreography, captions, helper hover,
 * hover/drag wiring) owns one TimerBag and addresses its timers by name
 * instead of juggling `ReturnType<typeof setTimeout>` variables. The host and
 * clock are injected so controllers are unit-testable with fake time — the
 * same seam style HoverMachine uses (time passed in, scheduling owned by the
 * caller).
 */

/** Injectable "what time is it" — production wiring passes Date.now. */
export type Clock = () => number;

/** Injectable timer primitive (fake in tests, global setTimeout in prod). */
export interface TimerHost {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimerHost: TimerHost = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A set of NAMED one-shot timers. Re-arming a name replaces its pending
 * timer; fired timers remove themselves. One bag per controller so a
 * controller's clearAll() can never cancel another controller's work.
 */
export class TimerBag {
  private readonly pending = new Map<string, unknown>();

  constructor(private readonly host: TimerHost = systemTimerHost) {}

  /** Arm (or replace) the named one-shot timer. */
  set(name: string, ms: number, fn: () => void): void {
    this.clear(name);
    this.pending.set(
      name,
      this.host.setTimeout(() => {
        this.pending.delete(name);
        fn();
      }, ms),
    );
  }

  /** Is the named timer currently armed? */
  has(name: string): boolean {
    return this.pending.has(name);
  }

  /** Cancel the named timer (no-op when not armed). */
  clear(name: string): void {
    if (!this.pending.has(name)) return;
    this.host.clearTimeout(this.pending.get(name));
    this.pending.delete(name);
  }

  /** Cancel every timer in this bag (controller teardown). */
  clearAll(): void {
    for (const handle of this.pending.values()) this.host.clearTimeout(handle);
    this.pending.clear();
  }
}
