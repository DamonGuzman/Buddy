import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS,
  HelperBuddyRunner,
} from '../src/main/agents/helper-buddy';
import { HelperBuddyMemoryStore } from '../src/main/agents/helper-buddy-memory-store';
import { helperBuddyToolDefinitions, findHelperBuddyTool } from '../src/main/agents/tools';
import type {
  HelperBuddyBackend,
  HelperBuddyBackendRequest,
  HelperBuddyBackendResult,
  HelperBuddyBrief,
  HelperBuddyToolContext,
} from '../src/main/agents/types';
import {
  createTestHelperBuddyBrowser,
  createTestHelperBuddyFilesystem,
  TEST_FILESYSTEM_BRIEF,
} from './support/helper-buddy-capabilities';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function memoryStore(): Promise<HelperBuddyMemoryStore> {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-helper-memories-'));
  cleanup.push(directory);
  const store = new HelperBuddyMemoryStore(directory);
  await store.initialize();
  return store;
}

function brief(): HelperBuddyBrief {
  return {
    id: 'memory-helper',
    userRequest: 'use the release checklist memory',
    task: 'use the release checklist memory',
    recentTranscript: '',
    createdAt: 1,
    filesystem: TEST_FILESYSTEM_BRIEF,
  };
}

describe('helper buddy memory', () => {
  it('gives helper buddies an explicitly named durable-memory save and exclusion policy', () => {
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain('helper-buddy memory policy');
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain('future helper buddies');
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain('explicit user preferences');
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain(
      'exact names, terminology, capitalization, or framing',
    );
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain('user corrections and guidance');
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain('decisions the user has made');
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain('recently completed work');
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain(
      'do not call memory_save after every task',
    );
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain(
      'do not save secrets, passwords, api keys, tokens',
    );
    expect(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS).toContain(
      'update the existing memory with the same purpose',
    );
  });

  it('atomically saves standalone Markdown, lists metadata, loads content, replaces, and deletes', async () => {
    const store = await memoryStore();
    const saved = await store.save({
      name: 'Release checklist',
      usage: 'Load before preparing or verifying a production release.',
      content: '# Checks\n\n- Run tests\n- Verify the artifact',
    });

    expect(saved.path.startsWith(`${store.directory}/`)).toBe(true);
    expect(saved.fileName).toMatch(/^release-checklist-[a-f0-9]{24}\.md$/);
    expect(await store.list()).toEqual([saved]);
    const markdown = await readFile(saved.path, 'utf8');
    if (process.platform !== 'win32') expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(markdown).toContain('<memory_name>Release checklist</memory_name>');
    expect(markdown).toContain(
      '<memory_usage>Load before preparing or verifying a production release.</memory_usage>',
    );
    expect(markdown).toContain('<!-- buddy-helper-memory-content -->\n\n# Checks');
    await expect(store.load('release CHECKLIST')).resolves.toBe(markdown);

    await store.save({
      name: 'Release checklist',
      usage: 'Load before every release operation.',
      content: 'Updated instructions.',
    });
    await expect(store.load('release checklist')).resolves.toContain('Updated instructions.');
    expect(await store.list()).toEqual([
      expect.objectContaining({
        name: 'Release checklist',
        usage: 'Load before every release operation.',
      }),
    ]);

    await store.delete('RELEASE CHECKLIST');
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.load('Release checklist')).rejects.toThrow('memory not found');
  });

  it('uses safe deterministic filenames and escapes metadata without changing Markdown content', async () => {
    const store = await memoryStore();
    const saved = await store.save({
      name: '../Deploy <prod> & verify',
      usage: 'Use when <production> needs a safe & exact deployment check.',
      content: 'Keep `<xml>` and **Markdown** unchanged.',
    });
    expect(saved.fileName).toMatch(/^deploy-prod-verify-[a-f0-9]{24}\.md$/);
    expect(saved.path.startsWith(`${store.directory}/`)).toBe(true);
    const markdown = await store.load('../Deploy <prod> & verify');
    expect(markdown).toContain('<memory_name>../Deploy &lt;prod&gt; &amp; verify</memory_name>');
    expect(markdown).toContain('Keep `<xml>` and **Markdown** unchanged.');
  });

  it('fails fast on malformed Markdown in the dedicated memories directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-malformed-memory-'));
    cleanup.push(directory);
    await writeFile(join(directory, 'broken.md'), '# not a Buddy memory\n', 'utf8');
    const store = new HelperBuddyMemoryStore(directory);
    await expect(store.initialize()).rejects.toThrow('invalid helper memory format: broken.md');
    await expect(store.list()).rejects.toThrow('not initialized');
  });

  it('registers save/load/delete on the unified helper tool surface', () => {
    const memoryDefinitions = helperBuddyToolDefinitions().filter((tool) =>
      tool.name.startsWith('memory_'),
    );
    expect(memoryDefinitions.map((tool) => tool.name)).toEqual([
      'memory_save',
      'memory_load',
      'memory_delete',
    ]);
    const save = memoryDefinitions[0]!;
    expect(save.parameters['required']).toEqual(['name', 'usage', 'content', 'description']);
  });

  it('executes all three tools against the durable store', async () => {
    const memory = await memoryStore();
    const context: HelperBuddyToolContext = {
      brief: brief(),
      signal: new AbortController().signal,
      scratchpad: { get: () => '', set: () => undefined, append: () => undefined },
      addSource: () => undefined,
      memory,
      browser: {
        execute: async () => ({ output: '{}' }),
        requestUser: async () => ({ output: '{}' }),
        dispose: async () => undefined,
      },
      filesystem: createTestHelperBuddyFilesystem(),
    };
    await expect(
      findHelperBuddyTool('memory_save')!.execute(
        {
          name: 'Project conventions',
          usage: 'Load before editing this project.',
          content: 'Use strict TypeScript.',
        },
        context,
      ),
    ).resolves.toContain('"saved":true');
    await expect(
      findHelperBuddyTool('memory_load')!.execute({ name: 'Project conventions' }, context),
    ).resolves.toContain('Use strict TypeScript.');
    await expect(
      findHelperBuddyTool('memory_delete')!.execute({ name: 'Project conventions' }, context),
    ).resolves.toBe('{"deleted":true,"name":"Project conventions"}');
  });

  it('gives a new helper metadata only, then returns full Markdown on demand', async () => {
    const memory = await memoryStore();
    await memory.save({
      name: 'Release checklist',
      usage: 'Load before release work.',
      content: 'SECRET_FULL_MEMORY_CONTENT',
    });
    const requests: HelperBuddyBackendRequest[] = [];
    const backend: HelperBuddyBackend = {
      isReady: () => true,
      async request(request): Promise<HelperBuddyBackendResult> {
        requests.push(request);
        if (requests.length === 1) {
          return {
            ok: true,
            outputItems: [
              {
                type: 'function_call',
                call_id: 'load-memory',
                name: 'memory_load',
                arguments: JSON.stringify({
                  description: 'loading the release checklist',
                  name: 'Release checklist',
                }),
              },
            ],
            text: '',
            functionCalls: [
              {
                callId: 'load-memory',
                name: 'memory_load',
                argsJson: JSON.stringify({
                  description: 'loading the release checklist',
                  name: 'Release checklist',
                }),
              },
            ],
            searchQueries: [],
            citations: [],
            usedPercent: null,
          };
        }
        return {
          ok: true,
          outputItems: [],
          text: 'used the relevant release memory',
          functionCalls: [],
          searchQueries: [],
          citations: [],
          usedPercent: null,
        };
      },
    };

    const summary = await new HelperBuddyRunner({
      brief: brief(),
      backend,
      memory,
      browser: createTestHelperBuddyBrowser(),
      filesystem: createTestHelperBuddyFilesystem(),
      onUpdate: vi.fn(),
    }).run();

    const initialInput = JSON.stringify(requests[0]!.input);
    expect(requests[0]!.instructions).toContain(HELPER_BUDDY_MEMORY_POLICY_INSTRUCTIONS);
    expect(initialInput).toContain('<memory_name>Release checklist</memory_name>');
    expect(initialInput).toContain('<memory_usage>Load before release work.</memory_usage>');
    expect(initialInput).toContain(`<memory_directory>${memory.directory}</memory_directory>`);
    expect(initialInput).not.toContain('SECRET_FULL_MEMORY_CONTENT');
    expect(JSON.stringify(requests[1]!.input)).toContain('SECRET_FULL_MEMORY_CONTENT');
    expect(summary).toMatchObject({ status: 'done', summary: 'used the relevant release memory' });
  });
});
