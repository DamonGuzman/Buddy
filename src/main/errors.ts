/**
 * M11: the error catalog + classifier — the single place that decides what a
 * failure is called, what clicky SAYS about it, where the copy shows up, and
 * whether the panel auto-surfaces for it.
 *
 * PURE module: no Electron imports, no side effects — unit-tested in
 * tests/errors.test.ts. Consumers:
 * - conversation.failTurn (turn-start/commit failures),
 * - the conversation's session 'error' listener (mid-session server events),
 * - index.ts boot wiring (hotkey_dead, renderer_dead, crash
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
 * autoShowPanel: the settings window surfaces itself AT MOST ONCE PER KIND per
 * app run (windows/panel.ts showPanelOnce), and only for kinds the user can
 * act on. Actionable failures also use an overlay caption: the old transcript
 * panel no longer exists, so opening Settings must never hide the reason it
 * opened. Transient OpenAI/network failures deliberately remain transcript +
 * pill only and never open Settings or interrupt the user with a caption.
 */

import type {
  ActionableErrorKind,
  ActionableErrorNotice,
  ActionableErrorTarget,
} from '../shared/types';

export type ErrorKind =
  | ActionableErrorKind
  | 'rate_limited'
  | 'network_unreachable'
  | 'response_interrupted'
  | 'response_incomplete'
  | 'server_error'
  | 'renderer_dead'
  // M18 additions (integration-approved): agent mode (docs/AGENT-MODE.md §7).
  | 'agent_backend_down'
  | 'agent_tool_failed';

export type ErrorSurface = 'transcript' | 'pill' | 'caption' | 'tray';

/** What to show for one concrete failure. `kind: 'unknown'` = fallback line. */
export interface ErrorPresentation {
  kind: ErrorKind | 'unknown';
  /** Final user-facing copy — complete, never re-prefixed. */
  message: string;
  surfaces: readonly ErrorSurface[];
  /** Show the panel (once per kind per run) so the copy is actually seen. */
  autoShowPanel: boolean;
  /** Persistent Settings destination for user-repairable failures. */
  target?: ActionableErrorTarget;
}

/** Optional context for copy interpolation / variant selection. */
export interface ErrorParams {
  /** Model id, for model_unavailable ("...can't use <model> yet..."). */
  model?: string;
  /** DOMException name from the renderer mic report (NotAllowedError, ...). */
  micErrorName?: string;
  /** DOMException name/message from the renderer playback report. */
  audioOutputErrorName?: string;
  audioOutputErrorMessage?: string;
  /** Selects macOS-specific repair steps for the global hotkey. */
  macHotkeyPermissions?: boolean;
}

/**
 * Defensive scrub for server/library error text before it reaches logs or a
 * renderer. OpenAI may echo part of a rejected credential in its error copy;
 * classification still uses the original Error, but presentation never does.
 */
export function redactSensitiveErrorText(text: string): string {
  return text
    .replace(
      /((?:incorrect|invalid) api key(?: provided)?:\s*)[\s\S]*?(?=\s*you can find your api key\b|$)/gi,
      '$1[redacted].',
    )
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, 'sk-[redacted]');
}

interface CatalogEntry {
  copy: string;
  surfaces: readonly ErrorSurface[];
  autoShowPanel: boolean;
  /** Per-kind copy interpolation / variant selection (describeKind hook). */
  presentCopy?(copy: string, params: ErrorParams | undefined): string;
}

const ACTIONABLE_SURFACES = ['transcript', 'pill', 'caption'] as const;

/** One exhaustive routing table from catalog kind to its repair destination. */
const ACTIONABLE_TARGET: Record<ActionableErrorKind, ActionableErrorTarget> = {
  no_api_key: 'openai',
  api_key_rejected: 'openai',
  api_key_unreadable: 'openai',
  insufficient_quota: 'openai',
  model_unavailable: 'openai',
  api_access_forbidden: 'openai',
  mic_unavailable: 'microphone',
  audio_output_failed: 'voice',
  capture_failed: 'permissions',
  codex_plan_limit: 'chatgpt',
  hotkey_dead: 'permissions',
  settings_reset: 'openai',
  settings_save_failed: 'settings',
  agent_not_signed_in: 'chatgpt',
  agent_quota: 'chatgpt',
};

