/**
 * RestGrounder (M10): non-realtime REST grounding fallback for `point_at`.
 *
 * The coordinate study (docs/COORD-STUDY.md §8-§9) measured that the realtime
 * family is intrinsically weak at image-space coordinates (median ~80-100px)
 * while `gpt-5.4-mini` at `reasoning effort: low` over plain REST grounds the
 * SAME screenshots at ~10px median / 93% in-element / 1.3s p50. When the UIA
 * element snap (§6b) finds no match — no UIA Name, label/name token mismatch,
 * timeout — this module re-grounds the model's own spoken label against the
 * exact screenshot JPEG the realtime model saw, using the study's winning
 * protocol verbatim: BARE image (no overlays, no gridlines, no fiducials),
 * PIXEL coordinates of the provided image (the study showed normalized
 * 0-1000 output actively HURTS new-gen models), strict-JSON output.
 *
 * Contract with the conversation layer:
 * - `groundWithModel()` NEVER throws and never hangs past the timeout.
 * - It returns null on: no API key, mock mode (CLICKY_MOCK_URL — the mock
 *   server has no REST endpoint and unit tests must stay offline), timeout,
 *   HTTP error, unparsable output, coordinates outside the image bounds, or
 *   a second call while one is already in flight (one in-flight max; the
 *   conversation's pointerChain serializes callers anyway — this is a guard).
 * - The API key comes from the same source as the realtime session
 *   (settings, decrypted in main) via the `getApiKey` callback and is used
 *   ONLY in the Authorization header — never logged, never in errors.
 *
 * M13-core addition: a SECOND transport for the ChatGPT-subscription path.
 * When the resolved AuthSource is `chatgptCodex`, `ground()` hits
 * `chatgpt.com/backend-api/codex/responses` with gpt-5.6-sol (COORD-STUDY §11:
 * pixel-exact, ~1.4s, cheapest — and free under the user's plan) using the
 * proven Codex request shape (message-list input, streamed SSE, prompt-enforced
 * JSON, NO request-level text.format). Same never-throw/return-null contract.
 * Selection is by AuthSource kind; the api-key transport is unchanged.
 */

import type { AuthSource } from '../auth/auth-source';

export interface RestGroundQuery {
  /** JPEG bytes, base64 (NOT a data URL) — the same capture the model saw. */
  jpegBase64: string;
  /** Pixel dimensions of that JPEG (CaptureMeta.imageW/imageH). */
  imageW: number;
  imageH: number;
  /** The model's spoken label for the target ("the save button"). */
  label: string;
  /** Optional extra context (what the assistant was saying). */
  spokenContext?: string;
}

export interface RestGroundResult {
  /** Pixel coordinates in the PROVIDED image's space. */
  x: number;
  y: number;
  confidence?: number;
}

export interface RestGrounderOptions {
  /** Same key source as the realtime session (settings, decrypted in main). */
  getApiKey: () => string | null;
  /** Injection point for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-call budget, ms. Default 2500. */
  timeoutMs?: number;
  /** Model + effort default to the COORD-STUDY §9 winner. */
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Codex-transport model override (tests). Default: gpt-5.6-sol (§11). */
  codexModel?: string;
  /** Env override for the mock-mode check (tests). Default: process.env. */
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_EFFORT = 'low';
/** Reasoning models burn hidden tokens before the ~10-token answer. */
const MAX_OUTPUT_TOKENS = 1_500;

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

// --- Codex-subscription transport (COORD-STUDY §11) ------------------------
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** COORD-STUDY §11 winner: pixel-exact, cheapest, free under the ChatGPT plan. */
const CODEX_MODEL = 'gpt-5.6-sol';
/**
 * The exact originator/UA the Codex CLI uses — the backend gates on these.
 * Version-pinned to the shape proven live; NOT a secret.
 */
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_USER_AGENT = 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown';

/** Token usage from a grounding response (subset we surface). */
export interface GroundUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * ChatGPT-plan rate-limit telemetry, parsed from the `x-codex-*-used-percent`
 * response headers. Fed to the (deferred) fail-closed "plan limit reached" UX.
 * A field is null when its header was absent/unparsable.
 */
export interface CodexUsedPercent {
  /** Primary (short) window used %, 0..100. */
  primary: number | null;
  /** Secondary (long / weekly) window used %, 0..100. */
  secondary: number | null;
}

export type GroundSource = 'apiKey' | 'codex' | 'none';

/**
 * Unified grounding outcome (both transports). `point` is null on any failure
 * — the caller then keeps the raw model point. `quotaExhausted` is set ONLY on
 * the Codex path when the plan quota is hit (429 / usage-limit classified); the
 * conversation uses it to FAIL CLOSED (never silently spend the metered key).
 */
export interface GroundOutcome {
  point: RestGroundResult | null;
  source: GroundSource;
  quotaExhausted: boolean;
  usedPercent: CodexUsedPercent | null;
  usage?: GroundUsage;
}

/** Strict output schema: pixel point, nothing else (COORD-STUDY §8.2). */
const POINT_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
  },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;

