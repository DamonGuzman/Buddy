export const MAX_HELPER_BUDDY_ID_LENGTH = 200;

/** Require one exact, canonical helper-buddy identity at every trust boundary. */
export function requireCanonicalHelperBuddyId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('helper buddy id must be a string');
  if (!value.trim() || value.includes('\0')) throw new Error('helper buddy id is invalid');
  if (value.length > MAX_HELPER_BUDDY_ID_LENGTH)
    throw new Error('helper buddy id exceeds the size limit');
  if (value.trim() !== value)
    throw new Error('helper buddy id must be canonical and not contain surrounding whitespace');
  return value;
}

/** Predicate form for validating persisted or otherwise untrusted records. */
export function isCanonicalHelperBuddyId(value: unknown): value is string {
  try {
    return requireCanonicalHelperBuddyId(value) === value;
  } catch {
    return false;
  }
}
