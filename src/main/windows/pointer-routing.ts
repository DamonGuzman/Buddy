/**
 * Pure routing decisions for the overlay manager (unit-tested like coords.ts):
 * which overlay a pointer command lands on, and what mouse-event mode each
 * overlay window should be in. windows/overlay.ts owns the Electron side and
 * delegates every decision here.
 */

import type { PointerCommand } from '../../shared/types';

/**
 * Where `routePointer` sends a command, per the buddy residency rule
 * (M2, amended M15):
 * - 'animate' → addressed screenIndex gets the command, all others 'hide'
 * - 'idle'    → rest display gets 'idle' (rest corner), others 'hide'
 * - 'hide'    → everyone hides (targetIndex null = broadcast)
 */
export interface PointerRouting {
  /**
   * screenIndex that receives the command unchanged; every other overlay
   * gets 'hide'. null = broadcast the command to every overlay.
   */
  targetIndex: number | null;
  /** screenIndex hosting the buddy once the command lands; null = hidden. */
  buddyHostIndex: number | null;
}

export function computePointerRouting(
  cmd: PointerCommand,
  restScreenIndex: number,
): PointerRouting {
  switch (cmd.type) {
    case 'animate':
      return { targetIndex: cmd.screenIndex, buddyHostIndex: cmd.screenIndex };
    case 'idle':
      return { targetIndex: restScreenIndex, buddyHostIndex: restScreenIndex };
    case 'hide':
      return { targetIndex: null, buddyHostIndex: null };
  }
}

/**
 * M15 mouse-event mode of one overlay window:
 * - 'interactive':   the dwell flip is active — the window is NOT ignoring
 *                    mouse events; leave it alone (the HoverController owns
 *                    restoring it).
 * - 'forward':       click-through with mousemove forwarding — ONLY the
 *                    window currently showing the buddy, so its renderer can
 *                    see the cursor approach.
 * - 'click-through': plain click-through, no forwarding (zero idle cost).
 */
export type OverlayMouseMode = 'interactive' | 'forward' | 'click-through';

export function forwardingModeFor(args: {
  displayId: number;
  screenIndex: number;
  buddyHostIndex: number | null;
  interactiveDisplayId: number | null;
}): OverlayMouseMode {
  if (args.displayId === args.interactiveDisplayId) return 'interactive';
  if (args.buddyHostIndex !== null && args.screenIndex === args.buddyHostIndex) return 'forward';
  return 'click-through';
}
