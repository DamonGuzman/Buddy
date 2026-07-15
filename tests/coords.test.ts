/**
 * Coordinate contract tests (docs/ARCHITECTURE.md §6).
 *
 * Fixtures simulate the real capture math: physical resolution = DIP bounds x
 * scaleFactor, then the <= CAPTURE_MAX_EDGE longest-edge resize with per-axis
 * rounding — exactly what src/main/capture.ts produces.
 */

import { describe, expect, it } from 'vitest';
import { CAPTURE_MAX_EDGE } from '../src/shared/constants';
import {
  clampToDisplay,
  mapModelPoint,
  mapPointToScreen,
  normalizeModelPoint,
  physicalSize,
} from '../src/main/coords';
import type { CaptureMeta, Rect } from '../src/shared/types';

/** Build CaptureMeta the same way the capture pipeline does. */
function makeMeta(
  bounds: Rect,
  scaleFactor: number,
  overrides: Partial<CaptureMeta> = {},
): CaptureMeta {
  const physW = Math.round(bounds.width * scaleFactor);
  const physH = Math.round(bounds.height * scaleFactor);
  const longest = Math.max(physW, physH);
  const ratio = Math.min(1, CAPTURE_MAX_EDGE / longest);
  return {
    screenIndex: 0,
    displayId: 1,
    imageW: Math.round(physW * ratio),
    imageH: Math.round(physH * ratio),
    displayBounds: { ...bounds },
    scaleFactor,
    isActive: true,
    ...overrides,
  };
}

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

describe('fixture sanity (capture math simulation)', () => {
  it('1080p@100% fits under the 2048 cap (no resize)', () => {
    const meta = makeMeta(rect(0, 0, 1920, 1080), 1);
    expect(meta.imageW).toBe(1920);
    expect(meta.imageH).toBe(1080);
  });

  it('4K@200% (1920x1080 DIP) resizes to 2048x1152', () => {
    const meta = makeMeta(rect(0, 0, 1920, 1080), 2);
    expect(meta.imageW).toBe(2048);
    expect(meta.imageH).toBe(1152);
  });

  it('portrait 2160x3840 physical resizes to 1152x2048 (height is longest edge)', () => {
    const meta = makeMeta(rect(0, 0, 1080, 1920), 2);
    expect(meta.imageW).toBe(1152);
    expect(meta.imageH).toBe(2048);
  });

  it('small displays are not upscaled', () => {
    const meta = makeMeta(rect(0, 0, 1024, 768), 1);
    expect(meta.imageW).toBe(1024);
    expect(meta.imageH).toBe(768);
  });
});

describe('mapPointToScreen — DPI scale factors', () => {
  it('100% DPI: image center -> display center', () => {
    const meta = makeMeta(rect(0, 0, 1920, 1080), 1); // image 1920x1080 (no resize)
    const { globalDip, overlayLocal } = mapPointToScreen({ x: 960, y: 540 }, meta);
    expect(overlayLocal).toEqual({ x: 960, y: 540 });
    expect(globalDip).toEqual({ x: 960, y: 540 });
  });

  it('100% DPI: no-resize display maps 1:1', () => {
    const meta = makeMeta(rect(0, 0, 1024, 768), 1); // ratio 1
    const { overlayLocal } = mapPointToScreen({ x: 100, y: 200 }, meta);
    expect(overlayLocal.x).toBeCloseTo(100, 10);
    expect(overlayLocal.y).toBeCloseTo(200, 10);
  });

  it('125% DPI: 1920x1080 physical / 1536x864 DIP', () => {
    const meta = makeMeta(rect(0, 0, 1536, 864), 1.25); // phys 1920x1080, image 1920x1080
    expect(meta.imageW).toBe(1920);
    const { overlayLocal } = mapPointToScreen({ x: 1920, y: 1080 }, meta);
    expect(overlayLocal.x).toBeCloseTo(1536, 6);
    expect(overlayLocal.y).toBeCloseTo(864, 6);
  });

  it('150% DPI: 2560x1440 physical / 1707x960 DIP resizes to 2048x1152', () => {
    const meta = makeMeta(rect(0, 0, 1707, 960), 1.5); // phys 2561x1440, image 2048x1152
    expect(meta.imageW).toBe(2048);
    expect(meta.imageH).toBe(1152);
    const { overlayLocal } = mapPointToScreen({ x: 1024, y: 576 }, meta);
    expect(overlayLocal.x).toBeCloseTo(1707 / 2, 6);
    expect(overlayLocal.y).toBeCloseTo(480, 6);
  });

  it('200% DPI: 4K physical / 1920x1080 DIP', () => {
    const meta = makeMeta(rect(0, 0, 1920, 1080), 2); // phys 3840x2160, image 2048x1152
    const { overlayLocal, globalDip } = mapPointToScreen({ x: 1024, y: 576 }, meta);
    // 1024 image px -> 1920 phys px -> 960 DIP
    expect(overlayLocal.x).toBeCloseTo(960, 6);
    expect(overlayLocal.y).toBeCloseTo(540, 6);
    expect(globalDip).toEqual(overlayLocal);
  });

  it('150% DPI with non-integer DIP bounds rounding (2560x1440 phys -> 1707 DIP)', () => {
    // Windows reports 2560/1.5 = 1706.67 as 1707 DIP. Corner must still map
    // exactly onto the DIP corner thanks to per-axis ratios.
    const meta = makeMeta(rect(0, 0, 1707, 960), 1.5);
    const corner = mapPointToScreen({ x: meta.imageW, y: meta.imageH }, meta);
    expect(corner.overlayLocal.x).toBeCloseTo(1707, 6);
    expect(corner.overlayLocal.y).toBeCloseTo(960, 6);
  });
});

