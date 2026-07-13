/**
 * M11: the error catalog + classifier — the single place that decides what a
 * failure is called, what clicky SAYS about it, where the copy shows up, and
 * whether the panel auto-surfaces for it.
 *
 * PURE module: no Electron imports, no side effects — unit-tested in
 * tests/errors.test.ts. Consumers:
 * - conversation.failTurn (turn-start/commit failures),
 * - the conversation's session 'error' listener (mid-session server events),
 * - index.ts boot wiring (hotkey_dead, hold_too_long, renderer_dead, crash
 *   logging tooltips),
 * - settings/mic/playback reporting paths (api_key_unreadable,
 *   mic_unavailable, audio_output_failed, settings_reset).
 *
 * Copy rules (lowercase clicky voice): every catalog line says what happened
 * AND what to do next. Catalog copy is COMPLETE — never prefix it with
 * "something went wrong:". Only the unclassified fallback keeps the
 * `something went wrong: <detail>` shape.
 *
 * Surfaces:
 * - 'transcript' — a system entry in the panel transcript (main's ring).
 * - 'pill'       — the assistant error state (panel state pill + overlay
 *                  indicator flash via setState('error')).
 * - 'caption'    — an overlay caption bubble (for failures that happen while
 *                  the user is looking at the screen, not the panel).
 * - 'tray'       — tray tooltip/balloon (for failures where the panel itself
 *                  may be unavailable).
 *
 * autoShowPanel: the panel surfaces itself AT MOST ONCE PER KIND per app run
 * (windows/panel.ts showPanelOnce), and only for kinds the user can act on.
 * Per the M11 audit, that set is: no_api_key, api_key_rejected,
 * api_key_unreadable, insufficient_quota, model_unavailable, mic_unavailable,
 * audio_output_failed — plus hotkey_dead and settings_reset, whose fix items
 * explicitly call for a one-time auto-show (both are actionable: switch to
 * typing / re-paste the key).
 */

export type ErrorKind =
  | 'no_api_key'
  | 'api_key_rejected'
  | 'api_key_unreadable'
  | 'insufficient_quota'
  | 'rate_limited'
  | 'model_unavailable'
  | 'network_unreachable'
  | 'response_interrupted'
  | 'response_incomplete'
  | 'server_error'
  | 'mic_unavailable'
  | 'audio_output_failed'
  | 'capture_failed'
  | 'codex_plan_limit'
  | 'hotkey_dead'
  | 'hold_too_long'
  | 'settings_reset'
  | 'renderer_dead';

export type ErrorSurface = 'transcript' | 'pill' | 'caption' | 'tray';

/** What to show for one concrete failure. `kind: 'unknown'` = fallback line. */
export interface ErrorPresentation {
  kind: ErrorKind | 'unknown';
  /** Final user-facing copy — complete, never re-prefixed. */
  message: string;
  surfaces: readonly ErrorSurface[];
  /** Show the panel (once per kind per run) so the copy is actually seen. */
  autoShowPanel: boolean;
}

/** Optional context for copy interpolation / variant selection. */
export interface ErrorParams {
  /** Model id, for model_unavailable ("...can't use <model> yet..."). */
  model?: string;
  /** DOMException name from the renderer mic report (NotAllowedError, ...). */
  micErrorName?: string;
}

interface CatalogEntry {
  copy: string;
  surfaces: readonly ErrorSurface[];
  autoShowPanel: boolean;
}

const MIC_BLOCKED_COPY =
  "windows is blocking desktop apps from using the microphone — flip it on in " +
  "settings > privacy > microphone and i'll hear you. typing works meanwhile.";

