/**
 * M15 dwell-to-interact state machine (windows/hover-controller.ts).
 * SAFETY-CRITICAL invariant under test: click-through is restored from every
 * failure branch — renderer exit, cursor leaving the region (poll), a lost
 * region, and a dead window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverController, INTERACTIVE_POLL_MS } from '../src/main/windows/hover-controller';
import type { HoverWindowPort } from '../src/main/windows/hover-controller';
import type { Rect } from '../src/shared/types';

class FakePort implements HoverWindowPort {
  live = new Set<number>();
  bounds = new Map<number, Rect>();
  cursor = { x: 0, y: 0 };
  /** Ordered log of interactive/restore flips per display. */
  calls: string[] = [];

  isWindowLive(displayId: number): boolean {
    return this.live.has(displayId);
  }
  makeWindowInteractive(displayId: number): void {
    this.calls.push(`interactive:${displayId}`);
  }
  restoreWindowClickThrough(displayId: number): void {
    this.calls.push(`restore:${displayId}`);
  }
  windowBounds(displayId: number): Rect | null {
    return this.bounds.get(displayId) ?? null;
  }
  cursorPoint(): { x: number; y: number } {
    return this.cursor;
  }
}

const REGION: Rect = { x: 10, y: 20, width: 50, height: 40 };
const BOUNDS: Rect = { x: 100, y: 200, width: 800, height: 600 };
/** A cursor position inside BOUNDS+REGION. */
const INSIDE = { x: 120, y: 230 };
const OUTSIDE = { x: 500, y: 500 };

interface Harness {
  port: FakePort;
  hover: HoverController;
}

function makeHarness(): Harness {
  const port = new FakePort();
  port.live.add(1);
  port.bounds.set(1, BOUNDS);
  port.cursor = { ...INSIDE };
  return { port, hover: new HoverController(port) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dwell -> interactive', () => {
  it('flips the hosting window interactive exactly once', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    expect(port.calls).toEqual(['interactive:1']);
    expect(hover.isInteractive(1)).toBe(true);
    expect(hover.displayId).toBe(1);
    expect(hover.region).toEqual(REGION);
  });

  it('a repeated dwell on the same display is a region refresh only', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    const refreshed: Rect = { ...REGION, x: 15 };
    hover.makeInteractive(1, refreshed);
    expect(port.calls).toEqual(['interactive:1']); // no second flip
    expect(hover.region).toEqual(refreshed);
  });

  it('ignores a dwell for a dead window', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(99, REGION);
    expect(port.calls).toEqual([]);
    expect(hover.displayId).toBe(null);
  });

  it('switching displays restores the old window before flipping the new one', () => {
    const { port, hover } = makeHarness();
    port.live.add(2);
    port.bounds.set(2, { x: 900, y: 0, width: 800, height: 600 });
    hover.makeInteractive(1, REGION);
    hover.makeInteractive(2, REGION);
    expect(port.calls).toEqual(['interactive:1', 'restore:1', 'interactive:2']);
    expect(hover.isInteractive(2)).toBe(true);
  });
});

describe('restoreClickThrough (safety restore)', () => {
  it('restores the interactive window and is idempotent', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    hover.restoreClickThrough();
    hover.restoreClickThrough(); // no-op the second time
    expect(port.calls).toEqual(['interactive:1', 'restore:1']);
    expect(hover.displayId).toBe(null);
    expect(hover.region).toBe(null);
  });

  it('resets state even when the window died first (no port call possible)', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    port.live.delete(1);
    hover.restoreClickThrough();
    expect(port.calls).toEqual(['interactive:1']); // nothing to flip back
    expect(hover.displayId).toBe(null);
  });
});

describe('belt-and-braces cursor poll', () => {
  it('keeps the flip while the cursor stays inside the padded region', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    vi.advanceTimersByTime(INTERACTIVE_POLL_MS * 5);
    expect(port.calls).toEqual(['interactive:1']);
    expect(hover.isInteractive(1)).toBe(true);
  });

  it('force-restores when the cursor leaves the region (missed exit event)', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    port.cursor = { ...OUTSIDE };
    vi.advanceTimersByTime(INTERACTIVE_POLL_MS);
    expect(port.calls).toEqual(['interactive:1', 'restore:1']);
    expect(hover.displayId).toBe(null);
  });

  it('force-restores when the window dies mid-hover', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    port.live.delete(1);
    vi.advanceTimersByTime(INTERACTIVE_POLL_MS);
    expect(hover.displayId).toBe(null); // state reset; dead window not flipped
    expect(port.calls).toEqual(['interactive:1']);
  });

  it('treats a boundary cursor position as inside (inclusive edges)', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    port.cursor = { x: BOUNDS.x + REGION.x + REGION.width, y: BOUNDS.y + REGION.y };
    vi.advanceTimersByTime(INTERACTIVE_POLL_MS);
    expect(port.calls).toEqual(['interactive:1']);
  });

  it('stops polling after restore (no further port traffic)', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    hover.restoreClickThrough();
    port.cursor = { ...OUTSIDE };
    vi.advanceTimersByTime(INTERACTIVE_POLL_MS * 10);
    expect(port.calls).toEqual(['interactive:1', 'restore:1']);
  });
});

describe('dispose', () => {
  it('stops the poll without flipping anything (teardown path)', () => {
    const { port, hover } = makeHarness();
    hover.makeInteractive(1, REGION);
    hover.dispose();
    port.cursor = { ...OUTSIDE };
    vi.advanceTimersByTime(INTERACTIVE_POLL_MS * 10);
    expect(port.calls).toEqual(['interactive:1']);
  });
});
