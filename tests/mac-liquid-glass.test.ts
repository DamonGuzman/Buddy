import { describe, expect, it, vi } from 'vitest';

import {
  createMacLiquidGlassApplier,
  createMacLiquidGlassRegionApplier,
  type MacLiquidGlassRuntime,
  type MacLiquidGlassWindow,
} from '../src/main/windows/mac-liquid-glass';

function harness(overrides: Partial<MacLiquidGlassRuntime> = {}) {
  const supportsLiquidGlass = vi.fn((): unknown => true);
  const installLiquidGlass = vi.fn(
    (_nativeWindowHandle: Buffer, _optionsJson: string): unknown => true,
  );
  const setLiquidGlassRegions = vi.fn(
    (_nativeWindowHandle: Buffer, _optionsJson: string): unknown => true,
  );
  const loadNativeBridge = vi.fn(() => ({
    supportsLiquidGlass,
    installLiquidGlass,
    setLiquidGlassRegions,
  }));
  const getSystemVersion = vi.fn(() => '26.2.0');
  const getNativeWindowHandle = vi.fn(() => Buffer.alloc(8, 1));
  const isDestroyed = vi.fn(() => false);
  const runtime: MacLiquidGlassRuntime = {
    platform: 'darwin',
    getSystemVersion,
    loadNativeBridge,
    ...overrides,
  };
  const win: MacLiquidGlassWindow = { getNativeWindowHandle, isDestroyed };
  return {
    apply: createMacLiquidGlassApplier(runtime),
    getNativeWindowHandle,
    getSystemVersion,
    installLiquidGlass,
    isDestroyed,
    loadNativeBridge,
    setLiquidGlassRegions,
    supportsLiquidGlass,
    win,
  };
}

describe('macOS Liquid Glass bridge', () => {
  it('is an explicit no-op outside macOS', () => {
    const h = harness({ platform: 'win32' });

    expect(h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toBe(false);
    expect(h.getSystemVersion).not.toHaveBeenCalled();
    expect(h.loadNativeBridge).not.toHaveBeenCalled();
    expect(h.getNativeWindowHandle).not.toHaveBeenCalled();
  });

  it('returns false on macOS versions before Liquid Glass', () => {
    const h = harness({ getSystemVersion: () => '15.7.1' });

    expect(h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toBe(false);
    expect(h.loadNativeBridge).not.toHaveBeenCalled();
  });

  it('installs native glass with an exact, normalized native payload', () => {
    const h = harness();
    const handle = h.getNativeWindowHandle();
    h.getNativeWindowHandle.mockClear();

    expect(h.apply(h.win, { style: 'clear', cornerRadius: 22.5 })).toBe(true);
    expect(h.installLiquidGlass).toHaveBeenCalledWith(
      handle,
      JSON.stringify({ style: 'clear', cornerRadius: 22.5, tintColor: null }),
    );
    expect(h.getNativeWindowHandle).toHaveBeenCalledOnce();
  });

  it('passes an explicit RGBA tint without changing it', () => {
    const h = harness();

    expect(h.apply(h.win, { style: 'regular', cornerRadius: 0, tintColor: '#A1b2C3d4' })).toBe(
      true,
    );
    expect(JSON.parse(h.installLiquidGlass.mock.calls[0]?.[1] as string)).toEqual({
      style: 'regular',
      cornerRadius: 0,
      tintColor: '#A1b2C3d4',
    });
  });

  it.each([
    [{ style: 'vibrant', cornerRadius: 16 }, 'style'],
    [{ style: 'regular', cornerRadius: Number.NaN }, 'cornerRadius'],
    [{ style: 'regular', cornerRadius: -1 }, 'cornerRadius'],
    [{ style: 'regular', cornerRadius: 1_001 }, 'cornerRadius'],
    [{ style: 'regular', cornerRadius: 16, tintColor: '#fff' }, 'tintColor'],
    [{ style: 'regular', cornerRadius: 16, privateStyle: 2 }, 'Unknown'],
  ])('rejects invalid options before calling native code: %j', (options, expected) => {
    const h = harness();

    expect(() => h.apply(h.win, options as never)).toThrow(expected);
    expect(h.loadNativeBridge).not.toHaveBeenCalled();
  });

  it('fails fast when the system version cannot be validated', () => {
    const h = harness({ getSystemVersion: () => 'unknown' });

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
      'could not determine the macOS version',
    );
    expect(h.loadNativeBridge).not.toHaveBeenCalled();
  });

  it('fails fast for a destroyed BrowserWindow', () => {
    const h = harness();
    h.isDestroyed.mockReturnValue(true);

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
      'destroyed window',
    );
    expect(h.loadNativeBridge).not.toHaveBeenCalled();
  });

  it.each([null, {}, { supportsLiquidGlass: () => true }])(
    'rejects an invalid native bridge module: %j',
    (bridge) => {
      const h = harness({ loadNativeBridge: () => bridge });

      expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
        /invalid module|required native exports/,
      );
    },
  );

  it('fails fast when NSGlassEffectView is absent on macOS 26 or later', () => {
    const h = harness();
    h.supportsLiquidGlass.mockReturnValue(false);

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
      'unavailable even though this Mac is running macOS 26 or later',
    );
  });

  it('rejects invalid support probe results', () => {
    const h = harness();
    h.supportsLiquidGlass.mockReturnValue('yes');

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
      'invalid support result',
    );
  });

  it('rejects an invalid native window handle before installation', () => {
    const h = harness();
    h.getNativeWindowHandle.mockReturnValue(Buffer.alloc(0));

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
      'invalid native window handle',
    );
    expect(h.installLiquidGlass).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'did not install'],
    ['yes', 'invalid install result'],
  ])('rejects a native install result of %j', (result, expected) => {
    const h = harness();
    h.installLiquidGlass.mockReturnValue(result);

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(expected);
  });

  it('preserves actionable native installation errors', () => {
    const h = harness();
    h.installLiquidGlass.mockImplementation(() => {
      throw new Error('macOS Liquid Glass: unsafe Electron view hierarchy');
    });

    expect(() => h.apply(h.win, { style: 'regular', cornerRadius: 16 })).toThrow(
      'macOS Liquid Glass: unsafe Electron view hierarchy',
    );
  });
});

