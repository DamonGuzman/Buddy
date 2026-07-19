/**
 * Multi-display screenshot pipeline (M3) — the Electron half.
 *
 * Contract (docs/ARCHITECTURE.md §2, §6): on hotkey press, capture every
 * display via desktopCapturer, resize to <= CAPTURE_MAX_EDGE on the longest
 * edge, encode JPEG ~CAPTURE_JPEG_QUALITY, label screen0..N with the cursor's
 * display flagged active, and exclude Buddy's own windows (content
 * protection during capture). Capture happens ONLY on hotkey / explicit
 * request — never continuous.
 *
 * Pure math (resize planning, source<->display matching, meta construction)
 * lives in capture-math.ts so it can be unit-tested without Electron.
 */

import { BrowserWindow, desktopCapturer, screen, systemPreferences } from 'electron';
import type { Display, DesktopCapturerSource } from 'electron';
import { CAPTURE_JPEG_QUALITY } from '../shared/constants';
import type { CaptureMeta } from '../shared/types';
import {
  buildCaptureMeta,
  displayPhysicalSize,
  matchSourcesToDisplays,
  planResize,
} from './capture-math';
import { requestMacScreenCaptureAccess } from './windows/mac-screen-permission';

export interface CaptureResult {
  meta: CaptureMeta;
  /** JPEG bytes, base64 (ready for an input_image content part). */
  jpegBase64: string;
}

/**
 * Warning sink for capture-time diagnostics. Injectable so tests assert on
 * messages instead of console.warn call shapes.
 */
export interface CaptureLogger {
  warn(message: string): void;
}

const consoleCaptureLogger: CaptureLogger = {
  warn: (message) => console.warn(message),
};

// ---------------------------------------------------------------------------
// Self-exclusion (content protection)
// ---------------------------------------------------------------------------

/**
 * Windows exempted from capture-time content protection. QA/self-test only:
 * lets a control window stay visible in captures to prove protection works.
 */
const captureVisibleWindows = new WeakSet<BrowserWindow>();

/** Exempt a window from the capture-time content protection toggle. */
export function exemptFromCaptureProtection(win: BrowserWindow): void {
  captureVisibleWindows.add(win);
}

/**
 * Toggle content protection on every Buddy BrowserWindow so the model never
 * sees the buddy/caption/panel in screenshots. Best-effort per window (a
 * window may be destroyed mid-iteration).
 */
function setBuddyWindowsContentProtection(enabled: boolean, logger: CaptureLogger): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Hidden offscreen browser surfaces cannot appear in a desktop grab. Do
    // not mutate their compositor/content-protection state: a concurrent
    // webContents.capturePage() must keep producing the helper buddy's page rather
    // than a protected blank frame.
    if (win.isDestroyed() || !win.isVisible() || captureVisibleWindows.has(win)) continue;
    try {
      win.setContentProtection(enabled);
    } catch (err) {
      logger.warn(`[capture] setContentProtection failed: ${String(err)}`);
    }
  }
}

/** ScreenCaptureKit can ignore NSWindowSharingNone; hide Buddy for one compositor beat too. */
function hideBuddyWindowsForMacCapture(logger: CaptureLogger): () => void {
  if (process.platform !== 'darwin') return () => undefined;
  const prior = new Map<BrowserWindow, number>();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !win.isVisible() || captureVisibleWindows.has(win)) continue;
    try {
      prior.set(win, win.getOpacity());
      win.setOpacity(0);
    } catch (err) {
      logger.warn(`[capture] temporary macOS window exclusion failed: ${String(err)}`);
    }
  }
  return () => {
    for (const [win, opacity] of prior) {
      if (win.isDestroyed()) continue;
      try {
        win.setOpacity(opacity);
      } catch (err) {
        logger.warn(`[capture] restoring macOS window opacity failed: ${String(err)}`);
      }
    }
  };
}

function compositorBeat(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 34));
}

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

