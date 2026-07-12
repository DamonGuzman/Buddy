/**
 * Multi-display screenshot pipeline (M1 stub).
 *
 * Contract (docs/ARCHITECTURE.md §2, §6): on hotkey press, capture every
 * display via desktopCapturer, resize to <= CAPTURE_MAX_EDGE on the longest
 * edge, encode JPEG ~CAPTURE_JPEG_QUALITY, label screen0..N with the cursor's
 * display flagged active, and exclude Clicky's own windows. Capture happens
 * ONLY on hotkey / explicit request — never continuous.
 */

import { screen } from 'electron';
import { CAPTURE_MAX_EDGE } from '../shared/constants';
import type { CaptureMeta } from '../shared/types';

export interface CaptureResult {
  meta: CaptureMeta;
  /** JPEG bytes, base64 (ready for an input_image content part). */
  jpegBase64: string;
}

/**
 * Capture all displays.
 *
 * M1: returns accurate per-display METADATA with an empty image payload so
 * the coordinate contract and debug surface are exercisable end-to-end.
 * The real desktopCapturer pipeline lands in the capture milestone.
 */
export async function captureAllDisplays(): Promise<CaptureResult[]> {
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  const activeDisplay = screen.getDisplayNearestPoint(cursor);

  return displays.map((display, screenIndex) => {
    const physicalW = Math.round(display.bounds.width * display.scaleFactor);
    const physicalH = Math.round(display.bounds.height * display.scaleFactor);
    const ratio = Math.min(1, CAPTURE_MAX_EDGE / Math.max(physicalW, physicalH));
    return {
      meta: {
        screenIndex,
        displayId: display.id,
        imageW: Math.round(physicalW * ratio),
        imageH: Math.round(physicalH * ratio),
        displayBounds: { ...display.bounds },
        scaleFactor: display.scaleFactor,
        isActive: display.id === activeDisplay.id,
      },
      jpegBase64: '', // TODO(capture milestone): desktopCapturer + resize + JPEG
    };
  });
}
