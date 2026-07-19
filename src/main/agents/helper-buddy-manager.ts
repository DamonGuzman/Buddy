import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HelperBuddyStatus, HelperBuddyStep, HelperBuddySummary } from '../../shared/types';
import { HelperBuddyRunner } from './helper-buddy';
import type {
  HelperBuddyBrief,
  HelperBuddyManagerDeps,
  HelperBuddyPersistencePort,
  HelperBuddySpawnResult,
} from './types';
import {
  HELPER_BUDDY_STEP_LOG_CAP,
  HELPER_BUDDY_MANAGER_DISPOSE_TIMEOUT_MS,
  PERSISTED_SUMMARY_CAP,
} from './helper-buddy-config';
import { cloneHelperBuddySummary } from './helper-buddy-summary-text';
import { isCanonicalHelperBuddyId, requireCanonicalHelperBuddyId } from '../helper-buddy-id';
import { errorMessage } from '../util/guards';

/**
 * Default HelperBuddyPersistencePort: one JSON file, written atomically
 * (tmp + rename) with owner-only mode 0o600.
 */
export function createFilePersistence(path: string): HelperBuddyPersistencePort {
  return {
    load(): unknown {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    save(records: HelperBuddySummary[]): void {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
      // `mode` only applies when the temporary file is first created. A stale
      // temp file left by a prior crash may already exist with broader bits.
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    },
  };
}

export class HelperBuddyManager {
  private readonly records = new Map<string, HelperBuddySummary>();
  private readonly runners = new Map<string, HelperBuddyRunner>();
  private readonly runPromises = new Map<string, Promise<void>>();
  private readonly persistence: HelperBuddyPersistencePort | null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private browserAdmissionBlocked = false;

  constructor(private readonly deps: HelperBuddyManagerDeps) {
    this.persistence =
      deps.persistence ??
      (deps.persistencePath ? createFilePersistence(deps.persistencePath) : null);
    this.load();
  }

  list(): HelperBuddySummary[] {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneHelperBuddySummary);
  }

  isReady(): boolean {
    return this.deps.isReady();
  }

  spawn(brief: HelperBuddyBrief): HelperBuddySpawnResult {
    if (this.disposed) throw new Error('helper buddy manager is disposed');
    const id = requireCanonicalHelperBuddyId(brief.id);
    if (this.records.has(id) || this.runners.has(id) || this.runPromises.has(id))
      throw new Error(`helper buddy id is already registered: ${id}`);
    if (!this.deps.isReady()) return { ok: false, reason: 'not_signed_in' };
    if (this.browserAdmissionBlocked || !this.deps.browser)
      return { ok: false, reason: 'browser_unavailable' };
    if (!this.deps.filesystem) return { ok: false, reason: 'filesystem_unavailable' };
    const runner = new HelperBuddyRunner({
      brief,
      backend: this.deps.backend,
      memory: this.deps.memory,
      browser: this.deps.browser,
      filesystem: this.deps.filesystem,
      ...(this.deps.firecrawl ? { firecrawl: this.deps.firecrawl } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      onUpdate: (summary) => {
        this.records.set(summary.id, cloneHelperBuddySummary(summary));
        this.push();
      },
    });
    this.runners.set(id, runner);
    const completion = runner
      .run()
      .then((summary) => {
        this.runners.delete(summary.id);
        this.records.set(summary.id, cloneHelperBuddySummary(summary));
        this.persist();
        this.push();
        if (!this.disposed) {
          this.deps.onFinished(cloneHelperBuddySummary(summary));
          if (summary.status === 'done') {
            this.deps.notify?.('helper buddy finished', summary.task);
          } else if (summary.status === 'failed') {
            this.deps.notify?.('helper buddy stopped', summary.error ?? summary.task);
          }
        }
      })
      .catch((error) => {
        const summary = runner.finishUnexpected(error);
        this.runners.delete(id);
        this.records.set(summary.id, cloneHelperBuddySummary(summary));
        this.persist();
        this.push();
        if (!this.disposed) {
          this.deps.onFinished(cloneHelperBuddySummary(summary));
          this.deps.notify?.('helper buddy stopped', errorMessage(error));
        }
      })
      .finally(() => {
        this.runPromises.delete(id);
      });
    this.runPromises.set(id, completion);
    return { ok: true, helperBuddyId: id };
  }

  cancel(id: string): void {
    const helperBuddyId = requireCanonicalHelperBuddyId(id);
    this.runners.get(helperBuddyId)?.cancel();
  }
  async resolveApproval(approvalId: string, verdict: 'once' | 'always' | 'deny'): Promise<void> {
    const approvals = this.deps.browser?.approvals;
    if (!approvals) throw new Error('browser approvals are unavailable');
    await approvals.resolve(approvalId, verdict);
  }
  async showBrowserForApproval(approvalId: string): Promise<void> {
    const request = this.deps.browser?.approvals.get(approvalId);
    if (!request || !request.allowTakeover) throw new Error('approval cannot take over a browser');
    const runner = this.runners.get(request.helperBuddyId);
    if (!runner) throw new Error('approval helper buddy is no longer running');
    await runner.showBrowserForUser();
  }
  async hideBrowserForApproval(approvalId: string): Promise<void> {
    const request = this.deps.browser?.approvals.get(approvalId);
    if (!request || !request.allowTakeover) throw new Error('approval cannot take over a browser');
    const runner = this.runners.get(request.helperBuddyId);
    if (!runner) throw new Error('approval helper buddy is no longer running');
    await runner.hideBrowserFromUser();
    const approvals = this.deps.browser?.approvals;
    if (!approvals) throw new Error('browser approvals are unavailable');
    await approvals.resolve(approvalId, 'handled');
  }
  cancelAll(): void {
    for (const runner of this.runners.values()) runner.cancel();
  }
  /**
   * Destructive browser-state boundary: cancel and join every helper
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
        HELPER_BUDDY_MANAGER_DISPOSE_TIMEOUT_MS,
        'browser helper buddy cancellation',
      );
    }
  }
  /**
   * Atomic admission barrier for destructive browser-profile mutations.
   * Browser spawns fail closed from the instant the barrier is entered until
   * the mutation settles. Every helper has browser capability, so all helper
   * admission pauses while the shared profile is being mutated.
   */
  async withBrowserAdmissionBlocked<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('helper buddy manager is disposed');
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
    const record = this.records.get(requireCanonicalHelperBuddyId(id));
    if (!record || !record.unseen) return;
    record.unseen = false;
    this.persist();
    this.push();
  }
  markSpoken(id: string): void {
    const record = this.records.get(requireCanonicalHelperBuddyId(id));
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
          HELPER_BUDDY_MANAGER_DISPOSE_TIMEOUT_MS,
          'helper buddy manager disposal',
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
    this.deps.onHelperBuddiesChanged(this.list());
  }
  private load(): void {
    if (!this.persistence) return;
    try {
      const parsed = this.persistence.load();
      if (!Array.isArray(parsed)) return;
      let accepted = 0;
      for (const value of parsed) {
        if (accepted >= PERSISTED_SUMMARY_CAP) break;
        if (isPersistedSummary(value)) {
          this.records.set(value.id, cloneHelperBuddySummary(value));
          accepted += 1;
        }
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
] satisfies HelperBuddyStatus[];
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
] satisfies HelperBuddyStep['kind'][];

function isStep(value: unknown): value is HelperBuddyStep {
  if (value === null || typeof value !== 'object') return false;
  const step = value as Partial<HelperBuddyStep>;
  return (
    typeof step.kind === 'string' &&
    KNOWN_STEP_KINDS.includes(step.kind) &&
    typeof step.label === 'string' &&
    typeof step.at === 'number' &&
    Number.isFinite(step.at)
  );
}

function isPersistedSummary(value: unknown): value is HelperBuddySummary {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<HelperBuddySummary>;
  return (
    isCanonicalHelperBuddyId(item.id) &&
    typeof item.task === 'string' &&
    typeof item.status === 'string' &&
    KNOWN_STATUSES.includes(item.status) &&
    isTerminalStatus(item.status) &&
    typeof item.createdAt === 'number' &&
    Number.isFinite(item.createdAt) &&
    typeof item.finishedAt === 'number' &&
    Number.isFinite(item.finishedAt) &&
    item.finishedAt >= item.createdAt &&
    typeof item.spoken === 'boolean' &&
    typeof item.unseen === 'boolean' &&
    (item.status !== 'cancelled' || item.unseen === false) &&
    Array.isArray(item.steps) &&
    item.steps.length <= HELPER_BUDDY_STEP_LOG_CAP &&
    item.steps.every(isStep) &&
    optionalStep(item.step) &&
    optionalString(item.summary) &&
    optionalString(item.output) &&
    optionalString(item.error) &&
    (item.sources === undefined ||
      (Array.isArray(item.sources) && item.sources.every((source) => typeof source === 'string')))
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalStep(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 1)
  );
}

function isTerminalStatus(
  status: string,
): status is Extract<HelperBuddyStatus, 'done' | 'failed' | 'cancelled'> {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}