/** Convert a catalog presentation into persistent Settings repair state. */
export function actionableErrorNotice(
  presentation: ErrorPresentation,
  occurredAt: number,
): ActionableErrorNotice | null {
  if (presentation.kind === 'unknown' || !presentation.autoShowPanel) return null;
  if (!Object.hasOwn(ACTIONABLE_TARGET, presentation.kind) || presentation.target === undefined) {
    throw new Error(`actionable error kind has no settings target: ${presentation.kind}`);
  }
  const kind = presentation.kind as ActionableErrorKind;
  return {
    kind,
    message: presentation.message,
    target: presentation.target,
    occurredAt,
  };
}

const MIC_PERMISSION_COPY =
  'microphone access is off — allow buddy under system privacy settings, then try the hotkey ' +
  'again. you can type meanwhile.';

const MIC_MISSING_COPY =
  "buddy can't find a microphone — connect or enable one, then choose it under settings → " +
  'microphone. you can type meanwhile.';

const MIC_BUSY_COPY =
  'your microphone is unavailable — close any app using it, or reconnect it, then try again. ' +
  'you can type meanwhile.';

const MIC_SELECTION_COPY =
  "the selected microphone isn't available — choose system default under settings → " +
  'microphone, then try again.';

function presentMicCopy(copy: string, params: ErrorParams | undefined): string {
  switch (params?.micErrorName?.toLowerCase()) {
    case 'notallowederror':
    case 'permissiondeniederror':
    case 'securityerror':
      return MIC_PERMISSION_COPY;
    case 'notfounderror':
    case 'devicesnotfounderror':
      return MIC_MISSING_COPY;
    case 'notreadableerror':
    case 'trackstarterror':
    case 'aborterror':
      return MIC_BUSY_COPY;
    case 'overconstrainederror':
    case 'constraintnotsatisfiederror':
      return MIC_SELECTION_COPY;
    default:
      return copy;
  }
}

function presentAudioOutputCopy(copy: string, params: ErrorParams | undefined): string {
  const detail = `${params?.audioOutputErrorName ?? ''} ${
    params?.audioOutputErrorMessage ?? ''
  }`.toLowerCase();
  if (
    /notfound|device.?not.?found|no (audio |output )?device|no speakers?|disconnected/.test(detail)
  ) {
    return (
      "buddy can't find an audio output — connect or select speakers in system sound settings. " +
      'answers will appear on screen as captions meanwhile.'
    );
  }
  if (/notallowed|permission|blocked|denied/.test(detail)) {
    return (
      'audio playback could not start — restart buddy and check system output and volume. ' +
      'answers will appear on screen as captions meanwhile.'
    );
  }
  return copy;
}

