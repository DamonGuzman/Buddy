/**
 * buildScreenshotFraming: pins the EXACT framing strings byte-for-byte.
 *
 * Two call sites depend on this prose being stable: the realtime session's
 * image turns (the mock server keys on the `context:` prefix) and the Codex
 * text path. These snapshots let adopters verify byte-identity when they
 * delegate to the shared builder — do not "fix" the wording here without
 * checking both paths and tools/mock-realtime.
 */

import { describe, expect, it } from 'vitest';
import { buildScreenshotFraming } from '../src/main/realtime/framing';
import { CONTEXT_PREFIX } from '../src/main/realtime/session';
import type { CaptureMeta } from '../src/shared/types';

function meta(overrides: Partial<CaptureMeta> = {}): CaptureMeta {
  return {
    screenIndex: 0,
    displayId: 1,
    imageW: 1920,
    imageH: 1080,
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    isActive: false,
    ...overrides,
  };
}

describe('buildScreenshotFraming', () => {
  it('pins the exact prose for one screenshot, no extra context', () => {
    expect(buildScreenshotFraming([meta({ isActive: true })], '')).toBe(
      'context: 1 screenshot(s) attached. ' +
        'screen0 is 1920x1080 pixels (active screen, the cursor is here). ' +
        'point_at coordinates must be pixel coordinates within the named screenshot. ' +
        'coordinate anchors — screen0: top-left corner (0,0), bottom-right corner (1920,1080). ' +
        'to point accurately: judge how far across and down the target sits as a fraction ' +
        "of the full screenshot, then multiply by that screenshot's pixel size " +
        '(e.g. a target 1/3 across and 1/4 down screen0 is at (640,270)); ' +
        "commit to the target's actual offset — never default to the middle of the screen.",
    );
  });

  it('pins the exact prose for two screenshots (active first) with context text', () => {
    const metas = [
      meta({ isActive: true }),
      meta({ screenIndex: 1, displayId: 2, imageW: 1280, imageH: 720 }),
    ];
    expect(buildScreenshotFraming(metas, 'the user is hovering the Save button')).toBe(
      'context: 2 screenshot(s) attached. ' +
        'screen0 is 1920x1080 pixels (active screen, the cursor is here); ' +
        'screen1 is 1280x720 pixels. ' +
        'point_at coordinates must be pixel coordinates within the named screenshot. ' +
        'coordinate anchors — screen0: top-left corner (0,0), bottom-right corner (1920,1080); ' +
        'screen1: top-left corner (0,0), bottom-right corner (1280,720). ' +
        'to point accurately: judge how far across and down the target sits as a fraction ' +
        "of the full screenshot, then multiply by that screenshot's pixel size " +
        '(e.g. a target 1/3 across and 1/4 down screen0 is at (640,270)); ' +
        "commit to the target's actual offset — never default to the middle of the screen. " +
        'the user is hovering the Save button',
    );
  });

  it('rounds the worked example from the FIRST screenshot even when it is not active', () => {
    const metas = [
      meta({ screenIndex: 3, imageW: 1366, imageH: 768 }),
      meta({ screenIndex: 4, displayId: 2, isActive: true }),
    ];
    const text = buildScreenshotFraming(metas, '');
    // 1366/3 = 455.33 -> 455; 768/4 = 192.
    expect(text).toContain('(e.g. a target 1/3 across and 1/4 down screen3 is at (455,192));');
    expect(text).toContain('screen4 is 1920x1080 pixels (active screen, the cursor is here)');
  });

  it('with no screenshots, frames bare context text with the app-wide prefix', () => {
    expect(buildScreenshotFraming([], 'the user pressed the hotkey')).toBe(
      'context: the user pressed the hotkey',
    );
  });

  it('returns the empty string when there is nothing to frame', () => {
    expect(buildScreenshotFraming([], '')).toBe('');
  });

  it("starts with the session's CONTEXT_PREFIX (the mock server keys on it)", () => {
    expect(buildScreenshotFraming([meta()], '').startsWith(`${CONTEXT_PREFIX} `)).toBe(true);
    expect(buildScreenshotFraming([], 'x').startsWith(`${CONTEXT_PREFIX} `)).toBe(true);
  });
});
