/**
 * Hotkey FSM unit tests (F1 fixes): left-Alt-only matching (AltGr must never
 * trigger), the max-hold watchdog (C1), and forced-release state reset.
 * The uiohook dependency is injected as a fake emitter.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotkeyManager, MAX_HOLD_MS } from '../src/main/hotkey';
import type { UiohookLike } from '../src/main/hotkey';

// uiohook keycodes.
const L_CTRL = 29;
const R_CTRL = 3613;
const L_ALT = 56;
const R_ALT = 3640; // AltGr on international layouts

class FakeHook extends EventEmitter implements UiohookLike {
  started = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.started = false;
  }
}

interface Harness {
  hook: FakeHook;
  hotkey: HotkeyManager;
  events: string[];
  down(code: number): void;
  up(code: number): void;
}

function makeHarness(maxHoldMs?: number): Harness {
  const hook = new FakeHook();
  const hotkey = new HotkeyManager({ hook, ...(maxHoldMs !== undefined ? { maxHoldMs } : {}) });
  const events: string[] = [];
  hotkey.on('hold-start', () => events.push('start'));
  hotkey.on('hold-end', () => events.push('end'));
  hotkey.on('hold-cancel', () => events.push('cancel'));
  hotkey.start();
  return {
    hook,
    hotkey,
    events,
    down: (code) => hook.emit('keydown', { keycode: code }),
    up: (code) => hook.emit('keyup', { keycode: code }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('hold-to-talk state machine', () => {
  it('Ctrl + LEFT Alt starts a hold; releasing either ends it', () => {
    const h = makeHarness();
    expect(h.hook.started).toBe(true);
    h.down(L_CTRL);
    expect(h.events).toEqual([]);
    h.down(L_ALT);
    expect(h.events).toEqual(['start']);
    expect(h.hotkey.status().holding).toBe(true);
    h.up(L_CTRL);
    expect(h.events).toEqual(['start', 'end']);
    expect(h.hotkey.status().holding).toBe(false);
  });

  it('either Ctrl variant works (right Ctrl + left Alt)', () => {
    const h = makeHarness();
    h.down(R_CTRL);
    h.down(L_ALT);
    expect(h.events).toEqual(['start']);
  });

  it('simulate() drives the same FSM (debug harness path)', () => {
    const h = makeHarness();
    h.hotkey.simulate('press');
    h.hotkey.simulate('release');
    expect(h.events).toEqual(['start', 'end']);
  });
});

describe('AltGr / international layouts (F1 AltGr fix)', () => {
  it('AltGr (synthetic LCtrl + RIGHT Alt) never starts a hold', () => {
    const h = makeHarness();
    // Typing € on an international layout: Windows synthesizes LCtrl+RAlt.
    h.down(L_CTRL);
    h.down(R_ALT);
    expect(h.events).toEqual([]);
    expect(h.hotkey.status().holding).toBe(false);
    h.up(R_ALT);
    h.up(L_CTRL);
    expect(h.events).toEqual([]);
  });

  it('repeated AltGr keystrokes stay silent (no capture flash per character)', () => {
    const h = makeHarness();
    for (let i = 0; i < 5; i++) {
      h.down(L_CTRL);
      h.down(R_ALT);
      h.up(R_ALT);
      h.up(L_CTRL);
    }
    expect(h.events).toEqual([]);
  });

  it('right Alt does not complete a hold even with a real Ctrl held', () => {
    const h = makeHarness();
    h.down(R_CTRL);
    h.down(R_ALT);
    expect(h.events).toEqual([]);
    // ...but LEFT Alt still does.
    h.down(L_ALT);
    expect(h.events).toEqual(['start']);
  });
});

describe('max-hold watchdog + forced release (F1 C1 fix)', () => {
  it('force-cancels a hold after MAX_HOLD_MS (swallowed keyup)', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.down(L_CTRL);
    h.down(L_ALT);
    expect(h.events).toEqual(['start']);
    vi.advanceTimersByTime(MAX_HOLD_MS - 1);
    expect(h.events).toEqual(['start']);
    vi.advanceTimersByTime(1);
    expect(h.events).toEqual(['start', 'cancel']);
    expect(h.hotkey.status().holding).toBe(false);
    // The (never-delivered) keyups later must not produce a spurious end.
    h.up(L_CTRL);
    h.up(L_ALT);
    expect(h.events).toEqual(['start', 'cancel']);
  });

  it('a normal release before the watchdog fires never cancels', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.down(L_CTRL);
    h.down(L_ALT);
    h.up(L_ALT);
    expect(h.events).toEqual(['start', 'end']);
    vi.advanceTimersByTime(MAX_HOLD_MS * 2);
    expect(h.events).toEqual(['start', 'end']); // no late cancel
  });

  it('forceCancel() (lock-screen/suspend) cancels and fully resets modifiers', () => {
    const h = makeHarness();
    h.down(L_CTRL);
    h.down(L_ALT);
    expect(h.events).toEqual(['start']);
    // Win+L: the keyups are swallowed by the secure desktop.
    h.hotkey.forceCancel();
    expect(h.events).toEqual(['start', 'cancel']);
    expect(h.hotkey.status().holding).toBe(false);
    // Modifier state was reset: a fresh press works without any keyups.
    h.down(L_CTRL);
    h.down(L_ALT);
    expect(h.events).toEqual(['start', 'cancel', 'start']);
  });

  it('forceCancel() while not holding is a safe no-op', () => {
    const h = makeHarness();
    h.hotkey.forceCancel();
    expect(h.events).toEqual([]);
  });

  it('holds keep working after a watchdog cancellation', () => {
    vi.useFakeTimers();
    const h = makeHarness(1_000);
    h.down(L_CTRL);
    h.down(L_ALT);
    vi.advanceTimersByTime(1_000);
    expect(h.events).toEqual(['start', 'cancel']);
    h.down(L_CTRL);
    h.down(L_ALT);
    h.up(L_ALT);
    expect(h.events).toEqual(['start', 'cancel', 'start', 'end']);
  });
});
