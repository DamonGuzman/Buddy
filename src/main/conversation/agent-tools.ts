/**
 * The two read/spawn agent TOOLS the models call (voice and text paths share
 * them): `spawn_agent` builds a brief from the current turn (active-screen
 * screenshot + recent transcript) and starts a background worker;
 * `check_agents` returns a compact, read-only foreground view of active and
 * recent background work (never the workers' full output or sources).
 */

import type { AgentBrief } from '../agents/types';
import type { CaptureResult } from '../capture';
import { showPanelOnce } from '../windows/panel';
import { asRecord, asString } from '../util/guards';
import type { AgentContinuationMode } from './agent-continuations';
import type { AgentsPort } from './ports';
import type { TranscriptStore } from './transcript-store';

export interface AgentToolsDeps {
  /** Null when agent mode is not wired up (focused conversation tests). */
  agents: AgentsPort | null;
  transcript: TranscriptStore;
  /** Captures of the turn that asked to spawn (screenshot for the brief). */
  turnCaptures: () => CaptureResult[];
  /** Remember which transport delegated the run (continuation routing). */
  noteOrigin: (agentId: string, mode: AgentContinuationMode) => void;
}

export class AgentTools {
  private agentSeq = 0;

  constructor(private readonly deps: AgentToolsDeps) {}

  spawnAgent(value: unknown, mode: AgentContinuationMode): object {
    const { agents, transcript, noteOrigin } = this.deps;
    if (agents === null) return { error: 'agent mode is unavailable' };
    const args = asRecord(value) ?? {};
    const task = asString(args['task']).trim().slice(0, 2_000);
    if (!task) return { error: 'task is required' };
    const why = asString(args['why']).trim().slice(0, 1_000);
    const captures = this.deps.turnCaptures();
    const capture = captures.find((item) => item.meta.isActive) ?? captures[0];
    const id = `agent_${(this.agentSeq += 1)}_${Date.now()}`;
    const brief: AgentBrief = {
      id,
      task,
      ...(why ? { why } : {}),
      ...(capture ? { screenshot: { jpegBase64: capture.jpegBase64, meta: capture.meta } } : {}),
      recentTranscript: transcript
        .list()
        .slice(-6)
        .map((entry) => `${entry.role === 'assistant' ? 'buddy' : entry.role}: ${entry.text}`)
        .join('\n')
        .slice(-1_500),
      createdAt: Date.now(),
    };
    const result = agents.spawn(brief);
    if (result.ok) {
      noteOrigin(result.agentId, mode);
      return { ok: true, agent_id: result.agentId };
    }
    if (result.reason === 'at_capacity')
      return { error: 'at capacity — three agents are already running' };
    showPanelOnce('agent_not_signed_in');
    return { error: 'agent mode needs chatgpt sign-in' };
  }

  /** Compact, read-only foreground view of active and recent background work. */
  checkAgents(value: unknown): object {
    const { agents } = this.deps;
    if (agents === null) return { error: 'agent mode is unavailable' };
    const args = asRecord(value) ?? {};
    const agentId = asString(args['agent_id']).trim().slice(0, 200);
    const all = agents.list();
    const selected = agentId
      ? all.filter((agent) => agent.id === agentId)
      : [
          ...all.filter((agent) => agent.status === 'queued' || agent.status === 'running'),
          ...all
            .filter((agent) => agent.status !== 'queued' && agent.status !== 'running')
            .slice(0, 5),
        ];
    if (agentId && selected.length === 0) {
      return { error: 'agent not found', agent_id: agentId };
    }
    const now = Date.now();
    return {
      ok: true,
      agents: selected.map((agent) => ({
        agent_id: agent.id,
        task: agent.task.slice(0, 500),
        status: agent.status,
        elapsed_ms: Math.max(0, (agent.finishedAt ?? now) - agent.createdAt),
        ...(agent.step !== undefined ? { step: agent.step } : {}),
        max_steps: agent.maxSteps,
        ...(agent.steps.length > 0
          ? { latest_activity: agent.steps[agent.steps.length - 1]!.label.slice(0, 500) }
          : {}),
        ...(agent.summary ? { summary: agent.summary.slice(0, 1_000) } : {}),
        ...(agent.error ? { error: agent.error.slice(0, 500) } : {}),
      })),
    };
  }
}
