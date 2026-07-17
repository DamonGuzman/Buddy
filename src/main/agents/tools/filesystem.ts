import type { AgentToolSpec } from '../types';

export const filesystemTools: AgentToolSpec[] = [
  {
    definition: {
      type: 'function',
      name: 'run_shell',
      description:
        "Run ordinary host macOS zsh with the selected folder as cwd. It has the Buddy user account's filesystem permissions and is not mechanically read-only. Use it only for ls, rg, git status, inspection, and checks that do not write project files; use stage_paths and run_staged_shell for edits.",
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'A zsh script. Shell startup files are disabled. A terminationSignal or exit 137 is a hard failure; do not retry the same command unchanged or hide it with `|| true`.',
          },
          cwd: {
            type: 'string',
            description:
              'Selected-folder-relative working directory. Use "." unless a subdirectory is needed.',
          },
        },
        required: ['script'],
        additionalProperties: false,
      },
    },
    timeoutMs: 125_000,
    stepKind: 'shell',
    async execute(args, ctx) {
      if (!ctx.filesystem || !ctx.brief.filesystem)
        throw new Error('filesystem access was not granted for this task');
      const script = typeof args['script'] === 'string' ? args['script'] : '';
      const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : '.';
      const result = await ctx.filesystem.runShell(
        ctx.brief.filesystem.taskId,
        script,
        cwd,
        ctx.signal,
      );
      return JSON.stringify(result);
    },
  },
  {
    definition: {
      type: 'function',
      name: 'stage_paths',
      description:
        'Copy only the specific files or small directories you intend to change into Buddy\'s private staging area. Never stage "." or the whole project. New paths may be listed before they exist.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 100,
            description: 'Exact selected-folder-relative file or directory paths.',
          },
        },
        required: ['paths'],
        additionalProperties: false,
      },
    },
    timeoutMs: 125_000,
    stepKind: 'file',
    async execute(args, ctx) {
      if (!ctx.filesystem || !ctx.brief.filesystem)
        throw new Error('filesystem access was not granted for this task');
      const paths = Array.isArray(args['paths'])
        ? args['paths'].filter((value): value is string => typeof value === 'string')
        : [];
      return ctx.filesystem.stagePaths(ctx.brief.filesystem.taskId, paths);
    },
  },
  {
    definition: {
      type: 'function',
      name: 'run_staged_shell',
      description:
        'Run ordinary host macOS zsh inside the sparse private staging area after calling stage_paths. Only staged paths are initially present. Use this workflow for edits so Buddy can verify, publish, and retain Undo; the process itself is not OS-sandboxed.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description:
              'A zsh script. Shell startup files are disabled. A terminationSignal or exit 137 is a hard failure; do not retry the same command unchanged or hide it with `|| true`.',
          },
          cwd: {
            type: 'string',
            description: 'Staging-area-relative working directory. Use "." by default.',
          },
        },
        required: ['script'],
        additionalProperties: false,
      },
    },
    timeoutMs: 125_000,
    stepKind: 'shell',
    async execute(args, ctx) {
      if (!ctx.filesystem || !ctx.brief.filesystem)
        throw new Error('filesystem access was not granted for this task');
      const script = typeof args['script'] === 'string' ? args['script'] : '';
      const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : '.';
      return JSON.stringify(
        await ctx.filesystem.runStagedShell(ctx.brief.filesystem.taskId, script, cwd, ctx.signal),
      );
    },
  },
  {
    definition: {
      type: 'function',
      name: 'workspace_changes',
      description:
        'List the files currently changed in the sparse staging area compared with the selected folder.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    timeoutMs: 30_000,
    stepKind: 'file',
    async execute(_args, ctx) {
      if (!ctx.filesystem || !ctx.brief.filesystem)
        throw new Error('filesystem access was not granted for this task');
      return ctx.filesystem.describeChanges(ctx.brief.filesystem.taskId);
    },
  },
  {
    definition: {
      type: 'function',
      name: 'present_file',
      description:
        'Choose the single finished, non-executable regular file Buddy should open for the user after the staged transaction is verified and committed. Call this after validation and workspace_changes. If several files changed, choose the primary user-facing artifact.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Exact selected-folder-relative path of the finished file to present.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    timeoutMs: 30_000,
    stepKind: 'file',
    async execute(args, ctx) {
      if (!ctx.filesystem || !ctx.brief.filesystem)
        throw new Error('filesystem access was not granted for this task');
      const path = typeof args['path'] === 'string' ? args['path'] : '';
      return ctx.filesystem.presentFile(ctx.brief.filesystem.taskId, path);
    },
  },
];