describe('mapPointToScreen — multi-monitor arrangements', () => {
  // 4K@200% primary + 1080p@100% to the LEFT of it (negative origin).
  const primary = makeMeta(rect(0, 0, 1920, 1080), 2, { screenIndex: 0, displayId: 10 });
  const left = makeMeta(rect(-1920, 0, 1920, 1080), 1, {
    screenIndex: 1,
    displayId: 20,
    isActive: false,
  });

  it('mixed-DPI: each image corner lands on its own display corner', () => {
    // primary image is 2048x1152 (resized), left image is 1920x1080 (1:1)
    const onPrimary = mapPointToScreen({ x: primary.imageW, y: primary.imageH }, primary);
    const onLeft = mapPointToScreen({ x: left.imageW, y: left.imageH }, left);
    expect(onPrimary.globalDip.x).toBeCloseTo(1920, 6);
    expect(onLeft.globalDip.x).toBeCloseTo(0, 6); // -1920 + 1920
    expect(onLeft.overlayLocal.x).toBeCloseTo(1920, 6);
  });

  it('negative-origin (left-of-primary): origin of image -> negative global DIP', () => {
    const { globalDip, overlayLocal } = mapPointToScreen({ x: 0, y: 0 }, left);
    expect(globalDip).toEqual({ x: -1920, y: 0 });
    expect(overlayLocal).toEqual({ x: 0, y: 0 });
  });

  it('negative-origin above-primary monitor', () => {
    const above = makeMeta(rect(0, -1080, 1920, 1080), 1); // image 1920x1080 (1:1)
    const { globalDip, overlayLocal } = mapPointToScreen({ x: 960, y: 540 }, above);
    expect(overlayLocal).toEqual({ x: 960, y: 540 });
    expect(globalDip).toEqual({ x: 960, y: -540 });
  });

  it('portrait secondary display maps both axes with their own ratios', () => {
    const portrait = makeMeta(rect(1920, -400, 1080, 1920), 2); // phys 2160x3840, image 1152x2048
    const center = mapPointToScreen({ x: 576, y: 1024 }, portrait);
    expect(center.overlayLocal.x).toBeCloseTo(540, 6);
    expect(center.overlayLocal.y).toBeCloseTo(960, 6);
    expect(center.globalDip.x).toBeCloseTo(2460, 6);
    expect(center.globalDip.y).toBeCloseTo(560, 6);
  });

  it('portrait 200% DPI display', () => {
    const meta = makeMeta(rect(0, 0, 1080, 1920), 2); // phys 2160x3840, image 1152x2048
    expect(meta.imageW).toBe(1152);
    expect(meta.imageH).toBe(2048);
    const corner = mapPointToScreen({ x: 1152, y: 2048 }, meta);
    expect(corner.overlayLocal.x).toBeCloseTo(1080, 6);
    expect(corner.overlayLocal.y).toBeCloseTo(1920, 6);
  });
});

