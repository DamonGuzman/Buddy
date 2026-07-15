/**
 * M11: showPanelOnce per-REASON budget (windows/panel.ts). The old single
 * `shownOnce` boolean meant the first-run discoverability show consumed the
 * one-and-only auto-surface — a later "add your openai key" failure died
 * silently behind the tray icon. Now each reason (error kind or 'first-run')
 * gets its own once-per-run budget, owned by the PanelManager instance.
 *
 * Electron is mocked (module-load only — the PanelManager constructor touches
 * nothing Electron; window pre-creation happens in start(), never called
 * here); PanelManager.showInactive is spied to a no-op so no window is ever
 * created.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {},
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

  it('retains the latest notice and clears only the exact recovered revision and kind', () => {
    const panel = new PanelManager();
    panel.presentActionableError({
      kind: 'no_api_key',
      message: 'add a key',
      target: 'openai',
      occurredAt: 1,
    });
    expect(panel.actionableErrorState()).toMatchObject({
      revision: 1,
      notice: { kind: 'no_api_key', target: 'openai' },
    });

    panel.resolveActionableError({ revision: 1, kind: 'mic_unavailable' });
    expect(panel.actionableErrorState().revision).toBe(1);

    panel.resolveActionableError({ revision: 1, kind: 'no_api_key' });
    expect(panel.actionableErrorState()).toEqual({ revision: 2, notice: null });
    panel.destroy();
  });

  it('does not let an older async recovery clear a newer notice with the same target', () => {
    const panel = new PanelManager();
    panel.presentActionableError({
      kind: 'no_api_key',
      message: 'add a key',
      target: 'openai',
      occurredAt: 1,
    });
    const oldRecovery = panel.currentActionableError(['no_api_key']);
    panel.presentActionableError({
      kind: 'api_key_rejected',
      message: 'replace the key',
      target: 'openai',
      occurredAt: 2,
    });

    expect(oldRecovery).toEqual({ revision: 1, kind: 'no_api_key' });
    if (oldRecovery === null) throw new Error('expected a recovery identity');
    expect(panel.resolveActionableError(oldRecovery)).toBe(false);
    expect(panel.actionableErrorState()).toMatchObject({
      revision: 2,
      notice: { kind: 'api_key_rejected' },
    });

    expect(panel.dismissActionableError({ revision: 1, kind: 'no_api_key' })).toBe(false);
    expect(panel.dismissActionableError({ revision: 2, kind: 'api_key_rejected' })).toBe(true);
    expect(panel.actionableErrorState()).toEqual({ revision: 3, notice: null });
    panel.destroy();
  });
});