const CATALOG: Record<ErrorKind, CatalogEntry> = {
  no_api_key: {
    copy:
      'buddy needs an openai api key to answer voice or typed questions — paste one under ' +
      'settings → openai, save it, then try again.',
    surfaces: ACTIONABLE_SURFACES,
    autoShowPanel: true,
  },
  api_key_rejected: {
    copy:
      'openai rejected the saved api key — replace it under settings → openai, or create a new ' +
      'key at platform.openai.com/api-keys.',
    surfaces: ACTIONABLE_SURFACES,
    autoShowPanel: true,
  },
  api_key_unreadable: {
    copy:
      "buddy can't unlock the saved api key on this computer — paste it again under settings → " +
      'openai, save it, then try again.',
    surfaces: ACTIONABLE_SURFACES,
    autoShowPanel: true,
  },
  insufficient_quota: {
    copy:
      'openai says an api billing or usage limit was reached — check billing credit and ' +
      'organization or project limits in the openai platform, then try again.',
    surfaces: ACTIONABLE_SURFACES,
    autoShowPanel: true,
  },
  rate_limited: {
    copy: 'openai is asking us to slow down a little — give it a few seconds and try again.',
    surfaces: ['transcript', 'pill'],
    autoShowPanel: false,
  },
  model_unavailable: {
    copy:
      "your openai project can't use <model> — choose another model under settings → openai, " +
      'or grant that project access in the openai platform.',
    surfaces: ACTIONABLE_SURFACES,
    autoShowPanel: true,
    presentCopy: (copy, params) => copy.replace('<model>', params?.model ?? 'this model'),
  },
  api_access_forbidden: {
    copy:
      'openai blocked this api request — check the saved key and its project, endpoint, and ip ' +
      'permissions in the openai platform, then try again.',
    surfaces: ACTIONABLE_SURFACES,
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
      "buddy didn't receive microphone audio — check the input under settings → microphone and " +
      'allow buddy in system privacy settings. you can type meanwhile.',
    surfaces: ACTIONABLE_SURFACES,
    autoShowPanel: true,
    presentCopy: presentMicCopy,
  },
  audio_output_failed: {
    copy:
      "buddy couldn't start voice playback — restart buddy, then check the selected output in " +
      'system sound settings. answers will appear on screen as captions meanwhile.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
    presentCopy: presentAudioOutputCopy,
  },
  capture_failed: {
    copy:
      "heads up — i couldn't grab your screen this time, so i'm answering blind. " +
      'allow buddy to record the screen in system privacy settings, then try once more.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
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
      "buddy couldn't register push-to-talk — restart buddy; if it stays offline, close keyboard " +
      'remapping or shortcut apps and try again. you can type meanwhile.',
    surfaces: ['transcript', 'caption', 'tray'],
    autoShowPanel: true,
  },
  settings_reset: {
    copy: 'buddy reset a damaged settings file — review settings and paste your openai api key again.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
  },
  settings_save_failed: {
    copy:
      "buddy couldn't save that setting — the previous saved value is unchanged. try again, " +
      'or restart buddy if it keeps happening.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
  },
  renderer_dead: {
    copy: "buddy hit a snag it couldn't fix — a restart will patch things up.",
    surfaces: ['tray'],
    autoShowPanel: false,
  },
  // M18 (integration): agent-mode failures (docs/AGENT-MODE.md §7). The two
  // actionable gates (sign-in, plan quota) auto-show the panel once and add a
  // caption — they hit while the user is looking at the screen, not the panel.
  // The rest land on the agent Card + transcript; agent_quota and
  // agent_backend_down FAIL CLOSED (the run stops, no retry storm).
  agent_not_signed_in: {
    copy: 'agent mode needs your chatgpt sign-in — connect it in settings.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
  },
  agent_quota: {
    copy: 'your chatgpt plan is out of agent runs for now — voice still works.',
    surfaces: ['transcript', 'caption'],
    autoShowPanel: true,
  },
  agent_backend_down: {
    copy: "couldn't reach chatgpt just now — i stopped that agent; try again in a bit.",
    surfaces: ['transcript'],
    autoShowPanel: false,
  },
  agent_tool_failed: {
    copy: "one of my tools kept failing on that task — here's what i got anyway.",
    surfaces: ['transcript'],
    autoShowPanel: false,
  },
};

/** Every catalog kind (exported so tests derive their kind list from the catalog). */
export const ERROR_KINDS: readonly ErrorKind[] = Object.keys(CATALOG) as ErrorKind[];

/** Kinds that auto-show the panel (exported for the policy unit test). */
export const AUTO_SHOW_KINDS: readonly ErrorKind[] = ERROR_KINDS.filter(
  (k) => CATALOG[k].autoShowPanel,
);

/** Catalog lookup with copy interpolation / variant selection. */
export function describeKind(kind: ErrorKind, params?: ErrorParams): ErrorPresentation {
  const entry = CATALOG[kind];
  let message = entry.presentCopy ? entry.presentCopy(entry.copy, params) : entry.copy;
  if (kind === 'hotkey_dead' && params?.macHotkeyPermissions) {
    message =
      'push-to-talk is blocked — under settings → permissions, choose fix for accessibility and ' +
      'input monitoring. buddy will recheck automatically. if macos already allows both, use ' +
      'reset stale grants. you can type meanwhile.';
  }
  let target = ACTIONABLE_TARGET[kind as ActionableErrorKind];
  if (
    kind === 'mic_unavailable' &&
    ['notallowederror', 'permissiondeniederror', 'securityerror'].includes(
      params?.micErrorName?.toLowerCase() ?? '',
    )
  ) {
    target = 'permissions';
  }
  return {
    kind,
    message,
    surfaces: entry.surfaces,
    autoShowPanel: entry.autoShowPanel,
    ...(target !== undefined ? { target } : {}),
  };
}

