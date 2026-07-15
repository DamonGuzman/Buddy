/**
 * M11: error catalog + classifier unit tests (pure module — no Electron).
 *
 * Covers: the classifyError mapping table (server codes, HTTP-rejected
 * upgrades, network errno strings, handshake timeout, interrupted turns),
 * per-kind surface/auto-show policy, copy interpolation (model), the
 * device-specific mic/playback variants, and the unclassified fallback shape.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_SHOW_KINDS,
  ERROR_KINDS,
  classifyError,
  describeKind,
  redactSensitiveErrorText,
  singleLine,
  withErrorCode,
} from '../src/main/errors';
import type { ErrorKind } from '../src/main/errors';

// Derived from the catalog itself — Record<ErrorKind, …> already guarantees
// (at the type level) that every kind has an entry.
const ALL_KINDS: readonly ErrorKind[] = ERROR_KINDS;

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
        'api_access_forbidden',
        'mic_unavailable',
        'audio_output_failed',
        'capture_failed',
        // Fix items 1 and 6 explicitly add these two actionable kinds.
        'hotkey_dead',
        'settings_reset',
        'settings_save_failed',
        // M17 (integration): the fail-closed ChatGPT plan-limit prompt is
        // actionable (try later / add a key), so it auto-shows once.
        'codex_plan_limit',
        // M18 (integration): the two actionable agent-mode gates — connect
        // chatgpt in settings / plan out of agent runs — auto-show once.
        'agent_not_signed_in',
        'agent_quota',
      ].sort(),
    );
    for (const kind of ALL_KINDS) {
      expect(describeKind(kind).autoShowPanel).toBe(AUTO_SHOW_KINDS.includes(kind));
      expect(describeKind(kind).target !== undefined).toBe(AUTO_SHOW_KINDS.includes(kind));
    }
  });

  it('routes actionable errors to the settings card that can repair them', () => {
    for (const kind of [
      'no_api_key',
      'api_key_rejected',
      'api_key_unreadable',
      'insufficient_quota',
      'model_unavailable',
      'api_access_forbidden',
      'settings_reset',
    ] as const) {
      expect(describeKind(kind).target).toBe('openai');
    }
    expect(describeKind('mic_unavailable', { micErrorName: 'NotFoundError' }).target).toBe(
      'microphone',
    );
    expect(describeKind('mic_unavailable', { micErrorName: 'NotAllowedError' }).target).toBe(
      'permissions',
    );
    expect(describeKind('capture_failed').target).toBe('permissions');
    expect(describeKind('hotkey_dead').target).toBe('permissions');
    expect(describeKind('audio_output_failed').target).toBe('voice');
    expect(describeKind('settings_save_failed').target).toBe('settings');
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
    for (const kind of [
      'no_api_key',
      'api_key_rejected',
      'api_key_unreadable',
      'insufficient_quota',
      'model_unavailable',
      'api_access_forbidden',
      'mic_unavailable',
      'hotkey_dead',
      'settings_save_failed',
    ] as const) {
      expect(describeKind(kind).surfaces).toContain('caption');
    }
    for (const kind of ['rate_limited', 'network_unreachable', 'server_error'] as const) {
      expect(describeKind(kind).surfaces).not.toContain('caption');
      expect(describeKind(kind).autoShowPanel).toBe(false);
    }
    // M18: the actionable agent gates caption (they hit while the user is
    // looking at the screen); the run-level failures stay transcript-only.
    expect(describeKind('agent_not_signed_in').surfaces).toEqual(['transcript', 'caption']);
    expect(describeKind('agent_quota').surfaces).toEqual(['transcript', 'caption']);
    expect(describeKind('agent_backend_down').surfaces).toEqual(['transcript']);
    expect(describeKind('agent_timed_out').surfaces).toEqual(['transcript']);
    expect(describeKind('agent_tool_failed').surfaces).toEqual(['transcript']);
    // Informational — never flips the assistant to the error state.
    expect(describeKind('response_incomplete').surfaces).not.toContain('pill');
    expect(describeKind('capture_failed').surfaces).not.toContain('pill');
  });

  it('maps codex_plan_limit to the fail-closed copy (transcript + caption, auto-show)', () => {
    const pres = describeKind('codex_plan_limit');
    expect(pres.kind).toBe('codex_plan_limit');
    expect(pres.message).toBe(
      "you've hit your chatgpt plan limit for now — i'll point from memory. try again " +
        'later, or add an openai key in settings.',
    );
    // Happens while the user is looking at the screen, not just the panel.
    expect(pres.surfaces).toEqual(['transcript', 'caption']);
    // Fail-closed but NOT the assistant error state — the answer still lands.
    expect(pres.surfaces).not.toContain('pill');
    expect(pres.autoShowPanel).toBe(true);
  });

  it('gives macOS hotkey failures concrete permission repair steps', () => {
    const pres = describeKind('hotkey_dead', { macHotkeyPermissions: true });
    expect(pres.message).toContain('settings → permissions');
    expect(pres.message).toContain('accessibility');
    expect(pres.message).toContain('input monitoring');
    expect(pres.message).toContain('reset stale grants');
    expect(pres.message).toContain('recheck automatically');
  });

  it('interpolates the model into model_unavailable copy', () => {
    const pres = describeKind('model_unavailable', { model: 'gpt-realtime-2.1' });
    expect(pres.message).toBe(
      "your openai project can't use gpt-realtime-2.1 — choose another model under settings → " +
        'openai, or grant that project access in the openai platform.',
    );
    expect(describeKind('model_unavailable').message).toContain('this model');
  });

  it('mic_unavailable distinguishes permission, missing, busy, and stale-selection failures', () => {
    const denied = describeKind('mic_unavailable', { micErrorName: 'NotAllowedError' });
    expect(denied.message).toContain('microphone access is off');
    expect(denied.message).toContain('system privacy settings');
    expect(describeKind('mic_unavailable', { micErrorName: 'SecurityError' }).message).toBe(
      denied.message,
    );

    const missing = describeKind('mic_unavailable', { micErrorName: 'NotFoundError' });
    expect(missing.message).toContain("can't find a microphone");
    expect(missing.message).toContain('settings → microphone');

    const busy = describeKind('mic_unavailable', { micErrorName: 'NotReadableError' });
    expect(busy.message).toContain('close any app using it');

    const selection = describeKind('mic_unavailable', { micErrorName: 'OverconstrainedError' });
    expect(selection.message).toContain('choose system default');
  });

  it('covers both billing credit and organization/project limit repairs', () => {
    const copy = describeKind('insufficient_quota').message;
    expect(copy).toContain('billing credit');
    expect(copy).toContain('organization or project limits');
  });
  it('distinguishes missing and blocked audio outputs from internal playback failures', () => {
    const missing = describeKind('audio_output_failed', {
      audioOutputErrorName: 'NotFoundError',
      audioOutputErrorMessage: 'no output device',
    });
    expect(missing.message).toContain("can't find an audio output");
    expect(missing.message).toContain('system sound settings');
    expect(missing.message).toContain('captions');

    const blocked = describeKind('audio_output_failed', {
      audioOutputErrorName: 'NotAllowedError',
      audioOutputErrorMessage: 'permission denied',
    });
    expect(blocked.message).toContain('audio playback could not start');
    expect(blocked.message).toContain('restart buddy');
    expect(blocked.message).not.toContain('allow sound');

    const internal = describeKind('audio_output_failed', {
      audioOutputErrorName: 'TypeError',
      audioOutputErrorMessage: 'worklet failed to load',
    });
    expect(internal.message).toContain('restart buddy');
    expect(internal.message).not.toContain("can't find an audio output");
  });
});

describe('classifyError mapping table', () => {
  const table: Array<[unknown, ErrorKind | 'unknown']> = [
    // -- key problems ------------------------------------------------------
    [new Error('no API key configured'), 'no_api_key'],
    [withErrorCode(new Error('Invalid API key provided'), 'invalid_api_key'), 'api_key_rejected'],
    [new Error('openai error: Incorrect API key provided (invalid_api_key)'), 'api_key_rejected'],
    [new Error('Unexpected server response: 401'), 'api_key_rejected'],
    [withErrorCode(new Error('unauthorized'), 'AUTHENTICATION_ERROR'), 'api_key_rejected'],
    // -- quota -------------------------------------------------------------
    [
      withErrorCode(new Error('You exceeded your current quota'), 'insufficient_quota'),
      'insufficient_quota',
    ],
    [
      new Error('connection closed during handshake (code 1013: insufficient_quota)'),
      'insufficient_quota',
    ],
    [new Error('You exceeded your current quota'), 'insufficient_quota'],
    [
      withErrorCode(new Error('billing stopped'), 'billing_hard_limit_reached'),
      'insufficient_quota',
    ],
    // -- model access ------------------------------------------------------
    [withErrorCode(new Error('The model does not exist'), 'model_not_found'), 'model_unavailable'],
    [new Error('Unexpected server response: 404'), 'model_unavailable'],
    [
      new Error('Project proj_x does not have access to model gpt-realtime-2.1'),
      'model_unavailable',
    ],
    [new Error('Unexpected server response: 403'), 'api_access_forbidden'],
    [withErrorCode(new Error('Permission denied'), 'permission_denied'), 'api_access_forbidden'],
    // -- rate limiting -----------------------------------------------------
    [withErrorCode(new Error('Rate limit reached'), 'rate_limit_exceeded'), 'rate_limited'],
    [withErrorCode(new Error('slow down'), 'rate_limit_error'), 'rate_limited'],
    [new Error('Unexpected server response: 429'), 'rate_limited'],
    // -- network -----------------------------------------------------------
    [new Error('getaddrinfo ENOTFOUND api.openai.com'), 'network_unreachable'],
    [new Error('getaddrinfo EAI_AGAIN api.openai.com'), 'network_unreachable'],
    [new Error('connect ECONNREFUSED 127.0.0.1:443'), 'network_unreachable'],
    [new Error('connect ETIMEDOUT 1.2.3.4:443'), 'network_unreachable'],
    [new Error('realtime handshake timed out after 10000ms'), 'network_unreachable'],
    [new Error('socket hang up'), 'network_unreachable'],
    [new Error('TypeError: Failed to fetch'), 'network_unreachable'],
    // -- interrupted / server-side ------------------------------------------
    [new Error('the response was interrupted'), 'response_interrupted'],
    [withErrorCode(new Error('The server had an error'), 'server_error'), 'server_error'],
    [withErrorCode(new Error('The server had an error'), 'INTERNAL_SERVER_ERROR'), 'server_error'],
    [new Error('Unexpected server response: 500'), 'server_error'],
    // -- unclassified --------------------------------------------------------
    [new Error('mock scenario error (you asked for one)'), 'unknown'],
    ['a plain string failure', 'unknown'],
  ];

  it.each(table.map(([err, kind]) => [kind, err] as const))('maps to %s', (kind, err) => {
    expect(classifyError(err).kind).toBe(kind);
  });

  it('unclassified fallback keeps `something went wrong: <single line>`', () => {
    const pres = classifyError(new Error('weird\n  multi-line\nfailure'));
    expect(pres.kind).toBe('unknown');
    expect(pres.message).toBe('something went wrong: weird multi-line failure');
    // Still surfaced (never a wordless flash), but never auto-shows.
    expect(pres.surfaces).toContain('transcript');
    expect(pres.autoShowPanel).toBe(false);
  });

  it('redacts credentials from unclassified fallback copy before it reaches the renderer', () => {
    const pres = classifyError(
      new Error('request failed with Bearer secret-token and key sk-proj-1234567890'),
    );
    expect(pres.kind).toBe('unknown');
    expect(pres.message).toContain('Bearer [redacted]');
    expect(pres.message).toContain('sk-[redacted]');
    expect(pres.message).not.toContain('secret-token');
    expect(pres.message).not.toContain('1234567890');
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

  it('redactSensitiveErrorText removes bearer and OpenAI-style credentials', () => {
    expect(redactSensitiveErrorText('Bearer abc.def sk-live_secret')).toBe(
      'Bearer [redacted] sk-[redacted]',
    );
    expect(
      redactSensitiveErrorText(
        'Incorrect API key provided: David, ***amon. You can find your API key in Settings.',
      ),
    ).toBe('Incorrect API key provided: [redacted]. You can find your API key in Settings.');
    expect(redactSensitiveErrorText('Invalid API key: arbitrary prose credential')).toBe(
      'Invalid API key: [redacted].',
    );
  });
});
