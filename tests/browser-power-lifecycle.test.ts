import { describe, expect, it, vi } from 'vitest';
import { BrowserPowerLifecycle } from '../src/main/computer/browser-power-lifecycle';

describe('BrowserPowerLifecycle', () => {
  it('does not let slow cancellation suspend the browser after a newer resume', async () => {
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const sequence: string[] = [];
    const lifecycle = new BrowserPowerLifecycle({
      cancelBrowserRuns: async () => {
        sequence.push('cancel-start');
        await cancellation;
        sequence.push('cancel-finished');
      },
      suspendBrowserRuntime: async () => {
        sequence.push('suspend');
      },
      resumeBrowserRuntime: () => {
        sequence.push('resume');
      },
      onError: vi.fn(),
    });

    lifecycle.suspend();
    await vi.waitFor(() => expect(sequence).toEqual(['cancel-start']));
    lifecycle.resume();
    finishCancellation();
    await lifecycle.settled();

    expect(sequence).toEqual(['cancel-start', 'cancel-finished', 'suspend', 'resume']);
  });

  it('still suspends the profile when joining helper runs fails', async () => {
    const suspendBrowserRuntime = vi.fn(async () => undefined);
    const onError = vi.fn();
    const lifecycle = new BrowserPowerLifecycle({
      cancelBrowserRuns: async () => {
        throw new Error('join timed out');
      },
      suspendBrowserRuntime,
      resumeBrowserRuntime: vi.fn(),
      onError,
    });

    lifecycle.lock();
    await lifecycle.settled();

    expect(suspendBrowserRuntime).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      'lock',
      expect.objectContaining({ message: 'join timed out' }),
    );
  });

  it('continues later transitions after reporting an earlier transition failure', async () => {
    const resumeBrowserRuntime = vi.fn();
    const lifecycle = new BrowserPowerLifecycle({
      cancelBrowserRuns: async () => undefined,
      suspendBrowserRuntime: async () => {
        throw new Error('profile refused to suspend');
      },
      resumeBrowserRuntime,
      onError: vi.fn(),
    });

    lifecycle.suspend();
    lifecycle.resume();
    await lifecycle.settled();

    expect(resumeBrowserRuntime).toHaveBeenCalledOnce();
  });
});
