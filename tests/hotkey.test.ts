/**
 * Hotkey FSM unit tests (F1 fixes): left-Alt-only matching (AltGr must never
 * trigger), the max-hold watchdog (C1), and forced-release state reset.
 * The uiohook dependency is injected as a fake emitter.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HotkeyManager, MAX_HOLD_MS, TAP_MAX_MS } from '../src/main/hotkey';
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
  /** M20: taps tracked separately — hold semantics stay unchanged by taps. */
  taps: number;
  down(code: number): void;
  up(code: number): void;
  click(button: number, ctrlKey?: boolean): void;
}

function makeHarness(maxHoldMs?: number): Harness {
  const hook = new FakeHook();
  const hotkey = new HotkeyManager({ hook, ...(maxHoldMs !== undefined ? { maxHoldMs } : {}) });
  const events: string[] = [];
  const harness: Harness = {
    hook,
    hotkey,
    events,
    taps: 0,
    down: (code) => hook.emit('keydown', { keycode: code }),
    up: (code) => hook.emit('keyup', { keycode: code }),
    click: (button, ctrlKey = false) => hook.emit('click', { button, ctrlKey }),
  };
  hotkey.on('hold-start', () => events.push('start'));
  hotkey.on('hold-end', () => events.push('end'));
  hotkey.on('hold-cancel', () => events.push('cancel'));
  hotkey.on('tap', () => (harness.taps += 1));
  hotkey.start();
  return harness;
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

describe('global primary click', () => {
  it('emits only for the left/primary mouse button', () => {
    const h = makeHarness();
    const clicks: boolean[] = [];
    h.hotkey.on('primary-click', (ctrlKey) => clicks.push(ctrlKey));
    h.click(3);
    h.click(2);
    h.click(1);
    h.click(1, true);
    expect(clicks).toEqual([false, true]);
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

describe('hook start failure (M11 crash fix)', () => {
  class ThrowingHook implements UiohookLike {
    on(): unknown {
      return this;
    }
    start(): void {
      throw new Error('SetWindowsHookEx failed (simulated)');
    }
    stop(): void {}
  }

  it('start() never throws WITH an error listener: emits + hookAlive false', () => {
    const hotkey = new HotkeyManager({ hook: new ThrowingHook() });
    const errors: Error[] = [];
    hotkey.on('error', (err) => errors.push(err));
    expect(() => hotkey.start()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('SetWindowsHookEx failed');
    expect(hotkey.status().hookAlive).toBe(false);
    expect(hotkey.status().error).toContain('SetWindowsHookEx failed');
  });

  it('start() never throws even with NO error listener (the old crash)', () => {
    const hotkey = new HotkeyManager({ hook: new ThrowingHook() });
    // Before M11 the unlistened EventEmitter 'error' escaped start() and
    // aborted app boot (tray / powerMonitor / debug server never ran).
    expect(() => hotkey.start()).not.toThrow();
    expect(hotkey.status().hookAlive).toBe(false);
  });

  it('the debug simulate() path still drives the FSM after a hook failure', () => {
    const hotkey = new HotkeyManager({ hook: new ThrowingHook() });
    hotkey.on('error', () => {});
    hotkey.start();
    const events: string[] = [];
    hotkey.on('hold-start', () => events.push('start'));
    hotkey.on('hold-end', () => events.push('end'));
    hotkey.simulate('press');
    hotkey.simulate('release');
    expect(events).toEqual(['start', 'end']);
  });

  it('retries a recovered native hook without duplicating event listeners', () => {
    class RecoveringHook extends EventEmitter implements UiohookLike {
      starts = 0;
      stops = 0;
      start(): void {
        this.starts++;
        if (this.starts === 1) throw new Error('access denied');
      }
      stop(): void {
        this.stops++;
      }
    }

    const hook = new RecoveringHook();
    const onSpy = vi.spyOn(hook, 'on');
    const hotkey = new HotkeyManager({ hook });
    hotkey.on('error', () => undefined);
    hotkey.start();
    expect(hotkey.status().hookAlive).toBe(false);
    hotkey.start();

    expect(hotkey.status()).toMatchObject({ hookAlive: true, holding: false });
    expect(hotkey.status().error).toBeUndefined();
    expect(hook.starts).toBe(2);
    expect(hook.stops).toBe(1);
    expect(onSpy).toHaveBeenCalledTimes(3); // keydown, keyup, click — once each

    let starts = 0;
    hotkey.on('hold-start', () => starts++);
    hook.emit('keydown', { keycode: L_CTRL });
    hook.emit('keydown', { keycode: L_ALT });
    expect(starts).toBe(1);
  });
});

describe('double-start guard', () => {
  it('a second start() on a live hook is a no-op (no duplicate listeners)', () => {
    const h = makeHarness();
    h.hotkey.start(); // second start: must not attach a second listener set
    expect(h.hook.listenerCount('keydown')).toBe(1);
    expect(h.hook.listenerCount('keyup')).toBe(1);
    h.down(L_CTRL);
    h.down(L_ALT);
    h.up(L_ALT);
    expect(h.events).toEqual(['start', 'end']); // each hold fires exactly once
  });

  it('start() may retry after a FAILED start (guard keys off hookAlive)', () => {
    class FlakyHook extends FakeHook {
      attempts = 0;
      override start(): void {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('transient hook failure');
        super.start();
      }
    }
    const hook = new FlakyHook();
    const hotkey = new HotkeyManager({ hook });
    hotkey.on('error', () => {});
    hotkey.start();
    expect(hotkey.status().hookAlive).toBe(false);
    hotkey.start(); // retry is allowed — only a LIVE hook blocks re-start
    expect(hotkey.status().hookAlive).toBe(true);
  });
});

describe('tap detection (M20 whisper)', () => {
  it('a release within TAP_MAX_MS fires tap, AFTER hold-end', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const order: string[] = [];
    h.hotkey.on('hold-end', () => order.push('end'));
    h.hotkey.on('tap', () => order.push('tap'));
    h.down(L_CTRL);
    h.down(L_ALT);
    vi.advanceTimersByTime(TAP_MAX_MS);
    h.up(L_ALT);
    expect(h.taps).toBe(1);
    expect(order).toEqual(['end', 'tap']);
    expect(h.events).toEqual(['start', 'end']); // hold semantics untouched
  });

  it('a release after TAP_MAX_MS is a talk, not a tap', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.down(L_CTRL);
    h.down(L_ALT);
    vi.advanceTimersByTime(TAP_MAX_MS + 1);
    h.up(L_CTRL);
    expect(h.taps).toBe(0);
    expect(h.events).toEqual(['start', 'end']);
  });

  it('forced releases (watchdog / lock) never tap', () => {
    vi.useFakeTimers();
    const h = makeHarness(1_000);
    h.down(L_CTRL);
    h.down(L_ALT);
    h.hotkey.forceCancel();
    expect(h.taps).toBe(0);
    h.down(L_CTRL);
    h.down(L_ALT);
    vi.advanceTimersByTime(1_000); // watchdog
    expect(h.taps).toBe(0);
    expect(h.events).toEqual(['start', 'cancel', 'start', 'cancel']);
  });

  it('simulate() press/release counts as a tap (debug harness parity)', () => {
    const h = makeHarness();
    h.hotkey.simulate('press');
    h.hotkey.simulate('release');
    expect(h.taps).toBe(1);
    expect(h.events).toEqual(['start', 'end']);
  });

  it('a Ctrl+Alt+<key> CHORD never taps (app shortcuts must not summon the whisper)', () => {
    const K = 37; // arbitrary letter keycode
    const h = makeHarness();
    h.down(L_CTRL);
    h.down(L_ALT);
    h.down(K); // the chord key
    h.up(K);
    h.up(L_ALT);
    h.up(L_CTRL);
    expect(h.taps).toBe(0);
    expect(h.events).toEqual(['start', 'end']); // hold semantics untouched
  });

  it('a chord in one hold does not poison the next pure tap', () => {
    const K = 37;
    const h = makeHarness();
    h.down(L_CTRL);
    h.down(L_ALT);
    h.down(K);
    h.up(K);
    h.up(L_ALT);
    expect(h.taps).toBe(0);
    h.up(L_CTRL);
    // Fresh pure tap: chordSeen must have been reset by the new hold.
    h.down(L_CTRL);
    h.down(L_ALT);
    h.up(L_ALT);
    expect(h.taps).toBe(1);
  });

  it('keys pressed while NOT holding do not disqualify a following tap', () => {
    const K = 37;
    const h = makeHarness();
    h.down(K); // typing before the hotkey
    h.up(K);
    h.down(L_CTRL);
    h.down(L_ALT);
    h.up(L_ALT);
    h.up(L_CTRL);
    expect(h.taps).toBe(1);
  });
});

describe('hold-cancel reasons (M11 hold_too_long)', () => {
  it('the watchdog cancel carries reason "watchdog"', () => {
    vi.useFakeTimers();
    const h = makeHarness(1_000);
    const reasons: string[] = [];
    h.hotkey.on('hold-cancel', (reason) => reasons.push(reason));
    h.down(L_CTRL);
    h.down(L_ALT);
    vi.advanceTimersByTime(1_000);
    expect(reasons).toEqual(['watchdog']);
  });

  it('an external forceCancel (lock/suspend) carries reason "forced"', () => {
    const h = makeHarness();
    const reasons: string[] = [];
    h.hotkey.on('hold-cancel', (reason) => reasons.push(reason));
    h.down(L_CTRL);
    h.down(L_ALT);
    h.hotkey.forceCancel();
    expect(reasons).toEqual(['forced']);
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
