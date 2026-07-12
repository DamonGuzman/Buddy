/**
 * M11: showPanelOnce per-REASON budget (windows/panel.ts). The old single
 * `shownOnce` boolean meant the first-run discoverability show consumed the
 * one-and-only auto-surface — a later "add your openai key" failure died
 * silently behind the tray icon. Now each reason (error kind or 'first-run')
 * gets its own once-per-run budget.
 *
 * Electron is mocked; PanelManager.showInactive is spied to a no-op so no
 * window is ever created.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    // Never resolves: the constructor's ensureWindow path stays dormant.
    whenReady: () => new Promise(() => {}),
    getPath: () => 'unused-in-tests',
    getAppPath: () => 'unused-in-tests',
  },
  BrowserWindow: class {},
  screen: {},
}));

const { PanelManager, showPanelOnce } = await import('../src/main/windows/panel');

describe('showPanelOnce (M11 per-kind auto-show budget)', () => {
  it('shows once per reason; first-run does not consume the error budget', () => {
    const panel = new PanelManager();
    const shows = vi.spyOn(panel, 'showInactive').mockImplementation(() => {});

    // First-run discoverability.
    showPanelOnce(); // defaults to 'first-run'
    showPanelOnce('first-run');
    expect(shows).toHaveBeenCalledTimes(1);

    // A later error kind still gets its surface (the old boolean ate this).
    showPanelOnce('no_api_key');
    expect(shows).toHaveBeenCalledTimes(2);

    // ...but only once per kind.
    showPanelOnce('no_api_key');
    showPanelOnce('no_api_key');
    expect(shows).toHaveBeenCalledTimes(2);

    // A different kind has its own budget.
    showPanelOnce('mic_unavailable');
    expect(shows).toHaveBeenCalledTimes(3);
    showPanelOnce('mic_unavailable');
    expect(shows).toHaveBeenCalledTimes(3);

    panel.destroy();
  });
});
