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

describe.runIf(process.platform === 'darwin')('macOS filesystem execution', () => {
  it('gives filesystem agents only staged shell tools, never web or browser tools', () => {
    expect(agentToolDefinitions(false, true)).toEqual([
      expect.objectContaining({ type: 'function', name: 'run_shell' }),
      expect.objectContaining({ type: 'function', name: 'stage_paths' }),
      expect.objectContaining({ type: 'function', name: 'run_staged_shell' }),
      expect.objectContaining({ type: 'function', name: 'workspace_changes' }),
    ]);
  });

  it('uses read-only source shell plus lazy staging, publishes reviewed changes, and undoes them', async () => {
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
      'printf attempted > existing.txt 2>/dev/null || true; cat existing.txt',
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
    const escaped = await service.runStagedShell(
      prepared.taskId,
      `printf unsafe > '${join(outer, 'escape.txt')}'`,
      '.',
      controller.signal,
    );
    expect(escaped.exitCode).not.toBe(0);
    await expect(readFile(join(outer, 'escape.txt'), 'utf8')).rejects.toThrow();

    const summary: AgentSummary = {
      id: 'agent-test',
      task: 'update the sample files',
      status: 'done',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      maxSteps: null,
      steps: [],
      summary: 'updated the sample files',
      spoken: false,
      unseen: true,
    };
    expect(await service.completeAgent(summary)).toBe(true);
    expect(service.state()?.status).toBe('review');
    expect(service.state()?.changes.map((change) => `${change.kind}:${change.path}`)).toEqual([
      'created:created/new.txt',
      'deleted:deleted.txt',
      'modified:existing.txt',
    ]);

    const published = await service.publish(prepared.taskId);
    expect(published.status).toBe('published');
    expect(published.canUndo).toBe(true);
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

  it('refuses publication when the selected folder changed after staging', async () => {
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
    await service.completeAgent({
      id: 'agent-conflict',
      task: 'change the document',
      status: 'done',
      createdAt: Date.now(),
      finishedAt: Date.now(),
      maxSteps: null,
      steps: [],
      spoken: false,
      unseen: true,
    });
    await writeFile(join(root, 'document.txt'), 'newer human edit');

    await expect(service.publish(task.taskId)).rejects.toThrow('changed while Buddy was working');
    expect(await readFile(join(root, 'document.txt'), 'utf8')).toBe('newer human edit');
  });

  it('rejects writes outside explicitly staged paths', async () => {
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
      maxSteps: null,
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
