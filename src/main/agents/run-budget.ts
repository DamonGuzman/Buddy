/** Pauseable wall-clock budget. Parked human-approval time is not charged. */
export class AgentRunBudget {
  private remainingMs: number;
  private runningSince: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expired = false;

  constructor(
    durationMs: number,
    private readonly onExpire: () => void,
    private readonly now: () => number = monotonicNow,
  ) {
    if (!Number.isFinite(durationMs) || durationMs <= 0)
      throw new Error('agent run budget must be a positive duration');
    this.remainingMs = durationMs;
  }

  start(): void {
    if (this.expired || this.runningSince !== null) return;
    this.runningSince = this.now();
    this.arm();
  }

  pause(): void {
    if (this.runningSince === null || this.expired) return;
    this.remainingMs = Math.max(0, this.remainingMs - (this.now() - this.runningSince));
    this.runningSince = null;
    this.clearTimer();
    if (this.remainingMs === 0) this.expire();
  }

  resume(): void {
    this.start();
  }

  dispose(): void {
    this.clearTimer();
    this.runningSince = null;
  }

  remaining(): number {
    return this.runningSince === null
      ? this.remainingMs
      : Math.max(0, this.remainingMs - (this.now() - this.runningSince));
  }

  private arm(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.expire(), Math.max(1, this.remainingMs));
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private expire(): void {
    if (this.expired) return;
    this.expired = true;
    this.remainingMs = 0;
    this.clearTimer();
    this.runningSince = null;
    this.onExpire();
  }
}

function monotonicNow(): number {
  return performance.now();
}
