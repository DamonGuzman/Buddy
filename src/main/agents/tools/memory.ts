import { HELPER_BUDDY_TOOL_TIMEOUT_MS } from '../helper-buddy-config';
import type { HelperBuddyToolSpec } from '../types';

export const memoryTools: HelperBuddyToolSpec[] = [
  {
    definition: {
      type: 'function',
      name: 'memory_save',
      description:
        'Save or replace one durable helper-buddy memory as a Markdown file. Use this only for reusable knowledge that will help future helper buddies, not temporary task notes.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: 'Short, specific name of the memory.',
          },
          usage: {
            type: 'string',
            minLength: 1,
            maxLength: 8000,
            description:
              'Detailed description of exactly when a future helper buddy should load and use this memory.',
          },
          content: {
            type: 'string',
            minLength: 1,
            maxLength: 524288,
            description: 'Complete Markdown content of the durable memory.',
          },
        },
        required: ['name', 'usage', 'content'],
        additionalProperties: false,
      },
    },
    timeoutMs: HELPER_BUDDY_TOOL_TIMEOUT_MS,
    stepKind: 'note',
    async execute(args, ctx) {
      const name = typeof args['name'] === 'string' ? args['name'] : '';
      const usage = typeof args['usage'] === 'string' ? args['usage'] : '';
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      const saved = await ctx.memory.save({ name, usage, content });
      return JSON.stringify({ saved: true, ...saved });
    },
  },
  {
    definition: {
      type: 'function',
      name: 'memory_load',
      description:
        'Load the full Markdown for one relevant helper-buddy memory. Use the metadata catalog first and load only memories whose usage matches the current task.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: 'Exact memory name from the helper-buddy memory catalog.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    timeoutMs: HELPER_BUDDY_TOOL_TIMEOUT_MS,
    stepKind: 'note',
    async execute(args, ctx) {
      const name = typeof args['name'] === 'string' ? args['name'] : '';
      return ctx.memory.load(name);
    },
  },
  {
    definition: {
      type: 'function',
      name: 'memory_delete',
      description:
        'Permanently delete one obsolete or incorrect helper-buddy memory. Delete only when the current task clearly establishes that the memory must no longer be used.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 120,
            description: 'Exact name of the memory to delete.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    timeoutMs: HELPER_BUDDY_TOOL_TIMEOUT_MS,
    stepKind: 'note',
    async execute(args, ctx) {
      const name = typeof args['name'] === 'string' ? args['name'] : '';
      await ctx.memory.delete(name);
      return JSON.stringify({ deleted: true, name: name.trim() });
    },
  },
];
