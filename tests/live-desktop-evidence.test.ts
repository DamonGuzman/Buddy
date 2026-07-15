import { describe, expect, it } from 'vitest';
import type { CaptureResult } from '../src/main/capture';
import {
  coarseVisualFingerprint,
  denseVisualFingerprint,
  enforceVisualSnapshotBudget,
  isBoundedTransientChange,
  mapReceiverFocusToCapture,
  NativeReceiverLiveDesktopEvidence,
  quantizedRegionSample,
} from '../src/main/computer/live-desktop-evidence';

function bitmapWithPatch(patch: { x: number; y: number; size: number } | null): Buffer {
  const width = 200;
  const height = 200;
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const highlighted =
        patch !== null &&
        x >= patch.x &&
        x < patch.x + patch.size &&
        y >= patch.y &&
        y < patch.y + patch.size;
      bitmap[offset] = highlighted ? 240 : 64;
      bitmap[offset + 1] = highlighted ? 240 : 64;
      bitmap[offset + 2] = highlighted ? 240 : 64;
      bitmap[offset + 3] = 255;
    }
  }
  return bitmap;
}

describe('VisualLiveDesktopEvidence', () => {
  it('binds literal typing to exact native identity without JPEG caret churn', async () => {
    const receiver = {
      query: async () => 'receiver-field-a',
      restore: async () => true,
      prepareTypeTextPostcondition: async () => 'proof',
      verifyTypeTextPostcondition: async () => true,
    };
    const evidence = new NativeReceiverLiveDesktopEvidence(receiver);

    await expect(evidence.fingerprint([], null, true, 'receiver-field-a', false)).resolves.toBe(
      'receiver-field-a',
    );
    await expect(
      evidence.fingerprint([], null, true, 'receiver-field-a', true),
    ).resolves.toBeNull();
  });

  it('ignores animation away from a click target but rejects a target-local change', async () => {
    const anchor = { screenIndex: 0, x: 100, y: 100 };
    const baseline = coarseVisualFingerprint(bitmapWithPatch(null), 200, 200, anchor);
    const remoteClock = coarseVisualFingerprint(
      bitmapWithPatch({ x: 5, y: 5, size: 20 }),
      200,
      200,
      anchor,
    );
    const changedTarget = coarseVisualFingerprint(
      bitmapWithPatch({ x: 90, y: 90, size: 20 }),
      200,
      200,
      anchor,
    );

    expect(remoteClock).toBe(baseline);
    expect(changedTarget).not.toBe(baseline);
  });

  it('distinguishes target layouts with identical block luminance averages', () => {
    const anchor = { screenIndex: 0, x: 100, y: 100 };
    const first = bitmapWithPatch(null);
    const second = Buffer.from(first);
    const firstOffset = (88 * 200 + 88) * 4;
    const secondOffset = (88 * 200 + 89) * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      first[firstOffset + channel] = 240;
      first[secondOffset + channel] = 16;
      second[firstOffset + channel] = 16;
      second[secondOffset + channel] = 240;
    }

    expect(coarseVisualFingerprint(first, 200, 200, anchor)).not.toBe(
      coarseVisualFingerprint(second, 200, 200, anchor),
    );
  });

  it('maps a receiver on screen1 with a negative origin while the cursor is elsewhere', () => {
    const captures: CaptureResult[] = [
      capture(0, { x: 0, y: 0, width: 1440, height: 900 }, 1280, 800, true, 2),
      capture(1, { x: -1200, y: 0, width: 1200, height: 800 }, 600, 400, false, 2),
    ];
    const mapped = mapReceiverFocusToCapture(captures, {
      platform: 'darwin',
      rect: { x: -1100, y: 100, w: 200, h: 40 },
    });

    expect(mapped?.capture.meta.screenIndex).toBe(1);
    expect(mapped?.region).toEqual({ x: 50, y: 50, width: 100, height: 20 });
  });

  it('ignores Buddy-panel pixels outside the receiver while staling receiver-local changes', () => {
    const region = { x: 80, y: 80, width: 40, height: 30 };
    const baseline = bitmapWithPatch(null);
    const hiddenPanel = bitmapWithPatch({ x: 5, y: 5, size: 20 });
    const changedReceiver = bitmapWithPatch({ x: 90, y: 90, size: 12 });

    expect(denseVisualFingerprint(hiddenPanel, 200, 200, region)).toBe(
      denseVisualFingerprint(baseline, 200, 200, region),
    );
    expect(denseVisualFingerprint(changedReceiver, 200, 200, region)).not.toBe(
      denseVisualFingerprint(baseline, 200, 200, region),
    );
  });

  it('uses injected Windows physical-to-DIP conversion and per-axis portrait scaling', () => {
    const captures = [
      capture(2, { x: 100, y: -900, width: 600, height: 900 }, 400, 600, false, 1.5),
    ];
    const mapped = mapReceiverFocusToCapture(
      captures,
      { platform: 'win32', rect: { x: 500, y: -1500, w: 300, h: 180 } },
      (_platform, point) => ({ x: point.x / 2, y: point.y / 2 }),
    );

    expect(mapped?.region).toEqual({ x: 100, y: 100, width: 100, height: 60 });
  });

  it('fails closed for ambiguous overlapping displays and clipped receiver rectangles', () => {
    const duplicate = capture(1, { x: 0, y: 0, width: 200, height: 200 }, 200, 200);
    expect(
      mapReceiverFocusToCapture(
        [capture(0, { x: 0, y: 0, width: 200, height: 200 }, 200, 200), duplicate],
        { platform: 'darwin', rect: { x: 50, y: 50, w: 40, h: 20 } },
      ),
    ).toBeNull();
    expect(
      mapReceiverFocusToCapture([capture(0, { x: 0, y: 0, width: 200, height: 200 }, 200, 200)], {
        platform: 'darwin',
        rect: { x: -10, y: 50, w: 20, h: 20 },
      }),
    ).toBeNull();
  });

  it('tolerates a bounded blinking caret but rejects meaningful local content changes', () => {
    const region = { x: 0, y: 0, width: 100, height: 20 };
    const baseline = Buffer.alloc(region.width * region.height * 3, 20);
    const caret = Buffer.from(baseline);
    for (let y = 3; y < 17; y += 1) {
      for (let x = 50; x < 52; x += 1)
        caret.fill(0, (y * region.width + x) * 3, (y * region.width + x) * 3 + 3);
    }
    const content = Buffer.from(baseline);
    for (let y = 5; y < 15; y += 1) {
      for (let x = 30; x < 45; x += 1)
        content.fill(0, (y * region.width + x) * 3, (y * region.width + x) * 3 + 3);
    }

    expect(isBoundedTransientChange(baseline, caret, region)).toBe(true);
    expect(isBoundedTransientChange(baseline, content, region)).toBe(false);
  });

  it('bounds large-control samples and total retained receiver evidence memory', () => {
    const bitmap = Buffer.alloc(1600 * 1200 * 4, 64);
    const sample = quantizedRegionSample(bitmap, 1600, {
      x: 0,
      y: 0,
      width: 1600,
      height: 1200,
    });
    expect(sample.width * sample.height).toBeLessThanOrEqual(512 * 512);
    expect(sample.pixels.byteLength).toBeLessThanOrEqual(512 * 512 * 3);

    const snapshots = new Map<string, { pixels: Buffer }>();
    for (let index = 0; index < 40; index += 1) {
      snapshots.set(`receiver-${index}`, { pixels: Buffer.alloc(512 * 512 * 3) });
    }
    enforceVisualSnapshotBudget(snapshots);
    const retainedBytes = [...snapshots.values()].reduce(
      (total, value) => total + value.pixels.byteLength,
      0,
    );
    expect(snapshots.size).toBeLessThanOrEqual(32);
    expect(retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(snapshots.has('receiver-0')).toBe(false);
  });
});

function capture(
  screenIndex: number,
  displayBounds: { x: number; y: number; width: number; height: number },
  imageW: number,
  imageH: number,
  isActive = false,
  scaleFactor = 1,
): CaptureResult {
  return {
    meta: {
      screenIndex,
      displayId: screenIndex + 10,
      imageW,
      imageH,
      displayBounds,
      scaleFactor,
      isActive,
    },
    jpegBase64: '',
  };
}