describe('macOS Liquid Glass popup regions', () => {
  it('normalizes bounded regions into the grouped native contract', () => {
    const h = harness();
    const apply = createMacLiquidGlassRegionApplier({
      platform: 'darwin',
      getSystemVersion: () => '26.2',
      loadNativeBridge: h.loadNativeBridge,
    });

    expect(
      apply(h.win, [
        {
          id: 'helper-card',
          x: 12.25,
          y: 20,
          width: 248,
          height: 132.5,
          style: 'regular',
          cornerRadius: 16,
          tintColor: '#11182773',
        },
      ]),
    ).toBe(true);
    expect(JSON.parse(h.setLiquidGlassRegions.mock.calls[0]?.[1] as string)).toEqual({
      spacing: 12,
      regions: [
        {
          id: 'helper-card',
          x: 12.25,
          y: 20,
          width: 248,
          height: 132.5,
          style: 'regular',
          cornerRadius: 16,
          tintColor: '#11182773',
        },
      ],
    });
  });

  it.each([
    [[{ id: 'bad id', x: 0, y: 0, width: 10, height: 10, style: 'regular', cornerRadius: 4 }]],
    [[{ id: 'a', x: 0, y: 0, width: 0, height: 10, style: 'regular', cornerRadius: 4 }]],
    [
      [
        { id: 'a', x: 0, y: 0, width: 10, height: 10, style: 'regular', cornerRadius: 4 },
        { id: 'a', x: 20, y: 0, width: 10, height: 10, style: 'regular', cornerRadius: 4 },
      ],
    ],
  ])('rejects invalid region contracts before native code', (regions) => {
    const h = harness();
    const apply = createMacLiquidGlassRegionApplier({
      platform: 'darwin',
      getSystemVersion: () => '26.2',
      loadNativeBridge: h.loadNativeBridge,
    });

    expect(() => apply(h.win, regions as never)).toThrow();
    expect(h.loadNativeBridge).not.toHaveBeenCalled();
  });
});
