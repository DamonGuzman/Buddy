import type { HelperBuddySummary, AssistantState } from '../../shared/types';

export type IslandActivityKind =
  | 'capture'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'approval'
  | 'helper-buddy'
  | 'result'
  | 'result-dot';

export interface IslandActivity {
  kind: IslandActivityKind;
  label: string;
  count?: number;
}

interface IslandActivityInput {
  assistantState: AssistantState;
  capturing: boolean;
  helperBuddies: HelperBuddySummary[];
  revealNewResult: boolean;
}

/** One deterministic priority order prevents competing status animations. */
export function resolveIslandActivity(input: IslandActivityInput): IslandActivity | null {
  if (input.capturing) return { kind: 'capture', label: 'seeing your screen' };

  switch (input.assistantState) {
    case 'error':
      return { kind: 'error', label: 'needs attention' };
    case 'listening':
      return { kind: 'listening', label: 'listening' };
    case 'thinking':
      return { kind: 'thinking', label: 'thinking' };
    case 'speaking':
      return { kind: 'speaking', label: 'speaking' };
    case 'idle':
      break;
  }

  const approvals = input.helperBuddies.filter(
    (helperBuddy) => helperBuddy.status === 'waiting_approval',
  );
  if (approvals.length > 0) {
    return {
      kind: 'approval',
      label:
        approvals.length === 1
          ? 'a helper needs your ok'
          : `${approvals.length} helpers need your ok`,
      count: approvals.length,
    };
  }

  const running = input.helperBuddies.filter(
    (helperBuddy) => helperBuddy.status === 'queued' || helperBuddy.status === 'running',
  );
  if (running.length > 0) {
    return {
      kind: 'helper-buddy',
      label: running.length === 1 ? 'buddy is working' : `${running.length} buddies working`,
      count: running.length,
    };
  }

  const unseen = input.helperBuddies.filter((helperBuddy) => helperBuddy.unseen).length;
  if (unseen > 0) {
    return {
      kind: input.revealNewResult ? 'result' : 'result-dot',
      label: unseen === 1 ? 'result ready' : `${unseen} results ready`,
      count: unseen,
    };
  }
  return null;
}
