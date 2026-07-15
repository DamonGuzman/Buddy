import { asFiniteNumber } from '../../util/guards';
import { AGENT_TOOL_TIMEOUT_MS } from '../config';
import type { AgentToolSpec } from '../types';

const JUSTIFICATION_MAX = 1_000;
const LABEL_MAX = 200;
const TEXT_MAX = 10_000;

function justification(args: Record<string, unknown>): string {
  const value = typeof args['justification'] === 'string' ? args['justification'].trim() : '';
  return value.slice(0, JUSTIFICATION_MAX);
}

function browserSpec(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  stepLabel: (args: Record<string, unknown>) => string,
  stepKind: AgentToolSpec['stepKind'] = 'action',
): AgentToolSpec {
  return {
    definition: {
      type: 'function',
      name,
      description,
      parameters: {
        type: 'object',
        properties: {
          ...properties,
          justification: {
            type: 'string',
            description:
              'One honest, specific sentence explaining why this action serves the user task.',
          },
        },
        required: [...required, 'justification'],
        additionalProperties: false,
      },
    },
    timeoutMs: AGENT_TOOL_TIMEOUT_MS,
    stepKind,
    stepLabel,
    async execute(args, ctx) {
      if (!ctx.browser)
        return JSON.stringify({ error: 'browser use was not granted for this task' });
      if (!justification(args)) return JSON.stringify({ error: 'justification is required' });
      return (await ctx.browser.execute(name, args)).output;
    },
  };
}

export const browserNavigateTool = browserSpec(
  'browser_navigate',
  'Navigate the buddy browser to an http or https URL. This is one action.',
  { url: { type: 'string' } },
  ['url'],
  (args) => `navigated to ${safeUrlLabel(args['url'])}`,
  'browse',
);

export const browserClickTool = browserSpec(
  'browser_click',
  'Click a visible target in the most recent buddy-browser screenshot. Coordinates are screenshot pixels.',
  {
    x: { type: 'number' },
    y: { type: 'number' },
    label: { type: 'string' },
    button: { type: 'string', enum: ['left'] },
    count: { type: 'integer', enum: [1, 2] },
  },
  ['x', 'y', 'label'],
  (args) => `clicked ${stringArg(args['label']).slice(0, LABEL_MAX) || 'a browser target'}`,
);

export const browserTypeTool = browserSpec(
  'browser_type',
  'Type literal Unicode text into the visibly focused field. This is one action.',
  { text: { type: 'string', maxLength: TEXT_MAX } },
  ['text'],
  () => 'typed into the focused browser field',
);

export const browserPressKeysTool = browserSpec(
  'browser_press_keys',
  'Press one key or chord in the buddy browser, for example ["ENTER"] or ["CTRL","L"]. This is one action.',
  { keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
  ['keys'],
  (args) => `pressed ${stringArray(args['keys']).join('+').slice(0, 100) || 'browser keys'}`,
);

export const browserScrollTool = browserSpec(
  'browser_scroll',
  'Scroll the buddy browser at a visible point. Positive dy scrolls down. This is one action.',
  { x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' } },
  ['x', 'y', 'dy'],
  () => 'scrolled the buddy browser',
  'browse',
);

export const browserScreenshotTool = browserSpec(
  'browser_screenshot',
  'Capture a fresh observation of the buddy browser without taking an action.',
  {},
  [],
  () => 'inspected the buddy browser',
  'browse',
);

export const needsUserTool: AgentToolSpec = {
  definition: {
    type: 'function',
    name: 'needs_user',
    description:
      'Park this browser task when a person must handle sign-in, CAPTCHA, OAuth consent, or another explicitly human-only step.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        action_text: { type: 'string' },
        justification: { type: 'string' },
      },
      required: ['reason', 'justification'],
      additionalProperties: false,
    },
  },
  stepKind: 'review',
  stepLabel: (args) => `needs you: ${stringArg(args['reason']).slice(0, 160)}`,
  async execute(args, ctx) {
    if (!ctx.browser) return JSON.stringify({ error: 'browser use was not granted for this task' });
    if (!justification(args)) return JSON.stringify({ error: 'justification is required' });
    return (await ctx.browser.requestUser(args)).output;
  },
};

export const browserTools: AgentToolSpec[] = [
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserPressKeysTool,
  browserScrollTool,
  browserScreenshotTool,
  needsUserTool,
];

export const BROWSER_ACTION_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_press_keys',
  'browser_scroll',
]);
const BROWSER_TOOL_NAMES = new Set(browserTools.map((tool) => tool.definition.name));

export function isBrowserActionTool(name: string): boolean {
  return BROWSER_ACTION_TOOL_NAMES.has(name);
}

export function isBrowserTool(name: string): boolean {
  return BROWSER_TOOL_NAMES.has(name);
}

export function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === 'string')
    ? value
    : [];
}

export function finiteArg(value: unknown): number | null {
  return asFiniteNumber(value);
}

function safeUrlLabel(value: unknown): string {
  const raw = stringArg(value);
  try {
    return new URL(raw).hostname || 'a browser page';
  } catch {
    return 'a browser page';
  }
}
