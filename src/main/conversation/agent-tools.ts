/**
 * The two read/spawn agent TOOLS the models call (voice and text paths share
 * them): `spawn_agent` builds a brief from the current turn (active-screen
 * screenshot + recent transcript) and starts a background worker;
 * `check_agents` returns a compact, read-only foreground view of active and
 * recent background work (never the workers' full output or sources).
 */

import type { AgentBrief } from '../agents/types';
import type { CaptureResult } from '../capture';
import type { ErrorKind } from '../errors';
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
  /** Route actionable agent gates through the same persistent error policy. */
  surfaceError: (kind: ErrorKind) => void;
  /** Picker-backed read grant and lazy staging task prepared for every background helper. */
  prepareFilesystem: (
    task: string,
    agentId: string,
  ) => Promise<{ taskId: string; rootName: string }>;
  /** Release a prepared workspace when manager admission fails. */
  failFilesystem: (taskId: string, reason: string) => Promise<void>;
}

export class AgentTools {
  private agentSeq = 0;

  constructor(private readonly deps: AgentToolsDeps) {}

  async spawnAgent(value: unknown, mode: AgentContinuationMode): Promise<object> {
    const { agents, transcript, noteOrigin } = this.deps;
    if (agents === null) return { error: 'agent mode is unavailable' };
    const args = asRecord(value) ?? {};
    const task = asString(args['task']).trim().slice(0, 2_000);
    if (!task) return { error: 'task is required' };
    const why = asString(args['why']).trim().slice(0, 1_000);
    const captures = this.deps.turnCaptures();
    const capture = captures.find((item) => item.meta.isActive) ?? captures[0];
    const transcriptEntries = transcript.list();
    const latestUserEntry = [...transcriptEntries].reverse().find((entry) => entry.role === 'user');
    if (latestUserEntry?.streaming)
      return { error: 'the original user request is still being transcribed' };
    const userRequest = latestUserEntry?.text.trim().slice(0, 2_000);
    if (!userRequest) return { error: 'the original user request is unavailable' };
    const id = `agent_${(this.agentSeq += 1)}_${Date.now()}`;
    if (!agents.isReady()) {
      this.deps.surfaceError('agent_not_signed_in');
      return { error: 'agent mode needs chatgpt sign-in' };
    }
    let filesystem: { taskId: string; rootName: string };
    try {
      filesystem = await this.deps.prepareFilesystem(task, id);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const brief: AgentBrief = {
      id,
      userRequest,
      task,
      browserEnabled: false,
      filesystem,
      ...(why ? { why } : {}),
      ...(capture ? { screenshot: { jpegBase64: capture.jpegBase64, meta: capture.meta } } : {}),
      recentTranscript: transcriptEntries
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
    const failure =
      result.reason === 'not_signed_in'
        ? 'Buddy needs ChatGPT sign-in.'
        : 'Filesystem execution is unavailable.';
    await this.deps.failFilesystem(filesystem.taskId, failure);
    if (result.reason === 'filesystem_unavailable')
      return { error: 'filesystem use is unavailable for background buddies right now' };
    this.deps.surfaceError('agent_not_signed_in');
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
        ...(agent.steps.length > 0
          ? { latest_activity: agent.steps.at(-1)?.label.slice(0, 500) ?? '' }
          : {}),
        ...(agent.summary ? { summary: agent.summary.slice(0, 1_000) } : {}),
        ...(agent.error ? { error: agent.error.slice(0, 500) } : {}),
      })),
    };
  }
}
