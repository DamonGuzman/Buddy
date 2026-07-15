import { describe, expect, it, vi } from 'vitest';
import { persistBuddyRest, settingsSaveFailureNotice } from '../src/main/windows/overlay-settings';

const REST = { screenIndex: 1, xFrac: 0.25, yFrac: 0.75 };

describe('overlay settings persistence', () => {
  it('persists the exact validated rest position', () => {
    const set = vi.fn(() => ({}));

    expect(persistBuddyRest({ set }, REST)).toBe(true);
    expect(set).toHaveBeenCalledWith({ buddyRest: REST });
  });

  it('contains persistence failures so the IPC event handler can surface them', () => {
    const set = vi.fn(() => {
      throw new Error('/private/path/settings.json contains sk-secret');
    });

    expect(persistBuddyRest({ set }, REST)).toBe(false);
  });

  it('surfaces fixed, persistent, settings-directed repair copy', () => {
    expect(settingsSaveFailureNotice(42)).toEqual({
      kind: 'settings_save_failed',
      message:
        "buddy couldn't save that setting — the previous saved value is unchanged. try again, " +
        'or restart buddy if it keeps happening.',
      target: 'settings',
      occurredAt: 42,
    });
  });
});
