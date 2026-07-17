import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemTaskService } from '../src/main/filesystem/service';
import { agentToolDefinitions } from '../src/main/agents/tools';
import type { AgentSummary } from '../src/shared/types';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'darwin')('macOS host filesystem execution', () => {
  it('gives filesystem agents every Firecrawl endpoint plus staged shell tools, never browser tools', () => {
    expect(agentToolDefinitions(false, true)).toEqual([
      expect.objectContaining({ type: 'function', name: 'web_search' }),
      expect.objectContaining({ type: 'function', name: 'web_scrape' }),
      expect.objectContaining({ type: 'function', name: 'web_map' }),
      expect.objectContaining({ type: 'function', name: 'web_crawl' }),
      expect.objectContaining({ type: 'function', name: 'web_batch_scrape' }),
      expect.objectContaining({ type: 'function', name: 'web_research' }),
      expect.objectContaining({ type: 'function', name: 'run_shell' }),
      expect.objectContaining({ type: 'function', name: 'stage_paths' }),
      expect.objectContaining({ type: 'function', name: 'run_staged_shell' }),
      expect.objectContaining({ type: 'function', name: 'workspace_changes' }),
      expect.objectContaining({ type: 'function', name: 'present_file' }),
    ]);
    expect(agentToolDefinitions(false, true).map((tool) => tool.name)).not.toContain(
      'browser_navigate',
    );
  });

  it('runs source and staged commands with unrestricted host filesystem access', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-host-shell-test-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    await mkdir(root);
    const service = new FilesystemTaskService({
      basePath: join(outer, 'private'),
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const task = await service.prepare(grant.id, 'verify direct host execution');
    const sourceEscape = join(outer, 'source-host-write.txt');
    const stagedEscape = join(outer, 'staged-host-write.txt');
    const signal = new AbortController().signal;

    const sourceResult = await service.runShell(
      task.taskId,
      `printf source > ${shellQuote(sourceEscape)}; printf %s "$BUDDY_EXECUTION_MODE"`,
      '.',
      signal,
    );
    const stagedResult = await service.runStagedShell(
      task.taskId,
      `printf staged > ${shellQuote(stagedEscape)}`,
      '.',
      signal,
    );

    expect(sourceResult).toMatchObject({ exitCode: 0, stdout: 'host' });
    expect(stagedResult.exitCode).toBe(0);
    expect(await readFile(sourceEscape, 'utf8')).toBe('source');
    expect(await readFile(stagedEscape, 'utf8')).toBe('staged');
    await service.cancelPending(task.taskId);
  });

  it('preserves terminating signals and explains macOS signed-parent launch failures', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-signal-test-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    await mkdir(root);
    const service = new FilesystemTaskService({
      basePath: join(outer, 'private'),
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const task = await service.prepare(grant.id, 'verify signal diagnostics');

    const result = await service.runShell(
      task.taskId,
      'kill -KILL $$',
      '.',
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      exitCode: 137,
      terminationSignal: 'SIGKILL',
      stdout: '',
      stderr: '',
    });
    expect(result.diagnostic).toContain('do not retry the same command unchanged');
    expect(result.diagnostic).toContain('signed-parent launch constraint');
    expect(result.diagnostic).toContain('Contents/MacOS');
    await service.cancelPending(task.taskId);
  });

  it('runs and auto-publishes independent filesystem helpers without a concurrency limit', async () => {
    const outer = await realpath(
      await mkdtemp(join(homedir(), '.buddy-parallel-filesystem-test-')),
    );
    cleanup.push(outer);
    const root = join(outer, 'selected');
    await mkdir(root);
    const service = new FilesystemTaskService({
      basePath: join(outer, 'private'),
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const [first, second] = await Promise.all([
      service.prepare(grant.id, 'create the first report'),
      service.prepare(grant.id, 'create the second report'),
    ]);
    await Promise.all([
      service.attachAgent(first.taskId, 'agent-first'),
      service.attachAgent(second.taskId, 'agent-second'),
    ]);
    await Promise.all([
      service.stagePaths(first.taskId, ['first.md']),
      service.stagePaths(second.taskId, ['second.md']),
    ]);
    await Promise.all([
      service.runStagedShell(
        first.taskId,
        "printf '# first\\n' > first.md",
        '.',
        new AbortController().signal,
      ),
      service.runStagedShell(
        second.taskId,
        "printf '# second\\n' > second.md",
        '.',
        new AbortController().signal,
      ),
    ]);

    const [firstCompletion, secondCompletion] = await Promise.all([
      service.completeAgent(doneSummary('agent-first', 'create the first report')),
      service.completeAgent(doneSummary('agent-second', 'create the second report')),
    ]);

    expect(firstCompletion.view).toMatchObject({ status: 'published', canUndo: true });
    expect(secondCompletion.view).toMatchObject({ status: 'published', canUndo: true });
    expect(
      service
        .states()
        .map((task) => task.taskId)
        .sort(),
    ).toEqual([first.taskId, second.taskId].sort());
    expect(service.state(first.taskId)).toMatchObject({ status: 'published', canUndo: true });
    expect(service.state(second.taskId)).toMatchObject({ status: 'published', canUndo: true });
    expect(await readFile(join(root, 'first.md'), 'utf8')).toBe('# first\n');
    expect(await readFile(join(root, 'second.md'), 'utf8')).toBe('# second\n');

    await service.undo(first.taskId);
    await service.keep(second.taskId);
    expect(service.state(first.taskId)).toBeNull();
    expect(service.state(second.taskId)).toBeNull();
    await expect(readFile(join(root, 'first.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(root, 'second.md'), 'utf8')).toBe('# second\n');
  });

  it('recovers every independent task record after restart instead of only the latest task', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-task-recovery-test-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    const privateData = join(outer, 'private');
    await mkdir(root);
    const service = new FilesystemTaskService({
      basePath: privateData,
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const first = await service.prepare(grant.id, 'first persistent task');
    const second = await service.prepare(grant.id, 'second persistent task');
    await service.attachAgent(first.taskId, 'agent-persist-first');
    await service.attachAgent(second.taskId, 'agent-persist-second');

    const restarted = new FilesystemTaskService({
      basePath: privateData,
      onState: () => {},
      onSelection: () => {},
    });
    await restarted.initialize();

    expect(restarted.state(first.taskId)).toMatchObject({
      taskId: first.taskId,
      status: 'failed',
    });
    expect(restarted.state(second.taskId)).toMatchObject({
      taskId: second.taskId,
      status: 'failed',
    });
  });

  it('publishes on completion, returns the selected presentation file, and retains verified Undo', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-filesystem-test-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    const privateData = join(outer, 'private');
    await mkdir(root);
    await writeFile(join(root, 'existing.txt'), 'before\n');
    await writeFile(join(root, 'deleted.txt'), 'remove me\n');

    const service = new FilesystemTaskService({
      basePath: privateData,
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const prepared = await service.prepare(grant.id, 'update the sample files');
    await service.attachAgent(prepared.taskId, 'agent-test');

    const controller = new AbortController();
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before\n');
    const inspected = await service.runShell(
      prepared.taskId,
      'cat existing.txt',
      '.',
      controller.signal,
    );
    expect(inspected.stdout).toBe('before\n');
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before\n');

    await service.stagePaths(prepared.taskId, ['existing.txt', 'deleted.txt', 'created/new.txt']);
    const result = await service.runStagedShell(
      prepared.taskId,
      "printf 'after\\n' > existing.txt; rm deleted.txt; mkdir -p created; printf 'new\\n' > created/new.txt",
      '.',
      controller.signal,
    );
    expect(result.exitCode).toBe(0);
    await expect(service.presentFile(prepared.taskId, 'created')).rejects.toThrow(
      'stage the presentation file',
    );
    await expect(service.presentFile(prepared.taskId, '../escape.txt')).rejects.toThrow(
      'escapes the selected folder',
    );
    await service.runStagedShell(
      prepared.taskId,
      'chmod +x created/new.txt',
      '.',
      controller.signal,
    );
    await expect(service.presentFile(prepared.taskId, 'created/new.txt')).rejects.toThrow(
      'non-executable and safe to open',
    );
    await service.runStagedShell(
      prepared.taskId,
      'chmod -x created/new.txt',
      '.',
      controller.signal,
    );
    await service.presentFile(prepared.taskId, 'created/new.txt');

    const summary: AgentSummary = {
      id: 'agent-test',
      task: 'update the sample files',
      status: 'done',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      steps: [],
      summary: 'updated the sample files',
      spoken: false,
      unseen: true,
    };
    const completion = await service.completeAgent(summary);
    expect(completion).toMatchObject({
      handled: true,
      error: null,
      presentation: { kind: 'file', path: join(root, 'created/new.txt') },
      view: { status: 'published', canUndo: true },
    });
    expect(service.state()?.status).toBe('published');
    expect(() => service.retainedWorkspacePath(prepared.taskId)).toThrow(
      'only a failed task has a safe copy to inspect',
    );
    expect(service.state()?.changes.map((change) => `${change.kind}:${change.path}`)).toEqual([
      'created:created/new.txt',
      'deleted:deleted.txt',
      'modified:existing.txt',
    ]);
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('after\n');
    expect(await readFile(join(root, 'created/new.txt'), 'utf8')).toBe('new\n');
    await expect(readFile(join(root, 'deleted.txt'), 'utf8')).rejects.toThrow();

    const undone = await service.undo(prepared.taskId);
    expect(undone.status).toBe('undone');
    expect(service.state()).toBeNull();
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before\n');
    expect(await readFile(join(root, 'deleted.txt'), 'utf8')).toBe('remove me\n');
    await expect(readFile(join(root, 'created/new.txt'), 'utf8')).rejects.toThrow();

    const restarted = new FilesystemTaskService({
      basePath: privateData,
      onState: () => {},
      onSelection: () => {},
    });
    await restarted.initialize();
    expect(restarted.activeSelection()?.displayPath).toBe(root);
    await restarted.clearGrant();
    expect(restarted.activeSelection()).toBeNull();
  });

  it('opens the sole changed regular file when the helper does not select one explicitly', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-filesystem-fallback-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    await mkdir(root);
    const service = new FilesystemTaskService({
      basePath: join(outer, 'private'),
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const task = await service.prepare(grant.id, 'create the finished report');
    await service.attachAgent(task.taskId, 'agent-fallback');
    await service.stagePaths(task.taskId, ['report.md']);
    await service.runStagedShell(
      task.taskId,
      "printf '# finished\\n' > report.md",
      '.',
      new AbortController().signal,
    );

    const completion = await service.completeAgent({
      id: 'agent-fallback',
      task: 'create the finished report',
      status: 'done',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      steps: [],
      spoken: false,
      unseen: true,
    });

    expect(completion.presentation).toEqual({ kind: 'file', path: join(root, 'report.md') });
    expect(await readFile(join(root, 'report.md'), 'utf8')).toBe('# finished\n');
  });

  it('stops the automatic handoff when the selected folder changed during the run', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-filesystem-conflict-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    await mkdir(root);
    await writeFile(join(root, 'document.txt'), 'baseline');
    const service = new FilesystemTaskService({
      basePath: join(outer, 'private'),
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const task = await service.prepare(grant.id, 'change the document');
    await service.attachAgent(task.taskId, 'agent-conflict');
    await service.stagePaths(task.taskId, ['document.txt']);
    await service.runStagedShell(
      task.taskId,
      'printf staged > document.txt',
      '.',
      new AbortController().signal,
    );
    await writeFile(join(root, 'document.txt'), 'newer human edit');

    const completion = await service.completeAgent({
      id: 'agent-conflict',
      task: 'change the document',
      status: 'done',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      steps: [],
      spoken: false,
      unseen: true,
    });
    expect(completion.handled).toBe(true);
    expect(completion.error).toContain('changed while Buddy was working');
    expect(completion.presentation).toBeNull();
    expect(service.state()?.status).toBe('failed');
    expect(service.retainedWorkspacePath(task.taskId)).toBe(
      join(outer, 'private', 'tasks', task.taskId, 'workspace'),
    );
    expect(await readFile(join(root, 'document.txt'), 'utf8')).toBe('newer human edit');
  });

  it('rejects unstaged workspace changes at publication', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-filesystem-scope-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    await mkdir(root);
    const service = new FilesystemTaskService({
      basePath: join(outer, 'private'),
      onState: () => {},
      onSelection: () => {},
    });
    await service.initialize();
    const grant = await service.grant(root);
    const task = await service.prepare(grant.id, 'create one file');
    await service.attachAgent(task.taskId, 'agent-scope');
    await service.stagePaths(task.taskId, ['allowed/result.txt']);
    await service.runStagedShell(
      task.taskId,
      'mkdir -p allowed; printf allowed > allowed/result.txt; printf denied > surprise.txt',
      '.',
      new AbortController().signal,
    );

    await service.completeAgent({
      id: 'agent-scope',
      task: 'create one file',
      status: 'done',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      steps: [],
      spoken: false,
      unseen: true,
    });
    expect(service.state()?.status).toBe('failed');
    expect(service.state()?.error).toContain('stage a path before creating or modifying it');
    await expect(readFile(join(root, 'allowed/result.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(root, 'surprise.txt'), 'utf8')).rejects.toThrow();
  });

  it('does not traverse the project at prepare time and cancels stale tasks idempotently', async () => {
    const outer = await realpath(await mkdtemp(join(homedir(), '.buddy-filesystem-recovery-')));
    cleanup.push(outer);
    const root = join(outer, 'selected');
    const privateData = join(outer, 'private');
    const socketPath = join(root, 'unsupported.socket');
    await mkdir(root);
    const server = createServer();
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolvePromise);
    });

    try {
      const service = new FilesystemTaskService({
        basePath: privateData,
        onState: () => {},
        onSelection: () => {},
      });
      await service.initialize();
      const grant = await service.grant(root);
      const prepared = await service.prepare(grant.id, 'inspect this folder');
      expect(prepared.status).toBe('running');
      await expect(service.stagePaths(prepared.taskId, ['unsupported.socket'])).rejects.toThrow(
        'unsupported filesystem object',
      );
      await service.cancelPending(prepared.taskId);
      await expect(service.cancelPending(prepared.taskId)).resolves.toBeUndefined();
      expect(service.state()).toBeNull();
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function doneSummary(id: string, task: string): AgentSummary {
  return {
    id,
    task,
    status: 'done',
    createdAt: Date.now(),
    finishedAt: Date.now(),
    steps: [],
    spoken: false,
    unseen: true,
  };
}
