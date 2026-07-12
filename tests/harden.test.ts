/**
 * Crash-loop guard unit tests (pure logic — no Electron needed; the harden
 * module only imports Electron types, which erase at compile time).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrashLoopGuard } from '../src/main/windows/harden';
import type { RenderProcessGoneDetails } from 'electron';

const gone = (reason: RenderProcessGoneDetails['reason'] = 'crashed'): RenderProcessGoneDetails =>
  ({ reason, exitCode: 1 }) as RenderProcessGoneDetails;

describe('CrashLoopGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows up to max recreates inside the window', () => {
    const guard = new CrashLoopGuard(3, 5 * 60_000, 'test');
    expect(guard.allowRecreate(gone())).toBe(true);
    expect(guard.allowRecreate(gone())).toBe(true);
    expect(guard.allowRecreate(gone())).toBe(true);
  });

  it('gives up on the crash after max within the window', () => {
    const guard = new CrashLoopGuard(3, 5 * 60_000, 'test');
    for (let i = 0; i < 3; i++) guard.allowRecreate(gone());
    expect(guard.allowRecreate(gone())).toBe(false);
    expect(guard.allowRecreate(gone())).toBe(false);
  });

  it('forgets crashes older than the window', () => {
    const guard = new CrashLoopGuard(3, 5 * 60_000, 'test');
    for (let i = 0; i < 3; i++) guard.allowRecreate(gone());
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(guard.allowRecreate(gone())).toBe(true);
  });

  it('keeps refusing while crashes stay inside the window', () => {
    const guard = new CrashLoopGuard(2, 60_000, 'test');
    guard.allowRecreate(gone());
    vi.advanceTimersByTime(30_000);
    guard.allowRecreate(gone());
    vi.advanceTimersByTime(20_000);
    // first crash (50s ago) still in the 60s window -> this is #3
    expect(guard.allowRecreate(gone())).toBe(false);
  });
});
