/** Strict main-process seam for macOS 26's native NSGlassEffectView. */

import type { BrowserWindow } from 'electron';

import { loadMacNativeBridge } from './mac-native-bridge';

const MACOS_LIQUID_GLASS_MAJOR_VERSION = 26;
const MAX_CORNER_RADIUS = 1_000;
const TINT_COLOR_PATTERN = /^#[0-9a-f]{8}$/i;

export interface MacLiquidGlassOptions {
  style: 'regular' | 'clear';
  cornerRadius: number;
  tintColor?: string;
}

export interface MacLiquidGlassRegion extends MacLiquidGlassOptions {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MacLiquidGlassNative {
  supportsLiquidGlass(): boolean;
  installLiquidGlass(nativeWindowHandle: Buffer, optionsJson: string): boolean;
  setLiquidGlassRegions(nativeWindowHandle: Buffer, optionsJson: string): boolean;
}

export interface MacLiquidGlassRuntime {
  platform: NodeJS.Platform;
  getSystemVersion(): string;
  loadNativeBridge(): unknown;
}

export type MacLiquidGlassWindow = Pick<BrowserWindow, 'getNativeWindowHandle' | 'isDestroyed'>;

export type MacLiquidGlassApplier = (
  win: MacLiquidGlassWindow,
  options: MacLiquidGlassOptions,
) => boolean;

export type MacLiquidGlassRegionApplier = (
  win: MacLiquidGlassWindow,
  regions: readonly MacLiquidGlassRegion[],
) => boolean;

/** Create an installer with an injected runtime for focused unit tests. */
export function createMacLiquidGlassApplier(runtime: MacLiquidGlassRuntime): MacLiquidGlassApplier {
  return (win, options) => {
    const nativeOptions = validateOptions(options);
    if (runtime.platform !== 'darwin') return false;

    const majorVersion = macOSMajorVersion(runtime.getSystemVersion());
    if (majorVersion < MACOS_LIQUID_GLASS_MAJOR_VERSION) return false;

    if (win.isDestroyed()) {
      throw new Error('Buddy cannot apply macOS Liquid Glass to a destroyed window');
    }

    const native = validateBridge(runtime.loadNativeBridge());
    const supported = native.supportsLiquidGlass();
    if (supported !== true) {
      if (typeof supported !== 'boolean') {
        throw new Error('Buddy macOS Liquid Glass bridge returned an invalid support result');
      }
      throw new Error(
        'Buddy macOS Liquid Glass is unavailable even though this Mac is running macOS 26 or later',
      );
    }

    const nativeWindowHandle = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(nativeWindowHandle) || nativeWindowHandle.length < 4) {
      throw new Error('Buddy received an invalid native window handle for macOS Liquid Glass');
    }

    const installed = native.installLiquidGlass(nativeWindowHandle, JSON.stringify(nativeOptions));
    if (installed !== true) {
      if (typeof installed !== 'boolean') {
        throw new Error('Buddy macOS Liquid Glass bridge returned an invalid install result');
      }
      throw new Error('Buddy macOS Liquid Glass bridge did not install the native effect');
    }
    return true;
  };
}

/**
 * Install or update native Liquid Glass on a BrowserWindow.
 *
 * Cross-platform callers may invoke this unconditionally: platforms without
 * Liquid Glass, including macOS before 26, return false. A supported macOS
 * runtime fails fast because silently substituting CSS would hide a broken
 * native product contract.
 */
export const applyMacLiquidGlass: MacLiquidGlassApplier = createMacLiquidGlassApplier({
  platform: process.platform,
  getSystemVersion: () => process.getSystemVersion(),
  loadNativeBridge: () => {
    try {
      return loadMacNativeBridge();
    } catch (error) {
      throw new Error('Buddy macOS Liquid Glass bridge failed to load', { cause: error });
    }
  },
});

/** Create a bounded-region installer with an injected runtime for tests. */
export function createMacLiquidGlassRegionApplier(
  runtime: MacLiquidGlassRuntime,
): MacLiquidGlassRegionApplier {
  return (win, regions) => {
    const payload = validateRegions(regions);
    if (runtime.platform !== 'darwin') return false;
    if (macOSMajorVersion(runtime.getSystemVersion()) < MACOS_LIQUID_GLASS_MAJOR_VERSION) {
      return false;
    }
    if (win.isDestroyed()) {
      throw new Error('Buddy cannot apply macOS Liquid Glass regions to a destroyed window');
    }
    const native = validateBridge(runtime.loadNativeBridge());
    if (native.supportsLiquidGlass() !== true) {
      throw new Error(
        'Buddy macOS Liquid Glass is unavailable even though this Mac is running macOS 26 or later',
      );
    }
    const handle = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length < 4) {
      throw new Error('Buddy received an invalid native window handle for macOS Liquid Glass');
    }
    if (native.setLiquidGlassRegions(handle, JSON.stringify(payload)) !== true) {
      throw new Error('Buddy macOS Liquid Glass bridge did not apply the popup regions');
    }
    return true;
  };
}

