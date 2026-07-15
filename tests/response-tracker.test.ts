/**
 * ResponseTracker unit tests: exclusive response starts, active-id adoption,
 * cancelled/unidentified/parallel response isolation, the M4 deferred
 * continue (coalesced, completed-only, dropped on cancel), and the
 * response.done branch decisions the session's emission order hangs on.
 */

import { describe, expect, it } from 'vitest';
import { ResponseTracker } from '../src/main/realtime/response-tracker';

function makeTracker(): { tracker: ResponseTracker; transitions: boolean[] } {
  const transitions: boolean[] = [];
  const tracker = new ResponseTracker((active) => transitions.push(active));
  return { tracker, transitions };
}

describe('ResponseTracker', () => {
  it('begin() activates, notifies, and is exclusive', () => {
    const { tracker, transitions } = makeTracker();
    expect(tracker.active).toBe(false);
    expect(() => tracker.assertIdle()).not.toThrow();

    tracker.begin();
    expect(tracker.active).toBe(true);
    expect(tracker.activeResponseId).toBeNull();
    expect(transitions).toEqual([true]);

    expect(() => tracker.begin()).toThrow('a realtime response is already active');
    expect(() => tracker.assertIdle()).toThrow('a realtime response is already active');
  });

  it('acceptsEvent(): id-less events mirror the active flag', () => {
    const { tracker } = makeTracker();
    expect(tracker.acceptsEvent(undefined)).toBe(false);
    tracker.begin();
    expect(tracker.acceptsEvent(undefined)).toBe(true);
    expect(tracker.acceptsEvent('')).toBe(true); // empty id === no id
  });

  it('acceptsEvent(): adopts the first id seen and rejects any other', () => {
    const { tracker } = makeTracker();
    expect(tracker.acceptsEvent('resp_1')).toBe(false); // nothing requested
    tracker.begin();
    expect(tracker.acceptsEvent('resp_1')).toBe(true); // adopted
    expect(tracker.activeResponseId).toBe('resp_1');
    expect(tracker.acceptsEvent('resp_2')).toBe(false);
    expect(tracker.acceptsEvent('resp_1')).toBe(true);
  });

  it('onResponseCreated(): adopts the active id; flags unexpected and parallel debris', () => {
    const { tracker } = makeTracker();
    expect(tracker.onResponseCreated('resp_ghost')).toBe('cancel-unexpected');
    expect(tracker.acceptsEvent('resp_ghost')).toBe(false); // stale even once active
    tracker.begin();
    expect(tracker.acceptsEvent('resp_ghost')).toBe(false);
    expect(tracker.onResponseCreated('resp_1')).toBe('active');
    expect(tracker.activeResponseId).toBe('resp_1');
    expect(tracker.onResponseCreated('resp_1')).toBe('active'); // idempotent for the same id
    expect(tracker.onResponseCreated('resp_2')).toBe('cancel-parallel');
    expect(tracker.acceptsEvent('resp_2')).toBe(false);
    expect(tracker.activeResponseId).toBe('resp_1'); // untouched
  });

  it('cancel() with a known id: marks it stale, deactivates, reports the id', () => {
    const { tracker, transitions } = makeTracker();
    tracker.begin();
    tracker.onResponseCreated('resp_1');
    expect(tracker.cancel()).toEqual({ cancelled: true, responseId: 'resp_1' });
    expect(tracker.active).toBe(false);
    expect(tracker.activeResponseId).toBeNull();
    expect(transitions).toEqual([true, false]);
    // Late stream events from the cancelled response are dropped...
    expect(tracker.acceptsEvent('resp_1')).toBe(false);
    // ...and its completion is classified 'stale' exactly once.
    expect(tracker.onResponseDone('resp_1', 'cancelled')).toEqual({ kind: 'stale' });
  });

  it('cancel() before response.created: the next unidentified id is absorbed as stale', () => {
    const { tracker } = makeTracker();
    tracker.begin();
    expect(tracker.cancel()).toEqual({ cancelled: true, responseId: null });
    // WebSocket event order: the next created id belongs to the cancelled request.
    expect(tracker.onResponseCreated('resp_late')).toBe('absorbed-cancel');
    expect(tracker.acceptsEvent('resp_late')).toBe(false);
    // The absorption is consumed: a later created (with a response active) adopts.
    tracker.begin();
    expect(tracker.onResponseCreated('resp_next')).toBe('active');
  });

  it('cancel() when idle is a no-op (but still clears a pending continue)', () => {
    const { tracker, transitions } = makeTracker();
    expect(tracker.cancel()).toEqual({ cancelled: false, responseId: null });
    expect(transitions).toEqual([]);
  });

  it('M4: continues defer while active, coalesce, and fire only on completed', () => {
    const { tracker } = makeTracker();
    expect(tracker.deferContinueIfActive()).toBe(false); // idle: start now
    tracker.begin();
    tracker.onResponseCreated('resp_1');
    expect(tracker.deferContinueIfActive()).toBe(true);
    expect(tracker.deferContinueIfActive()).toBe(true); // multi-point turn coalesces
    expect(tracker.onResponseDone('resp_1', 'completed')).toEqual({
      kind: 'active',
      continueAfter: true,
    });
    // Consumed: the follow-up response does not continue again.
    tracker.begin();
    expect(tracker.onResponseDone('resp_2', 'completed')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
  });

  it('M4: a deferred continue never fires for a non-completed response', () => {
    const { tracker } = makeTracker();
    tracker.begin();
    tracker.onResponseCreated('resp_1');
    expect(tracker.deferContinueIfActive()).toBe(true);
    expect(tracker.onResponseDone('resp_1', 'failed')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
  });

  it('a cancelled turn must not auto-continue', () => {
    const { tracker } = makeTracker();
    tracker.begin();
    tracker.onResponseCreated('resp_1');
    tracker.deferContinueIfActive();
    tracker.cancel();
    tracker.begin();
    expect(tracker.onResponseDone('resp_2', 'completed')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
  });

  it('markActiveResponseStale(): VAD interruption isolates the response and drops the continue', () => {
    const { tracker } = makeTracker();
    tracker.markActiveResponseStale(); // idle: no-op
    expect(tracker.active).toBe(false);

    tracker.begin();
    tracker.onResponseCreated('resp_1');
    tracker.deferContinueIfActive();
    tracker.markActiveResponseStale();
    expect(tracker.active).toBe(false);
    expect(tracker.acceptsEvent('resp_1')).toBe(false); // late audio cannot leak
    tracker.begin();
    expect(tracker.onResponseDone('resp_2', 'completed')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
  });

  it('onResponseDone(): completion for a non-active id leaves the active response alone', () => {
    const { tracker } = makeTracker();
    tracker.begin();
    tracker.onResponseCreated('resp_new');
    expect(tracker.onResponseDone('resp_old', 'completed')).toEqual({ kind: 'non-active' });
    expect(tracker.active).toBe(true);
    expect(tracker.activeResponseId).toBe('resp_new');
  });

  it('onResponseDone(): an empty id tears down the active response (M6/M9 recovery path)', () => {
    const { tracker } = makeTracker();
    tracker.begin();
    expect(tracker.onResponseDone('', 'completed')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
    expect(tracker.active).toBe(false);
  });

  it('fail() clears active state and the pending continue', () => {
    const { tracker, transitions } = makeTracker();
    tracker.begin();
    tracker.onResponseCreated('resp_1');
    tracker.deferContinueIfActive();
    tracker.fail();
    expect(tracker.active).toBe(false);
    expect(tracker.activeResponseId).toBeNull();
    expect(transitions).toEqual([true, false]);
    tracker.begin();
    expect(tracker.onResponseDone('resp_2', 'completed')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
  });

  it('reset() releases everything, including the stale-id ledger', () => {
    const { tracker } = makeTracker();
    tracker.begin();
    tracker.onResponseCreated('resp_1');
    tracker.cancel(); // resp_1 is stale
    tracker.begin();
    tracker.cancel(); // one unidentified cancel outstanding
    tracker.reset();
    // Stale ledger is gone: resp_1 no longer classifies as stale...
    expect(tracker.onResponseDone('resp_1', 'cancelled')).toEqual({
      kind: 'active',
      continueAfter: false,
    });
    // ...and no unidentified cancel is absorbed.
    tracker.begin();
    expect(tracker.onResponseCreated('resp_2')).toBe('active');
  });
});
