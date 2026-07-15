import type { AgentToolSpec } from '../types';
import { AGENT_TOOL_TIMEOUT_MS } from '../config';

export const readScreenTool: AgentToolSpec = {
  definition: {
    type: 'function',
    name: 'read_screen',
    description:
      'Re-read the screenshot included with the original handoff. It is immutable and no new capture occurs.',
    parameters: { type: 'object', properties: {} },
  },
  timeoutMs: AGENT_TOOL_TIMEOUT_MS,
  stepKind: 'think',
  stepLabel: () => 're-read the handoff screen',
  async execute(_args, ctx) {
    if (!ctx.brief.screenshot)
      return JSON.stringify({ error: 'no handoff screenshot was available' });
    return JSON.stringify({
      ok: true,
      note: 'the original screenshot is attached to the first user message; inspect that image again',
      screen: ctx.brief.screenshot.meta.screenIndex,
      width: ctx.brief.screenshot.meta.imageW,
      height: ctx.brief.screenshot.meta.imageH,
    });
  },
};
