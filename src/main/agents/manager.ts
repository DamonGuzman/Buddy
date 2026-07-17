import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentStatus, AgentStep, AgentSummary } from '../../shared/types';
import { AgentRunner } from './agent';
import type { AgentBrief, AgentManagerDeps, AgentPersistencePort, SpawnResult } from './types';
import { AGENT_MANAGER_DISPOSE_TIMEOUT_MS, PERSISTED_SUMMARY_CAP } from './config';
import { cloneAgentSummary } from './summary-text';
import { errorMessage } from '../util/guards';

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
  private readonly runPromises = new Map<string, Promise<void>>();
  private readonly persistence: AgentPersistencePort | null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private browserAdmissionBlocked = false;

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
    if (this.disposed) throw new Error('agent manager is disposed');
    if (!this.deps.isReady()) return { ok: false, reason: 'not_signed_in' };
    if (brief.browserEnabled && this.browserAdmissionBlocked)
      return { ok: false, reason: 'browser_unavailable' };
    if (brief.browserEnabled && !this.deps.browser)
      return { ok: false, reason: 'browser_unavailable' };
    if (brief.browserEnabled && brief.filesystem)
      throw new Error('browser and filesystem capabilities are mutually exclusive');
    if (brief.filesystem && !this.deps.filesystem)
      return { ok: false, reason: 'filesystem_unavailable' };
    const runner = new AgentRunner({
      brief,
      backend: this.deps.backend,
      ...(brief.browserEnabled && this.deps.browser ? { browser: this.deps.browser } : {}),
      ...(brief.filesystem && this.deps.filesystem ? { filesystem: this.deps.filesystem } : {}),
      ...(this.deps.firecrawl ? { firecrawl: this.deps.firecrawl } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      onUpdate: (summary) => {
        this.records.set(summary.id, cloneAgentSummary(summary));
        this.push();
      },
    });
    this.runners.set(brief.id, runner);
    const completion = runner
      .run()
      .then((summary) => {
        this.runners.delete(summary.id);
        this.records.set(summary.id, cloneAgentSummary(summary));
        this.persist();
        this.push();
        if (!this.disposed) {
          this.deps.onFinished(cloneAgentSummary(summary));
          this.deps.notify?.('buddy finished', summary.task);
        }
      })
      .catch((error) => {
        const summary = runner.finishUnexpected(error);
        this.runners.delete(brief.id);
        this.records.set(summary.id, cloneAgentSummary(summary));
        this.persist();
        this.push();
        if (!this.disposed) {
          this.deps.onFinished(cloneAgentSummary(summary));
          this.deps.notify?.('buddy stopped', errorMessage(error));
        }
      })
      .finally(() => {
        this.runPromises.delete(brief.id);
      });
    this.runPromises.set(brief.id, completion);
    return { ok: true, agentId: brief.id };
  }

  cancel(id: string): void {
    this.runners.get(id)?.cancel();
  }
  async resolveApproval(approvalId: string, verdict: 'once' | 'always' | 'deny'): Promise<void> {
    const approvals = this.deps.browser?.approvals;
    if (!approvals) throw new Error('browser approvals are unavailable');
    await approvals.resolve(approvalId, verdict);
  }
  async showBrowserForApproval(approvalId: string): Promise<void> {
    const request = this.deps.browser?.approvals.get(approvalId);
    if (!request || !request.allowTakeover) throw new Error('approval cannot take over a browser');
    const runner = this.runners.get(request.agentId);
    if (!runner) throw new Error('approval agent is no longer running');
    await runner.showBrowserForUser();
  }
  async hideBrowserForApproval(approvalId: string): Promise<void> {
    const request = this.deps.browser?.approvals.get(approvalId);
    if (!request || !request.allowTakeover) throw new Error('approval cannot take over a browser');
    const runner = this.runners.get(request.agentId);
    if (!runner) throw new Error('approval agent is no longer running');
    await runner.hideBrowserFromUser();
    const approvals = this.deps.browser?.approvals;
    if (!approvals) throw new Error('browser approvals are unavailable');
    await approvals.resolve(approvalId, 'handled');
  }
  cancelAll(): void {
    for (const runner of this.runners.values()) runner.cancel();
  }
  /**
   * Destructive browser-state boundary: cancel and join every browser-enabled
   * runner, including one still in its initial backend deliberation. Repeat
   * until registration is empty so profile clearing cannot race late lazy
   * driver creation.
   */
  async cancelBrowserRuns(): Promise<void> {
    for (;;) {
      const active = [...this.runners.entries()].filter(([, runner]) => runner.usesBrowser());
      if (active.length === 0) return;
      for (const [, runner] of active) runner.cancel();
      await withTimeout(
        Promise.all(
          active.flatMap(([id]) => {
            const completion = this.runPromises.get(id);
            return completion ? [completion] : [];
          }),
        ).then(() => undefined),
        AGENT_MANAGER_DISPOSE_TIMEOUT_MS,
        'browser agent cancellation',
      );
    }
  }
  /**
   * Atomic admission barrier for destructive browser-profile mutations.
   * Browser spawns fail closed from the instant the barrier is entered until
   * the mutation settles; read-only research remains independent.
   */
  async withBrowserAdmissionBlocked<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('agent manager is disposed');
    if (this.browserAdmissionBlocked)
      throw new Error('a browser state mutation is already in progress');
    this.browserAdmissionBlocked = true;
    try {
      await this.cancelBrowserRuns();
      return await mutation();
    } finally {
      this.browserAdmissionBlocked = false;
    }
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
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    const runners = [...this.runners.values()];
    const completions = [...this.runPromises.values()];
    this.disposePromise = (async () => {
      const settled = Promise.allSettled([
        ...runners.map((runner) => runner.dispose()),
        ...completions,
      ]);
      let results: Awaited<typeof settled>;
      try {
        results = await withTimeout(
          settled,
          AGENT_MANAGER_DISPOSE_TIMEOUT_MS,
          'agent manager disposal',
        );
      } finally {
        this.persist();
      }
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    })();
    return this.disposePromise;
  }

  private push(): void {
    if (this.disposed) return;
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const KNOWN_STATUSES: readonly string[] = [
  'queued',
  'running',
  'waiting_approval',
  'done',
  'failed',
  'cancelled',
] satisfies AgentStatus[];
const KNOWN_STEP_KINDS: readonly string[] = [
  'search',
  'fetch',
  'note',
  'think',
  'browse',
  'action',
  'review',
  'shell',
  'file',
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
