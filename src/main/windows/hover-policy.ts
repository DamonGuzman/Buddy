import type { AssistantState } from '../../shared/types';

/**
 * `listening` is a physical hold only in push-to-talk mode. Full realtime
 * deliberately stays listening between turns and must remain interactive.
 */
export function listeningBlocksHover(state: AssistantState, fullRealtimeMode: boolean): boolean {
  return state === 'listening' && !fullRealtimeMode;
}
