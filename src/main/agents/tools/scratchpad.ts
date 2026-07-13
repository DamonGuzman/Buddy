import type { AgentToolSpec } from '../types';

export const scratchpadTool: AgentToolSpec = {
  definition: {
    type: 'function',
    name: 'scratchpad_write',
    description: 'Save concise private research notes. Use append=true to add to existing notes.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, append: { type: 'boolean' } },
      required: ['text'],
    },
  },
  timeoutMs: 15_000,
  stepKind: 'note',
  stepLabel: () => 'updated private research notes',
  async execute(args, ctx) {
    const text = typeof args['text'] === 'string' ? args['text'].slice(0, 20_000) : '';
    if (!text) return JSON.stringify({ error: 'text is required' });
    if (args['append'] === true) ctx.scratchpad.append(text);
    else ctx.scratchpad.set(text);
    return JSON.stringify({ ok: true, characters: ctx.scratchpad.get().length });
  },
};