/** What the classifier matchers see: derived once per classifyError call. */
interface ClassifierInput {
  /** Lowercased error message. */
  msg: string;
  /** Server error code attached via withErrorCode, or ''. */
  code: string;
  /** HTTP status from a ws rejected-upgrade message, or 0. */
  httpStatus: number;
}

/**
 * Ordered classifier table, FIRST MATCH WINS — 1:1 with the mapping table in
 * tests/errors.test.ts. Order is load-bearing: e.g. insufficient_quota must
 * win before the 401/handshake matchers see the message.
 */
const CLASSIFIERS: ReadonlyArray<{ kind: ErrorKind; matches(input: ClassifierInput): boolean }> = [
  {
    kind: 'insufficient_quota',
    matches: ({ msg, code }) =>
      ['insufficient_quota', 'billing_hard_limit_reached', 'usage_limit_reached'].includes(code) ||
      /insufficient_quota|billing hard limit|exceeded your current quota|out of (credit|quota)/.test(
        msg,
      ),
  },
  {
    kind: 'no_api_key',
    matches: ({ msg }) => msg.includes('no api key configured'),
  },
  {
    kind: 'api_key_rejected',
    matches: ({ msg, code, httpStatus }) =>
      ['invalid_api_key', 'authentication_error'].includes(code) ||
      msg.includes('invalid_api_key') ||
      msg.includes('incorrect api key') ||
      httpStatus === 401,
  },
  {
    kind: 'model_unavailable',
    matches: ({ msg, code, httpStatus }) =>
      ['model_not_found', 'model_not_available'].includes(code) ||
      msg.includes('model_not_found') ||
      msg.includes('does not have access to model') ||
      httpStatus === 404,
  },
  {
    kind: 'api_access_forbidden',
    matches: ({ msg, code, httpStatus }) =>
      ['permission_denied', 'access_denied'].includes(code) ||
      msg.includes('permission denied') ||
      httpStatus === 403,
  },
  {
    kind: 'rate_limited',
    matches: ({ msg, code, httpStatus }) =>
      ['rate_limit_exceeded', 'rate_limit_error'].includes(code) ||
      /rate.?limit/.test(msg) ||
      httpStatus === 429,
  },
  {
    kind: 'network_unreachable',
    matches: ({ msg }) =>
      /\b(enotfound|eai_again|econnrefused|etimedout|econnreset|ehostunreach|enetunreach)\b/.test(
        msg,
      ) ||
      msg.includes('handshake timed out') ||
      msg.includes('socket hang up') ||
      msg.includes('failed to fetch') ||
      msg.includes('network error'),
  },
  {
    kind: 'response_interrupted',
    matches: ({ msg }) => msg.includes('the response was interrupted'),
  },
  {
    kind: 'server_error',
    matches: ({ msg, code, httpStatus }) =>
      ['server_error', 'internal_server_error'].includes(code) ||
      msg.includes('server_error') ||
      httpStatus >= 500,
  },
];

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
      ? (err as { code: string }).code.trim().toLowerCase()
      : '';
  // ws rejected-upgrade errors look like "Unexpected server response: 401".
  const statusMatch = /unexpected server response: (\d{3})/.exec(msg);
  const httpStatus = statusMatch !== null ? Number(statusMatch[1]) : 0;

  const input: ClassifierInput = { msg, code, httpStatus };
  const match = CLASSIFIERS.find((classifier) => classifier.matches(input));
  if (match !== undefined) return describeKind(match.kind, params);
  return {
    kind: 'unknown',
    message: `something went wrong: ${singleLine(redactSensitiveErrorText(message))}`,
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
