import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { AgentSummary, FilesystemSelection, FilesystemTaskView } from '../../shared/types';
import type { AgentFilesystemToolPort } from '../agents/types';
import { hostFs, hostFsPromises } from './host-fs';
import {
  applyManifest,
  buildManifest,
  buildSparseManifest,
  diffManifests,
  inspectManifestEntry,
  manifestsEqual,
  rendererChanges,
  resolveInside,
  type TreeManifest,
} from './manifest';
import { MacSeatbeltRunner, type ShellTaskPaths } from './seatbelt-runner';

const { constants } = hostFs;
const { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } = hostFsPromises;

const MAX_PUBLISH_CHANGES = 5_000;
const MAX_STAGED_ROOTS = 200;
const MAX_STAGED_ENTRIES = 20_000;
const MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;

interface TaskRecord {
  version: 2;
  rootPath: string;
  taskRoot: string;
  workspacePath: string;
  backupPath: string;
  baselinePath: string;
  stagedPath: string;
  stagedRoots: string[];
  view: FilesystemTaskView;
}

export interface FilesystemTaskServiceOptions {
  basePath: string;
  onState(state: FilesystemTaskView | null): void;
  onSelection(selection: FilesystemSelection | null): void;
}

/**
 * Owns picker grants, a lazy path-scoped staging area, Seatbelt shells, publication, and Undo.
 * Selecting a folder and admitting a helper never hashes or copies the complete folder.
 */
export class FilesystemTaskService implements AgentFilesystemToolPort {
  private readonly grants = new Map<string, string>();
  private readonly runner: MacSeatbeltRunner;
  private activeGrant: FilesystemSelection | null = null;
  private record: TaskRecord | null = null;
  private mutation: Promise<FilesystemTaskView> | null = null;

