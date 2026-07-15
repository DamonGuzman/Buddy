import type { AgentSummary, AssistantState } from '../../shared/types';

export type IslandActivityKind =
  | 'capture'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'agent'
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
  agents: AgentSummary[];
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

  const running = input.agents.filter((agent) =>
    agent.status === 'queued' || agent.status === 'running',
  );
  if (running.length > 0) {
    return {
      kind: 'agent',
      label: running.length === 1 ? 'buddy is working' : `${running.length} buddies working`,
      count: running.length,
    };
  }

  const unseen = input.agents.filter((agent) => agent.unseen).length;
  if (unseen > 0) {
    return {
      kind: input.revealNewResult ? 'result' : 'result-dot',
      label: unseen === 1 ? 'result ready' : `${unseen} results ready`,
      count: unseen,
    };
  }
  return null;
}
