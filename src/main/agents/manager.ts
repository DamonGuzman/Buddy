import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentSummary } from '../../shared/types';
import { AgentRunner } from './agent';
import type { AgentBrief, AgentManagerDeps, SpawnResult } from './types';
import { AGENT_MAX_CONCURRENT, AGENT_RUN_WALL_CLOCK_MS } from './types';

export class AgentManager {
  private readonly records = new Map<string, AgentSummary>();
  private readonly runners = new Map<string, AgentRunner>();

  constructor(private readonly deps: AgentManagerDeps) {
    this.load();
  }

  list(): AgentSummary[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt).map(clone);
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
        this.records.set(summary.id, clone(summary));
        this.push();
      },
    });
    this.runners.set(brief.id, runner);
    const timeout = setTimeout(() => runner.cancel('timed_out'), AGENT_RUN_WALL_CLOCK_MS);
    void runner.run().then((summary) => {
      clearTimeout(timeout);
      this.runners.delete(summary.id);
      this.records.set(summary.id, clone(summary));
      this.persist();
      this.push();
      this.deps.onFinished(clone(summary));
      this.deps.notify?.('buddy finished', summary.task);
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
    const path = this.deps.persistencePath;
    if (!path || !existsSync(path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(parsed)) return;
      for (const value of parsed.slice(0, 50)) {
        if (isSummary(value)) this.records.set(value.id, { ...value, steps: [...value.steps] });
      }
    } catch {
      /* corrupt history is non-fatal */
    }
  }
  private persist(): void {
    const path = this.deps.persistencePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const terminal = this.list()
        .filter((item) => item.finishedAt !== undefined)
        .slice(0, 50);
      writeFileSync(tmp, JSON.stringify(terminal, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      /* persistence must never take down the tray */
    }
  }
}

function clone(summary: AgentSummary): AgentSummary {
  return { ...summary, steps: [...summary.steps], sources: [...(summary.sources ?? [])] };
}
function isSummary(value: unknown): value is AgentSummary {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<AgentSummary>;
  return (
    typeof item.id === 'string' &&
    typeof item.task === 'string' &&
    Array.isArray(item.steps) &&
    typeof item.status === 'string'
  );
}
