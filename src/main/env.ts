/**
 * Typed accessors for every CLICKY_* dev/QA env flag read by the main process.
 * One owner for the flag NAMES and their exact parse semantics; values are
 * read at CALL time (never cached), so flags behave identically whether a
 * module reads them at import or per call.
 *
 * Every accessor takes an optional env (default `process.env`) because several
 * consumers (realtime/mockable.ts, grounding/rest-grounder.ts,
 * codex/responses-session.ts) already inject one for tests.
 *
 * Parse-style inventory (kept EXACTLY as each current call site reads it —
 * do not unify without an explicit behavior-change task):
 * - `=== '1'` booleans: NO_SNAP, NO_REST_GROUND, NO_CODEX_SUB, DEBUG,
 *   IMPORT_API_KEY_FROM_ENV, AGENT_MOCK, SHOW_PANEL, KEEP_PANEL_OPEN,
 *   TEST_CAPTURE, CAPTURE_TEST.
 * - set-and-non-empty strings (unset OR '' → null): USER_DATA, FAKE_MIC,
 *   TEST_MIC, TEST_THROW, AGENT_MODEL, MOCK_URL, DEBUG_TOKEN.
 * - numbers via `Number(raw)` with site-specific validity checks: DEBUG_PORT
 *   (positive integer), BOB_IDLE_MS (finite, > 0).
 * - documented inconsistencies:
 *   - CAPTURE_OUT is the only string flag consumed with `??` — an EMPTY
 *     string is respected as a real value (index.ts capture self-test),
 *     unlike every other string flag. The accessor returns the raw value.
 *   - PHONE_AUDIO_AUTOSTART is tri-state: '1' forces on everywhere, '0'
 *     forces off, anything else defaults on ONLY when packaged.
 *   - PHONE_AUDIO_URL is trimmed and defaults to '' (index.ts treats '' as
 *     "use the bundled bridge default URL").
 */

import { ENV_DEBUG, ENV_MOCK_URL } from '../shared/constants';

type Env = NodeJS.ProcessEnv;

/** Set-and-non-empty string read (the common truthy-string idiom), else null. */
function nonEmpty(env: Env, name: string): string | null {
  const raw = env[name];
  return raw !== undefined && raw !== '' ? raw : null;
}

function flag(env: Env, name: string): boolean {
  return env[name] === '1';
}

// ---------------------------------------------------------------------------
// Grounding / auth A/B switches (conversation.ts)
// ---------------------------------------------------------------------------

/** CLICKY_NO_SNAP=1 disables UIA element snapping (eval A/B). */
export function isSnapDisabled(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_NO_SNAP');
}

/** CLICKY_NO_REST_GROUND=1 disables the REST grounding fallback (eval A/B). */
export function isRestGroundDisabled(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_NO_REST_GROUND');
}

/** CLICKY_NO_CODEX_SUB=1 forces the metered API key over Codex-sub (eval A/B). */
export function isCodexSubDisabled(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_NO_CODEX_SUB');
}

// ---------------------------------------------------------------------------
// Mock realtime endpoint
// ---------------------------------------------------------------------------

/**
 * CLICKY_MOCK_URL: ws:// URL of the mock Realtime server, or null when unset
 * or empty. All four current readers agree on set-and-non-empty semantics
 * (mockable.ts, rest-grounder.ts, responses-session.ts explicitly;
 * conversation.ts via `!process.env[...]` truthiness — equivalent for a
 * string env value).
 */
export function mockRealtimeUrl(env: Env = process.env): string | null {
  return nonEmpty(env, ENV_MOCK_URL);
}

// ---------------------------------------------------------------------------
// Debug server (debug-server.ts)
// ---------------------------------------------------------------------------

/** CLICKY_DEBUG=1 enables the local debug HTTP server. */
export function isDebugEnabled(env: Env = process.env): boolean {
  return flag(env, ENV_DEBUG);
}

/** CLICKY_DEBUG_TOKEN: explicit debug auth token, or null (random per launch). */
export function debugTokenOverride(env: Env = process.env): string | null {
  return nonEmpty(env, 'CLICKY_DEBUG_TOKEN');
}

/**
 * CLICKY_DEBUG_PORT: positive-integer port override for parallel QA
 * instances, or null when unset/invalid (caller falls back to DEBUG_PORT).
 * Matches debug-server.ts: `Number(raw)` then `Number.isInteger(n) && n > 0`.
 */
