import type { ResponseItem } from './types';

const RETAINED_IMAGE_MESSAGES = 2;
const OMITTED_IMAGE_NOTE = '[older browser screenshot omitted; rely on newer observations]';

/**
 * Bound replay size for the store:false backend without disturbing any
 * function_call/function_call_output pair. Only image content parts are
 * compacted; every tool protocol item remains byte-for-byte in order.
 */
export function compactHelperBuddyHistory(
  history: readonly ResponseItem[],
  retainedImageMessages = RETAINED_IMAGE_MESSAGES,
): ResponseItem[] {
  if (!Number.isInteger(retainedImageMessages) || retainedImageMessages < 0)
    throw new Error('retained image message count must be a non-negative integer');

  const imageIndexes: number[] = [];
  for (let index = 0; index < history.length; index += 1) {
    if (hasInputImage(history[index])) imageIndexes.push(index);
  }
  const retain = new Set(
    retainedImageMessages === 0 ? [] : imageIndexes.slice(-retainedImageMessages),
  );

  return history.map((item, index) => {
    if (!hasInputImage(item) || retain.has(index)) return item;
    const content = Array.isArray(item['content']) ? item['content'] : [];
    const compacted: ResponseItem[] = [];
    let insertedNote = false;
    for (const part of content) {
      if (isInputImage(part)) {
        if (!insertedNote) {
          compacted.push({ type: 'input_text', text: OMITTED_IMAGE_NOTE });
          insertedNote = true;
        }
      } else if (isRecord(part)) {
        compacted.push(part);
      }
    }
    return { ...item, content: compacted };
  });
}

function hasInputImage(item: ResponseItem | undefined): boolean {
  return Boolean(
    item && Array.isArray(item['content']) && item['content'].some((part) => isInputImage(part)),
  );
}

function isInputImage(value: unknown): boolean {
  return isRecord(value) && value['type'] === 'input_image';
}

function isRecord(value: unknown): value is ResponseItem {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