export class RestGrounder {
  private readonly options: RestGrounderOptions;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly effort: string;
  private readonly codexModel: string;
  private inFlight = false;

  constructor(options: RestGrounderOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.reasoningEffort ?? DEFAULT_EFFORT;
    this.codexModel = options.codexModel ?? CODEX_MODEL;
  }

  /**
   * Ground `label` in the provided screenshot. Resolves to pixel coordinates
   * in the image's own space, or null on any failure (see class contract).
   */
  async groundWithModel(query: RestGroundQuery): Promise<RestGroundResult | null> {
    const env = this.options.env ?? process.env;
    // Mock mode: the realtime session talks to the in-process mock server;
    // there is no REST endpoint to call and tests must never hit the network.
    if (env['CLICKY_MOCK_URL'] !== undefined && env['CLICKY_MOCK_URL'] !== '') return null;
    const key = this.options.getApiKey();
    if (key === null || key.length === 0) return null;
    if (this.inFlight) {
      console.debug('[rest-ground] call skipped: one already in flight');
      return null;
    }
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const result = await this.request(query, key);
      console.debug(
        `[rest-ground] ${this.model} ${Date.now() - t0}ms -> ` +
          (result === null ? 'null' : `(${result.x},${result.y})`),
      );
      return result;
    } catch (err) {
      // Timeouts land here (AbortError), as do network failures.
      const reason = err instanceof Error ? err.message : String(err);
      console.debug(`[rest-ground] failed after ${Date.now() - t0}ms: ${reason}`);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Transport-selecting entry point (M13-core). Grounds `query` via whichever
   * backend the resolved AuthSource names:
   *   - `chatgptCodex` -> gpt-5.6-sol over chatgpt.com/backend-api/codex (SSE),
   *   - `apiKey`       -> gpt-5.4-mini over api.openai.com/v1/responses (JSON).
   * Never throws; returns a GroundOutcome whose `point` is null on any failure.
   * On the Codex path a plan-quota rejection sets `quotaExhausted` so the
   * conversation can FAIL CLOSED instead of silently spending the metered key.
   */
  async ground(query: RestGroundQuery, auth: AuthSource): Promise<GroundOutcome> {
    const env = this.options.env ?? process.env;
    // Mock mode: no REST endpoint; tests + `npm run dev` mock never hit the net.
    if (env['CLICKY_MOCK_URL'] !== undefined && env['CLICKY_MOCK_URL'] !== '') {
      return { point: null, source: 'none', quotaExhausted: false, usedPercent: null };
    }
    if (this.inFlight) {
      console.debug('[rest-ground] call skipped: one already in flight');
      return { point: null, source: 'none', quotaExhausted: false, usedPercent: null };
    }

    if (auth.kind === 'apiKey') {
      const key = auth.getApiKey();
      if (key === null || key.length === 0) {
        return { point: null, source: 'apiKey', quotaExhausted: false, usedPercent: null };
      }
      this.inFlight = true;
      const t0 = Date.now();
      try {
        const point = await this.request(query, key);
        console.debug(
          `[rest-ground] apiKey ${this.model} ${Date.now() - t0}ms -> ` +
            (point === null ? 'null' : `(${point.x},${point.y})`),
        );
        return { point, source: 'apiKey', quotaExhausted: false, usedPercent: null };
      } catch (err) {
        console.debug(`[rest-ground] apiKey failed after ${Date.now() - t0}ms: ${reason(err)}`);
        return { point: null, source: 'apiKey', quotaExhausted: false, usedPercent: null };
      } finally {
        this.inFlight = false;
      }
    }

    // chatgptCodex arm.
    let bearer: string;
    try {
      bearer = await auth.getBearer();
    } catch {
      // Not signed in / refresh failed — Codex path unavailable, no quota hit.
      return { point: null, source: 'codex', quotaExhausted: false, usedPercent: null };
    }
    if (bearer.length === 0) {
      return { point: null, source: 'codex', quotaExhausted: false, usedPercent: null };
    }
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const outcome = await this.requestCodex(query, bearer, auth.accountId);
      console.debug(
        `[rest-ground] codex ${this.codexModel} ${Date.now() - t0}ms -> ` +
          (outcome.point === null
            ? `null${outcome.quotaExhausted ? ' (quota)' : ''}`
            : `(${outcome.point.x},${outcome.point.y})`),
      );
      return outcome;
    } catch (err) {
      console.debug(`[rest-ground] codex failed after ${Date.now() - t0}ms: ${reason(err)}`);
      return { point: null, source: 'codex', quotaExhausted: false, usedPercent: null };
    } finally {
      this.inFlight = false;
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Codex-subscription transport. Streams gpt-5.6-sol over
   * chatgpt.com/backend-api/codex/responses with the proven request shape:
   * message-list `input` (a bare `input`/list is REQUIRED — the endpoint
   * rejects a string), input_text + input_image, `stream:true`, `store:false`,
   * `reasoning.effort:"low"`, and NO request-level `text.format` (the JSON is
   * prompt-enforced and parsed tolerantly). Usage + the `x-codex-*-used-percent`
   * headers are surfaced for the fail-closed UX.
   */
  private async requestCodex(
    query: RestGroundQuery,
    bearer: string,
    accountId: string,
  ): Promise<GroundOutcome> {
    const { jpegBase64, imageW, imageH, label, spokenContext } = query;
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Prompt-enforced strict JSON (no request-level text.format on this
      // endpoint). Same COORD-STUDY §8 posture: bare image, PIXEL coords.
      const instructions =
        'You are a precise UI grounding model. The user names an on-screen target in the ' +
        `attached screenshot (${imageW}x${imageH} pixels, origin top-left). Respond with ONLY ` +
        'a JSON object {"x": <int>, "y": <int>} — no prose, no code fence — giving the pixel ' +
        'coordinates of the CENTER of the target.';
      const ask =
        `return the pixel coordinates of the center of: ${label}. ` +
        `the screenshot is ${imageW}x${imageH} pixels. ` +
        'reply with only {"x": <int>, "y": <int>}.' +
        (spokenContext !== undefined && spokenContext.length > 0
          ? ` context: ${spokenContext}`
          : '');
      const res = await doFetch(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'ChatGPT-Account-Id': accountId,
          Accept: 'text/event-stream',
          'OpenAI-Beta': 'responses=experimental',
          originator: CODEX_ORIGINATOR,
          'User-Agent': CODEX_USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.codexModel,
          instructions,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: ask },
                { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}` },
              ],
            },
          ],
          stream: true,
          store: false,
          reasoning: { effort: 'low' },
        }),
      });

      const usedPercent = parseUsedPercent(res.headers);
      if (!res.ok) {
        // 429 (and 403/402 usage rejections) = plan quota — fail closed.
        const quota = res.status === 429 || res.status === 402 || res.status === 403;
        console.debug(`[rest-ground] codex http ${res.status}${quota ? ' (quota)' : ''}`);
        return { point: null, source: 'codex', quotaExhausted: quota, usedPercent };
      }

      const body = await res.text();
      const parsed = parseCodexStream(body, imageW, imageH);
      return {
        point: parsed.point,
        source: 'codex',
        quotaExhausted: parsed.quotaExhausted,
        usedPercent,
        ...(parsed.usage !== null ? { usage: parsed.usage } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------

  private async request(query: RestGroundQuery, key: string): Promise<RestGroundResult | null> {
    const { jpegBase64, imageW, imageH, label, spokenContext } = query;
    const doFetch = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // COORD-STUDY §8 winning protocol: bare image, terse instruction,
      // PIXEL coordinates of the provided image, strict JSON out.
      const instructions =
        'You are a precise UI grounding model. The user names an on-screen target in the ' +
        `attached screenshot (${imageW}x${imageH} pixels, origin top-left). Respond with ONLY ` +
        'a JSON object {"x": <int>, "y": <int>} giving the pixel coordinates of the CENTER ' +
        'of the target.';
      const ask =
        `return the pixel coordinates of the center of: ${label}. ` +
        `the screenshot is ${imageW}x${imageH} pixels.` +
        (spokenContext !== undefined && spokenContext.length > 0
          ? ` context: ${spokenContext}`
          : '');
      const res = await doFetch(RESPONSES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          reasoning: { effort: this.effort },
          instructions,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: ask },
                { type: 'input_image', image_url: `data:image/jpeg;base64,${jpegBase64}` },
              ],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'pixel_point',
              strict: true,
              schema: POINT_SCHEMA,
            },
          },
          max_output_tokens: MAX_OUTPUT_TOKENS,
        }),
      });
      if (!res.ok) {
        console.debug(`[rest-ground] http ${res.status}`);
        return null;
      }
      const payload: unknown = await res.json();
      return parseGroundingResponse(payload, imageW, imageH);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Extract the strict-JSON point from a Responses-API payload. Exported for
 * tests. Returns null on any shape surprise or out-of-bounds coordinates.
 */
export function parseGroundingResponse(
  payload: unknown,
  imageW: number,
  imageH: number,
): RestGroundResult | null {
  if (payload === null || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  // Prefer the aggregate convenience field when present; otherwise walk the
  // output items for the message's output_text parts (reasoning items first).
  let text = typeof body['output_text'] === 'string' ? (body['output_text'] as string) : '';
  if (text.length === 0 && Array.isArray(body['output'])) {
    for (const item of body['output'] as unknown[]) {
      if (item === null || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      if (it['type'] !== 'message' || !Array.isArray(it['content'])) continue;
      for (const part of it['content'] as unknown[]) {
        if (part === null || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (p['type'] === 'output_text' && typeof p['text'] === 'string') text += p['text'];
      }
    }
  }
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const pt = parsed as Record<string, unknown>;
  const x = pt['x'];
  const y = pt['y'];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Out-of-bounds = the model grounded something that is not in this image.
  if (x < 0 || y < 0 || x > imageW || y > imageH) return null;
  return { x, y };
}

/** Short, token-free reason string for a caught error (never a message body). */
function reason(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

/**
 * Parse the ChatGPT-plan rate-limit headers into used-% telemetry. Header
 * names are lowercased by fetch; a missing/unparsable value yields null for
 * that field. Exported for tests.
 */
export function parseUsedPercent(headers: Headers): CodexUsedPercent {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    primary: num('x-codex-primary-used-percent'),
    secondary: num('x-codex-secondary-used-percent'),
  };
}

/** Result of walking a Codex SSE grounding stream. */
interface CodexStreamResult {
  point: RestGroundResult | null;
  usage: GroundUsage | null;
  quotaExhausted: boolean;
}

/**
 * Parse a Codex `/responses` SSE body: accumulate `response.output_text.delta`
 * chunks, take the authoritative final text + usage from `response.completed`,
 * and classify a streamed error/`response.failed` event as quota when it is a
 * usage/rate-limit rejection. Tolerant JSON extraction of {x,y} (the endpoint
 * has no request-level schema). Exported for tests. Never throws.
 */
export function parseCodexStream(body: string, imageW: number, imageH: number): CodexStreamResult {
  let deltaText = '';
  let finalText = '';
  let usage: GroundUsage | null = null;
  let quotaExhausted = false;

  // SSE events are blank-line separated; we only care about `data:` payloads.
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice('data:'.length).trim();
    if (data.length === 0 || data === '[DONE]') continue;
    let evt: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed === null || typeof parsed !== 'object') continue;
      evt = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : '';
    switch (type) {
      case 'response.output_text.delta': {
        if (typeof evt['delta'] === 'string') deltaText += evt['delta'];
        break;
      }
      case 'response.output_text.done': {
        if (typeof evt['text'] === 'string') finalText = evt['text'] as string;
        break;
      }
      case 'response.completed': {
        const response = evt['response'];
        if (response !== null && typeof response === 'object') {
          const r = response as Record<string, unknown>;
          const text = extractMessageText(r['output']);
          if (text.length > 0) finalText = text;
          usage = extractUsage(r['usage']);
        }
        break;
      }
      case 'response.failed':
      case 'error': {
        if (isQuotaError(evt)) quotaExhausted = true;
        break;
      }
      default:
        break;
    }
  }

  const text = finalText.length > 0 ? finalText : deltaText;
  const point = text.length > 0 ? parseTolerantPoint(text, imageW, imageH) : null;
  return { point, usage, quotaExhausted };
}

/** Walk a Responses `output` array to the assistant message's output_text. */
function extractMessageText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output) {
    if (item === null || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (it['type'] !== 'message' || !Array.isArray(it['content'])) continue;
    for (const part of it['content'] as unknown[]) {
      if (part === null || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p['type'] === 'output_text' && typeof p['text'] === 'string') text += p['text'];
    }
  }
  return text;
}

function extractUsage(usage: unknown): GroundUsage | null {
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u['input_tokens']),
    outputTokens: n(u['output_tokens']),
    totalTokens: n(u['total_tokens']),
  };
}

/** True when a streamed error event is a plan usage / rate-limit rejection. */
function isQuotaError(evt: Record<string, unknown>): boolean {
  const err = evt['error'];
  const rec = err !== null && typeof err === 'object' ? (err as Record<string, unknown>) : evt;
  const hay = [
    typeof rec['code'] === 'string' ? rec['code'] : '',
    typeof rec['type'] === 'string' ? rec['type'] : '',
    typeof rec['message'] === 'string' ? rec['message'] : '',
  ]
    .join(' ')
    .toLowerCase();
  return /quota|rate.?limit|usage.?limit|too many requests|insufficient/.test(hay);
}

/**
 * Tolerant {x,y} extraction from prompt-enforced JSON output. Strips code
 * fences, then tries a whole-string parse, then the first balanced object
 * containing numeric x/y. Returns null on no match or out-of-bounds coords.
 * Exported for tests.
 */
export function parseTolerantPoint(
  text: string,
  imageW: number,
  imageH: number,
): RestGroundResult | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const candidates: string[] = [];
  candidates.push(cleaned);
  // First {...} block (non-greedy won't span nested braces, but our object is flat).
  const match = cleaned.match(/\{[^{}]*\}/);
  if (match !== null) candidates.push(match[0]);
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const pt = parsed as Record<string, unknown>;
    const x = pt['x'];
    const y = pt['y'];
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || y < 0 || x > imageW || y > imageH) return null;
    return { x, y };
  }
  return null;
}