  constructor(private readonly options: FilesystemTaskServiceOptions) {
    this.runner = new MacSeatbeltRunner(options.basePath);
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.basePath, { recursive: true, mode: 0o700 });
    await this.loadGrant();
    await this.loadLatest();
    if (!this.record) return;
    const status = this.record.view.status;
    if (status === 'publishing' || status === 'undoing') {
      await this.recoverInterruptedMutation(status);
      return;
    }
    if (status === 'running' || status === 'preparing') {
      this.record.view = {
        ...this.record.view,
        status: 'failed',
        error: 'Buddy closed before this task finished. Your selected folder was never changed.',
      };
      await this.persistRecord();
    }
    this.emit();
  }

  state(): FilesystemTaskView | null {
    return this.record ? cloneView(this.record.view) : null;
  }

  activeSelection(): FilesystemSelection | null {
    return this.activeGrant ? { ...this.activeGrant } : null;
  }

  async grant(selectedPath: string): Promise<FilesystemSelection> {
    const rootPath = await this.validateSelectedRoot(selectedPath);
    const id = randomUUID();
    this.grants.clear();
    this.grants.set(id, rootPath);
    const selection = { id, name: basename(rootPath), displayPath: rootPath };
    this.activeGrant = selection;
    await writeJson(join(this.options.basePath, 'grant.json'), { id, rootPath });
    this.options.onSelection({ ...selection });
    return { ...selection };
  }

  async clearGrant(): Promise<void> {
    if (this.hasUnresolvedTask()) throw new Error('finish the current folder task first');
    this.grants.clear();
    this.activeGrant = null;
    await rm(join(this.options.basePath, 'grant.json'), { force: true });
    this.options.onSelection(null);
  }

  async prepare(grantId: string, request: string): Promise<FilesystemTaskView> {
    const text = request.trim();
    if (text.length === 0 || text.length > 8_000)
      throw new Error('describe the folder task in 8,000 characters or fewer');
    if (this.hasUnresolvedTask())
      throw new Error('finish, discard, or undo the current folder task first');
    const rootPath = this.grants.get(grantId);
    if (!rootPath) throw new Error('that folder permission expired; choose the folder again');
    await this.runner.assertAvailable();

    const taskId = randomUUID();
    const taskRoot = join(this.options.basePath, 'tasks', taskId);
    const workspacePath = join(taskRoot, 'workspace');
    const view: FilesystemTaskView = {
      taskId,
      rootName: basename(rootPath),
      displayPath: rootPath,
      request: text,
      status: 'preparing',
      createdAt: Date.now(),
      changes: [],
      canUndo: false,
    };
    const record: TaskRecord = {
      version: 2,
      rootPath,
      taskRoot,
      workspacePath,
      backupPath: join(taskRoot, 'before'),
      baselinePath: join(taskRoot, 'baseline.json'),
      stagedPath: join(taskRoot, 'staged.json'),
      stagedRoots: [],
      view,
    };
    this.record = record;
    this.emit();
    try {
      await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      await writeJson(join(this.options.basePath, 'latest.json'), { taskId });
      await writeJson(record.baselinePath, await buildSparseManifest(rootPath, []));
      await this.runner.prepare(this.shellPaths(record));
      record.view = { ...view, status: 'running' };
      await this.persistRecord();
      this.emit();
      return cloneView(record.view);
    } catch (error) {
      if (this.record === record) {
        record.view = { ...view, status: 'failed', error: errorText(error) };
        await this.persistRecord().catch(() => undefined);
        this.emit();
      }
      throw error;
    }
  }

  async attachAgent(taskId: string, agentId: string): Promise<FilesystemTaskView> {
    const record = this.requireTask(taskId);
    if (record.view.status !== 'running')
      throw new Error('filesystem task is not ready for an agent');
    record.view = { ...record.view, agentId };
    await this.persistRecord();
    this.emit();
    return cloneView(record.view);
  }

  async fail(taskId: string, message: string): Promise<FilesystemTaskView> {
    const record = this.requireTask(taskId);
    record.view = { ...record.view, status: 'failed', error: message, canUndo: false };
    await this.persistRecord();
    this.emit();
    return cloneView(record.view);
  }

  /** Idempotent stale/pre-agent cancellation; a missing task is already cancelled. */
  async cancelPending(taskId: string): Promise<void> {
    const record = this.record;
    if (!record || record.view.taskId !== taskId) return;
    if (record.view.agentId) return;
    await this.clearRecord(record);
  }

  async completeAgent(summary: AgentSummary): Promise<boolean> {
    const record = this.record;
    if (!record || record.view.agentId !== summary.id) return false;
    if (record.view.status !== 'running') return true;
    if (summary.status === 'cancelled') {
      await this.clearRecord(record);
      return true;
    }
    if (summary.status !== 'done') {
      record.view = {
        ...record.view,
        status: 'failed',
        ...(summary.summary ? { summary: summary.summary } : {}),
        error:
          summary.error ??
          `The folder task ${summary.status.replaceAll('_', ' ')}. Your selected folder was not changed.`,
      };
      await this.persistRecord();
      this.emit();
      return true;
    }
    try {
      const { staged, changes } = await this.computeStagedState(record);
      await writeJson(record.stagedPath, staged);
      record.view = {
        ...record.view,
        status: 'review',
        summary: summary.summary ?? 'The folder task is ready to review.',
        changes: rendererChanges(changes),
      };
    } catch (error) {
      record.view = { ...record.view, status: 'failed', error: errorText(error) };
    }
    await this.persistRecord();
    this.emit();
    return true;
  }

  async runShell(
    taskId: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const record = this.requireRunningTask(taskId);
    return this.runner.runSource(this.shellPaths(record), script, cwdRelative, signal);
  }

  async stagePaths(taskId: string, paths: string[]): Promise<string> {
    const record = this.requireRunningTask(taskId);
    const requested = minimalRelativeRoots(paths.map(validateRelativePath));
    if (requested.length === 0) throw new Error('provide at least one path to stage');
    for (const candidate of requested) {
      if (record.stagedRoots.some((existing) => overlaps(existing, candidate)))
        throw new Error(`path overlaps an already staged root: ${candidate}`);
    }
    const combinedRoots = minimalRelativeRoots([...record.stagedRoots, ...requested]);
    if (combinedRoots.length > MAX_STAGED_ROOTS)
      throw new Error(`refusing to stage more than ${MAX_STAGED_ROOTS} path roots`);

    const [baseline, currentWorkspace, sourceSnapshot] = await Promise.all([
      readManifest(record.baselinePath),
      buildManifest(record.workspacePath),
      buildSparseManifest(record.rootPath, requested),
    ]);
    const combinedBaseline = { ...baseline, ...sourceSnapshot };
    assertStageBudget(combinedBaseline);
    // Existing staged edits win over newly materialized ancestor metadata.
    const desiredWorkspace = { ...sourceSnapshot, ...currentWorkspace };
    await applyManifest(
      record.rootPath,
      record.workspacePath,
      currentWorkspace,
      desiredWorkspace,
      record.view.taskId,
    );
    record.stagedRoots = combinedRoots;
    await writeJson(record.baselinePath, combinedBaseline);
    await this.persistRecord();
    return `Staged paths:\n${requested.join('\n')}`;
  }

  async runStagedShell(
    taskId: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const record = this.requireRunningTask(taskId);
    return this.runner.runStaged(this.shellPaths(record), script, cwdRelative, signal);
  }

  async describeChanges(taskId: string): Promise<string> {
    const record = this.requireRunningTask(taskId);
    const { changes } = await this.computeStagedState(record);
    if (changes.length === 0) return 'No staged filesystem changes.';
    return changes
      .slice(0, 200)
      .map(
        (change) =>
          `${change.before === null ? 'created' : change.after === null ? 'deleted' : 'modified'}: ${change.path}`,
      )
      .join('\n');
  }

  publish(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (record.view.status !== 'review')
        throw new Error('this task is not waiting for publication');
      const [baseline, staged] = await Promise.all([
        readManifest(record.baselinePath),
        readManifest(record.stagedPath),
      ]);
      const live = await buildSparseManifest(record.rootPath, record.stagedRoots);
      if (!manifestsEqual(baseline, live)) {
        throw new Error(
          'One of the staged paths changed while Buddy was working. Nothing was applied; start a fresh task so those edits are preserved.',
        );
      }
      const changes = diffManifests(baseline, staged);
      if (changes.length > MAX_PUBLISH_CHANGES)
        throw new Error(
          `refusing to publish more than ${MAX_PUBLISH_CHANGES.toLocaleString()} changes at once`,
        );
      if (changes.length === 0) {
        const terminal = {
          ...record.view,
          status: 'discarded' as const,
          changes: [],
          canUndo: false,
        };
        await this.clearRecord(record);
        return terminal;
      }

      await mkdir(record.backupPath, { recursive: true, mode: 0o700 });
      const emptyBackup = await buildManifest(record.backupPath);
      await applyManifest(
        record.rootPath,
        record.backupPath,
        emptyBackup,
        { ...baseline, '.': emptyBackup['.']! },
        taskId,
      );
      record.view = { ...record.view, status: 'publishing' };
      await this.persistRecord();
      this.emit();
      try {
        await applyManifest(record.workspacePath, record.rootPath, live, staged, taskId);
        const published = await buildSparseManifest(record.rootPath, record.stagedRoots);
        if (!manifestsEqual(staged, published))
          throw new Error('published files did not match the reviewed staging area');
      } catch (error) {
        await this.restoreBeforeImage(record, baseline).catch((restoreError: unknown) => {
          throw new Error(
            `publication failed and automatic recovery also failed: ${errorText(restoreError)}`,
          );
        });
        record.view = {
          ...record.view,
          status: 'review',
          error: `Nothing was changed: ${errorText(error)}`,
        };
        await this.persistRecord();
        this.emit();
        throw error;
      }
      const { error: _previousError, ...cleanView } = record.view;
      record.view = { ...cleanView, status: 'published', canUndo: true };
      await this.persistRecord();
      this.emit();
      return cloneView(record.view);
    });
  }

  undo(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (record.view.status !== 'published' || !record.view.canUndo)
        throw new Error('this task is not undoable');
      const [baseline, staged] = await Promise.all([
        readManifest(record.baselinePath),
        readManifest(record.stagedPath),
      ]);
      const live = await buildSparseManifest(record.rootPath, record.stagedRoots);
      if (!manifestsEqual(staged, live)) {
        throw new Error(
          'A published path changed after Buddy applied its work, so Undo stopped rather than overwrite newer edits.',
        );
      }
      record.view = { ...record.view, status: 'undoing' };
      await this.persistRecord();
      this.emit();
      await applyManifest(record.backupPath, record.rootPath, live, baseline, taskId);
      const restored = await buildSparseManifest(record.rootPath, record.stagedRoots);
      if (!manifestsEqual(baseline, restored))
        throw new Error('Undo verification failed; the recovery snapshot was retained');
      const terminal = { ...record.view, status: 'undone' as const, canUndo: false };
      await this.clearRecord(record);
      return terminal;
    });
  }

  discard(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (!['review', 'failed'].includes(record.view.status))
        throw new Error('this task cannot be discarded now');
      const terminal = { ...record.view, status: 'discarded' as const, canUndo: false };
      await this.clearRecord(record);
      return terminal;
    });
  }

  keep(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (record.view.status !== 'published')
        throw new Error('only published changes can be finalized');
      const terminal = { ...record.view, status: 'kept' as const, canUndo: false };
      await this.clearRecord(record);
      return terminal;
    });
  }

  private async computeStagedState(record: TaskRecord): Promise<{
    staged: TreeManifest;
    changes: ReturnType<typeof diffManifests>;
  }> {
    const baseline = await readManifest(record.baselinePath);
    const staged = await buildManifest(record.workspacePath);
    staged['.'] = baseline['.']!;
    let baselineChanged = false;
    for (const [key, entry] of Object.entries(staged)) {
      if (key === '.' || baseline[key]) continue;
      if (!isAuthorizedStagedKey(record.stagedRoots, key, entry.type === 'directory'))
        throw new Error(`stage a path before creating or modifying it: ${key}`);
      const live = await inspectManifestEntry(resolveInside(record.rootPath, key));
      if (live === null) continue;
      if (live.type === 'directory' && entry.type === 'directory') {
        baseline[key] = live;
        staged[key] = live;
        baselineChanged = true;
        continue;
      }
      throw new Error(`stage an existing path before modifying it: ${key}`);
    }
    assertStageBudget(staged);
    if (baselineChanged) {
      await writeJson(record.baselinePath, baseline);
      await this.persistRecord();
    }
    return { staged, changes: diffManifests(baseline, staged) };
  }

  private async validateSelectedRoot(selectedPath: string): Promise<string> {
    if (!isAbsolute(selectedPath)) throw new Error('folder selection must be absolute');
    const rootPath = await realpath(selectedPath);
    const info = await stat(rootPath);
    if (!info.isDirectory()) throw new Error('choose a folder');
    const forbidden = new Set([
      '/',
      '/System',
      '/Library',
      '/Applications',
      '/Users',
      '/private',
      '/usr',
      '/bin',
      '/sbin',
      '/var',
      '/etc',
      await realpath(homedir()),
    ]);
    if (forbidden.has(rootPath))
      throw new Error('choose a specific project or documents folder, not a system-wide folder');
    const base = await realpath(this.options.basePath).catch(() => resolve(this.options.basePath));
    if (contains(rootPath, base) || contains(base, rootPath))
      throw new Error('Buddy cannot use its own private data folder as a workspace');
    await access(rootPath, constants.R_OK | constants.W_OK);
    return rootPath;
  }

  private async restoreBeforeImage(record: TaskRecord, baseline: TreeManifest): Promise<void> {
    const live = await buildSparseManifest(record.rootPath, record.stagedRoots);
    await applyManifest(record.backupPath, record.rootPath, live, baseline, record.view.taskId);
    const restored = await buildSparseManifest(record.rootPath, record.stagedRoots);
    if (!manifestsEqual(baseline, restored)) throw new Error('before-image verification failed');
  }

  private async recoverInterruptedMutation(status: 'publishing' | 'undoing'): Promise<void> {
    const record = this.record;
    if (!record) return;
    const baseline = await readManifest(record.baselinePath);
    await this.restoreBeforeImage(record, baseline);
    if (status === 'undoing') {
      await this.clearRecord(record);
      return;
    }
    const { error: _previousError, ...cleanView } = record.view;
    record.view = {
      ...cleanView,
      status: 'review',
      canUndo: false,
      error:
        'Buddy recovered the selected paths after an interrupted publication. Nothing remains applied.',
    };
    await this.persistRecord();
    this.emit();
  }

  private hasUnresolvedTask(): boolean {
    return (
      !!this.record &&
      ['preparing', 'running', 'review', 'publishing', 'published', 'undoing'].includes(
        this.record.view.status,
      )
    );
  }

  private shellPaths(record: TaskRecord): ShellTaskPaths {
    return {
      taskRoot: record.taskRoot,
      source: record.rootPath,
      workspace: record.workspacePath,
      home: join(record.taskRoot, 'home'),
      temp: join(record.taskRoot, 'tmp'),
      profile: join(record.taskRoot, 'profile.sb'),
    };
  }

  private requireTask(taskId: string): TaskRecord {
    if (!this.record || this.record.view.taskId !== taskId)
      throw new Error('filesystem task not found');
    return this.record;
  }

  private requireRunningTask(taskId: string): TaskRecord {
    const record = this.requireTask(taskId);
    if (record.view.status !== 'running') throw new Error('the filesystem task is not running');
    return record;
  }

  private exclusive(operation: () => Promise<FilesystemTaskView>): Promise<FilesystemTaskView> {
    if (this.mutation) throw new Error('a filesystem transaction is already in progress');
    const run = operation().finally(() => {
      this.mutation = null;
    });
    this.mutation = run;
    return run;
  }

  private emit(): void {
    this.options.onState(this.state());
  }

  private async persistRecord(): Promise<void> {
    if (!this.record) return;
    await writeJson(join(this.record.taskRoot, 'task.json'), this.record);
  }

  private async clearRecord(record: TaskRecord): Promise<void> {
    await rm(record.taskRoot, { recursive: true, force: true });
    if (this.record === record) this.record = null;
    await removeLatest(this.options.basePath, record.view.taskId);
    this.emit();
  }

  private async loadLatest(): Promise<void> {
    const latestPath = join(this.options.basePath, 'latest.json');
    let taskId: string | null = null;
    try {
      const pointer = JSON.parse(await readFile(latestPath, 'utf8')) as { taskId?: unknown };
      if (
        typeof pointer.taskId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          pointer.taskId,
        )
      )
        throw new Error('invalid task pointer');
      taskId = pointer.taskId;
      const taskRoot = join(this.options.basePath, 'tasks', taskId);
      const taskPath = join(taskRoot, 'task.json');
      const raw = JSON.parse(await readFile(taskPath, 'utf8')) as TaskRecord;
      if (
        raw.version !== 2 ||
        raw.view?.taskId !== taskId ||
        typeof raw.rootPath !== 'string' ||
        !Array.isArray(raw.stagedRoots) ||
        !raw.stagedRoots.every(
          (value) => typeof value === 'string' && validateRelativePath(value) === value,
        )
      )
        throw new Error('unsupported task record');
      this.record = {
        ...raw,
        taskRoot,
        workspacePath: join(taskRoot, 'workspace'),
        backupPath: join(taskRoot, 'before'),
        baselinePath: join(taskRoot, 'baseline.json'),
        stagedPath: join(taskRoot, 'staged.json'),
      };
    } catch {
      this.record = null;
      await rm(latestPath, { force: true }).catch(() => undefined);
      if (taskId)
        await rm(join(this.options.basePath, 'tasks', taskId), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
    }
  }

  private async loadGrant(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.options.basePath, 'grant.json'), 'utf8'),
      ) as { id?: unknown; rootPath?: unknown };
      if (typeof parsed.id !== 'string' || typeof parsed.rootPath !== 'string') return;
      const rootPath = await this.validateSelectedRoot(parsed.rootPath);
      this.grants.set(parsed.id, rootPath);
      this.activeGrant = {
        id: parsed.id,
        name: basename(rootPath),
        displayPath: rootPath,
      };
    } catch {
      this.activeGrant = null;
      await rm(join(this.options.basePath, 'grant.json'), { force: true }).catch(() => undefined);
    }
  }
}

