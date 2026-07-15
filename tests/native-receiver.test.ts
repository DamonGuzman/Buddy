import { describe, expect, it, vi } from 'vitest';
import {
  PlatformNativeReceiverProvider,
  parseMacReceiver,
  parseWindowsReceiver,
} from '../src/main/computer/native-receiver';

const MAC_RECEIVER = {
  pid: 412,
  restoreToken: 'mac-token-1',
  window: { identifier: 'window-1', title: 'Draft', x: 10, y: 20, w: 800, h: 600 },
  focus: { role: 'AXTextArea', identifier: 'editor', x: 30, y: 50, w: 400, h: 240 },
};

const WINDOWS_RECEIVER = {
  pid: 813,
  windowHandle: '1048982',
  windowTitle: 'Draft',
  windowRect: { x: -1200, y: 20, w: 1100, h: 700 },
  focusPid: 813,
  focusHandle: '1049010',
  automationId: 'BodyEditor',
  controlType: 'ControlType.Edit',
  runtimeId: [42, 813, 7, 9],
  focusRect: { x: -1100, y: 80, w: 700, h: 400 },
};

describe('native keyboard receiver identity', () => {
  it('parses a complete macOS AX receiver and rejects incomplete/error output', () => {
    expect(parseMacReceiver(JSON.stringify(MAC_RECEIVER))).toMatchObject({
      platform: 'darwin',
      pid: 412,
      window: { identifier: 'window-1', rect: { x: 10, y: 20, w: 800, h: 600 } },
      focus: { pid: 412, role: 'AXTextArea', identifier: 'editor' },
    });
    expect(parseMacReceiver('{bad json')).toBeNull();
    expect(parseMacReceiver({ error: 'accessibility_permission_required' })).toBeNull();
    expect(
      parseMacReceiver({
        ...MAC_RECEIVER,
        focus: { ...MAC_RECEIVER.focus, role: '', w: 0 },
      }),
    ).toBeNull();
  });

  it('parses a complete Windows UIA receiver and rejects incomplete output', () => {
    expect(parseWindowsReceiver(WINDOWS_RECEIVER)).toMatchObject({
      platform: 'win32',
      pid: 813,
      window: { handle: '1048982', rect: { x: -1200, y: 20, w: 1100, h: 700 } },
      focus: {
        pid: 813,
        role: 'ControlType.Edit',
        identifier: 'BodyEditor',
        nativeHandle: '1049010',
        runtimeId: [42, 813, 7, 9],
      },
    });
    expect(parseWindowsReceiver('not json')).toBeNull();
    expect(
      parseWindowsReceiver({
        ...WINDOWS_RECEIVER,
        focusRect: { x: 0, y: 0, w: Number.NaN, h: 20 },
      }),
    ).toBeNull();
  });

  it('returns one canonical macOS identity through the injectable native seam', async () => {
    const restoreMac = vi.fn(() => true);
    const provider = new PlatformNativeReceiverProvider({
      platform: 'darwin',
      queryMac: () => JSON.stringify(MAC_RECEIVER),
      restoreMac,
    });

    const identity = await provider.query();
    expect(identity).not.toBeNull();
    expect(JSON.parse(identity ?? '{}')).toMatchObject({
      platform: 'darwin',
      pid: 412,
      focus: { role: 'AXTextArea', identifier: 'editor' },
    });
    await expect(provider.restore(identity ?? '')).resolves.toBe(true);
    expect(restoreMac).toHaveBeenCalledWith('mac-token-1');
    await expect(provider.restore('unretained')).resolves.toBe(false);
  });

  it('fails macOS capture early when no exact retained restore token exists', async () => {
    const { restoreToken: _restoreToken, ...unrestorable } = MAC_RECEIVER;
    const provider = new PlatformNativeReceiverProvider({
      platform: 'darwin',
      queryMac: () => JSON.stringify(unrestorable),
      restoreMac: vi.fn(() => true),
    });

    await expect(provider.query()).resolves.toBeNull();
  });

  it('bounds the Windows UIA subprocess and fails closed on timeout', async () => {
    const exec = vi.fn((_file, _args, _options, callback) => {
      callback(Object.assign(new Error('timed out'), { killed: true }), '', '');
    });
    const provider = new PlatformNativeReceiverProvider({
      platform: 'win32',
      timeoutMs: 321,
      exec,
    });

    await expect(provider.query()).resolves.toBeNull();
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0]).toBe('powershell.exe');
    expect(exec.mock.calls[0]?.[2]).toEqual({
      timeout: 321,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
  });

  it('validates successful Windows UIA subprocess output', async () => {
    let request = 0;
    const exec = vi.fn((_file, _args, _options, callback) => {
      request += 1;
      callback(
        null,
        request === 1 ? JSON.stringify(WINDOWS_RECEIVER) : JSON.stringify({ ok: true }),
        '',
      );
    });
    const provider = new PlatformNativeReceiverProvider({ platform: 'win32', exec });

    const identity = await provider.query();
    expect(JSON.parse(identity ?? '{}')).toMatchObject({
      platform: 'win32',
      pid: 813,
      window: { handle: '1048982' },
      focus: { identifier: 'BodyEditor', role: 'ControlType.Edit' },
    });
    await expect(provider.restore(identity ?? '')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Windows rejects exact receiver restoration', async () => {
    let request = 0;
    const exec = vi.fn((_file, _args, _options, callback) => {
      request += 1;
      if (request === 1) callback(null, JSON.stringify(WINDOWS_RECEIVER), '');
      else callback(new Error('restore timed out'), '', '');
    });
    const provider = new PlatformNativeReceiverProvider({ platform: 'win32', exec });
    const identity = await provider.query();

    expect(identity).not.toBeNull();
    await expect(provider.restore(identity ?? '')).resolves.toBe(false);
  });
});
