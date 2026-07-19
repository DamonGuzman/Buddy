/**
 * Serializes browser-profile power transitions in the order Electron emits
 * them. In particular, a resume must never be overtaken by a slow helper-run
 * cancellation that belongs to an earlier lock/suspend event.
 */
export class BrowserPowerLifecycle {
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      cancelBrowserRuns(): Promise<void>;
      suspendBrowserRuntime(): Promise<void>;
      resumeBrowserRuntime(): void;
      onError(label: 'lock' | 'suspend' | 'resume', error: unknown): void;
    },
  ) {}

  lock(): void {
    this.enqueueSuspend('lock');
  }

  suspend(): void {
    this.enqueueSuspend('suspend');
  }

  resume(): void {
    this.enqueue('resume', async () => this.deps.resumeBrowserRuntime());
  }

  /** Test/shutdown seam: resolves after every transition admitted so far. */
  settled(): Promise<void> {
    return this.transition;
  }

  private enqueueSuspend(label: 'lock' | 'suspend'): void {
    this.enqueue(label, async () => {
      const failures: unknown[] = [];
      try {
        await this.deps.cancelBrowserRuns();
      } catch (error) {
        failures.push(error);
      }
      // Suspending the profile is the safety boundary. Attempt it even when a
      // backend ignored cancellation and joining that run failed or timed out.
      try {
        await this.deps.suspendBrowserRuntime();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `browser ${label} transition failed`);
      }
    });
  }

  private enqueue(label: 'lock' | 'suspend' | 'resume', run: () => Promise<void>): void {
    this.transition = this.transition.then(run).catch((error: unknown) => {
      this.deps.onError(label, error);
    });
  }
}