async function readManifest(path: string): Promise<TreeManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as TreeManifest;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function removeLatest(basePath: string, taskId: string): Promise<void> {
  const path = join(basePath, 'latest.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { taskId?: unknown };
    if (parsed.taskId === taskId) await rm(path, { force: true });
  } catch {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

function validateRelativePath(value: string): string {
  if (typeof value !== 'string') throw new Error('staged paths must be strings');
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || isAbsolute(trimmed) || trimmed.includes('\0'))
    throw new Error('stage a specific folder-relative path, not the entire selected folder');
  const normalized = normalize(trimmed).replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../'))
    throw new Error(`path escapes the selected folder: ${value}`);
  return normalized;
}

function minimalRelativeRoots(values: readonly string[]): string[] {
  const sorted = [...new Set(values)].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
  return sorted.filter(
    (candidate, index) =>
      !sorted.some(
        (parent, parentIndex) =>
          parentIndex !== index &&
          parent.split('/').length < candidate.split('/').length &&
          candidate.startsWith(`${parent}/`),
      ),
  );
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isAuthorizedStagedKey(
  roots: readonly string[],
  key: string,
  isDirectory: boolean,
): boolean {
  return roots.some(
    (root) =>
      key === root || key.startsWith(`${root}/`) || (isDirectory && root.startsWith(`${key}/`)),
  );
}

function assertStageBudget(manifest: TreeManifest): void {
  const entries = Object.values(manifest);
  if (entries.length > MAX_STAGED_ENTRIES)
    throw new Error(`refusing to stage more than ${MAX_STAGED_ENTRIES.toLocaleString()} entries`);
  const bytes = entries.reduce(
    (total, entry) => total + (entry.type === 'file' ? entry.size : 0),
    0,
  );
  if (bytes > MAX_STAGED_BYTES) throw new Error('refusing to stage more than 2 GB at once');
}

function contains(parent: string, child: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(prefix);
}

function cloneView(view: FilesystemTaskView): FilesystemTaskView {
  return { ...view, changes: view.changes.map((change) => ({ ...change })) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
