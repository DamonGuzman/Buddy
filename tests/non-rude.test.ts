import { describe, expect, it, vi } from 'vitest';
import {
  markNativeWindowNonRude,
  nativeHandleValue,
  nonRudeEncodedCommand,
} from '../src/main/windows/non-rude';

describe('Windows NonRudeHWND marker', () => {
  it('decodes a 64-bit native HWND without precision loss', () => {
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(0x1234_5678_9abc_def0n);
    expect(nativeHandleValue(handle)).toBe(0x1234_5678_9abc_def0n);
  });

  it('encodes a static SetProp command containing only the numeric HWND', () => {
    const encoded = nonRudeEncodedCommand(987654321n);
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain("SetProp([IntPtr]987654321, 'NonRudeHWND', [IntPtr]1)");
  });

  it('runs the marker on Windows and reports success', async () => {
    const runPowerShell = vi.fn(async () => undefined);
    const handle = Buffer.alloc(8);
    handle.writeBigUInt64LE(42n);

    await expect(
      markNativeWindowNonRude(handle, { platform: 'win32', runPowerShell }),
    ).resolves.toBe(true);
    expect(runPowerShell).toHaveBeenCalledOnce();
  });

  it('skips the Windows seam on other platforms', async () => {
    const runPowerShell = vi.fn(async () => undefined);
    await expect(
      markNativeWindowNonRude(Buffer.alloc(0), { platform: 'darwin', runPowerShell }),
    ).resolves.toBe(true);
    expect(runPowerShell).not.toHaveBeenCalled();
  });

  it('fails closed so the caller can remove always-on-top', async () => {
    const runPowerShell = vi.fn(async () => {
      throw new Error('SetProp failed');
    });
    await expect(
      markNativeWindowNonRude(Buffer.alloc(8), { platform: 'win32', runPowerShell }),
    ).resolves.toBe(false);
  });
});
