import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type {
  HelperBuddySummary,
  FilesystemSelection,
  FilesystemTaskView,
} from '../../shared/types';
import type { HelperBuddyFilesystemToolPort } from '../agents/types';
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
import { HostShellRunner, type HostShellPaths, type ShellRunResult } from './host-shell-runner';

const { constants } = hostFs;
const { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } = hostFsPromises;

const MAX_PUBLISH_CHANGES = 5_000;
const MAX_STAGED_ROOTS = 200;
const MAX_STAGED_ENTRIES = 20_000;
const MAX_STAGED_BYTES = 2 * 1024 * 1024 * 1024;

interface TaskRecord {
  version: 4;
  rootPath: string;
  taskRoot: string;
  workspacePath: string;
  backupPath: string;
  baselinePath: string;
  stagedPath: string;
  stagedRoots: string[];
  presentationFile: string | null;
  view: FilesystemTaskView;
}

export interface FilesystemHelperBuddyCompletion {
  handled: boolean;
  view: FilesystemTaskView | null;
  error: string | null;
  presentation: { kind: 'file' | 'folder'; path: string } | null;
}

export interface FilesystemTaskServiceOptions {
  basePath: string;
  onState(states: FilesystemTaskView[]): void;
  onSelection(selection: FilesystemSelection | null): void;
}

/**
 * Owns picker grants, a lazy path-scoped staging area, host shells, publication, and Undo.
 * Selecting a folder and admitting a helper never hashes or copies the complete folder.
 */
export class FilesystemTaskService implements HelperBuddyFilesystemToolPort {
  private readonly grants = new Map<string, string>();
  private readonly runner: HostShellRunner;
  private readonly records = new Map<string, TaskRecord>();
  private readonly rootMutations = new Map<string, Promise<void>>();
  private activeGrant: FilesystemSelection | null = null;
  private visibleTaskId: string | null = null;

