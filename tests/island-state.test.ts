import { describe, expect, it } from 'vitest';
import type { AgentSummary } from '../src/shared/types';
import { resolveIslandActivity } from '../src/renderer/overlay/island-state';

function agent(patch: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'agent-1',
    task: 'compare displays',
    status: 'running',
    createdAt: 1,
    maxSteps: null,
    steps: [],
    spoken: false,
    unseen: false,
    ...patch,
  };
}

describe('resolveIslandActivity', () => {
  it('prioritizes the privacy signpost over conversational state', () => {
    expect(
      resolveIslandActivity({
        assistantState: 'listening',
        capturing: true,
        agents: [],
        revealNewResult: false,
      }),
    ).toEqual({ kind: 'capture', label: 'seeing your screen' });
  });

  it('shows conversational state before background work', () => {
    expect(
      resolveIslandActivity({
        assistantState: 'speaking',
        capturing: false,
        agents: [agent({})],
        revealNewResult: false,
      })?.kind,
    ).toBe('speaking');
  });

  it('surfaces waiting approvals ahead of ordinary helper work', () => {
    expect(
      resolveIslandActivity({
        assistantState: 'idle',
        capturing: false,
        agents: [agent({ id: 'working' }), agent({ id: 'waiting', status: 'waiting_approval' })],
        revealNewResult: false,
      }),
    ).toEqual({ kind: 'approval', label: 'a helper needs your ok', count: 1 });
  });

  it('collapses unseen results to a persistent dot after the reveal', () => {
    const agents = [agent({ status: 'done', unseen: true })];
    expect(
      resolveIslandActivity({
        assistantState: 'idle',
        capturing: false,
        agents,
        revealNewResult: true,
      })?.kind,
    ).toBe('result');
    expect(
      resolveIslandActivity({
        assistantState: 'idle',
        capturing: false,
        agents,
        revealNewResult: false,
      })?.kind,
    ).toBe('result-dot');
  });

  it('stays hidden when Buddy is fully idle', () => {
    expect(
      resolveIslandActivity({
        assistantState: 'idle',
        capturing: false,
        agents: [],
        revealNewResult: false,
      }),
    ).toBeNull();
  });
});
