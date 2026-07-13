import { describe, expect, it } from 'vitest';
import { PointerReturnLifecycle } from '../src/renderer/overlay/pointer-lifecycle';

describe('PointerReturnLifecycle', () => {
  it('starts the dwell after a final flight that outlasts the turn', () => {
    const lifecycle = new PointerReturnLifecycle();
    lifecycle.beginPoints(1);
    lifecycle.setMode('flying');

    expect(lifecycle.assistantStateChanged('idle', 1)).toBe('none');
    lifecycle.setMode('pointing');
    expect(lifecycle.pointsFinished(1)).toBe('schedule');
  });

  it('starts a fresh dwell when idle arrives after landing', () => {
    const lifecycle = new PointerReturnLifecycle();
    lifecycle.assistantStateChanged('speaking', 0);
    lifecycle.beginPoints(1);
    lifecycle.setMode('pointing');

    expect(lifecycle.pointsFinished(1)).toBe('schedule');
    expect(lifecycle.assistantStateChanged('idle', 1)).toBe('schedule');
  });

  it('treats listening as settled between full realtime turns', () => {
    const lifecycle = new PointerReturnLifecycle();
    lifecycle.assistantStateChanged('speaking', 0, true);
    lifecycle.beginPoints(2);
    lifecycle.setMode('pointing');

    expect(lifecycle.assistantStateChanged('listening', 2, true)).toBe('schedule');
    expect(lifecycle.homeTimerFired(2)).toBe('home');
  });

  it('does not treat a push-to-talk listening hold as settled', () => {
    const lifecycle = new PointerReturnLifecycle();
    lifecycle.assistantStateChanged('speaking', 0, false);
    lifecycle.beginPoints(3);
    lifecycle.setMode('pointing');

    expect(lifecycle.assistantStateChanged('listening', 3, false)).toBe('none');
    expect(lifecycle.homeTimerFired(3)).toBe('none');
  });

  it('keeps the safety timeout for a response that has not settled', () => {
    const lifecycle = new PointerReturnLifecycle();
    lifecycle.assistantStateChanged('speaking', 0);
    lifecycle.beginPoints(4);
    lifecycle.setMode('pointing');

    expect(lifecycle.pointsFinished(4)).toBe('schedule');
    expect(lifecycle.homeTimerFired(4)).toBe('none');
    lifecycle.setMode('rest');
    expect(lifecycle.assistantStateChanged('idle', 4)).toBe('schedule');
  });

  it('ignores stale timers from a superseded pointer command', () => {
    const lifecycle = new PointerReturnLifecycle();
    lifecycle.assistantStateChanged('speaking', 0);
    lifecycle.beginPoints(1);
    lifecycle.beginPoints(2);

    expect(lifecycle.homeTimerFired(1)).toBe('none');
  });
});
