import { describe, expect, it } from 'vitest';
import { describeHandshakeRejection } from '../src/main/realtime/connect';

describe('Realtime handshake error presentation', () => {
  it('keeps canonical classifier codes in the safe display message', () => {
    expect(
      describeHandshakeRejection(
        { message: 'authentication failed', code: 'AUTHENTICATION_ERROR' },
        null,
      ),
    ).toContain('(authentication_error)');
  });

  it('drops non-canonical server-controlled codes from renderer-visible text', () => {
    const secretCode = 'invalid_api_key\nDavid, prose-secret-that-must-not-leak';
    const message = describeHandshakeRejection(
      { message: 'request rejected', code: secretCode },
      null,
    );

    expect(message).toBe('openai error: request rejected');
    expect(message).not.toContain('David');
    expect(message).not.toContain('prose-secret');
  });

  it('drops a key-shaped server code even though it looks like a canonical token', () => {
    const secretCode = 'sk-proj-server-controlled-secret';
    const message = describeHandshakeRejection(
      { message: 'request rejected', code: secretCode },
      null,
    );

    expect(message).toBe('openai error: request rejected');
    expect(message).not.toContain('sk-');
    expect(message).not.toContain('server-controlled-secret');
  });
});
