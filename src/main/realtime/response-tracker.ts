/**
 * Response-lifecycle accounting for RealtimeSession, extracted so the
 * cancelled / superseded / unidentified-cancel bookkeeping is directly
 * unit-testable (tests/response-tracker.test.ts). PURE state — no sockets, no
 * timers, no emits; the session reacts to `onActiveChange` (watchdog + ping)
 * and to the returned decisions (warns, response.cancel sends, and the
 * ordering of 'response-done' emission).
 *
 * Invariants preserved from the F1 review fixes:
 * - M4: a continue requested mid-response DEFERS; `onResponseDone` reports
 *   `continueAfter: true` exactly once (multiple requests coalesce), and only
 *   for status 'completed'. A cancelled turn must never auto-continue.
 * - response isolation: server events are accepted only for the active
 *   response id. Ids cancelled before response.created arrives are absorbed
 *   by WebSocket event order (`unidentifiedCancelled`), so late stream debris
 *   from a cancelled response can never leak into the next playback epoch.
 */

import type { ResponseStatus } from './protocol';

export type ResponseCreatedDecision =
  /** Absorbed a cancel issued before the id was known; the id is now stale. */
  | 'absorbed-cancel'
  /** No response was requested: the caller warns and cancels it. */
  | 'cancel-unexpected'
  /** The active request's id (learned now, or matching what we knew). */
  | 'active'
  /** A different id while one is active: the caller warns and cancels it. */
  | 'cancel-parallel';

export type ResponseDoneDecision =
  /**
   * A cancelled/superseded response completed. The app-level response ledger
   * still needs the completion, but it must not mutate the newer active
   * response: the caller emits 'response-done' and nothing else.
   */
  | { kind: 'stale' }
  /** Completion for a non-active id: the caller warns, then emits only. */
  | { kind: 'non-active' }
  /**
   * The active response finished: full teardown ran. `continueAfter` means
   * the deferred tool-output continue must fire BEFORE 'response-done' is
   * emitted, so app-level response accounting never dips to zero in the
   * middle of a multi-response turn (M4/M5 ordering).
   */
  | { kind: 'active'; continueAfter: boolean };

export class ResponseTracker {
  /** True between response.create and response.done/error. */
  private responseActive = false;
  /** Server id learned from response.created for the active request. */
  private activeId: string | null = null;
  /** Cancelled/superseded response ids whose late stream events are ignored. */
  private readonly staleIds = new Set<string>();
  /** Cancels issued before response.created; WebSocket event order identifies them later. */
  private unidentifiedCancelled = 0;
  /** F1 (M4): a continue was requested mid-response; fire it after done. */
  private continuePending = false;

  constructor(private readonly onActiveChange: (active: boolean) => void) {}

  get active(): boolean {
    return this.responseActive;
  }

  get activeResponseId(): string | null {
    return this.activeId;
  }

  /** Direct response starts are exclusive. */
  assertIdle(): void {
    if (this.responseActive) {
      throw new Error('a realtime response is already active');
    }
  }

  /** A response.create is about to be sent. Throws when one is active. */
  begin(): void {
    this.assertIdle();
    this.activeId = null;
    this.setActive(true);
  }

  /**
   * F1 (M4): the real API rejects response.create while a response is active
   * ('conversation_already_has_active_response'). Returns true when the
   * continue was deferred until response.done; false = start it now.
   */
  deferContinueIfActive(): boolean {
    if (!this.responseActive) return false;
    this.continuePending = true;
    return true;
  }

  /**
   * Cancel the in-progress response. Marks it stale (by id, or as an
   * unidentified cancel when response.created has not arrived yet) and
   * deactivates. Returns whether anything was cancelled plus the id to send
   * response.cancel with (null = cancel without response_id).
   */
  cancel(): { cancelled: boolean; responseId: string | null } {
    this.continuePending = false; // a cancelled turn must not auto-continue
    if (!this.responseActive) return { cancelled: false, responseId: null };
    const responseId = this.activeId;
    this.markActiveResponseStale();
    return { cancelled: true, responseId };
  }

  /**
   * The active response was cancelled out from under us (server-VAD
   * interruption, supersession): remember it as stale immediately so late
   * WebSocket audio cannot leak while the app stops local playback.
   */
  markActiveResponseStale(): void {
    if (!this.responseActive) return;
    if (this.activeId !== null) {
      this.staleIds.add(this.activeId);
    } else {
      // response.created is ordered after the response.create we already sent,
      // so the next unidentified created id belongs to this cancelled request.
      this.unidentifiedCancelled += 1;
    }
    this.continuePending = false;
    this.setActive(false);
    this.activeId = null;
  }

  /** True only for the current response; cancelled/parallel stream debris is dropped. */
  acceptsEvent(responseId: string | undefined): boolean {
    if (!responseId) return this.responseActive;
    if (this.staleIds.has(responseId)) return false;
    if (!this.responseActive) return false;
    if (this.activeId === null) this.activeId = responseId;
    return this.activeId === responseId;
  }

  /** response.created arrived: adopt, absorb a pending cancel, or flag debris. */
  onResponseCreated(responseId: string): ResponseCreatedDecision {
    if (this.unidentifiedCancelled > 0) {
      this.unidentifiedCancelled -= 1;
      this.staleIds.add(responseId);
      return 'absorbed-cancel';
    }
    if (!this.responseActive) {
      this.staleIds.add(responseId);
      return 'cancel-unexpected';
    }
    if (this.activeId === null) {
      this.activeId = responseId;
      return 'active';
    }
    if (this.activeId !== responseId) {
      this.staleIds.add(responseId);
      return 'cancel-parallel';
    }
    return 'active';
  }

  /** response.done arrived: classify it and tear down the active state. */
  onResponseDone(responseId: string, status: ResponseStatus): ResponseDoneDecision {
    if (responseId.length > 0 && this.staleIds.delete(responseId)) {
      return { kind: 'stale' };
    }
    if (responseId.length > 0 && this.activeId !== null && responseId !== this.activeId) {
      return { kind: 'non-active' };
    }
    this.setActive(false);
    this.activeId = null;
    const continueAfter = this.continuePending && status === 'completed';
    this.continuePending = false;
    return { kind: 'active', continueAfter };
  }

  /** The active response died (socket drop / watchdog / rejected commit). */
  fail(): void {
    this.setActive(false);
    this.activeId = null;
    this.continuePending = false;
  }

  /** Clean shutdown: release everything, including the stale-id ledger. */
  reset(): void {
    this.setActive(false);
    this.activeId = null;
    this.continuePending = false;
    this.staleIds.clear();
    this.unidentifiedCancelled = 0;
  }

  private setActive(active: boolean): void {
    this.responseActive = active;
    this.onActiveChange(active);
  }
}
