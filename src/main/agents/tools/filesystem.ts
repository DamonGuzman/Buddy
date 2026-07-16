import type { AgentToolSpec } from '../types';

export const filesystemTools: AgentToolSpec[] = [
  {
    definition: {
      type: 'function',
      name: 'run_shell',
      description:
        'Run real macOS zsh with the selected folder as cwd. This shell is mechanically READ-ONLY for the selected folder; use it for ls, rg, git status, inspection, and checks that do not write project files. Network and unrelated paths are denied.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'A zsh script. Shell startup files are disabled.',
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
    stepLabel: (args) => {
      const script = typeof args['script'] === 'string' ? args['script'].trim() : '';
      const firstLine = script.split('\n', 1)[0] ?? '';
      return `ran ${firstLine.slice(0, 100) || 'a shell command'}`;
    },
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
    stepLabel: (args) => {
      const count = Array.isArray(args['paths']) ? args['paths'].length : 0;
      return `staged ${count} path${count === 1 ? '' : 's'} for editing`;
    },
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
        'Run writable macOS zsh inside the sparse private staging area after calling stage_paths. Only staged paths are initially present. The selected folder remains read-only and unchanged until review and Apply.',
      parameters: {
        type: 'object',
        properties: {
          script: {
            type: 'string',
            description: 'A zsh script. Shell startup files are disabled.',
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
    stepLabel: (args) => {
      const script = typeof args['script'] === 'string' ? args['script'].trim() : '';
      const firstLine = script.split('\n', 1)[0] ?? '';
      return `edited staging with ${firstLine.slice(0, 90) || 'a shell command'}`;
    },
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
    stepLabel: () => 'reviewed staged file changes',
    async execute(_args, ctx) {
      if (!ctx.filesystem || !ctx.brief.filesystem)
        throw new Error('filesystem access was not granted for this task');
      return ctx.filesystem.describeChanges(ctx.brief.filesystem.taskId);
    },
  },
];
