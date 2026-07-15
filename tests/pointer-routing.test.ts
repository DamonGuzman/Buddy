/**
 * Pure routing decisions extracted from windows/overlay.ts: the buddy
 * residency rule (M2/M15) and the M15 mouse-forwarding gate.
 */

import { describe, expect, it } from 'vitest';
import { computePointerRouting, forwardingModeFor } from '../src/main/windows/pointer-routing';
import type { PointerCommand } from '../src/shared/types';

const REST_INDEX = 0;

describe('computePointerRouting (buddy residency rule)', () => {
  it("'animate' targets the addressed screen and moves the buddy host there", () => {
    const cmd: PointerCommand = { type: 'animate', points: [{ x: 10, y: 20 }], screenIndex: 2 };
    expect(computePointerRouting(cmd, REST_INDEX)).toEqual({
      targetIndex: 2,
      buddyHostIndex: 2,
    });
  });

  it("'idle' targets the rest display (Settings.buddyRest / primary)", () => {
    expect(computePointerRouting({ type: 'idle' }, 1)).toEqual({
      targetIndex: 1,
      buddyHostIndex: 1,
    });
  });

  it("'hide' broadcasts (null target) and leaves the buddy hosted nowhere", () => {
    expect(computePointerRouting({ type: 'hide' }, REST_INDEX)).toEqual({
      targetIndex: null,
      buddyHostIndex: null,
    });
  });

  it('an animate to the rest display itself still routes there', () => {
    const cmd: PointerCommand = { type: 'animate', points: [{ x: 0, y: 0 }], screenIndex: 0 };
    expect(computePointerRouting(cmd, 0)).toEqual({ targetIndex: 0, buddyHostIndex: 0 });
  });
});

describe('forwardingModeFor (M15 mouse-forwarding gate)', () => {
  it('the interactive (dwell-flipped) window is left alone', () => {
    expect(
      forwardingModeFor({
        displayId: 7,
        screenIndex: 1,
        buddyHostIndex: 1,
        interactiveDisplayId: 7,
      }),
    ).toBe('interactive');
  });

  it('ONLY the buddy-hosting window forwards mousemove', () => {
    expect(
      forwardingModeFor({
        displayId: 7,
        screenIndex: 1,
        buddyHostIndex: 1,
        interactiveDisplayId: null,
      }),
    ).toBe('forward');
    expect(
      forwardingModeFor({
        displayId: 8,
        screenIndex: 2,
        buddyHostIndex: 1,
        interactiveDisplayId: null,
      }),
    ).toBe('click-through');
  });

  it('a hidden buddy (host null) means plain click-through everywhere', () => {
    expect(
      forwardingModeFor({
        displayId: 7,
        screenIndex: 0,
        buddyHostIndex: null,
        interactiveDisplayId: null,
      }),
    ).toBe('click-through');
  });

  it('interactive wins over hosting (the flip owns the window)', () => {
    expect(
      forwardingModeFor({
        displayId: 7,
        screenIndex: 0,
        buddyHostIndex: 0,
        interactiveDisplayId: 7,
      }),
    ).toBe('interactive');
  });
});