  constructor(private readonly options: FilesystemTaskServiceOptions) {
    this.runner = new HostShellRunner();
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.basePath, { recursive: true, mode: 0o700 });
    await this.loadGrant();
    await this.loadTasks();
    for (const record of [...this.records.values()]) {
      const status = record.view.status;
      if (status === 'publishing' || status === 'undoing') {
        await this.exclusive(record, () => this.recoverInterruptedMutation(record, status));
        continue;
      }
      if (status === 'running' || status === 'preparing') {
        record.view = {
          ...record.view,
          status: 'failed',
          error: 'Buddy closed before this task finished. Your selected folder was never changed.',
        };
        await this.persistRecord(record);
      }
    }
    this.emit();
  }

  state(taskId?: string): FilesystemTaskView | null {
    const record = taskId ? this.records.get(taskId) : this.visibleRecord();
    return record ? cloneView(record.view) : null;
  }

  states(): FilesystemTaskView[] {
    return [...this.records.values()]
      .sort((left, right) => right.view.createdAt - left.view.createdAt)
      .map((record) => cloneView(record.view));
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
    this.grants.clear();
    this.activeGrant = null;
    await rm(join(this.options.basePath, 'grant.json'), { force: true });
    this.options.onSelection(null);
  }

  async prepare(grantId: string, request: string): Promise<FilesystemTaskView> {
    const text = request.trim();
    if (text.length === 0 || text.length > 8_000)
      throw new Error('describe the folder task in 8,000 characters or fewer');
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
      version: 4,
      rootPath,
      taskRoot,
      workspacePath,
      backupPath: join(taskRoot, 'before'),
      baselinePath: join(taskRoot, 'baseline.json'),
      stagedPath: join(taskRoot, 'staged.json'),
      stagedRoots: [],
      presentationFile: null,
      view,
    };
    this.records.set(taskId, record);
    this.emit(record);
    try {
      await mkdir(workspacePath, { recursive: true, mode: 0o700 });
      await writeJson(record.baselinePath, await buildSparseManifest(rootPath, []));
      await this.runner.prepare(this.shellPaths(record));
      record.view = { ...view, status: 'running' };
      await this.persistRecord(record);
      this.emit(record);
      return cloneView(record.view);
    } catch (error) {
      if (this.records.get(taskId) === record) {
        record.view = { ...view, status: 'failed', error: errorText(error) };
        await this.persistRecord(record).catch(() => undefined);
        this.emit(record);
      }
      throw error;
    }
  }

  async attachHelperBuddy(taskId: string, helperBuddyId: string): Promise<FilesystemTaskView> {
    const record = this.requireTask(taskId);
    if (record.view.status !== 'running')
      throw new Error('filesystem task is not ready for a helper buddy');
    const id = validateHelperBuddyId(helperBuddyId);
    if (record.view.helperBuddyId !== undefined)
      throw new Error('filesystem task already has a helper buddy');
    const assigned = [...this.records.values()].find(
      (candidate) => candidate !== record && candidate.view.helperBuddyId === id,
    );
    if (assigned) throw new Error('helper buddy is already attached to another filesystem task');
    record.view = { ...record.view, helperBuddyId: id };
    await this.persistRecord(record);
    this.emit(record);
    return cloneView(record.view);
  }

  async fail(taskId: string, message: string): Promise<FilesystemTaskView> {
    const record = this.requireTask(taskId);
    record.view = { ...record.view, status: 'failed', error: message, canUndo: false };
    await this.persistRecord(record);
    this.emit(record);
    return cloneView(record.view);
  }

  /** Idempotent stale/pre-helper-buddy cancellation; a missing task is already cancelled. */
  async cancelPending(taskId: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record) return;
    if (record.view.helperBuddyId) return;
    await this.clearRecord(record);
  }

  async completeHelperBuddy(summary: HelperBuddySummary): Promise<FilesystemHelperBuddyCompletion> {
    const record = this.findRecordForHelperBuddy(summary.id);
    if (!record) return { handled: false, view: null, error: null, presentation: null };
    if (record.view.status !== 'running') {
      const view = cloneView(record.view);
      return {
        handled: true,
        view,
        error: view.error ?? null,
        presentation: null,
      };
    }
    if (summary.status === 'cancelled') {
      await this.clearRecord(record);
      return { handled: true, view: null, error: null, presentation: null };
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
      await this.persistRecord(record);
      this.emit(record);
      return {
        handled: true,
        view: cloneView(record.view),
        error: record.view.error ?? 'the folder task stopped',
        presentation: null,
      };
    }
    return this.exclusive(record, async () => {
      try {
        const { staged, changes } = await this.computeStagedState(record);
        const presentation = await this.resolvePresentation(record, staged, changes);
        await writeJson(record.stagedPath, staged);
        if (changes.length === 0) {
          await this.clearRecord(record);
          return { handled: true, view: null, error: null, presentation };
        }
        const view = await this.publishCompletedHelperBuddy(record, staged, changes, summary);
        return { handled: true, view, error: null, presentation };
      } catch (error) {
        const message = errorText(error);
        if (this.records.get(record.view.taskId) === record && record.view.status !== 'failed') {
          record.view = {
            ...record.view,
            ...(record.view.status === 'publishing' ? {} : { status: 'failed' as const }),
            error:
              record.view.status === 'publishing'
                ? `The handoff could not be recovered automatically: ${message}`
                : `Nothing was changed: ${message}`,
          };
          await this.persistRecord(record).catch(() => undefined);
          this.emit(record);
        }
        return {
          handled: true,
          view: this.records.get(record.view.taskId) === record ? cloneView(record.view) : null,
          error: record.view.error ?? message,
          presentation: null,
        };
      }
    });
  }

  async runShell(
    taskId: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
    const record = this.requireRunningTask(taskId);
    return this.runner.runSource(this.shellPaths(record), script, cwdRelative, signal);
  }

  async stagePaths(taskId: string, paths: string[]): Promise<string> {
    const record = this.requireRunningTask(taskId);
    return this.exclusive(record, async () => {
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
      await this.persistRecord(record);
      return `Staged paths:\n${requested.join('\n')}`;
    });
  }

  async runStagedShell(
    taskId: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult> {
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

  async presentFile(taskId: string, path: string): Promise<string> {
    const record = this.requireRunningTask(taskId);
    const relativePath = validateRelativePath(path);
    const workspaceEntry = await inspectManifestEntry(
      resolveInside(record.workspacePath, relativePath),
    );
    if (workspaceEntry && !isAuthorizedStagedKey(record.stagedRoots, relativePath, false))
      throw new Error(`stage the presentation file before selecting it: ${relativePath}`);
    const entry =
      workspaceEntry ?? (await inspectManifestEntry(resolveInside(record.rootPath, relativePath)));
    assertSafePresentationFile(relativePath, entry);
    record.presentationFile = relativePath;
    await this.persistRecord(record);
    return `Buddy will open ${relativePath} as soon as the verified transaction is published.`;
  }

  undo(taskId: string): Promise<FilesystemTaskView> {
    const record = this.requireTask(taskId);
    return this.exclusive(record, async () => {
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
      await this.persistRecord(record);
      this.emit(record);
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
    const record = this.requireTask(taskId);
    return this.exclusive(record, async () => {
      if (record.view.status !== 'failed') throw new Error('this task cannot be discarded now');
      const terminal = { ...record.view, status: 'discarded' as const, canUndo: false };
      await this.clearRecord(record);
      return terminal;
    });
  }

  retainedWorkspacePath(taskId: string): string {
    const record = this.requireTask(taskId);
    if (record.view.status !== 'failed')
      throw new Error('only a failed task has a safe copy to inspect');
    return record.workspacePath;
  }

  keep(taskId: string): Promise<FilesystemTaskView> {
    const record = this.requireTask(taskId);
    return this.exclusive(record, async () => {
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
    const baselineRoot = baseline['.'];
    if (baselineRoot === undefined) throw new Error('baseline manifest is missing its root entry');
    staged['.'] = baselineRoot;
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
      await this.persistRecord(record);
    }
    return { staged, changes: diffManifests(baseline, staged) };
  }

  private async resolvePresentation(
    record: TaskRecord,
    staged: TreeManifest,
    changes: ReturnType<typeof diffManifests>,
  ): Promise<{ kind: 'file' | 'folder'; path: string } | null> {
    if (record.presentationFile) {
      const stagedEntry = staged[record.presentationFile];
      const entry =
        stagedEntry ??
        (await inspectManifestEntry(resolveInside(record.rootPath, record.presentationFile)));
      assertSafePresentationFile(record.presentationFile, entry);
      return { kind: 'file', path: resolveInside(record.rootPath, record.presentationFile) };
    }
    const fileOutputs = changes.filter(
      (change) =>
        change.after?.type === 'file' && isSafePresentationFile(change.path, change.after.mode),
    );
    if (fileOutputs.length === 1) {
      const [fileOutput] = fileOutputs;
      if (fileOutput === undefined) throw new Error('presentation output selection failed');
      return { kind: 'file', path: resolveInside(record.rootPath, fileOutput.path) };
    }
    return changes.length > 0 ? { kind: 'folder', path: record.rootPath } : null;
  }

  private async publishCompletedHelperBuddy(
    record: TaskRecord,
    staged: TreeManifest,
    changes: ReturnType<typeof diffManifests>,
    summary: HelperBuddySummary,
  ): Promise<FilesystemTaskView> {
    const baseline = await readManifest(record.baselinePath);
    const live = await buildSparseManifest(record.rootPath, record.stagedRoots);
    if (!manifestsEqual(baseline, live)) {
      throw new Error(
        'One of the staged paths changed while Buddy was working. The automatic handoff stopped so those newer edits are preserved.',
      );
    }
    if (changes.length > MAX_PUBLISH_CHANGES)
      throw new Error(
        `refusing to publish more than ${MAX_PUBLISH_CHANGES.toLocaleString()} changes at once`,
      );

    await mkdir(record.backupPath, { recursive: true, mode: 0o700 });
    const emptyBackup = await buildManifest(record.backupPath);
    const emptyBackupRoot = emptyBackup['.'];
    if (emptyBackupRoot === undefined) throw new Error('backup manifest is missing its root entry');
    await applyManifest(
      record.rootPath,
      record.backupPath,
      emptyBackup,
      { ...baseline, '.': emptyBackupRoot },
      record.view.taskId,
    );
    record.view = {
      ...record.view,
      status: 'publishing',
      summary: summary.summary ?? 'The folder task finished.',
      changes: rendererChanges(changes),
      canUndo: false,
    };
    await this.persistRecord(record);
    this.emit(record);
    try {
      await applyManifest(record.workspacePath, record.rootPath, live, staged, record.view.taskId);
      const published = await buildSparseManifest(record.rootPath, record.stagedRoots);
      if (!manifestsEqual(staged, published))
        throw new Error('published files did not match the verified staging area');
    } catch (error) {
      await this.restoreBeforeImage(record, baseline).catch((restoreError: unknown) => {
        throw new Error(
          `publication failed and automatic recovery also failed: ${errorText(restoreError)}`,
        );
      });
      record.view = {
        ...record.view,
        status: 'failed',
        error: `Nothing was changed: ${errorText(error)}`,
      };
      await this.persistRecord(record);
      this.emit(record);
      throw error;
    }
    const { error: _previousError, ...cleanView } = record.view;
    record.view = { ...cleanView, status: 'published', canUndo: true };
    await this.persistRecord(record);
    this.emit(record);
    return cloneView(record.view);
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

  private async recoverInterruptedMutation(
    record: TaskRecord,
    status: 'publishing' | 'undoing',
  ): Promise<void> {
    const baseline = await readManifest(record.baselinePath);
    await this.restoreBeforeImage(record, baseline);
    if (status === 'undoing') {
      await this.clearRecord(record);
      return;
    }
    const { error: _previousError, ...cleanView } = record.view;
    record.view = {
      ...cleanView,
      status: 'failed',
      canUndo: false,
      error:
        'Buddy recovered the selected paths after an interrupted publication. Nothing remains applied.',
    };
    await this.persistRecord(record);
    this.emit(record);
  }

  private shellPaths(record: TaskRecord): HostShellPaths {
    return {
      taskRoot: record.taskRoot,
      source: record.rootPath,
      workspace: record.workspacePath,
      home: join(record.taskRoot, 'home'),
      temp: join(record.taskRoot, 'tmp'),
    };
  }

  private requireTask(taskId: string): TaskRecord {
    const record = this.records.get(taskId);
    if (!record) throw new Error('filesystem task not found');
    return record;
  }

  private requireRunningTask(taskId: string): TaskRecord {
    const record = this.requireTask(taskId);
    if (record.view.status !== 'running') throw new Error('the filesystem task is not running');
    return record;
  }

  private exclusive<T>(record: TaskRecord, operation: () => Promise<T>): Promise<T> {
    const rootPath = record.rootPath;
    const predecessor = this.rootMutations.get(rootPath) ?? Promise.resolve();
    const run = predecessor.then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.rootMutations.set(rootPath, tail);
    void tail.then(() => {
      if (this.rootMutations.get(rootPath) === tail) this.rootMutations.delete(rootPath);
    });
    return run;
  }

  private emit(record?: TaskRecord): void {
    if (record && this.records.get(record.view.taskId) === record)
      this.visibleTaskId = record.view.taskId;
    this.options.onState(this.states());
  }

  private visibleRecord(): TaskRecord | undefined {
    const visible = this.visibleTaskId ? this.records.get(this.visibleTaskId) : undefined;
    if (visible) return visible;
    const latest = [...this.records.values()].sort(
      (left, right) => right.view.createdAt - left.view.createdAt,
    )[0];
    this.visibleTaskId = latest?.view.taskId ?? null;
    return latest;
  }

  private findRecordForHelperBuddy(helperBuddyId: string): TaskRecord | undefined {
    return [...this.records.values()].find((record) => record.view.helperBuddyId === helperBuddyId);
  }

  private async persistRecord(record: TaskRecord): Promise<void> {
    if (this.records.get(record.view.taskId) !== record) return;
    await writeJson(join(record.taskRoot, 'task.json'), record);
  }

  private async clearRecord(record: TaskRecord): Promise<void> {
    await rm(record.taskRoot, { recursive: true, force: true });
    if (this.records.get(record.view.taskId) === record) this.records.delete(record.view.taskId);
    if (this.visibleTaskId === record.view.taskId) this.visibleTaskId = null;
    this.emit();
  }

  private async loadTasks(): Promise<void> {
    const tasksRoot = join(this.options.basePath, 'tasks');
    await mkdir(tasksRoot, { recursive: true, mode: 0o700 });
    const entries = await readdir(tasksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isTaskId(entry.name)) continue;
      const taskId = entry.name;
      const taskRoot = join(tasksRoot, taskId);
      try {
        const raw = JSON.parse(await readFile(join(taskRoot, 'task.json'), 'utf8')) as TaskRecord;
        assertTaskRecord(raw, taskId);
        const record: TaskRecord = {
          ...raw,
          taskRoot,
          workspacePath: join(taskRoot, 'workspace'),
          backupPath: join(taskRoot, 'before'),
          baselinePath: join(taskRoot, 'baseline.json'),
          stagedPath: join(taskRoot, 'staged.json'),
        };
        try {
          const rootPath = await this.validateSelectedRoot(raw.rootPath);
          if (rootPath !== raw.rootPath)
            throw new Error('the selected folder now resolves to a different path');
          record.rootPath = rootPath;
        } catch (error) {
          record.view = {
            ...record.view,
            status: 'failed',
            canUndo: false,
            error: `Buddy could not re-authorize the selected folder: ${errorText(error)}. The private safe copy was retained for inspection.`,
          };
        }
        this.records.set(taskId, record);
        if (record.view.status === 'failed') await this.persistRecord(record);
      } catch {
        await rm(taskRoot, { recursive: true, force: true });
      }
    }
    this.visibleTaskId = this.visibleRecord()?.view.taskId ?? null;
    await rm(join(this.options.basePath, 'latest.json'), { force: true }).catch(() => undefined);
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

function isTaskId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertTaskRecord(raw: TaskRecord, taskId: string): void {
  if (
    raw.version !== 4 ||
    raw.view?.taskId !== taskId ||
    typeof raw.view.createdAt !== 'number' ||
    typeof raw.rootPath !== 'string' ||
    raw.view.rootName !== basename(raw.rootPath) ||
    raw.view.displayPath !== raw.rootPath ||
    !(
      raw.view.helperBuddyId === undefined ||
      (typeof raw.view.helperBuddyId === 'string' &&
        validateHelperBuddyId(raw.view.helperBuddyId) === raw.view.helperBuddyId)
    ) ||
    !Array.isArray(raw.stagedRoots) ||
    !raw.stagedRoots.every(
      (value) => typeof value === 'string' && validateRelativePath(value) === value,
    ) ||
    !(
      raw.presentationFile === null ||
      (typeof raw.presentationFile === 'string' &&
        validateRelativePath(raw.presentationFile) === raw.presentationFile)
    )
  ) {
    throw new Error('unsupported task record');
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

function validateHelperBuddyId(value: string): string {
  if (typeof value !== 'string') throw new Error('helper buddy id must be a string');
  const id = value.trim();
  if (!id || id !== value || id.length > 200 || id.includes('\0'))
    throw new Error('helper buddy id is invalid');
  return id;
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

const UNSAFE_PRESENTATION_EXTENSIONS = new Set([
  '.action',
  '.app',
  '.applescript',
  '.command',
  '.dmg',
  '.inetloc',
  '.iso',
  '.jar',
  '.mobileconfig',
  '.pkg',
  '.scpt',
  '.terminal',
  '.url',
  '.webloc',
  '.workflow',
]);

function isSafePresentationFile(path: string, mode: number): boolean {
  if ((mode & 0o111) !== 0) return false;
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 || !UNSAFE_PRESENTATION_EXTENSIONS.has(name.slice(dot));
}

function assertSafePresentationFile(
  path: string,
  entry: Awaited<ReturnType<typeof inspectManifestEntry>>,
): asserts entry is NonNullable<typeof entry> & { type: 'file' } {
  if (entry?.type !== 'file')
    throw new Error(`the presentation path must be a regular file: ${path}`);
  if (!isSafePresentationFile(path, entry.mode))
    throw new Error(`the presentation file must be non-executable and safe to open: ${path}`);
}
