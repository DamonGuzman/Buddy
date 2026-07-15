/** Same-process macOS Screen Recording and Input Monitoring consent bridge. */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface MacPrivacyNative {
  requestScreenCaptureAccess(): boolean;
  preflightListenEventAccess(): boolean;
  requestListenEventAccess(): boolean;
  coverDisplayWithWindow(nativeHandle: Buffer, displayId: number): boolean;
  getDisplaySurface(displayId: number): MacDisplaySurfaceNative | null;
  queryAccessibility(requestJson: string): string;
}

export interface MacDisplaySurfaceNative {
  displayId: number;
  hasNotch: boolean;
  safeTop: number;
  notchWidth: number;
  menuBarHeight: number;
}

export interface MacAccessibilityCandidate {
  name: string;
  ct?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pid: number;
  windowRank: number;
}

export interface MacAccessibilityResult {
  candidates: MacAccessibilityCandidate[];
  elapsedMs: number;
  visited: number;
  windows: number;
  from: string | null;
  error?: string;
}

const loadNative = createRequire(__filename);
let cachedBridge: MacPrivacyNative | null | undefined;

export function getMacNativeBridgePath(): string | null {
  if (process.platform !== 'darwin') return null;
  const nativePath = app.isPackaged
    ? join(process.resourcesPath, 'macos-screen-permission.node')
    : join(app.getAppPath(), 'build', 'native', 'macos-screen-permission.node');
  return existsSync(nativePath) ? nativePath : null;
}

function bridge(): MacPrivacyNative | null {
  if (process.platform !== 'darwin') return null;
  if (cachedBridge !== undefined) return cachedBridge;
  const nativePath = getMacNativeBridgePath();
  if (nativePath === null) {
    console.warn('[permissions] macOS integration bridge is missing');
    cachedBridge = null;
    return null;
  }
  try {
    cachedBridge = loadNative(nativePath) as MacPrivacyNative;
  } catch (err) {
    console.warn(
      '[permissions] macOS privacy bridge failed to load:',
      err instanceof Error ? err.message : String(err),
    );
    cachedBridge = null;
  }
  return cachedBridge;
}

/**
 * Apple's consent API must execute inside Buddy itself. A helper executable
 * gets a separate TCC identity and would put the wrong process in Settings.
 * This runs only after an explicit user capture request.
 */
export function requestMacScreenCaptureAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    return bridge()?.requestScreenCaptureAccess() ?? false;
  } catch (err) {
    console.warn(
      '[permissions] macOS screen-consent request failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Whether this exact Buddy build may observe global keyboard events. */
export function preflightMacInputMonitoringAccess(): boolean | null {
  if (process.platform !== 'darwin') return true;
  try {
    return bridge()?.preflightListenEventAccess() ?? null;
  } catch (err) {
    console.warn(
      '[permissions] macOS input-monitoring preflight failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Register/request Buddy under Privacy & Security > Input Monitoring. */
export function requestMacInputMonitoringAccess(): boolean | null {
  if (process.platform !== 'darwin') return true;
  try {
    return bridge()?.requestListenEventAccess() ?? null;
  } catch (err) {
    console.warn(
      '[permissions] macOS input-monitoring request failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Fail-soft AppKit screen geometry for the overlay covering `displayId`. */
export function getMacDisplaySurface(displayId: number): MacDisplaySurfaceNative | null {
  if (process.platform !== 'darwin') return null;
  try {
    const value = bridge()?.getDisplaySurface(displayId) ?? null;
    if (
      value === null ||
      value.displayId !== displayId ||
      !Number.isFinite(value.safeTop) ||
      !Number.isFinite(value.notchWidth) ||
      !Number.isFinite(value.menuBarHeight)
    ) {
      return null;
    }
    return value;
  } catch (err) {
    console.warn(
      '[overlay] macOS display geometry failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Place an Electron overlay at the physical NSScreen frame, above the menu bar. */
export function coverMacDisplayWithWindow(nativeHandle: Buffer, displayId: number): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    return bridge()?.coverDisplayWithWindow(nativeHandle, displayId) ?? false;
  } catch (err) {
    console.warn(
      '[overlay] native full-display placement failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Bounded, synchronous AX enumeration. It runs in Buddy's own process so the
 * existing Accessibility grant applies; callers wrap it in the shared async
 * grounding contract and retain REST/raw fallbacks.
 */
export function queryMacAccessibility(request: {
  x: number;
  y: number;
  radius: number;
  budgetMs: number;
  maxNodes: number;
  excludePid: number;
}): MacAccessibilityResult {
  const empty = (error: string): MacAccessibilityResult => ({
    candidates: [],
    elapsedMs: 0,
    visited: 0,
    windows: 0,
    from: null,
    error,
  });
  if (process.platform !== 'darwin') return empty('unsupported_platform');
  try {
    const raw = bridge()?.queryAccessibility(JSON.stringify(request));
    return parseMacAccessibilityResult(raw);
  } catch (err) {
    console.warn(
      '[grounding] macOS accessibility query failed:',
      err instanceof Error ? err.message : String(err),
    );
    return empty('native_query_failed');
  }
}

/** Validate worker/native output before it enters the shared scorer. */
export function parseMacAccessibilityResult(raw: unknown): MacAccessibilityResult {
  const empty = (error: string): MacAccessibilityResult => ({
    candidates: [],
    elapsedMs: 0,
    visited: 0,
    windows: 0,
    from: null,
    error,
  });
  try {
    if (typeof raw !== 'string') return empty('native_bridge_unavailable');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidates: MacAccessibilityCandidate[] = [];
    const items = Array.isArray(parsed['candidates']) ? parsed['candidates'] : [];
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const c = item as Record<string, unknown>;
      if (
        typeof c['name'] !== 'string' ||
        typeof c['x'] !== 'number' ||
        typeof c['y'] !== 'number' ||
        typeof c['w'] !== 'number' ||
        typeof c['h'] !== 'number' ||
        typeof c['pid'] !== 'number' ||
        typeof c['windowRank'] !== 'number' ||
        !Number.isFinite(c['x']) ||
        !Number.isFinite(c['y']) ||
        !Number.isFinite(c['w']) ||
        !Number.isFinite(c['h'])
      ) {
        continue;
      }
      candidates.push({
        name: c['name'],
        ...(typeof c['ct'] === 'string' ? { ct: c['ct'] } : {}),
        x: c['x'],
        y: c['y'],
        w: c['w'],
        h: c['h'],
        pid: c['pid'],
        windowRank: c['windowRank'],
      });
    }
    return {
      candidates,
      elapsedMs: typeof parsed['elapsedMs'] === 'number' ? parsed['elapsedMs'] : 0,
      visited: typeof parsed['visited'] === 'number' ? parsed['visited'] : 0,
      windows: typeof parsed['windows'] === 'number' ? parsed['windows'] : 0,
      from: typeof parsed['from'] === 'string' ? parsed['from'] : null,
      ...(typeof parsed['error'] === 'string' ? { error: parsed['error'] } : {}),
    };
  } catch {
    return empty('invalid_native_response');
  }
}
