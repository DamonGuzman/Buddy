import { describe, expect, it } from 'vitest';
import { coarseVisualFingerprint } from '../src/main/computer/live-desktop-evidence';

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
});
