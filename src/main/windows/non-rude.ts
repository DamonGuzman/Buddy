/**
 * Windows Shell fullscreen-classification seam.
 *
 * A transparent BrowserWindow that exactly covers a monitor can make Explorer
 * treat it as a fullscreen app and demote the taskbar, even when Electron's
 * always-on-top level is `floating`. Microsoft documents the `NonRudeHWND`
 * window property as the opt-out. Electron does not expose SetPropW, so this
 * small Windows-only seam applies it through the inbox PowerShell runtime
 * before the overlay is first shown.
 */

import { execFile } from 'node:child_process';

const POWERSHELL_TIMEOUT_MS = 5_000;

export type EncodedPowerShellRunner = (encodedCommand: string) => Promise<void>;

export interface NonRudeOptions {
  platform?: NodeJS.Platform;
  runPowerShell?: EncodedPowerShellRunner;
}

/** Decode Electron's native HWND buffer without losing 64-bit precision. */
export function nativeHandleValue(handle: Buffer): bigint {
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  if (handle.length >= 4) return BigInt(handle.readUInt32LE(0));
  throw new Error(`native window handle is only ${handle.length} bytes`);
}

/** Build a UTF-16LE PowerShell encoded command for one trusted numeric HWND. */
export function nonRudeEncodedCommand(hwnd: bigint): string {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClickyTaskbarWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetProp(IntPtr hWnd, string lpString, IntPtr hData);
}
'@
$ok = [ClickyTaskbarWindow]::SetProp([IntPtr]${hwnd.toString()}, 'NonRudeHWND', [IntPtr]1)
if (-not $ok) { exit 1 }
`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Mark an HWND as a non-fullscreen overlay. Returns false rather than throwing
 * so startup can fall back to a non-topmost overlay without taking down Buddy.
 */
export async function markNativeWindowNonRude(
  handle: Buffer,
  options: NonRudeOptions = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return true;

  try {
    const encoded = nonRudeEncodedCommand(nativeHandleValue(handle));
    await (options.runPowerShell ?? runEncodedPowerShell)(encoded);
    return true;
  } catch (error) {
    console.warn('[overlay] failed to mark window NonRudeHWND:', String(error));
    return false;
  }
}

function runEncodedPowerShell(encodedCommand: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedCommand,
      ],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
