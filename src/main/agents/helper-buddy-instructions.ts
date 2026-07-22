import promptSource from './helper-buddy-prompt.md?raw';

export const HELPER_BUDDY_PROMPT_MAX_BYTES = 128 * 1024;

/** Validate the checked-in developer-authored prompt before it reaches the model. */
export function parseHelperBuddyInstructions(source: string): string {
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
  if (!normalized) throw new Error('helper buddy prompt is empty');
  if (normalized.includes('\0')) throw new Error('helper buddy prompt contains a null byte');
  if (Buffer.byteLength(normalized, 'utf8') > HELPER_BUDDY_PROMPT_MAX_BYTES) {
    throw new Error(`helper buddy prompt exceeds ${HELPER_BUDDY_PROMPT_MAX_BYTES} bytes`);
  }
  return normalized;
}

export const HELPER_BUDDY_INSTRUCTIONS = parseHelperBuddyInstructions(promptSource);
