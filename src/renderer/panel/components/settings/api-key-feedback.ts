import { normalizeOpenAiApiKey } from '../../../../shared/api-key';
import type { SessionStatus } from '../../../../shared/types';

export const INVALID_KEY_COPY =
  'that does not look like a complete OpenAI API key — paste the full key beginning with sk-.';
export const REJECTED_KEY_COPY =
  'openai rejected this key — paste a replacement, or create one at platform.openai.com.';

export function isClearlyMalformedApiKey(value: string): boolean {
  return normalizeOpenAiApiKey(value) === null;
}

export function sessionRejectedApiKey(session: SessionStatus | null): boolean {
  if (session?.state !== 'error' || !session.error) return false;
  return /invalid_api_key|authentication_error|incorrect api key|rejected (?:the )?api key|\b401\b/i.test(
    session.error,
  );
}
