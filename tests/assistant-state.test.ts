/**
 * Assistant state machine: the transition table is exhaustive, timers are
 * owned by the machine, and thinking/speaking can never strand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantStateMachine, resolveTransition } from '../src/main/conversation/assistant-state';
import type { AssistantEvent } from '../src/main/conversation/assistant-state';
import type { AssistantState } from '../src/shared/types';
import {
  ERROR_RECOVERY_MS,
  IDLE_GRACE_MS,
  STUCK_STATE_RECOVERY_MS,
} from '../src/main/conversation/constants';

interface Harness {
  machine: AssistantStateMachine;
  changes: Array<{ previous: AssistantState; next: AssistantState }>;
  watchdogRecoveries: AssistantState[];
  setPending: (n: number) => void;
  setForegroundWork: (busy: boolean) => void;
}

function makeMachine(): Harness {
  const changes: Array<{ previous: AssistantState; next: AssistantState }> = [];
  const watchdogRecoveries: AssistantState[] = [];
  let pending = 0;
  let foreground = false;
  const machine = new AssistantStateMachine({
    onChange: (previous, next) => changes.push({ previous, next }),
    pendingResponses: () => pending,
    hasForegroundWork: () => foreground,
    onWatchdogRecovery: (stuck) => watchdogRecoveries.push(stuck),
  });
  return {
    machine,
    changes,
    watchdogRecoveries,
    setPending: (n) => (pending = n),
    setForegroundWork: (busy) => (foreground = busy),
  };
}

describe('assistant state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the canonical push-to-talk cycle', () => {
    const h = makeMachine();
    h.machine.dispatch('hold_start');
    expect(h.machine.current()).toBe('listening');
    h.machine.dispatch('turn_committed');
    expect(h.machine.current()).toBe('thinking');
    h.setPending(1);
    h.machine.dispatch('response_pending');
    h.machine.dispatch('response_activity');
    expect(h.machine.current()).toBe('speaking');
    h.setPending(0);
    h.machine.dispatch('turn_settled');
    expect(h.machine.current()).toBe('speaking'); // grace, not an instant drop
    vi.advanceTimersByTime(IDLE_GRACE_MS);
    expect(h.machine.current()).toBe('idle');
  });

  it('a tap cancels back to idle without ever showing thinking', () => {
    const h = makeMachine();
    h.machine.dispatch('hold_start');
    h.machine.dispatch('hold_cancelled');
    expect(h.machine.current()).toBe('idle');
    expect(h.changes.map((c) => c.next)).toEqual(['listening', 'idle']);
  });

  it('THE strand fix: late activity after settle re-arms the grace instead of cancelling it', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.setPending(1);
    h.machine.dispatch('response_activity');
    h.setPending(0);
    h.machine.dispatch('turn_settled');
    // A trailing transcript/audio event lands AFTER the last response.done —
    // the old code cancelled the idle timer here and never re-armed it.
    vi.advanceTimersByTime(IDLE_GRACE_MS - 50);
    h.machine.dispatch('response_activity');
    expect(h.machine.current()).toBe('speaking');
    vi.advanceTimersByTime(IDLE_GRACE_MS);
    expect(h.machine.current()).toBe('idle'); // never stranded
  });

  it('idle promotes back to speaking ONLY while a response is truly open (F1 M5)', () => {
    const h = makeMachine();
    // Stray activity with no open response: stays idle.
    h.machine.dispatch('response_activity');
    expect(h.machine.current()).toBe('idle');
    // A follow-up response was requested first: promote.
    h.setPending(1);
    h.machine.dispatch('response_activity');
    expect(h.machine.current()).toBe('speaking');
  });

  it('activity while the user is talking (listening) is ignored', () => {
    const h = makeMachine();
    h.machine.dispatch('hold_start');
    h.setPending(1);
    h.machine.dispatch('response_activity');
    expect(h.machine.current()).toBe('listening');
  });

  it('open mic rests on listening between turns and idles only when turned off', () => {
    const h = makeMachine();
    h.machine.dispatch('open_mic_on');
    expect(h.machine.current()).toBe('thinking');
    h.machine.dispatch('open_mic_ready');
    expect(h.machine.current()).toBe('listening');
    h.machine.dispatch('turn_committed');
    h.setPending(1);
    h.machine.dispatch('response_activity');
    expect(h.machine.current()).toBe('speaking');
    h.setPending(0);
    h.machine.dispatch('turn_settled');
    vi.advanceTimersByTime(IDLE_GRACE_MS);
    expect(h.machine.current()).toBe('listening'); // base is listening, not idle
    h.machine.dispatch('open_mic_off');
    expect(h.machine.current()).toBe('idle');
  });

  it('open_mic_ready after the session was torn down is ignored (stale continuation)', () => {
    const h = makeMachine();
    h.machine.dispatch('open_mic_on');
    h.machine.dispatch('open_mic_off');
    h.machine.dispatch('open_mic_ready');
    expect(h.machine.current()).toBe('idle');
  });

  it('error flashes and auto-recovers to base', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.machine.dispatch('error');
    expect(h.machine.current()).toBe('error');
    vi.advanceTimersByTime(ERROR_RECOVERY_MS);
    expect(h.machine.current()).toBe('idle');
  });

  it('a repeated failure extends the error flash', () => {
    const h = makeMachine();
    h.machine.dispatch('error');
    vi.advanceTimersByTime(ERROR_RECOVERY_MS - 500);
    h.machine.dispatch('error');
    vi.advanceTimersByTime(ERROR_RECOVERY_MS - 500);
    expect(h.machine.current()).toBe('error');
    vi.advanceTimersByTime(500);
    expect(h.machine.current()).toBe('idle');
  });

  it('leaving error (new turn) disarms the recovery timer', () => {
    const h = makeMachine();
    h.machine.dispatch('error');
    h.machine.dispatch('turn_committed');
    expect(h.machine.current()).toBe('thinking');
    h.setForegroundWork(true); // keep the watchdog quiet for this window
    vi.advanceTimersByTime(ERROR_RECOVERY_MS);
    expect(h.machine.current()).toBe('thinking'); // the stale timer never fired
  });

  it('turn_settled is ignored while an error flash shows', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.machine.dispatch('error');
    h.machine.dispatch('turn_settled');
    vi.advanceTimersByTime(IDLE_GRACE_MS);
    expect(h.machine.current()).toBe('error');
  });

  it('reset returns to idle but never clips an error flash', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.machine.dispatch('reset');
    expect(h.machine.current()).toBe('idle');
    h.machine.dispatch('error');
    h.machine.dispatch('reset');
    expect(h.machine.current()).toBe('error');
  });

  it('watchdog force-lands a leaked thinking state with no open work', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    // No response ever arrives, no settle, no error — the leak scenario.
    vi.advanceTimersByTime(STUCK_STATE_RECOVERY_MS);
    expect(h.machine.current()).toBe('idle');
    expect(h.watchdogRecoveries).toEqual(['thinking']);
  });

  it('watchdog respects open responses and foreground work (long turns are legitimate)', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.setPending(1);
    vi.advanceTimersByTime(STUCK_STATE_RECOVERY_MS);
    expect(h.machine.current()).toBe('thinking'); // re-armed, not landed
    h.setPending(0);
    h.setForegroundWork(true); // e.g. an in-flight Codex text turn
    vi.advanceTimersByTime(STUCK_STATE_RECOVERY_MS);
    expect(h.machine.current()).toBe('thinking');
    h.setForegroundWork(false);
    vi.advanceTimersByTime(STUCK_STATE_RECOVERY_MS);
    expect(h.machine.current()).toBe('idle');
    expect(h.watchdogRecoveries).toEqual(['thinking']);
  });

  it('onChange fires only for real changes', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.machine.dispatch('turn_committed'); // no-op re-entry
    h.machine.dispatch('response_pending'); // bookkeeping only
    expect(h.changes).toEqual([{ previous: 'idle', next: 'thinking' }]);
  });

  it('dispose stops all timers and freezes the state', () => {
    const h = makeMachine();
    h.machine.dispatch('turn_committed');
    h.machine.dispatch('error');
    h.machine.dispose();
    vi.advanceTimersByTime(ERROR_RECOVERY_MS + STUCK_STATE_RECOVERY_MS);
    expect(h.machine.current()).toBe('error');
    h.machine.dispatch('turn_committed');
    expect(h.machine.current()).toBe('error');
  });

  it('the transition table ignores events that carry no meaning in the current state', () => {
    const ctx = { openMic: false, pendingResponses: 0 };
    const ignored: Array<[AssistantState, AssistantEvent]> = [
      ['idle', 'hold_cancelled'],
      ['idle', 'turn_settled'],
      ['speaking', 'hold_cancelled'],
      ['error', 'response_activity'],
      ['error', 'turn_settled'],
      ['listening', 'turn_settled'],
    ];
    for (const [state, event] of ignored) {
      expect(resolveTransition(state, event, ctx)).toEqual({ kind: 'ignore' });
    }
  });
});
