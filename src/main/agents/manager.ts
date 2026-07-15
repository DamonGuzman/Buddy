import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentStatus, AgentStep, AgentSummary } from '../../shared/types';
import { AgentRunner } from './agent';
import type { AgentBrief, AgentManagerDeps, AgentPersistencePort, SpawnResult } from './types';
import { AGENT_MAX_CONCURRENT, AGENT_RUN_WALL_CLOCK_MS, PERSISTED_SUMMARY_CAP } from './config';
import { cloneAgentSummary } from './summary-text';

/**
 * Default AgentPersistencePort: one JSON file, written atomically
 * (tmp + rename) with owner-only mode 0o600.
 */
export function createFilePersistence(path: string): AgentPersistencePort {
  return {
    load(): unknown {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    save(records: AgentSummary[]): void {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

export class AgentManager {
  private readonly records = new Map<string, AgentSummary>();
  private readonly runners = new Map<string, AgentRunner>();
  private readonly persistence: AgentPersistencePort | null;

  constructor(private readonly deps: AgentManagerDeps) {
    this.persistence =
      deps.persistence ??
      (deps.persistencePath ? createFilePersistence(deps.persistencePath) : null);
    this.load();
  }

  list(): AgentSummary[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneAgentSummary);
  }

  isReady(): boolean {
    return this.deps.isReady();
  }

  spawn(brief: AgentBrief): SpawnResult {
    if (!this.deps.isReady()) return { ok: false, reason: 'not_signed_in' };
    if (this.runners.size >= AGENT_MAX_CONCURRENT) return { ok: false, reason: 'at_capacity' };
    const runner = new AgentRunner({
      brief,
      backend: this.deps.backend,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      onUpdate: (summary) => {
        this.records.set(summary.id, cloneAgentSummary(summary));
        this.push();
      },
    });
    this.runners.set(brief.id, runner);
    const timeout = setTimeout(() => runner.cancel('timed_out'), AGENT_RUN_WALL_CLOCK_MS);
    void runner
      .run()
      .then((summary) => {
        clearTimeout(timeout);
        this.runners.delete(summary.id);
        this.records.set(summary.id, cloneAgentSummary(summary));
        this.persist();
        this.push();
        this.deps.onFinished(cloneAgentSummary(summary));
        this.deps.notify?.('buddy finished', summary.task);
      })
      .catch(() => {
        // run() never rejects today (every failure path resolves to a
        // terminal summary) — this guard only exists so a future regression
        // cannot leak a capacity slot.
        clearTimeout(timeout);
        this.runners.delete(brief.id);
        this.push();
      });
    return { ok: true, agentId: brief.id };
  }

  cancel(id: string): void {
    this.runners.get(id)?.cancel();
  }
  cancelAll(): void {
    for (const runner of this.runners.values()) runner.cancel();
  }
  markSeen(id: string): void {
    const record = this.records.get(id);
    if (!record || !record.unseen) return;
    record.unseen = false;
    this.persist();
    this.push();
  }
  markSpoken(id: string): void {
    const record = this.records.get(id);
    if (!record || record.spoken) return;
    record.spoken = true;
    this.persist();
    this.push();
  }
  dispose(): void {
    this.cancelAll();
    this.persist();
  }

  private push(): void {
    this.deps.onAgentsChanged(this.list());
  }
  private load(): void {
    if (!this.persistence) return;
    try {
      const parsed = this.persistence.load();
      if (!Array.isArray(parsed)) return;
      for (const value of parsed.slice(0, PERSISTED_SUMMARY_CAP)) {
        if (isSummary(value)) this.records.set(value.id, { ...value, steps: [...value.steps] });
      }
    } catch {
      /* corrupt history is non-fatal */
    }
  }
  private persist(): void {
    if (!this.persistence) return;
    try {
      const terminal = this.list()
        .filter((item) => item.finishedAt !== undefined)
        .slice(0, PERSISTED_SUMMARY_CAP);
      this.persistence.save(terminal);
    } catch {
      /* persistence must never take down the tray */
    }
  }
}

const KNOWN_STATUSES: readonly string[] = [
  'queued',
  'running',
  'done',
  'failed',
  'timed_out',
  'cancelled',
] satisfies AgentStatus[];
const KNOWN_STEP_KINDS: readonly string[] = [
  'search',
  'fetch',
  'note',
  'think',
] satisfies AgentStep['kind'][];

function isStep(value: unknown): value is AgentStep {
  if (value === null || typeof value !== 'object') return false;
  const step = value as Partial<AgentStep>;
  return (
    typeof step.kind === 'string' &&
    KNOWN_STEP_KINDS.includes(step.kind) &&
    typeof step.label === 'string' &&
    typeof step.at === 'number'
  );
}

function isSummary(value: unknown): value is AgentSummary {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<AgentSummary>;
  return (
    typeof item.id === 'string' &&
    typeof item.task === 'string' &&
    typeof item.status === 'string' &&
    KNOWN_STATUSES.includes(item.status) &&
    typeof item.createdAt === 'number' &&
    typeof item.spoken === 'boolean' &&
    typeof item.unseen === 'boolean' &&
    Array.isArray(item.steps) &&
    item.steps.every(isStep)
  );
}
