import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));

import type { CaptureResult } from '../src/main/capture';
import { OffscreenBrowserDriver, mapBrowserPoint } from '../src/main/computer/browser-driver';
import type { BuddyBrowserProfile } from '../src/main/computer/browser-profile';
import { normalizeBrowserUrl } from '../src/main/computer/browser-profile';

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<object> {
    this.commands.push({ method, ...(params ? { params } : {}) });
    return {};
  }
}

class FakeImage {
  constructor(
    readonly width = 1_000,
    readonly height = 500,
  ) {}

  isEmpty(): boolean {
    return false;
  }

  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(options: { width: number; height: number }): FakeImage {
    return new FakeImage(options.width, options.height);
  }

  toJPEG(): Buffer {
    return Buffer.from('jpeg');
  }
}

class FakeFrame {
  readonly detached = false;
  readonly frames: FakeFrame[] = [];
  readonly frameTreeNodeId = 7;
  readonly name = '';
  readonly url = 'https://example.com/form';

  isDestroyed(): boolean {
    return false;
  }

  async executeJavaScript(): Promise<unknown> {
    return {
      facts: {
        tag: 'input',
        inputType: 'text',
        text: 'recipient',
        inForm: true,
        formAction: 'https://example.com/send',
        url: this.url,
        name: 'to',
      },
      payloadFields: [{ name: 'to', value: 'person@example.com', type: 'text' }],
      fingerprint: 'html:0>form:0>input[name=to]:0',
      pageRevision: 4,
      childFrameIndex: null,
      childFrameUrl: null,
      childFrameName: null,
      childX: null,
      childY: null,
    };
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  readonly mainFrame = new FakeFrame();
  destroyed = false;

  async capturePage(): Promise<FakeImage> {
    return new FakeImage();
  }

  invalidate(): void {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  getURL(): string {
    return this.mainFrame.url;
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents();
  destroyed = false;
  visible = false;

  async loadURL(): Promise<void> {}
  getContentSize(): [number, number] {
    return [500, 250];
  }
  setSkipTaskbar(): void {}
  show(): void {
    this.visible = true;
  }
  focus(): void {}
  hide(): void {
    this.visible = false;
    this.emit('hide');
  }
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.webContents.destroyed = true;
  }
}

function harness(): { driver: OffscreenBrowserDriver; win: FakeWindow } {
  const win = new FakeWindow();
  const profile = {
    createWindow: () => win,
    authorizeNavigation: vi.fn(),
    validateDestination: async (url: string) => url,
    setUserOperated: vi.fn(),
    onNavigationBlocked: () => () => undefined,
    loadInternalStartPage: async () => undefined,
    ensureReady: async () => undefined,
    isSuspended: () => false,
  } as unknown as BuddyBrowserProfile;
  return { driver: new OffscreenBrowserDriver({ profile }), win };
}

describe('OffscreenBrowserDriver', () => {
  it('maps screenshot pixels through the exact per-axis content ratios', () => {
    const capture: CaptureResult = {
      meta: {
        screenIndex: 0,
        displayId: -1,
        imageW: 1_200,
        imageH: 903,
        displayBounds: { x: 0, y: 0, width: 800, height: 600 },
        scaleFactor: 1.5,
        isActive: true,
      },
      jpegBase64: '',
    };
    expect(
      mapBrowserPoint({ screenIndex: 0, x: 600, y: 451.5 }, capture, { width: 800, height: 600 }),
    ).toEqual({ x: 400, y: 300 });
    expect(() =>
      mapBrowserPoint({ screenIndex: 0, x: 1_200, y: 903 }, capture, {
        width: 800,
        height: 600,
      }),
    ).toThrow('outside screen0');
  });

  it('uses CDP keyDown text for Enter and releases the key', async () => {
    const { driver, win } = harness();
    await driver.capture();
    win.webContents.debugger.commands.length = 0;
    await driver.pressKeys(['ENTER']);
    expect(win.webContents.debugger.commands).toEqual([
      {
        method: 'Input.dispatchKeyEvent',
        params: expect.objectContaining({ type: 'keyDown', key: 'Enter', text: '\r' }),
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: expect.objectContaining({ type: 'keyUp', key: 'Enter' }),
      },
    ]);
    await expect(driver.click({ screenIndex: 0, x: 1, y: 1 }, 'left', 1)).rejects.toThrow(
      'capture the buddy browser',
    );
    await driver.dispose();
  });

  it('uses Chromium SelectAll for a control/meta+A chord', async () => {
    const { driver, win } = harness();
    await driver.capture();
    await driver.pressKeys(['CTRL', 'A']);
    expect(win.webContents.debugger.commands).toContainEqual({
      method: 'Input.dispatchKeyEvent',
      params: expect.objectContaining({
        type: 'keyDown',
        code: 'KeyA',
        commands: ['SelectAll'],
      }),
    });
    await driver.dispose();
  });

  it('normalizes modifier order and rejects malformed chords', async () => {
    const { driver, win } = harness();
    await driver.capture();
    win.webContents.debugger.commands.length = 0;
    await driver.pressKeys(['A', 'CTRL']);
    expect(win.webContents.debugger.commands[0]?.params).toMatchObject({
      type: 'keyDown',
      key: 'Control',
    });
    await expect(driver.pressKeys(['CTRL', 'CONTROL', 'A'])).rejects.toThrow(
      'duplicate browser modifier',
    );
    await expect(driver.pressKeys(['SHIFT'])).rejects.toThrow('exactly one non-modifier');
    await driver.dispose();
  });

  it('rejects non-left clicks before CDP dispatch', async () => {
    const { driver, win } = harness();
    await driver.capture();
    win.webContents.debugger.commands.length = 0;
    await expect(driver.click({ screenIndex: 0, x: 10, y: 10 }, 'right', 1)).rejects.toThrow(
      'left clicks only',
    );
    expect(win.webContents.debugger.commands).toEqual([]);
    await driver.dispose();
  });

  it('returns facts, payload, fingerprint, and mutation revision atomically', async () => {
    const { driver } = harness();
    await driver.capture();
    await expect(driver.inspectDetailed(null)).resolves.toEqual({
      facts: expect.objectContaining({ tag: 'input', inForm: true, frame: 'top' }),
      payloadFields: [{ name: 'to', value: 'person@example.com', type: 'text' }],
      fingerprint: '7:html:0>form:0>input[name=to]:0',
      pageRevision: '7:4',
    });
    await driver.dispose();
  });
});

describe('browser URL policy', () => {
  it('allows only credential-free http(s) action URLs', () => {
    expect(normalizeBrowserUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(() => normalizeBrowserUrl('file:///tmp/secret')).toThrow('scheme is not allowed');
    expect(() => normalizeBrowserUrl('https://user:pass@example.com')).toThrow(
      'must not contain credentials',
    );
  });
});
