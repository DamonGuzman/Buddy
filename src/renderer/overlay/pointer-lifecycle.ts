import type { AssistantState } from '../../shared/types';

export type BuddyMode = 'rest' | 'flying' | 'pointing';
export type PointerReturnAction = 'none' | 'home' | 'schedule';

/**
 * Coordinates pointer animation completion with assistant-state events.
 *
 * The two signals are independent: response.done can settle the assistant
 * before, during, or after the final pointer flight. Keeping that rendezvous
 * here prevents an early state event from being lost while hover is disabled.
 */
export class PointerReturnLifecycle {
  private turnSettled = true;
  private mode: BuddyMode = 'rest';
  private activeGeneration = 0;
  private settledGeneration: number | null = null;

  beginPoints(generation: number): void {
    this.activeGeneration = generation;
    this.settledGeneration = null;
  }

  setMode(mode: BuddyMode): void {
    this.mode = mode;
  }

  homeStarted(): void {
    this.settledGeneration = null;
  }

  /** Decide what to do once the final point has landed. */
  pointsFinished(generation: number): PointerReturnAction {
    if (generation !== this.activeGeneration) return 'none';
    return 'schedule';
  }

  /** Safety timer: return now if the turn settled, otherwise remember to return then. */
  homeTimerFired(generation: number): PointerReturnAction {
    if (generation !== this.activeGeneration) return 'none';
    if (this.turnSettled) return 'home';
    this.settledGeneration = generation;
    return 'none';
  }

  /** Reconcile an independently arriving assistant-state event. */
  assistantStateChanged(
    state: AssistantState,
    generation: number,
    fullRealtimeMode = false,
  ): PointerReturnAction {
    // In push-to-talk, `listening` means the user is physically holding the
    // hotkey and the turn is active. In full realtime, it is the persistent
    // open-mic READY state between turns, so waiting for literal `idle` would
    // strand the buddy at its last point until realtime mode is stopped.
    this.turnSettled = state === 'idle' || (fullRealtimeMode && state === 'listening');
    if (!this.turnSettled) return 'none';
    if (this.mode === 'pointing') return 'schedule';
    if (this.mode === 'flying') {
      this.settledGeneration = generation;
      return 'none';
    }
    return this.settledGeneration === generation ? 'schedule' : 'none';
  }
}
