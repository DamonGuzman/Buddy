/** One loader and one package path for Buddy's same-process AppKit bridge. */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const NATIVE_BINARY_NAME = 'buddy-macos-native.node';
const loadNative = createRequire(__filename);

let cachedBridge: unknown;

export function getMacNativeBridgePath(): string | null {
  if (process.platform !== 'darwin') return null;
  const nativePath = app.isPackaged
    ? join(process.resourcesPath, NATIVE_BINARY_NAME)
    : join(app.getAppPath(), 'build', 'native', NATIVE_BINARY_NAME);
  return existsSync(nativePath) ? nativePath : null;
}

/** Load the native module once. Callers own feature-specific validation and error policy. */
export function loadMacNativeBridge(): unknown {
  if (process.platform !== 'darwin') return null;
  if (cachedBridge !== undefined) return cachedBridge;
  const nativePath = getMacNativeBridgePath();
  if (nativePath === null) throw new Error('Buddy macOS integration bridge is missing');
  cachedBridge = loadNative(nativePath) as unknown;
  return cachedBridge;
}
