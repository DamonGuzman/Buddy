import { describe, expect, it } from 'vitest';
import {
  isClearlyMalformedApiKey,
  sessionRejectedApiKey,
} from '../src/renderer/panel/components/settings/api-key-feedback';

describe('OpenAI API-key settings feedback', () => {
  it('rejects prose, placeholders, truncation, and embedded whitespace', () => {
    for (const value of ['not a key', 'sk-…', 'sk-short', 'sk-valid prefix with spaces']) {
      expect(isClearlyMalformedApiKey(value)).toBe(true);
    }
    expect(isClearlyMalformedApiKey('  sk-project-credential-1234567890  ')).toBe(false);
  });

  it('recognizes secret-safe auth failures but not unrelated session errors', () => {
    const status = (error: string) => ({
      state: 'error' as const,
      model: 'gpt-realtime-2.1',
      usingMockServer: false,
      error,
    });
    expect(sessionRejectedApiKey(status('openai rejected the api key (invalid_api_key)'))).toBe(
      true,
    );
    expect(sessionRejectedApiKey(status('Unexpected server response: 401'))).toBe(true);
    expect(sessionRejectedApiKey(status('openai error (authentication_error)'))).toBe(true);
    expect(sessionRejectedApiKey(status('connection timed out'))).toBe(false);
    expect(sessionRejectedApiKey(null)).toBe(false);
  });
});
