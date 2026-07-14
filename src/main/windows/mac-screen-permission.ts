/** Same-process macOS Screen Recording consent request. */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface MacScreenPermissionNative {
  requestScreenCaptureAccess(): boolean;
}

const loadNative = createRequire(__filename);

/**
 * Apple's consent API must execute inside Buddy itself. A helper executable
 * gets a separate TCC identity and would put the wrong process in Settings.
 * This runs only after an explicit user capture request.
 */
export function requestMacScreenCaptureAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  const nativePath = app.isPackaged
    ? join(process.resourcesPath, 'macos-screen-permission.node')
    : join(app.getAppPath(), 'build', 'native', 'macos-screen-permission.node');
  if (!existsSync(nativePath)) {
    console.warn('[permissions] macOS screen-consent bridge is missing:', nativePath);
    return false;
  }
  try {
    const native = loadNative(nativePath) as MacScreenPermissionNative;
    return native.requestScreenCaptureAccess();
  } catch (err) {
    console.warn(
      '[permissions] macOS screen-consent request failed:',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