export const applyMacLiquidGlassRegions: MacLiquidGlassRegionApplier =
  createMacLiquidGlassRegionApplier({
    platform: process.platform,
    getSystemVersion: () => process.getSystemVersion(),
    loadNativeBridge: () => loadMacNativeBridge(),
  });

function macOSMajorVersion(systemVersion: string): number {
  const match = /^(\d+)(?:\.\d+)*$/.exec(systemVersion);
  if (match === null) {
    throw new Error(`Buddy could not determine the macOS version: ${systemVersion}`);
  }
  const majorVersion = Number(match[1]);
  if (!Number.isSafeInteger(majorVersion)) {
    throw new Error(`Buddy could not determine the macOS version: ${systemVersion}`);
  }
  return majorVersion;
}

function validateOptions(options: MacLiquidGlassOptions): {
  style: 'regular' | 'clear';
  cornerRadius: number;
  tintColor: string | null;
} {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('macOS Liquid Glass options must be an object');
  }
  const record = options as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => key !== 'style' && key !== 'cornerRadius' && key !== 'tintColor',
  );
  if (unknownKeys.length > 0) {
    throw new TypeError(`Unknown macOS Liquid Glass option: ${unknownKeys[0]}`);
  }
  if (record['style'] !== 'regular' && record['style'] !== 'clear') {
    throw new TypeError('macOS Liquid Glass style must be regular or clear');
  }
  if (
    typeof record['cornerRadius'] !== 'number' ||
    !Number.isFinite(record['cornerRadius']) ||
    record['cornerRadius'] < 0 ||
    record['cornerRadius'] > MAX_CORNER_RADIUS
  ) {
    throw new TypeError(
      `macOS Liquid Glass cornerRadius must be between 0 and ${MAX_CORNER_RADIUS}`,
    );
  }
  if (
    record['tintColor'] !== undefined &&
    (typeof record['tintColor'] !== 'string' || !TINT_COLOR_PATTERN.test(record['tintColor']))
  ) {
    throw new TypeError('macOS Liquid Glass tintColor must use #RRGGBBAA');
  }
  return {
    style: record['style'],
    cornerRadius: record['cornerRadius'],
    tintColor: typeof record['tintColor'] === 'string' ? record['tintColor'] : null,
  };
}

function validateBridge(value: unknown): MacLiquidGlassNative {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Buddy macOS Liquid Glass bridge returned an invalid module');
  }
  const bridge = value as Record<string, unknown>;
  if (
    typeof bridge['supportsLiquidGlass'] !== 'function' ||
    typeof bridge['installLiquidGlass'] !== 'function' ||
    typeof bridge['setLiquidGlassRegions'] !== 'function'
  ) {
    throw new Error('Buddy macOS Liquid Glass bridge is missing required native exports');
  }
  return value as MacLiquidGlassNative;
}

function validateRegions(regions: readonly MacLiquidGlassRegion[]): {
  spacing: number;
  regions: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    style: 'regular' | 'clear';
    cornerRadius: number;
    tintColor: string | null;
  }>;
} {
  if (!Array.isArray(regions) || regions.length > 8) {
    throw new TypeError('macOS Liquid Glass regions must contain at most 8 entries');
  }
  const ids = new Set<string>();
  const normalized = regions.map((region) => {
    if (typeof region !== 'object' || region === null || Array.isArray(region)) {
      throw new TypeError('macOS Liquid Glass region must be an object');
    }
    const { id, x, y, width, height, ...options } = region;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || ids.has(id)) {
      throw new TypeError('macOS Liquid Glass region ids must be unique canonical identifiers');
    }
    ids.add(id);
    for (const [name, value] of Object.entries({ x, y, width, height })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 20_000) {
        throw new TypeError(`macOS Liquid Glass region ${name} must be a finite coordinate`);
      }
    }
    if (width <= 0 || height <= 0) {
      throw new TypeError('macOS Liquid Glass region dimensions must be positive');
    }
    return { id, x, y, width, height, ...validateOptions(options as MacLiquidGlassOptions) };
  });
  return { spacing: 12, regions: normalized };
}
