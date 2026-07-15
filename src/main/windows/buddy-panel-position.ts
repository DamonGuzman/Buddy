/** Pure positioning for the settings window opened from Buddy's context click. */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowPosition {
  x: number;
  y: number;
}

const BUDDY_PANEL_GAP = 12;

/**
 * Place the panel beside Buddy, preferring the direction with the most room,
 * then clamp it into the display work area. A side that fully fits always
 * wins, so the panel does not cover Buddy on normal desktop-sized displays.
 */
export function positionBuddyPanel(
  anchor: Bounds,
  workArea: Bounds,
  panel: WindowSize,
): WindowPosition {
  const anchorX = anchor.x + anchor.width / 2;
  const anchorY = anchor.y + anchor.height / 2;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  const preferRight = anchorX <= workArea.x + workArea.width / 2;
  const preferBelow = anchorY <= workArea.y + workArea.height / 2;

  const horizontal = preferRight
    ? [
        {
          x: anchor.x + anchor.width + BUDDY_PANEL_GAP,
          fits: anchor.x + anchor.width + BUDDY_PANEL_GAP + panel.width <= workRight,
        },
        {
          x: anchor.x - BUDDY_PANEL_GAP - panel.width,
          fits: anchor.x - BUDDY_PANEL_GAP - panel.width >= workArea.x,
        },
      ]
    : [
        {
          x: anchor.x - BUDDY_PANEL_GAP - panel.width,
          fits: anchor.x - BUDDY_PANEL_GAP - panel.width >= workArea.x,
        },
        {
          x: anchor.x + anchor.width + BUDDY_PANEL_GAP,
          fits: anchor.x + anchor.width + BUDDY_PANEL_GAP + panel.width <= workRight,
        },
      ];
  const horizontalFit = horizontal.find((candidate) => candidate.fits);
  if (horizontalFit) {
    return {
      x: Math.round(horizontalFit.x),
      y: Math.round(clamp(anchorY - panel.height / 2, workArea.y, workBottom - panel.height)),
    };
  }

  const vertical = preferBelow
    ? [anchor.y + anchor.height + BUDDY_PANEL_GAP, anchor.y - BUDDY_PANEL_GAP - panel.height]
    : [anchor.y - BUDDY_PANEL_GAP - panel.height, anchor.y + anchor.height + BUDDY_PANEL_GAP];
  const verticalFit = vertical.find((y) => y >= workArea.y && y + panel.height <= workBottom);
  return {
    x: Math.round(clamp(anchorX - panel.width / 2, workArea.x, workRight - panel.width)),
    y: Math.round(
      verticalFit ??
        clamp(
          vertical[0] ?? workArea.y,
          workArea.y,
          Math.max(workArea.y, workBottom - panel.height),
        ),
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
