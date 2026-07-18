import type { HelperBuddyToolSpec } from '../types';
import { HELPER_BUDDY_TOOL_TIMEOUT_MS } from '../helper-buddy-config';

export const scratchpadTool: HelperBuddyToolSpec = {
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
  timeoutMs: HELPER_BUDDY_TOOL_TIMEOUT_MS,
  stepKind: 'note',
  async execute(args, ctx) {
    const text = typeof args['text'] === 'string' ? args['text'].slice(0, 20_000) : '';
    if (!text) return JSON.stringify({ error: 'text is required' });
    if (args['append'] === true) ctx.scratchpad.append(text);
    else ctx.scratchpad.set(text);
    return JSON.stringify({ ok: true, characters: ctx.scratchpad.get().length });
  },
};
