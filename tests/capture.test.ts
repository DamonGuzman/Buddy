/**
 * Capture pipeline unit tests. Electron is fully mocked: the pure helpers
 * (resize planning, source<->display matching, meta construction) are tested
 * directly, and captureAllDisplays is exercised end-to-end against fake
 * displays/sources — including the content-protection self-exclusion.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Electron mock (must be declared before importing the module under test)
// ---------------------------------------------------------------------------

interface FakeSize {
  width: number;
  height: number;
}

function fakeThumbnail(width: number, height: number, tag = 'img'): FakeNativeImage {
  return new FakeNativeImage(width, height, tag);
}

class FakeNativeImage {
  constructor(
    private w: number,
    private h: number,
    private tag: string,
  ) {}

  getSize(): FakeSize {
    return { width: this.w, height: this.h };
  }

  resize(opts: { width: number; height: number }): FakeNativeImage {
    return new FakeNativeImage(opts.width, opts.height, this.tag);
  }

  toJPEG(quality: number): Buffer {
    return Buffer.from(`${this.tag}:${this.w}x${this.h}@q${quality}`);
  }
}

class FakeBrowserWindow {
  destroyed = false;
  protectionCalls: boolean[] = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  setContentProtection(enabled: boolean): void {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.protectionCalls.push(enabled);
  }
}

const mockState = {
  displays: [] as unknown[],
  cursor: { x: 0, y: 0 },
  activeDisplay: null as unknown,
  sources: [] as unknown[],
  windows: [] as FakeBrowserWindow[],
  getSourcesOptions: null as unknown,
  getSourcesImpl: null as (() => Promise<unknown[]>) | null,
};

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => mockState.displays,
    getCursorScreenPoint: () => mockState.cursor,
    getDisplayNearestPoint: () => mockState.activeDisplay,
  },
  desktopCapturer: {
    getSources: (options: unknown) => {
      mockState.getSourcesOptions = options;
      if (mockState.getSourcesImpl) return mockState.getSourcesImpl();
      return Promise.resolve(mockState.sources);
    },
  },
  BrowserWindow: {
    getAllWindows: () => mockState.windows,
  },
}));

const {
  buildCaptureMeta,
  captureAllDisplays,
  displayPhysicalSize,
  exemptFromCaptureProtection,
  matchSourcesToDisplays,
  planResize,
} = await import('../src/main/capture');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function display(id: number, x: number, y: number, w: number, h: number, scale: number) {
  return { id, bounds: { x, y, width: w, height: h }, scaleFactor: scale };
}

beforeEach(() => {
  mockState.displays = [];
  mockState.cursor = { x: 0, y: 0 };
  mockState.activeDisplay = null;
  mockState.sources = [];
  mockState.windows = [];
  mockState.getSourcesOptions = null;
  mockState.getSourcesImpl = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('planResize', () => {
  it('scales a 4K landscape frame to 1280x720', () => {
    expect(planResize(3840, 2160)).toEqual({ width: 1280, height: 720, resized: true });
  });

  it('scales a portrait frame by its height (longest edge)', () => {
    expect(planResize(2160, 3840)).toEqual({ width: 720, height: 1280, resized: true });
  });

  it('leaves already-small frames untouched', () => {
    expect(planResize(800, 600)).toEqual({ width: 800, height: 600, resized: false });
  });

  it('leaves an exactly-1280 longest edge untouched', () => {
    expect(planResize(1280, 720)).toEqual({ width: 1280, height: 720, resized: false });
  });

  it('rounds the short edge; the longest edge lands exactly on the cap', () => {
    // 1366x768 -> 1280 x round(719.65) = 720
    expect(planResize(1366, 768)).toEqual({ width: 1280, height: 720, resized: true });
    // one px over the cap
    expect(planResize(1281, 1000)).toEqual({ width: 1280, height: 999, resized: true });
  });

  it('honors a custom maxEdge', () => {
    expect(planResize(2000, 1000, 500)).toEqual({ width: 500, height: 250, resized: true });
  });

  it('throws on degenerate sizes', () => {
    expect(() => planResize(0, 100)).toThrow(/invalid source size/);
    expect(() => planResize(100, -5)).toThrow(/invalid source size/);
  });
});

describe('displayPhysicalSize', () => {
  it('multiplies DIP bounds by scaleFactor and rounds', () => {
    expect(displayPhysicalSize({ x: 0, y: 0, width: 1920, height: 1080 }, 2)).toEqual({
      width: 3840,
      height: 2160,
    });
    // 1707 DIP @ 1.5 = 2560.5 -> 2561 (matches how Windows reports rounded DIP)
    expect(displayPhysicalSize({ x: 0, y: 0, width: 1707, height: 960 }, 1.5)).toEqual({
      width: 2561,
      height: 1440,
    });
  });
});

describe('matchSourcesToDisplays', () => {
  const displays = [{ id: 100 }, { id: 200 }];

  it('matches by display_id regardless of source order', () => {
    const match = matchSourcesToDisplays(displays, [
      { display_id: '200', name: 'Screen 2' },
      { display_id: '100', name: 'Screen 1' },
    ]);
    expect(match.matchedByDisplayId).toBe(true);
    expect(match.sourceIndexByDisplay).toEqual([1, 0]);
  });

  it('falls back to order matching when display_id is empty (flaky Windows)', () => {
    const match = matchSourcesToDisplays(displays, [
      { display_id: '', name: 'Screen 1' },
      { display_id: '', name: 'Screen 2' },
    ]);
    expect(match.matchedByDisplayId).toBe(false);
    expect(match.sourceIndexByDisplay).toEqual([0, 1]);
  });

  it('falls back to order matching when even ONE display has no id match', () => {
    const match = matchSourcesToDisplays(displays, [
      { display_id: '100', name: 'Screen 1' },
      { display_id: '999', name: 'Screen 2' }, // stale/garbage id
    ]);
    expect(match.matchedByDisplayId).toBe(false);
    expect(match.sourceIndexByDisplay).toEqual([0, 1]);
  });

  it('never assigns the same source to two displays (duplicate ids)', () => {
    const match = matchSourcesToDisplays([{ id: 100 }, { id: 100 }], [
      { display_id: '100', name: 'A' },
      { display_id: '100', name: 'B' },
    ]);
    expect(match.matchedByDisplayId).toBe(true);
    expect(match.sourceIndexByDisplay).toEqual([0, 1]);
  });

  it('marks displays beyond the source count as unmatched in fallback', () => {
    const match = matchSourcesToDisplays(displays, [{ display_id: '', name: 'only one' }]);
    expect(match.matchedByDisplayId).toBe(false);
    expect(match.sourceIndexByDisplay).toEqual([0, null]);
  });
});

describe('buildCaptureMeta', () => {
  it('fills every CaptureMeta field, with imageW/H = final sent-image size', () => {
    const d = display(42, -1920, 0, 1920, 1080, 1.25);
    const meta = buildCaptureMeta(d, 1, 1280, 720, 42);
    expect(meta).toEqual({
      screenIndex: 1,
      displayId: 42,
      imageW: 1280,
      imageH: 720,
      displayBounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1.25,
      isActive: true,
    });
    // bounds must be a copy, not a live reference
    expect(meta.displayBounds).not.toBe(d.bounds);
  });

  it('flags isActive=false when the cursor is on another display', () => {
    const meta = buildCaptureMeta(display(1, 0, 0, 100, 100, 1), 0, 100, 100, 2);
    expect(meta.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// captureAllDisplays (Electron mocked end-to-end)
// ---------------------------------------------------------------------------

describe('captureAllDisplays', () => {
  function setupSingle4kDisplay(): void {
    const d = display(1, 0, 0, 1920, 1080, 2);
    mockState.displays = [d];
    mockState.activeDisplay = d;
    mockState.sources = [{ display_id: '1', name: 'Screen 1', thumbnail: fakeThumbnail(3840, 2160) }];
  }

  it('captures, resizes to <=1280 longest edge, and reports final size in meta', async () => {
    setupSingle4kDisplay();
    const results = await captureAllDisplays();
    expect(results).toHaveLength(1);
    const { meta, jpegBase64 } = results[0]!;
    expect(meta).toEqual({
      screenIndex: 0,
      displayId: 1,
      imageW: 1280,
      imageH: 720,
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 2,
      isActive: true,
    });
    expect(Buffer.from(jpegBase64, 'base64').toString()).toBe('img:1280x720@q80');
  });

  it('requests thumbnails at the max physical resolution across displays', async () => {
    const d1 = display(1, 0, 0, 1920, 1080, 2); // 3840x2160 phys
    const d2 = display(2, -1920, 0, 1920, 1080, 1); // 1920x1080 phys
    mockState.displays = [d1, d2];
    mockState.activeDisplay = d2;
    mockState.sources = [
      { display_id: '1', name: 'S1', thumbnail: fakeThumbnail(3840, 2160, 'a') },
      { display_id: '2', name: 'S2', thumbnail: fakeThumbnail(1920, 1080, 'b') },
    ];
    await captureAllDisplays();
    expect(mockState.getSourcesOptions).toEqual({
      types: ['screen'],
      thumbnailSize: { width: 3840, height: 2160 },
    });
  });

  it('matches shuffled sources via display_id and flags the active display', async () => {
    const d1 = display(1, 0, 0, 1920, 1080, 2);
    const d2 = display(2, -1920, 0, 1920, 1080, 1);
    mockState.displays = [d1, d2];
    mockState.activeDisplay = d2; // cursor on the left monitor
    mockState.sources = [
      { display_id: '2', name: 'S2', thumbnail: fakeThumbnail(1920, 1080, 'left') },
      { display_id: '1', name: 'S1', thumbnail: fakeThumbnail(3840, 2160, 'primary') },
    ];
    const results = await captureAllDisplays();
    expect(results.map((r) => r.meta.screenIndex)).toEqual([0, 1]);
    expect(results[0]!.meta.isActive).toBe(false);
    expect(results[1]!.meta.isActive).toBe(true);
    expect(Buffer.from(results[0]!.jpegBase64, 'base64').toString()).toContain('primary');
    expect(Buffer.from(results[1]!.jpegBase64, 'base64').toString()).toContain('left');
  });

  it('falls back to order matching when display_id is empty, with a warning', async () => {
    const d1 = display(1, 0, 0, 1920, 1080, 1);
    mockState.displays = [d1];
    mockState.activeDisplay = d1;
    mockState.sources = [{ display_id: '', name: 'S1', thumbnail: fakeThumbnail(1920, 1080) }];
    const results = await captureAllDisplays();
    expect(results).toHaveLength(1);
    expect(results[0]!.meta.imageW).toBe(1280);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('display_id matching failed'),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not resize a small display and keeps its native size in meta', async () => {
    const d = display(1, 0, 0, 1024, 768, 1);
    mockState.displays = [d];
    mockState.activeDisplay = d;
    mockState.sources = [{ display_id: '1', name: 'S', thumbnail: fakeThumbnail(1024, 768) }];
    const [r] = await captureAllDisplays();
    expect(r!.meta.imageW).toBe(1024);
    expect(r!.meta.imageH).toBe(768);
    expect(Buffer.from(r!.jpegBase64, 'base64').toString()).toBe('img:1024x768@q80');
  });

  it('skips displays with no source or an empty thumbnail, keeping stable indexes', async () => {
    const d1 = display(1, 0, 0, 1920, 1080, 1);
    const d2 = display(2, 1920, 0, 1920, 1080, 1);
    mockState.displays = [d1, d2];
    mockState.activeDisplay = d2;
    mockState.sources = [
      { display_id: '1', name: 'S1', thumbnail: fakeThumbnail(0, 0) }, // failed grab
      { display_id: '2', name: 'S2', thumbnail: fakeThumbnail(1920, 1080) },
    ];
    const results = await captureAllDisplays();
    expect(results).toHaveLength(1);
    // screenIndex stays aligned with display order even when screen0 is skipped
    expect(results[0]!.meta.screenIndex).toBe(1);
    expect(results[0]!.meta.displayId).toBe(2);
  });

  it('returns [] when there are no displays', async () => {
    mockState.displays = [];
    await expect(captureAllDisplays()).resolves.toEqual([]);
  });

  describe('content-protection self-exclusion', () => {
    it('enables protection on every Clicky window before the grab, restores after', async () => {
      setupSingle4kDisplay();
      const w1 = new FakeBrowserWindow();
      const w2 = new FakeBrowserWindow();
      mockState.windows = [w1, w2];
      await captureAllDisplays();
      expect(w1.protectionCalls).toEqual([true, false]);
      expect(w2.protectionCalls).toEqual([true, false]);
    });

    it('protection is ON while desktopCapturer grabs the screen', async () => {
      setupSingle4kDisplay();
      const w = new FakeBrowserWindow();
      mockState.windows = [w];
      let protectedDuringGrab: boolean[] = [];
      mockState.getSourcesImpl = () => {
        protectedDuringGrab = [...w.protectionCalls];
        return Promise.resolve(mockState.sources);
      };
      await captureAllDisplays();
      expect(protectedDuringGrab).toEqual([true]); // enabled, not yet restored
      expect(w.protectionCalls).toEqual([true, false]);
    });

    it('restores protection even when the grab throws', async () => {
      setupSingle4kDisplay();
      const w = new FakeBrowserWindow();
      mockState.windows = [w];
      mockState.getSourcesImpl = () => Promise.reject(new Error('capture failed'));
      await expect(captureAllDisplays()).rejects.toThrow('capture failed');
      expect(w.protectionCalls).toEqual([true, false]);
    });

    it('skips destroyed windows and exempted (QA control) windows', async () => {
      setupSingle4kDisplay();
      const dead = new FakeBrowserWindow();
      dead.destroyed = true;
      const control = new FakeBrowserWindow();
      const normal = new FakeBrowserWindow();
      mockState.windows = [dead, control, normal];
      exemptFromCaptureProtection(control as never);
      await captureAllDisplays();
      expect(dead.protectionCalls).toEqual([]);
      expect(control.protectionCalls).toEqual([]);
      expect(normal.protectionCalls).toEqual([true, false]);
    });

    it('a window throwing on setContentProtection does not break the capture', async () => {
      setupSingle4kDisplay();
      const flaky = new FakeBrowserWindow();
      flaky.setContentProtection = () => {
        throw new Error('boom');
      };
      const normal = new FakeBrowserWindow();
      mockState.windows = [flaky, normal];
      const results = await captureAllDisplays();
      expect(results).toHaveLength(1);
      expect(normal.protectionCalls).toEqual([true, false]);
    });
  });
});
