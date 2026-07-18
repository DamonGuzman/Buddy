import { asRecord } from '../../util/guards';
import type { HelperBuddyToolDefinition } from '../types';

export const TOOL_ACTIVITY_DESCRIPTION_MIN_CHARS = 3;
export const TOOL_ACTIVITY_DESCRIPTION_MAX_CHARS = 120;
export const TOOL_ACTIVITY_DESCRIPTION_MIN_WORDS = 3;
export const TOOL_ACTIVITY_DESCRIPTION_MAX_WORDS = 12;

const ACTIVITY_DESCRIPTION_SCHEMA = {
  type: 'string',
  minLength: TOOL_ACTIVITY_DESCRIPTION_MIN_CHARS,
  maxLength: TOOL_ACTIVITY_DESCRIPTION_MAX_CHARS,
  description:
    'Required progress update for non-technical people. In 3–12 simple words, say only what you are doing now, such as "checking the project files" or "opening the account settings". Avoid tool names, code, commands, URLs, jargon, reasons, and future work.',
};

type FunctionToolDefinition = Extract<HelperBuddyToolDefinition, { type: 'function' }>;

/**
 * Add the user-facing activity field at the registry boundary so every current
 * and future helper function tool receives the same required contract.
 */
export function withActivityDescription(
  definition: FunctionToolDefinition,
): FunctionToolDefinition {
  const parameters = asRecord(definition.parameters);
  if (!parameters || parameters['type'] !== 'object')
    throw new Error(`helper tool ${definition.name} must use an object parameter schema`);
  const properties = asRecord(parameters['properties']);
  if (!properties)
    throw new Error(`helper tool ${definition.name} must declare parameter properties`);
  if (Object.hasOwn(properties, 'description'))
    throw new Error(`helper tool ${definition.name} must not declare its own description field`);

  const rawRequired = parameters['required'];
  if (
    rawRequired !== undefined &&
    (!Array.isArray(rawRequired) || rawRequired.some((value) => typeof value !== 'string'))
  ) {
    throw new Error(`helper tool ${definition.name} has an invalid required-fields schema`);
  }
  const required = rawRequired === undefined ? [] : (rawRequired as string[]);

  return {
    ...definition,
    parameters: {
      ...parameters,
      properties: { description: ACTIVITY_DESCRIPTION_SCHEMA, ...properties },
      required: [...required, 'description'],
    },
  };
}

export type ActivityDescriptionResult =
  { ok: true; description: string } | { ok: false; error: string };

/** Reject malformed progress copy before the helper tool can perform work. */
export function readActivityDescription(args: Record<string, unknown>): ActivityDescriptionResult {
  const raw = args['description'];
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error:
        'description is required and must briefly explain the current action in plain language',
    };
  }
  const description = raw.replace(/\s+/g, ' ').trim();
  if (description.length < TOOL_ACTIVITY_DESCRIPTION_MIN_CHARS) {
    return {
      ok: false,
      error: `description must be at least ${TOOL_ACTIVITY_DESCRIPTION_MIN_CHARS} characters`,
    };
  }
  if (description.length > TOOL_ACTIVITY_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      error: `description must be at most ${TOOL_ACTIVITY_DESCRIPTION_MAX_CHARS} characters`,
    };
  }
  const words = description.split(' ');
  if (
    words.length < TOOL_ACTIVITY_DESCRIPTION_MIN_WORDS ||
    words.length > TOOL_ACTIVITY_DESCRIPTION_MAX_WORDS
  ) {
    return {
      ok: false,
      error: `description must use ${TOOL_ACTIVITY_DESCRIPTION_MIN_WORDS} to ${TOOL_ACTIVITY_DESCRIPTION_MAX_WORDS} simple words`,
    };
  }
  if (/\b(?:https?:\/\/|www\.)/i.test(description)) {
    return { ok: false, error: 'description must not include a URL' };
  }
  return { ok: true, description };
}
