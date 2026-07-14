/** Same-process macOS Screen Recording and Input Monitoring consent bridge. */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface MacPrivacyNative {
  requestScreenCaptureAccess(): boolean;
  preflightListenEventAccess(): boolean;
  requestListenEventAccess(): boolean;
}

const loadNative = createRequire(__filename);
let cachedBridge: MacPrivacyNative | null | undefined;

function bridge(): MacPrivacyNative | null {
  if (process.platform !== 'darwin') return null;
  if (cachedBridge !== undefined) return cachedBridge;
  const nativePath = app.isPackaged
    ? join(process.resourcesPath, 'macos-screen-permission.node')
    : join(app.getAppPath(), 'build', 'native', 'macos-screen-permission.node');
  if (!existsSync(nativePath)) {
    console.warn('[permissions] macOS privacy bridge is missing:', nativePath);
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
