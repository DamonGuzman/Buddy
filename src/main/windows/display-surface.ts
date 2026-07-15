import type { OverlayDisplaySurface } from '../../shared/types';
import type { MacDisplaySurfaceNative } from './mac-screen-permission';

interface DisplayFrame {
  bounds: { y: number };
  workArea: { y: number };
}

const OFF: OverlayDisplaySurface = {
  kind: 'off',
  notchWidth: 0,
  notchHeight: 0,
  menuBarHeight: 0,
};

/**
 * Normalize platform geometry into one renderer contract. Electron's work
 * area remains the fallback, so a missing/incompatible native bridge degrades
 * to the floating capsule instead of making the overlay fail.
 */
export function resolveDisplaySurface(
  platform: NodeJS.Platform,
  display: DisplayFrame,
  native: MacDisplaySurfaceNative | null,
): OverlayDisplaySurface {
  if (platform !== 'darwin') return OFF;

  const workAreaInset = Math.max(0, display.workArea.y - display.bounds.y);
  const menuBarHeight = Math.max(0, native?.menuBarHeight ?? workAreaInset);
  if (
    native?.hasNotch === true &&
    native.safeTop > 0 &&
    native.notchWidth > 0
  ) {
    return {
      kind: 'notch',
      notchWidth: native.notchWidth,
      notchHeight: Math.max(native.safeTop, menuBarHeight),
      menuBarHeight,
    };
  }

  return {
    kind: 'floating',
    notchWidth: 0,
    notchHeight: 0,
    menuBarHeight: menuBarHeight || workAreaInset,
  };
}