const CATALOG: Record<ErrorKind, CatalogEntry> = {
  no_api_key: {
    copy: "i don't have an openai api key yet — add one in settings and i'm all ears.",
    surfaces: ['transcript', 'pill'],
    autoShowPanel: true,
  },
  api_key_rejected: {
    copy:
      "openai didn't accept your api key — double-check it in settings, or make a fresh " +
      'one at platform.openai.com.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: true,
  },
  api_key_unreadable: {
    copy:
      "windows changed its keys and clicky can't unlock your saved api key anymore — " +
      "paste it again in settings and you're set.",
    surfaces: ['transcript', 'pill'],
    autoShowPanel: true,
  },
  insufficient_quota: {
    // Verbatim from the earlier quota hotfix — do not reword.
    copy: 'openai says your account is out of credit — add credits at platform.openai.com/billing',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: true,
  },
  rate_limited: {
    copy: 'openai is asking us to slow down a little — give it a few seconds and try again.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: false,
  },
  model_unavailable: {
    copy:
      "your openai account can't use <model> yet — try switching models in settings, " +
      'or check your account tier.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: true,
  },
  network_unreachable: {
    copy:
      "i can't reach openai right now — is the internet up? i'll try again on your " +
      'next question.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: false,
  },
  response_interrupted: {
    copy: "we got cut off mid-answer — ask me again and i'll pick it back up.",
    surfaces: ['transcript', 'pill'],
    autoShowPanel: false,
  },
  response_incomplete: {
    // Not an error state: the answer landed, just truncated.
    copy: '(i got cut off there — ask me to keep going.)',
    surfaces: ['transcript'],
    autoShowPanel: false,
  },
  server_error: {
    copy: 'openai hiccuped on their end — one more try usually does it.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: false,
  },
  mic_unavailable: {
    copy:
      "i couldn't hear your mic. check it's plugged in — and that windows lets " +
      'desktop apps use the microphone (settings > privacy > microphone). typing works meanwhile.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: true,
  },
  audio_output_failed: {
    copy:
      "i can't reach your speakers right now — my answers are all here in the panel " +
      'until sound comes back.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
  },
  capture_failed: {
    copy:
      "heads up — i couldn't grab your screen this time, so i'm answering blind. " +
      'try once more?',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: false,
  },
  // M17 (integration): the ChatGPT-plan grounding quota is spent. We FAIL
  // CLOSED — the metered api key is NOT spent for that pointer; clicky flies
  // the raw model point and says so. Actionable (try later / add a key), so it
  // auto-shows the panel once. Caption too: it happens while the user is
  // looking at the screen, not the panel.
  codex_plan_limit: {
    copy:
      "you've hit your chatgpt plan limit for now — i'll point from memory. try again " +
      'later, or add an openai key in settings.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
  },
  hotkey_dead: {
    copy:
      "clicky couldn't grab the push-to-talk keys (windows blocked the keyboard hook). " +
      'typing down below still works — a restart usually brings the hotkey back.',
    surfaces: ['transcript', 'tray'],
    autoShowPanel: true,
  },
  hold_too_long: {
    copy:
      'whoa, that was a long one — i can only listen about 30 seconds per hold. let go ' +
      'sooner and ask in parts.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: false,
  },
  settings_reset: {
    copy:
      "your settings file was scrambled, so i started fresh — you'll need to paste your " +
      'api key again.',
    surfaces: ['transcript'],
    autoShowPanel: true,
  },
  renderer_dead: {
    copy: "clicky hit a snag it couldn't fix — a restart will patch things up.",
    surfaces: ['tray'],
    autoShowPanel: false,
  },
};

/** Kinds that auto-show the panel (exported for the policy unit test). */
export const AUTO_SHOW_KINDS: readonly ErrorKind[] = (Object.keys(CATALOG) as ErrorKind[]).filter(
  (k) => CATALOG[k].autoShowPanel,
);

/** Catalog lookup with copy interpolation / variant selection. */
export function describeKind(kind: ErrorKind, params?: ErrorParams): ErrorPresentation {
  const entry = CATALOG[kind];
  let message = entry.copy;
  if (kind === 'model_unavailable') {
    message = message.replace('<model>', params?.model ?? 'this model');
  }
  if (kind === 'mic_unavailable' && params?.micErrorName === 'NotAllowedError') {
    // Permission denial: lead with the windows privacy toggle.
    message = MIC_BLOCKED_COPY;
  }
  return { kind, message, surfaces: entry.surfaces, autoShowPanel: entry.autoShowPanel };
}

/**
 * Classify an arbitrary error (turn failure / mid-session server event) into
 * a catalog kind. Pure — looks only at the error's message and, when present,
 * a `code` property (the session attaches the server error code / type).
 *
 * Unclassified errors fall back to `something went wrong: <single line>` —
 * still surfaced in the transcript (never a wordless red flash).
 */
export function classifyError(err: unknown, params?: ErrorParams): ErrorPresentation {
  const message = err instanceof Error ? err.message : String(err);
  const msg = message.toLowerCase();
  const code =
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';
  // ws rejected-upgrade errors look like "Unexpected server response: 401".
  const statusMatch = /unexpected server response: (\d{3})/.exec(msg);
  const httpStatus = statusMatch !== null ? Number(statusMatch[1]) : 0;

  let kind: ErrorKind | null = null;
  if (code === 'insufficient_quota' || msg.includes('insufficient_quota')) {
    kind = 'insufficient_quota';
  } else if (msg.includes('no api key configured')) {
    kind = 'no_api_key';
  } else if (
    code === 'invalid_api_key' ||
    msg.includes('invalid_api_key') ||
    msg.includes('incorrect api key') ||
    httpStatus === 401
  ) {
    kind = 'api_key_rejected';
  } else if (
    code === 'model_not_found' ||
    msg.includes('model_not_found') ||
    msg.includes('does not have access to model') ||
    httpStatus === 403 ||
    httpStatus === 404
  ) {
    kind = 'model_unavailable';
  } else if (code === 'rate_limit_exceeded' || /rate.?limit/.test(msg) || httpStatus === 429) {
    kind = 'rate_limited';
  } else if (
    /\b(enotfound|eai_again|econnrefused|etimedout|econnreset|ehostunreach|enetunreach)\b/.test(
      msg,
    ) ||
    msg.includes('handshake timed out')
  ) {
    kind = 'network_unreachable';
  } else if (msg.includes('the response was interrupted')) {
    kind = 'response_interrupted';
  } else if (code === 'server_error' || msg.includes('server_error') || httpStatus >= 500) {
    kind = 'server_error';
  }

  if (kind !== null) return describeKind(kind, params);
  return {
    kind: 'unknown',
    message: `something went wrong: ${singleLine(message)}`,
    surfaces: ['transcript', 'pill'],
    autoShowPanel: false,
  };
}

/** Collapse whitespace/newlines so a raw error stays a one-line transcript entry. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Attach a server error code to an Error so classifyError can use it. */
export function withErrorCode(err: Error, code: string | null | undefined): Error {
  if (typeof code === 'string' && code.length > 0) {
    (err as Error & { code?: string }).code = code;
  }
  return err;
}
