import type { AgentToolSpec } from '../types';

export const filesystemTools: AgentToolSpec[] = [
  {
    definition: {
      type: 'function',
      name: 'run_shell',
      description:
        'Run real macOS zsh in the staged folder workspace. The selected user folder is not changed until the user reviews and applies the staged diff. Network and paths outside the workspace are denied mechanically.',
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
              'Workspace-relative working directory. Use "." unless a subdirectory is needed.',
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
      name: 'workspace_changes',
      description:
        'List the files currently changed in the staged workspace compared with the selected folder.',
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
