/**
 * M11: error catalog + classifier unit tests (pure module — no Electron).
 *
 * Covers: the classifyError mapping table (server codes, HTTP-rejected
 * upgrades, network errno strings, handshake timeout, interrupted turns),
 * per-kind surface/auto-show policy, copy interpolation (model), the
 * NotAllowedError mic variant, and the unclassified fallback shape.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_SHOW_KINDS,
  classifyError,
  describeKind,
  singleLine,
  withErrorCode,
} from '../src/main/errors';
import type { ErrorKind } from '../src/main/errors';

const ALL_KINDS: ErrorKind[] = [
  'no_api_key',
  'api_key_rejected',
  'api_key_unreadable',
  'insufficient_quota',
  'rate_limited',
  'model_unavailable',
  'network_unreachable',
  'response_interrupted',
  'response_incomplete',
  'server_error',
  'mic_unavailable',
  'audio_output_failed',
  'capture_failed',
  'hotkey_dead',
  'hold_too_long',
  'settings_reset',
  'renderer_dead',
];

describe('error catalog (describeKind)', () => {
  it('covers every kind with non-empty complete copy (no fallback prefix)', () => {
    for (const kind of ALL_KINDS) {
      const pres = describeKind(kind);
      expect(pres.kind).toBe(kind);
      expect(pres.message.length).toBeGreaterThan(20);
      // Catalog copy is complete — never re-prefixed.
      expect(pres.message.startsWith('something went wrong')).toBe(false);
      // Lowercase clicky voice.
      expect(pres.message[0]).toBe(pres.message[0]?.toLowerCase());
      expect(pres.surfaces.length).toBeGreaterThan(0);
    }
  });

  it('auto-shows the panel ONLY for actionable kinds', () => {
    expect([...AUTO_SHOW_KINDS].sort()).toEqual(
      [
        'no_api_key',
        'api_key_rejected',
        'api_key_unreadable',
        'insufficient_quota',
        'model_unavailable',
        'mic_unavailable',
        'audio_output_failed',
        // Fix items 1 and 6 explicitly add these two actionable kinds.
        'hotkey_dead',
        'settings_reset',
      ].sort(),
    );
    for (const kind of ALL_KINDS) {
      expect(describeKind(kind).autoShowPanel).toBe(AUTO_SHOW_KINDS.includes(kind));
    }
  });

  it('routes each kind to its surfaces (transcript everywhere except renderer_dead)', () => {
    for (const kind of ALL_KINDS) {
      const { surfaces } = describeKind(kind);
      if (kind === 'renderer_dead') {
        expect(surfaces).toEqual(['tray']);
      } else {
        expect(surfaces).toContain('transcript');
      }
    }
    expect(describeKind('hotkey_dead').surfaces).toContain('tray');
    expect(describeKind('hold_too_long').surfaces).toContain('caption');
    expect(describeKind('capture_failed').surfaces).toContain('caption');
    expect(describeKind('audio_output_failed').surfaces).toContain('caption');
    // Informational — never flips the assistant to the error state.
    expect(describeKind('response_incomplete').surfaces).not.toContain('pill');
    expect(describeKind('capture_failed').surfaces).not.toContain('pill');
  });

  it('interpolates the model into model_unavailable copy', () => {
    const pres = describeKind('model_unavailable', { model: 'gpt-realtime-2.1' });
    expect(pres.message).toBe(
      "your openai account can't use gpt-realtime-2.1 yet — try switching models in " +
        'settings, or check your account tier.',
    );
    expect(describeKind('model_unavailable').message).toContain('this model');
  });

  it('mic_unavailable leads with the privacy toggle for NotAllowedError', () => {
    const denied = describeKind('mic_unavailable', { micErrorName: 'NotAllowedError' });
    expect(denied.message).toBe(
      'windows is blocking desktop apps from using the microphone — flip it on in ' +
        "settings > privacy > microphone and i'll hear you. typing works meanwhile.",
    );
    const generic = describeKind('mic_unavailable', { micErrorName: 'NotFoundError' });
    expect(generic.message).toContain("check it's plugged in");
  });

  it('keeps the quota copy verbatim', () => {
    expect(describeKind('insufficient_quota').message).toBe(
      'openai says your account is out of credit — add credits at platform.openai.com/billing',
    );
  });
});

describe('classifyError mapping table', () => {
  const table: Array<[unknown, ErrorKind | 'unknown']> = [
    // -- key problems ------------------------------------------------------
    [new Error('no API key configured'), 'no_api_key'],
    [withErrorCode(new Error('Invalid API key provided'), 'invalid_api_key'), 'api_key_rejected'],
    [new Error('openai error: Incorrect API key provided (invalid_api_key)'), 'api_key_rejected'],
    [new Error('Unexpected server response: 401'), 'api_key_rejected'],
    // -- quota -------------------------------------------------------------
    [
      withErrorCode(new Error('You exceeded your current quota'), 'insufficient_quota'),
      'insufficient_quota',
    ],
    [new Error('connection closed during handshake (code 1013: insufficient_quota)'),
      'insufficient_quota'],
    // -- model access ------------------------------------------------------
    [withErrorCode(new Error('The model does not exist'), 'model_not_found'), 'model_unavailable'],
    [new Error('Unexpected server response: 403'), 'model_unavailable'],
    [new Error('Unexpected server response: 404'), 'model_unavailable'],
    [new Error('Project proj_x does not have access to model gpt-realtime-2.1'),
      'model_unavailable'],
    // -- rate limiting -----------------------------------------------------
    [withErrorCode(new Error('Rate limit reached'), 'rate_limit_exceeded'), 'rate_limited'],
    [new Error('Unexpected server response: 429'), 'rate_limited'],
    // -- network -----------------------------------------------------------
    [new Error('getaddrinfo ENOTFOUND api.openai.com'), 'network_unreachable'],
    [new Error('getaddrinfo EAI_AGAIN api.openai.com'), 'network_unreachable'],
    [new Error('connect ECONNREFUSED 127.0.0.1:443'), 'network_unreachable'],
    [new Error('connect ETIMEDOUT 1.2.3.4:443'), 'network_unreachable'],
    [new Error('realtime handshake timed out after 10000ms'), 'network_unreachable'],
    // -- interrupted / server-side ------------------------------------------
    [new Error('the response was interrupted'), 'response_interrupted'],
    [withErrorCode(new Error('The server had an error'), 'server_error'), 'server_error'],
    [new Error('Unexpected server response: 500'), 'server_error'],
    // -- unclassified --------------------------------------------------------
    [new Error('mock scenario error (you asked for one)'), 'unknown'],
    ['a plain string failure', 'unknown'],
  ];

  it.each(table.map(([err, kind]) => [kind, err] as const))(
    'maps to %s',
    (kind, err) => {
      expect(classifyError(err).kind).toBe(kind);
    },
  );

  it('unclassified fallback keeps `something went wrong: <single line>`', () => {
    const pres = classifyError(new Error('weird\n  multi-line\nfailure'));
    expect(pres.kind).toBe('unknown');
    expect(pres.message).toBe('something went wrong: weird multi-line failure');
    // Still surfaced (never a wordless flash), but never auto-shows.
    expect(pres.surfaces).toContain('transcript');
    expect(pres.autoShowPanel).toBe(false);
  });

  it('classified results carry the catalog presentation', () => {
    const pres = classifyError(new Error('Unexpected server response: 429'));
    expect(pres.message).toBe(
      'openai is asking us to slow down a little — give it a few seconds and try again.',
    );
    expect(pres.surfaces).toContain('pill');
  });

  it('passes the model param through classification', () => {
    const pres = classifyError(new Error('Unexpected server response: 404'), {
      model: 'gpt-realtime-2.1-mini',
    });
    expect(pres.message).toContain('gpt-realtime-2.1-mini');
  });
});

describe('helpers', () => {
  it('singleLine collapses whitespace', () => {
    expect(singleLine('  a\n b\t\tc ')).toBe('a b c');
  });

  it('withErrorCode attaches only real codes', () => {
    const err = new Error('x');
    expect((withErrorCode(err, null) as { code?: string }).code).toBeUndefined();
    expect((withErrorCode(err, '') as { code?: string }).code).toBeUndefined();
    expect((withErrorCode(err, 'server_error') as { code?: string }).code).toBe('server_error');
  });
});
