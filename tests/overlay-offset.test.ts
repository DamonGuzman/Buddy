import { describe, expect, it } from 'vitest';
import { offsetPointerForWindow } from '../src/main/windows/overlay-offset';
import type { PointerCommand } from '../src/shared/types';

const animate: PointerCommand = {
  type: 'animate',
  screenIndex: 0,
  points: [{ x: 320, y: 220, label: 'button' }],
};

describe('overlay window coordinate offset', () => {
  it('subtracts the macOS menu-bar clamp from display-local targets', () => {
    expect(
      offsetPointerForWindow(
        animate,
        { x: 0, y: 0, width: 1440, height: 900 },
        { x: 0, y: 30, width: 1440, height: 900 },
      ),
    ).toMatchObject({ points: [{ x: 320, y: 190, label: 'button' }] });
  });

  it('is identity when origins already match and for non-flight commands', () => {
    const bounds = { x: -1440, y: 0, width: 1440, height: 900 };
    expect(offsetPointerForWindow(animate, bounds, bounds)).toBe(animate);
    const idle = { type: 'idle' } as const;
    expect(offsetPointerForWindow(idle, bounds, { ...bounds, y: 30 })).toBe(idle);
  });
});
