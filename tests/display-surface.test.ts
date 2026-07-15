import { describe, expect, it } from 'vitest';
import { resolveDisplaySurface } from '../src/main/windows/display-surface';

const display = {
  bounds: { y: 0 },
  workArea: { y: 25 },
};

describe('resolveDisplaySurface', () => {
  it('turns the native Mac safe area into notch-attached DIP geometry', () => {
    expect(
      resolveDisplaySurface('darwin', display, {
        displayId: 7,
        hasNotch: true,
        safeTop: 32,
        notchWidth: 184,
        menuBarHeight: 37,
      }),
    ).toEqual({
      kind: 'notch',
      notchWidth: 184,
      notchHeight: 37,
      menuBarHeight: 37,
    });
  });

  it('falls back to a detached Mac capsule when native geometry is absent', () => {
    expect(resolveDisplaySurface('darwin', display, null)).toEqual({
      kind: 'floating',
      notchWidth: 0,
      notchHeight: 0,
      menuBarHeight: 25,
    });
  });

  it('keeps the macOS-only surface off on Windows', () => {
    expect(resolveDisplaySurface('win32', display, null).kind).toBe('off');
  });
});
