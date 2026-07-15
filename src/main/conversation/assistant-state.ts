/**
 * The assistant state machine — the ONE owner of `AssistantState`.
 *
 * Before this module, `Conversation` mutated a bare `state` field from ~15
 * call sites plus two free-floating timers, and illegal event orders produced
 * stuck UI (the canonical bug: a late transcript/audio event after the last
 * response.done cancelled the idle-grace timer without re-arming it, stranding
 * the buddy in 'speaking' — waveform forever). Every change now flows through
 * `dispatch(event)`:
 *
 * - transitions are resolved by a pure, exhaustive table
 *   (`resolveTransition`) — an event that is not meaningful in the current
 *   state is IGNORED, never applied;
 * - the three timers (idle grace, error recovery, stuck watchdog) live here
 *   and are re-armed/cleared as part of the same dispatch, so a timer can
 *   never race a transition;
 * - 'thinking' and 'speaking' are guaranteed to resolve: settling arms the
 *   idle grace, stray late activity RE-ARMS it instead of stranding, and the
 *   watchdog force-lands the state if response accounting ever leaks.
 *
 * The states (shared contract, `AssistantState`):
 * - idle      — nothing in flight; base state for push-to-talk.
 * - listening — the mic is live: a held hotkey, or open-mic between turns.
 * - thinking  — a turn is committed; waiting for the model's first output.
 * - speaking  — response output is streaming (the ONLY state that may show a
 *               live waveform).
 * - error     — a surfaced failure flash; auto-recovers to the base state.
 */

import type { AssistantState } from '../../shared/types';
import { ERROR_RECOVERY_MS, IDLE_GRACE_MS, STUCK_STATE_RECOVERY_MS } from './constants';

/** Semantic inputs — call sites say what HAPPENED, never what state to show. */
export type AssistantEvent =
  /** Push-to-talk hotkey went down (always takes the foreground). */
  | 'hold_start'
  /** Hold ended without a turn: tap, forced cancel, or too little audio. */
  | 'hold_cancelled'
  /** A turn was sent: voice commit, typed ask, VAD speech stop, continuation. */
  | 'turn_committed'
  /** response.create observed — keeps thinking/speaking alive, no transition. */
  | 'response_pending'
  /** Response output is streaming (audio delta / transcript / tool call). */
  | 'response_activity'
  /** The turn's LAST response settled — start the grace toward base. */
  | 'turn_settled'
  /** Open-mic session is connecting (sets the open-mic base to listening). */
  | 'open_mic_on'
  /** Open-mic connected / user speech started. */
  | 'open_mic_ready'
  /** Open-mic session ended (clears the open-mic base). */
  | 'open_mic_off'
  /** A failure was surfaced (error flash; auto-recovers). */
  | 'error'
  /** Session rebuild — back to idle unless an error flash is showing. */
  | 'reset';

export interface TransitionContext {
  /** Open-mic mode: the resting state is 'listening' instead of 'idle'. */
  openMic: boolean;
  /** Open realtime responses (request/done ledger). */
  pendingResponses: number;
}

/** What a dispatch should do — 'settle' holds the state and arms the grace. */
export type TransitionAction =
  { kind: 'ignore' } | { kind: 'go'; next: AssistantState } | { kind: 'settle' };

/** The base (resting) state for the current mode. */
export function baseState(ctx: Pick<TransitionContext, 'openMic'>): AssistantState {
  return ctx.openMic ? 'listening' : 'idle';
}

/**
 * The full transition table, pure and exhaustive. Anything not listed here is
 * deliberately impossible — events arriving in states where they carry no
 * meaning (stale async continuations, duplicate session events) are ignored
 * instead of applied.
 */
export function resolveTransition(
  state: AssistantState,
  event: AssistantEvent,
  ctx: TransitionContext,
): TransitionAction {
  switch (event) {
    case 'hold_start':
      // The user's hotkey always wins, whatever buddy was doing.
      return { kind: 'go', next: 'listening' };
    case 'hold_cancelled':
      // Valid only while the hold owns the state: 'listening' (tap/cancel) or
      // 'thinking' (the too-little-audio cancel after the commit promoted it).
      return state === 'listening' || state === 'thinking'
        ? { kind: 'go', next: baseState(ctx) }
        : { kind: 'ignore' };
    case 'turn_committed':
      return { kind: 'go', next: 'thinking' };
    case 'response_pending':
      // Pure timer bookkeeping (clears a pending idle grace); never a state.
      return { kind: 'ignore' };
    case 'response_activity':
      if (state === 'thinking' || state === 'speaking') return { kind: 'go', next: 'speaking' };
      // A follow-up response can start streaming after the grace already
      // dropped to idle — promote back ONLY while a response is truly open.
      if (state === 'idle' && ctx.pendingResponses > 0) return { kind: 'go', next: 'speaking' };
      // 'listening' (user is talking) and 'error' never show output activity.
      return { kind: 'ignore' };
    case 'turn_settled':
      return state === 'thinking' || state === 'speaking' ? { kind: 'settle' } : { kind: 'ignore' };
    case 'open_mic_on':
      return { kind: 'go', next: 'thinking' };
    case 'open_mic_ready':
      // Stale connect continuations after the session was torn down.
      return ctx.openMic ? { kind: 'go', next: 'listening' } : { kind: 'ignore' };
    case 'open_mic_off':
      return { kind: 'go', next: 'idle' };
    case 'error':
      return { kind: 'go', next: 'error' };
    case 'reset':
      // A rebuild lands on idle, but never clips a showing error flash.
      return state === 'idle' || state === 'error'
        ? { kind: 'ignore' }
        : { kind: 'go', next: 'idle' };
  }
}