/**
 * Resize + encode one display's grab and build its CaptureMeta.
 * Null when the display has no usable source (warned, display skipped —
 * screenIndex stays aligned with display order for the surviving screens).
 */
function captureOneDisplay(
  display: Display,
  screenIndex: number,
  source: DesktopCapturerSource | undefined,
  activeDisplayId: number,
  logger: CaptureLogger,
): CaptureResult | null {
  if (!source) {
    logger.warn(`[capture] no source for display ${display.id} (screen${screenIndex}) — skipped`);
    return null;
  }

  const thumb = source.thumbnail;
  const size = thumb.getSize();
  if (size.width <= 0 || size.height <= 0) {
    logger.warn(`[capture] empty thumbnail for display ${display.id} — skipped`);
    return null;
  }

  const plan = planResize(size.width, size.height);
  const image = plan.resized
    ? thumb.resize({ width: plan.width, height: plan.height, quality: 'good' })
    : thumb;
  const finalSize = image.getSize();

  return {
    meta: buildCaptureMeta(
      display,
      screenIndex,
      finalSize.width,
      finalSize.height,
      activeDisplayId,
    ),
    jpegBase64: image.toJPEG(CAPTURE_JPEG_QUALITY).toString('base64'),
  };
}

/**
 * Capture all displays: desktopCapturer at physical resolution, per-display
 * source matching, resize to <= CAPTURE_MAX_EDGE longest edge, JPEG encode.
 *
 * Buddy's own windows are content-protected for the duration of the actual
 * screen grab (try/finally restores them so normal QA screenshots still see
 * them afterwards).
 */
export async function captureAllDisplays(
  logger: CaptureLogger = consoleCaptureLogger,
): Promise<CaptureResult[]> {
  if (process.platform === 'darwin') {
    let status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      requestMacScreenCaptureAccess();
      status = systemPreferences.getMediaAccessStatus('screen');
    }
    if (status !== 'granted') {
      throw new Error(
        'screen recording permission is denied; allow Buddy in System Settings > Privacy & Security > Screen & System Audio Recording',
      );
    }
  }
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return [];

  const cursor = screen.getCursorScreenPoint();
  const activeDisplayId = screen.getDisplayNearestPoint(cursor).id;

  // One thumbnailSize serves all sources: request the max physical
  // resolution; the capturer fits each screen's thumbnail within it,
  // preserving aspect ratio.
  let thumbW = 0;
  let thumbH = 0;
  for (const d of displays) {
    const phys = displayPhysicalSize(d.bounds, d.scaleFactor);
    thumbW = Math.max(thumbW, phys.width);
    thumbH = Math.max(thumbH, phys.height);
  }

  // SELF-EXCLUSION: hide Buddy's windows from the grab, always restore.
  setBuddyWindowsContentProtection(true, logger);
  const restoreMacVisibility = hideBuddyWindowsForMacCapture(logger);
  let sources;
  try {
    if (process.platform === 'darwin') await compositorBeat();
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });
  } finally {
    restoreMacVisibility();
    setBuddyWindowsContentProtection(false, logger);
  }

  const match = matchSourcesToDisplays(
    displays,
    sources.map((s) => ({ display_id: s.display_id, name: s.name })),
  );
  if (!match.matchedByDisplayId) {
    logger.warn(
      `[capture] display_id matching failed (ids: ${JSON.stringify(
        sources.map((s) => s.display_id),
      )} displays: ${JSON.stringify(displays.map((d) => d.id))}) — using order-based fallback`,
    );
  }

  const results: CaptureResult[] = [];
  displays.forEach((display, screenIndex) => {
    const sourceIndex = match.sourceIndexByDisplay[screenIndex] ?? null;
    const source = sourceIndex === null ? undefined : sources[sourceIndex];
    const result = captureOneDisplay(display, screenIndex, source, activeDisplayId, logger);
    if (result !== null) results.push(result);
  });

  return results;
}
