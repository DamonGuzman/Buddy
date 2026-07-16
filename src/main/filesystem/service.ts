import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import {
  access,
  chmod,
  chown,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { AgentSummary, FilesystemSelection, FilesystemTaskView } from '../../shared/types';
import type { AgentFilesystemToolPort } from '../agents/types';
import {
  applyManifest,
  buildManifest,
  diffManifests,
  manifestsEqual,
  rendererChanges,
  type TreeManifest,
} from './manifest';
import { MacSeatbeltRunner, type ShellTaskPaths } from './seatbelt-runner';

const MAX_PUBLISH_CHANGES = 5_000;
const MIN_FULL_COPY_HEADROOM = 512 * 1024 * 1024;

interface TaskRecord {
  version: 1;
  rootPath: string;
  taskRoot: string;
  workspacePath: string;
  backupPath: string;
  baselinePath: string;
  stagedPath: string;
  view: FilesystemTaskView;
}

export interface FilesystemTaskServiceOptions {
  basePath: string;
  onState(state: FilesystemTaskView | null): void;
}

/**
 * Owns picker grants, disposable workspaces, the Seatbelt runner, publication, and Undo. No other
 * Buddy module receives an authorized host path or mutates a selected folder.
 */
export class FilesystemTaskService implements AgentFilesystemToolPort {
  private readonly grants = new Map<string, string>();
  private readonly runner: MacSeatbeltRunner;
  private record: TaskRecord | null = null;
  private mutation: Promise<FilesystemTaskView> | null = null;

  constructor(private readonly options: FilesystemTaskServiceOptions) {
    this.runner = new MacSeatbeltRunner(options.basePath);
  }

  async initialize(): Promise<void> {
    await mkdir(this.options.basePath, { recursive: true, mode: 0o700 });
    await this.loadLatest();
    if (!this.record) return;
    const status = this.record.view.status;
    if (status === 'publishing' || status === 'undoing') {
      await this.recoverInterruptedMutation(status);
    } else if (status === 'running' || status === 'preparing') {
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

  async grant(selectedPath: string): Promise<FilesystemSelection> {
    const rootPath = await this.validateSelectedRoot(selectedPath);
    const id = randomUUID();
    this.grants.set(id, rootPath);
    return { id, name: basename(rootPath), displayPath: rootPath };
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
    this.record = {
      version: 1,
      rootPath,
      taskRoot,
      workspacePath,
      backupPath: join(taskRoot, 'before'),
      baselinePath: join(taskRoot, 'baseline.json'),
      stagedPath: join(taskRoot, 'staged.json'),
      view,
    };
    this.emit();
    try {
      await mkdir(taskRoot, { recursive: true, mode: 0o700 });
      const baseline = await buildManifest(rootPath);
      await writeJson(this.record.baselinePath, baseline);
      await cloneTree(rootPath, workspacePath, baseline);
      const paths = this.shellPaths(this.record);
      await this.runner.prepare(paths);
      this.record.view = { ...view, status: 'running' };
      await this.persistRecord();
      await writeJson(join(this.options.basePath, 'latest.json'), { taskId });
      this.emit();
      return cloneView(this.record.view);
    } catch (error) {
      this.record.view = { ...view, status: 'failed', error: errorText(error) };
      await this.persistRecord().catch(() => undefined);
      this.emit();
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

  async completeAgent(summary: AgentSummary): Promise<boolean> {
    const record = this.record;
    if (!record || record.view.agentId !== summary.id) return false;
    if (record.view.status !== 'running') return true;
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
      const [baseline, staged] = await Promise.all([
        readManifest(record.baselinePath),
        buildManifest(record.workspacePath),
      ]);
      await writeJson(record.stagedPath, staged);
      const changes = diffManifests(baseline, staged);
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
    const record = this.requireTask(taskId);
    if (record.view.status !== 'running') throw new Error('the staged workspace is not running');
    return this.runner.run(this.shellPaths(record), script, cwdRelative, signal);
  }

  async describeChanges(taskId: string): Promise<string> {
    const record = this.requireTask(taskId);
    const [baseline, staged] = await Promise.all([
      readManifest(record.baselinePath),
      buildManifest(record.workspacePath),
    ]);
    const changes = rendererChanges(diffManifests(baseline, staged));
    if (changes.length === 0) return 'No staged filesystem changes.';
    return changes
      .slice(0, 200)
      .map((change) => `${change.kind}: ${change.path}`)
      .join('\n');
  }

  publish(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (record.view.status !== 'review')
        throw new Error('this task is not waiting for publication');
      const [baseline, staged, live] = await Promise.all([
        readManifest(record.baselinePath),
        readManifest(record.stagedPath),
        buildManifest(record.rootPath),
      ]);
      if (!manifestsEqual(baseline, live)) {
        throw new Error(
          'The selected folder changed while Buddy was working. Nothing was applied; start a fresh task so those edits are preserved.',
        );
      }
      const changes = diffManifests(baseline, staged);
      if (changes.length > MAX_PUBLISH_CHANGES)
        throw new Error(
          `refusing to publish more than ${MAX_PUBLISH_CHANGES.toLocaleString()} changes at once`,
        );
      if (changes.length === 0) {
        record.view = { ...record.view, status: 'discarded', changes: [], canUndo: false };
        await rm(record.workspacePath, { recursive: true, force: true });
        await this.persistRecord();
        this.emit();
        return cloneView(record.view);
      }

      await cloneTree(record.rootPath, record.backupPath, baseline);
      record.view = { ...record.view, status: 'publishing' };
      await this.persistRecord();
      this.emit();
      try {
        await applyManifest(record.workspacePath, record.rootPath, live, staged, taskId);
        const published = await buildManifest(record.rootPath);
        if (!manifestsEqual(staged, published))
          throw new Error('published files did not match the reviewed workspace');
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
      const [baseline, staged, live] = await Promise.all([
        readManifest(record.baselinePath),
        readManifest(record.stagedPath),
        buildManifest(record.rootPath),
      ]);
      if (!manifestsEqual(staged, live)) {
        throw new Error(
          'The folder changed after Buddy applied its work, so Undo stopped rather than overwrite newer edits.',
        );
      }
      record.view = { ...record.view, status: 'undoing' };
      await this.persistRecord();
      this.emit();
      await applyManifest(record.backupPath, record.rootPath, live, baseline, taskId);
      const restored = await buildManifest(record.rootPath);
      if (!manifestsEqual(baseline, restored))
        throw new Error('Undo verification failed; the recovery snapshot was retained');
      record.view = { ...record.view, status: 'undone', canUndo: false };
      await rm(record.taskRoot, { recursive: true, force: true });
      this.emit();
      return cloneView(record.view);
    });
  }

  discard(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (!['review', 'failed'].includes(record.view.status))
        throw new Error('this task cannot be discarded now');
      record.view = { ...record.view, status: 'discarded', canUndo: false };
      await rm(record.taskRoot, { recursive: true, force: true });
      this.emit();
      return cloneView(record.view);
    });
  }

  keep(taskId: string): Promise<FilesystemTaskView> {
    return this.exclusive(async () => {
      const record = this.requireTask(taskId);
      if (record.view.status !== 'published')
        throw new Error('only published changes can be finalized');
      record.view = { ...record.view, status: 'kept', canUndo: false };
      await rm(record.taskRoot, { recursive: true, force: true });
      this.emit();
      return cloneView(record.view);
    });
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
    const live = await buildManifest(record.rootPath);
    await applyManifest(record.backupPath, record.rootPath, live, baseline, record.view.taskId);
    const restored = await buildManifest(record.rootPath);
    if (!manifestsEqual(baseline, restored)) throw new Error('before-image verification failed');
  }

  private async recoverInterruptedMutation(status: 'publishing' | 'undoing'): Promise<void> {
    const record = this.record;
    if (!record) return;
    const baseline = await readManifest(record.baselinePath);
    await this.restoreBeforeImage(record, baseline);
    const { error: _previousError, ...cleanView } = record.view;
    record.view = {
      ...cleanView,
      status: status === 'undoing' ? 'undone' : 'failed',
      canUndo: false,
      ...(status === 'publishing'
        ? {
            error:
              'Buddy recovered the selected folder after an interrupted publication. No staged changes remain applied.',
          }
        : {}),
    };
    await this.persistRecord();
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

  private async loadLatest(): Promise<void> {
    try {
      const pointer = JSON.parse(
        await readFile(join(this.options.basePath, 'latest.json'), 'utf8'),
      ) as { taskId?: unknown };
      if (typeof pointer.taskId !== 'string') return;
      const raw = JSON.parse(
        await readFile(join(this.options.basePath, 'tasks', pointer.taskId, 'task.json'), 'utf8'),
      ) as TaskRecord;
      if (
        raw.version !== 1 ||
        raw.view?.taskId !== pointer.taskId ||
        typeof raw.rootPath !== 'string'
      )
        return;
      this.record = raw;
    } catch {
      this.record = null;
    }
  }
}

async function cloneTree(
  source: string,
  destination: string,
  manifest: TreeManifest,
): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const cloned = await runFixed('/bin/cp', ['-cR', '-p', `${source}${sep}.`, destination]);
  if (cloned === 0) {
    const root = manifest['.'];
    if (root?.type === 'directory') {
      await chown(destination, root.uid, root.gid);
      await chmod(destination, root.mode);
    }
    return;
  }
  const required = Object.values(manifest).reduce(
    (sum, entry) => sum + (entry.type === 'file' ? entry.size : 0),
    0,
  );
  const volume = await statfs(dirname(destination));
  const free = volume.bavail * volume.bsize;
  if (free < required + MIN_FULL_COPY_HEADROOM)
    throw new Error('there is not enough free disk space to create a recoverable workspace');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const copied = await runFixed('/usr/bin/ditto', [source, destination]);
  if (copied !== 0) throw new Error('could not create the recoverable workspace');
  const root = manifest['.'];
  if (root?.type === 'directory') {
    await chown(destination, root.uid, root.gid);
    await chmod(destination, root.mode);
  }
}

function runFixed(executable: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? 1));
  });
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
