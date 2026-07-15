/**
 * Capture / coordinate types (docs/ARCHITECTURE.md §6).
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Per-display metadata produced by every capture. */
export interface CaptureMeta {
  /** Stable index for this capture batch; images are labeled screen0..N. */
  screenIndex: number;
  /** Electron display id. */
  displayId: number;
  /** Width of the (possibly resized) screenshot the model sees, in px. */
  imageW: number;
  /** Height of the (possibly resized) screenshot the model sees, in px. */
  imageH: number;
  /** Display bounds in DIP (global coordinate space). */
  displayBounds: Rect;
  /** Display scale factor (1, 1.5, 2, ...). */
  scaleFactor: number;
  /** Whether the cursor was on this display at capture time. */
  isActive: boolean;
}