export function debugPortOverride(env: Env = process.env): number | null {
  const n = Number(env['CLICKY_DEBUG_PORT']);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Boot / launcher (index.ts, settings.ts)
// ---------------------------------------------------------------------------

/** CLICKY_USER_DATA=<dir>: separate userData dir for parallel dev/QA instances. */
export function userDataDirOverride(env: Env = process.env): string | null {
  return nonEmpty(env, 'CLICKY_USER_DATA');
}

/** CLICKY_FAKE_MIC=<path.wav>: route getUserMedia to a WAV file (M8.5 eval). */
export function fakeMicWavPath(env: Env = process.env): string | null {
  return nonEmpty(env, 'CLICKY_FAKE_MIC');
}

/**
 * CLICKY_IMPORT_API_KEY_FROM_ENV=1: the dev launcher imports OPENAI_API_KEY
 * through safeStorage (index.ts awaits app.ready first; settings.ts does the
 * import).
 */
export function shouldImportApiKeyFromEnv(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_IMPORT_API_KEY_FROM_ENV');
}

/**
 * CLICKY_TEST_THROW=exception|rejection: blow up 3s after boot so the harness
 * can assert the last-resort handlers keep the tray app alive (M11). The site
 * only distinguishes 'rejection'; any other non-empty value throws.
 */
export function testThrowKind(env: Env = process.env): string | null {
  return nonEmpty(env, 'CLICKY_TEST_THROW');
}

/** CLICKY_CAPTURE_TEST=1: run the M3 capture self-test at boot, then quit. */
export function isCaptureSelfTestEnabled(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_CAPTURE_TEST');
}

/**
 * CLICKY_CAPTURE_OUT: output dir for the capture self-test. RAW value —
 * the call site applies `?? <temp default>`, so unlike every other string
 * flag an explicit EMPTY string is respected (documented inconsistency).
 */
export function captureTestOutDir(env: Env = process.env): string | undefined {
  return env['CLICKY_CAPTURE_OUT'];
}

// ---------------------------------------------------------------------------
// Agent mode (index.ts, agents/agent.ts)
// ---------------------------------------------------------------------------

/** CLICKY_AGENT_MOCK=1: use the mock agent backend instead of Codex. */
export function isAgentMockEnabled(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_AGENT_MOCK');
}

/**
 * CLICKY_AGENT_MODEL: agent model override, or null (caller falls back to
 * AGENT_DEFAULT_MODEL; the site uses `|| default`, i.e. '' also falls back).
 */
export function agentModelOverride(env: Env = process.env): string | null {
  return nonEmpty(env, 'CLICKY_AGENT_MODEL');
}

// ---------------------------------------------------------------------------
// Panel window QA hooks (windows/panel.ts)
// ---------------------------------------------------------------------------

/** CLICKY_SHOW_PANEL=1: show the panel on launch (still hides on blur). */
export function showPanelOnLaunch(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_SHOW_PANEL');
}

/** CLICKY_KEEP_PANEL_OPEN=1: don't hide the panel on blur (visual QA only). */
export function keepPanelOpen(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_KEEP_PANEL_OPEN');
}

/**
 * CLICKY_TEST_CAPTURE=1: run a mic start→stop capture cycle against the
 * hidden panel window after load. NOT the same flag as CLICKY_CAPTURE_TEST
 * (the M3 screenshot self-test above).
 */
export function isPanelCaptureTestEnabled(env: Env = process.env): boolean {
  return flag(env, 'CLICKY_TEST_CAPTURE');
}

/** CLICKY_TEST_MIC=<label substring>: pre-select that mic in the capture test. */
export function testMicLabelSubstring(env: Env = process.env): string | null {
  return nonEmpty(env, 'CLICKY_TEST_MIC');
}

// ---------------------------------------------------------------------------
// Overlay renderer hooks (windows/overlay.ts)
// ---------------------------------------------------------------------------

/**
 * CLICKY_BOB_IDLE_MS: shrink the renderer's idle bob-pause timeout without a
 * rebuild (test hook; forwarded as a query param). Finite and > 0, else null
 * (the site omits the query param).
 */
export function bobIdleMsOverride(env: Env = process.env): number | null {
  const n = Number(env['CLICKY_BOB_IDLE_MS']);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Phone-audio QA bridge (index.ts)
// ---------------------------------------------------------------------------

/**
 * CLICKY_PHONE_AUDIO_URL, trimmed; '' when unset (index.ts treats '' as
 * "use DEFAULT_PHONE_AUDIO_URL, no explicit bridge requested").
 */
export function phoneAudioUrl(env: Env = process.env): string {
  return env['CLICKY_PHONE_AUDIO_URL']?.trim() ?? '';
}

/**
 * CLICKY_PHONE_AUDIO_AUTOSTART tri-state: '1' forces the bundled bridge on,
 * '0' forces it off, and anything else defaults on ONLY when packaged.
 */
export function phoneAudioAutostart(isPackaged: boolean, env: Env = process.env): boolean {
  return (
    env['CLICKY_PHONE_AUDIO_AUTOSTART'] === '1' ||
    (isPackaged && env['CLICKY_PHONE_AUDIO_AUTOSTART'] !== '0')
  );
}

// ---------------------------------------------------------------------------
// Dev-flag inventories (index.ts)
// ---------------------------------------------------------------------------

/**
 * Every CLICKY_* flag set (non-empty) this run, full names, sorted — the
 * session recorder's `devFlags` manifest field.
 */
export function setClickyFlagNames(env: Env = process.env): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith('CLICKY_') && (env[key] ?? '') !== '')
    .sort();
}

/**
 * M11 dev chip: every CLICKY_* flag set (non-empty) BESIDES CLICKY_DEBUG,
 * prefix stripped, lowercase, sorted — `RuntimeFlags.devFlags` for the panel
 * header.
 */
export function devChipFlags(env: Env = process.env): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith('CLICKY_') && k !== ENV_DEBUG && (env[k] ?? '') !== '')
    .map((k) => k.slice('CLICKY_'.length).toLowerCase())
    .sort();
}
