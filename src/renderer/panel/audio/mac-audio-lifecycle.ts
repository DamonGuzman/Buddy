/**
 * Small macOS seam for Chromium's process-wide CoreAudio session.
 *
 * Capture and playback use separate Web Audio graphs, but Electron hosts both
 * in one audio-service process. Closing the capture graph can therefore
 * invalidate an otherwise `running` playback context. Capture announces that
 * teardown synchronously; playback drops its old graph and waits for teardown
 * to finish before creating the next one.
 */

type TeardownListener = () => void;

export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  const userAgent = navigator.userAgent ?? '';
  return platform.startsWith('Mac') || /Macintosh|Mac OS X/.test(userAgent);
}

export class MacAudioLifecycle {
  private captureTeardown: Promise<void> = Promise.resolve();
  private teardownGeneration = 0;
  private readonly listeners = new Set<TeardownListener>();

  beginCaptureTeardown(teardown: Promise<void>): void {
    if (!isMacOS()) return;
    const generation = ++this.teardownGeneration;
    this.listeners.forEach((listener) => listener());
    this.captureTeardown = teardown
      .catch(() => undefined)
      .then(() => {
        // A later teardown owns the barrier if capture was restarted quickly.
        if (generation !== this.teardownGeneration) return this.captureTeardown;
      });
  }

  waitForCaptureTeardown(): Promise<void> {
    return isMacOS() ? this.captureTeardown : Promise.resolve();
  }

  onCaptureTeardown(listener: TeardownListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const macAudioLifecycle = new MacAudioLifecycle();