export interface AssistantStateMachineDeps {
  /** A REAL change was applied (broadcast + record it). Never fired for no-ops. */
  onChange: (previous: AssistantState, next: AssistantState) => void;
  /** Open realtime responses — guards idle→speaking and the watchdog. */
  pendingResponses: () => number;
  /**
   * Non-realtime foreground work the watchdog must respect (an in-flight
   * Codex text turn keeps 'thinking' legitimate with zero pendingResponses).
   */
  hasForegroundWork: () => boolean;
  /** The watchdog force-landed a leaked thinking/speaking state (telemetry). */
  onWatchdogRecovery?: (stuck: AssistantState) => void;
  /** Timer overrides for tests; production uses the shared constants. */
  idleGraceMs?: number;
  errorRecoveryMs?: number;
  stuckRecoveryMs?: number;
}

export class AssistantStateMachine {
  private state: AssistantState = 'idle';
  private openMic = false;
  private disposed = false;

  private graceTimer: NodeJS.Timeout | null = null;
  private errorTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;

  private readonly idleGraceMs: number;
  private readonly errorRecoveryMs: number;
  private readonly stuckRecoveryMs: number;

  constructor(private readonly deps: AssistantStateMachineDeps) {
    this.idleGraceMs = deps.idleGraceMs ?? IDLE_GRACE_MS;
    this.errorRecoveryMs = deps.errorRecoveryMs ?? ERROR_RECOVERY_MS;
    this.stuckRecoveryMs = deps.stuckRecoveryMs ?? STUCK_STATE_RECOVERY_MS;
  }

  current(): AssistantState {
    return this.state;
  }

  /** App shutdown: stop all timers; the state stays readable. */
  dispose(): void {
    this.disposed = true;
    this.clearGrace();
    this.clearErrorRecovery();
    this.clearWatchdog();
  }

  dispatch(event: AssistantEvent): void {
    if (this.disposed) return;
    if (event === 'open_mic_on') this.openMic = true;
    if (event === 'open_mic_off') this.openMic = false;

    const action = resolveTransition(this.state, event, {
      openMic: this.openMic,
      pendingResponses: this.deps.pendingResponses(),
    });
    if (action.kind === 'go') this.apply(action.next);

    // Timer bookkeeping is part of the SAME dispatch — it can never race the
    // transition it belongs to.
    const busy = this.state === 'thinking' || this.state === 'speaking';
    if (!busy) {
      this.clearGrace();
    } else if (action.kind === 'settle') {
      this.armGrace();
    } else if (event === 'response_activity') {
      // The strand fix: stray output with NO open response must still land on
      // base eventually — re-arm the grace instead of merely cancelling it.
      if (this.deps.pendingResponses() === 0) this.armGrace();
      else this.clearGrace();
    } else if (
      event === 'turn_committed' ||
      event === 'response_pending' ||
      event === 'open_mic_on'
    ) {
      // A new/continuing response supersedes a pending drop to base.
      this.clearGrace();
    }

    if (busy) this.armWatchdog();
    else this.clearWatchdog();

    // A repeated failure while flashing extends the flash window.
    if (event === 'error') this.armErrorRecovery();
  }

  /** Apply a resolved transition; onChange fires only for real changes. */
  private apply(next: AssistantState): void {
    const previous = this.state;
    if (previous === next) return;
    this.state = next;
    if (next === 'error') this.armErrorRecovery();
    else this.clearErrorRecovery();
    this.deps.onChange(previous, next);
  }

  // ------------------------------------------------------------- timers

  /** Grace after the last response settles before dropping to base. */
  private armGrace(): void {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.disposed) return;
      if (this.state !== 'thinking' && this.state !== 'speaking') return;
      this.apply(baseState({ openMic: this.openMic }));
      this.clearWatchdog();
    }, this.idleGraceMs);
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /** Error flash auto-recovers to the base state. */
  private armErrorRecovery(): void {
    this.clearErrorRecovery();
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      if (this.disposed || this.state !== 'error') return;
      this.apply(baseState({ openMic: this.openMic }));
    }, this.errorRecoveryMs);
  }

  private clearErrorRecovery(): void {
    if (this.errorTimer !== null) clearTimeout(this.errorTimer);
    this.errorTimer = null;
  }

  /**
   * The stuck-state guarantee: thinking/speaking with no open response and no
   * foreground work for stuckRecoveryMs is a leak — force-land on base.
   * Every dispatch while busy re-arms it, so only a truly event-less stall
   * ever fires; legitimate long turns re-arm via their own pending work.
   */
  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.disposed) return;
      if (this.state !== 'thinking' && this.state !== 'speaking') return;
      if (this.deps.pendingResponses() > 0 || this.deps.hasForegroundWork()) {
        this.armWatchdog();
        return;
      }
      this.deps.onWatchdogRecovery?.(this.state);
      this.apply(baseState({ openMic: this.openMic }));
    }, this.stuckRecoveryMs);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
  }
}