describe('edges, rounding, clamping', () => {
  const meta = makeMeta(rect(0, 0, 1920, 1080), 2); // phys 3840x2160, image 2048x1152

  it('image origin maps exactly to display origin', () => {
    const { overlayLocal } = mapPointToScreen({ x: 0, y: 0 }, meta);
    expect(overlayLocal).toEqual({ x: 0, y: 0 });
  });

  it('image far corner maps exactly to display far corner (no drift)', () => {
    const { overlayLocal } = mapPointToScreen({ x: 2048, y: 1152 }, meta);
    expect(overlayLocal.x).toBeCloseTo(1920, 10);
    expect(overlayLocal.y).toBeCloseTo(1080, 10);
  });

  it('odd physical sizes: corner still maps onto the DIP corner per axis', () => {
    // 2732x1536@100% -> ratio 2048/2732, imageH rounds (1151.44 -> 1151)
    const odd = makeMeta(rect(0, 0, 2732, 1536), 1);
    expect(odd.imageW).toBe(2048);
    expect(odd.imageH).toBe(1151);
    const corner = mapPointToScreen({ x: odd.imageW, y: odd.imageH }, odd);
    expect(corner.overlayLocal.x).toBeCloseTo(2732, 6);
    expect(corner.overlayLocal.y).toBeCloseTo(1536, 6);
  });

  it('clampToDisplay clamps into [0, width]x[0, height]', () => {
    expect(clampToDisplay({ x: -5, y: 2000 }, meta)).toEqual({ x: 0, y: 1080 });
    expect(clampToDisplay({ x: 500, y: 500 }, meta)).toEqual({ x: 500, y: 500 });
    expect(clampToDisplay({ x: 1921, y: -0.001 }, meta)).toEqual({ x: 1920, y: 0 });
  });

  it('physicalSize agrees with the fixture math', () => {
    expect(physicalSize(meta)).toEqual({ width: 3840, height: 2160 });
  });

  it('throws on corrupt meta', () => {
    const bad = { ...meta, imageW: 0 };
    expect(() => mapPointToScreen({ x: 1, y: 1 }, bad)).toThrow(/invalid capture meta/);
    const badScale = { ...meta, scaleFactor: 0 };
    expect(() => mapPointToScreen({ x: 1, y: 1 }, badScale)).toThrow(/invalid capture meta/);
  });
});

describe('model-input validation (normalizeModelPoint / mapModelPoint)', () => {
  const meta = makeMeta(rect(0, 0, 1920, 1080), 1); // image 1920x1080 (1:1)

  it('in-range points pass through unadjusted', () => {
    const { point, adjusted } = normalizeModelPoint({ x: 640, y: 360 }, meta);
    expect(point).toEqual({ x: 640, y: 360 });
    expect(adjusted).toBe(false);
  });

  it('out-of-range coords clamp to the image edge and are flagged', () => {
    const { point, adjusted } = normalizeModelPoint({ x: -40, y: 99999 }, meta);
    expect(point).toEqual({ x: 0, y: 1080 });
    expect(adjusted).toBe(true);
  });

  it('non-finite coords fall back to the image center', () => {
    const { point, adjusted } = normalizeModelPoint({ x: Number.NaN, y: Infinity }, meta);
    expect(point).toEqual({ x: 960, y: 540 });
    expect(adjusted).toBe(true);
  });

  it('exact edge coords are NOT flagged as adjusted', () => {
    const { point, adjusted } = normalizeModelPoint({ x: 1920, y: 1080 }, meta);
    expect(point).toEqual({ x: 1920, y: 1080 });
    expect(adjusted).toBe(false);
  });

  it('mapModelPoint end-to-end: overshoot ends up on the display edge', () => {
    const mapped = mapModelPoint({ x: 5000, y: -20, label: 'save button' }, meta);
    expect(mapped.local).toEqual({ x: 1920, y: 0 });
    expect(mapped.global).toEqual({ x: 1920, y: 0 });
    expect(mapped.label).toBe('save button');
    expect(mapped.adjusted).toBe(true);
  });

  it('mapModelPoint on a negative-origin display keeps global consistent', () => {
    const left = makeMeta(rect(-1920, 0, 1920, 1080), 1);
    const mapped = mapModelPoint({ x: 999999, y: 360 }, left);
    expect(mapped.local.x).toBe(1920);
    expect(mapped.global.x).toBe(0); // -1920 + 1920
  });
});
