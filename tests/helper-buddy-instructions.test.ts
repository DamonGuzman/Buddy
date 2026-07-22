import { describe, expect, it } from 'vitest';
import {
  HELPER_BUDDY_INSTRUCTIONS,
  HELPER_BUDDY_PROMPT_MAX_BYTES,
  parseHelperBuddyInstructions,
} from '../src/main/agents/helper-buddy-instructions';

describe('helper buddy instructions', () => {
  it('loads the checked-in Markdown prompt as the runtime instruction source', () => {
    expect(HELPER_BUDDY_INSTRUCTIONS).toContain(
      'you are a background helper buddy working for buddy',
    );
    expect(HELPER_BUDDY_INSTRUCTIONS).toContain('## browser');
    expect(HELPER_BUDDY_INSTRUCTIONS).toContain('## filesystem');
    expect(HELPER_BUDDY_INSTRUCTIONS).not.toMatch(/^\s|\s$/);
  });

  it('normalizes line endings and surrounding whitespace', () => {
    expect(parseHelperBuddyInstructions('  first\r\n\rsecond  \n')).toBe('first\n\nsecond');
  });

  it('fails fast for empty, null-containing, and oversized prompts', () => {
    expect(() => parseHelperBuddyInstructions(' \n ')).toThrow('empty');
    expect(() => parseHelperBuddyInstructions('before\0after')).toThrow('null byte');
    expect(() =>
      parseHelperBuddyInstructions('x'.repeat(HELPER_BUDDY_PROMPT_MAX_BYTES + 1)),
    ).toThrow('exceeds');
  });
});
