import { asFiniteNumber } from '../../util/guards';
import { HELPER_BUDDY_TOOL_TIMEOUT_MS } from '../helper-buddy-config';
import type { HelperBuddyToolSpec } from '../types';

const JUSTIFICATION_MAX = 1_000;
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
  stepKind: HelperBuddyToolSpec['stepKind'] = 'action',
): HelperBuddyToolSpec {
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
    timeoutMs: HELPER_BUDDY_TOOL_TIMEOUT_MS,
    stepKind,
    async execute(args, ctx) {
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
);

export const browserTypeTool = browserSpec(
  'browser_type',
  'Type literal Unicode text into the visibly focused field. This is one action.',
  { text: { type: 'string', maxLength: TEXT_MAX } },
  ['text'],
);

export const browserPressKeysTool = browserSpec(
  'browser_press_keys',
  'Press one key or chord in the buddy browser, for example ["ENTER"] or ["CTRL","L"]. This is one action.',
  { keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 } },
  ['keys'],
);

export const browserScrollTool = browserSpec(
  'browser_scroll',
  'Scroll the buddy browser at a visible point. Positive dy scrolls down. This is one action.',
  { x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' } },
  ['x', 'y', 'dy'],
  'browse',
);

export const browserScreenshotTool = browserSpec(
  'browser_screenshot',
  'Capture a fresh observation of the buddy browser without taking an action.',
  {},
  [],
  'browse',
);

export const needsUserTool: HelperBuddyToolSpec = {
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
  async execute(args, ctx) {
    if (!justification(args)) return JSON.stringify({ error: 'justification is required' });
    return (await ctx.browser.requestUser(args)).output;
  },
};

export const browserTools: HelperBuddyToolSpec[] = [
  browserNavigateTool,
  browserClickTool,
  browserTypeTool,
  browserPressKeysTool,
  browserScrollTool,
  browserScreenshotTool,
  needsUserTool,
];

const BROWSER_TOOL_NAMES = new Set(browserTools.map((tool) => tool.definition.name));

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
