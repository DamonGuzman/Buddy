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
 * - `ground()` NEVER throws and never hangs past the timeout.
 * - Its `point` is null on: no usable auth, mock mode (CLICKY_MOCK_URL — the
 *   mock server has no REST endpoint and unit tests must stay offline),
 *   timeout, HTTP error, unparsable output, coordinates outside the image
 *   bounds, or a second call while one is already in flight (one in-flight
 *   max; the conversation's pointerChain serializes callers anyway — this is
 *   a guard).
 * - The API key comes from the same source as the realtime session
 *   (settings, decrypted in main) via the resolved `apiKey` AuthSource and is
 *   used ONLY in the Authorization header — never logged, never in errors.
 *
 * M13-core addition: a SECOND transport for the ChatGPT-subscription path.
 * When the resolved AuthSource is `chatgptCodex`, `ground()` hits
 * `chatgpt.com/backend-api/codex/responses` with gpt-5.6-sol (COORD-STUDY §11:
 * pixel-exact, ~1.4s, cheapest — and free under the user's plan) using the
 * proven Codex request shape (message-list input, streamed SSE, prompt-enforced
 * JSON, NO request-level text.format). Same never-throw/return-null contract.
 * Selection is by AuthSource kind; the api-key transport is unchanged. The
 * shared Codex wire mechanics (URL, impersonation headers, quota-status
 * classification, used-percent telemetry, SSE parsing) live in
 * `../codex/transport`.
 */

import type { AuthSource } from '../auth/auth-source';
import type { CodexUsedPercent } from '../../shared/types';
import type { UserContentPart } from '../codex/wire-types';
import { beginModelExecution, type ModelExecutionTrace } from '../model-execution-recorder';
import {
  CODEX_RESPONSES_URL,
  buildCodexHeaders,
  forEachSseEvent,
  isQuotaErrorEvent,
  isQuotaStatus,
  parseUsedPercent,
} from '../codex/transport';

export type { CodexUsedPercent };

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
  /**
   * Same key source as the realtime session (settings, decrypted in main).
   * The key used per call comes from the resolved `apiKey` AuthSource handed
   * to `ground()`; this option is retained at the construction seam.
   */
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
/** COORD-STUDY §11 winner: pixel-exact, cheapest, free under the ChatGPT plan. */
const CODEX_MODEL = 'gpt-5.6-sol';
/**
 * Codex grounding always runs at effort 'low' — the §11 protocol proven live.
 * KNOWN DISCREPANCY, kept deliberately: `options.reasoningEffort`
 * (`this.effort`) tunes only the api-key transport and does NOT reach the
 * Codex arm; changing that would change the proven wire shape.
 */
const CODEX_GROUNDING_EFFORT = 'low';

/** Token usage from a grounding response (subset we surface). */
export interface GroundUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
      return nullOutcome('none');
    }
    if (this.inFlight) {
      console.debug('[rest-ground] call skipped: one already in flight');
      return nullOutcome('none');
    }

    if (auth.kind === 'apiKey') {
      const key = auth.getApiKey();
      if (key === null || key.length === 0) return nullOutcome('apiKey');
      return this.runExclusive('apiKey', this.model, async () => ({
        point: await this.requestApiKey(query, key),
        source: 'apiKey',
        quotaExhausted: false,
        usedPercent: null,
      }));
    }

    // chatgptCodex arm.
    let bearer: string;
    try {
      bearer = await auth.getBearer();
    } catch {
      // Not signed in / refresh failed — Codex path unavailable, no quota hit.
      return nullOutcome('codex');
    }
    if (bearer.length === 0) return nullOutcome('codex');
    return this.runExclusive('codex', this.codexModel, () =>
      this.requestCodex(query, bearer, auth.accountId),
    );
  }

  // -------------------------------------------------------------------------

  /**
   * The inFlight/t0/debug-log/finally idiom shared by both transport arms:
   * marks the grounder busy for the duration of `run`, logs the outcome (or
   * the failure reason — timeouts land here as AbortError, as do network
   * failures) with per-arm tag + model, and NEVER lets `run` throw out.
   */
  private async runExclusive(
    tag: 'apiKey' | 'codex',
    model: string,
    run: () => Promise<GroundOutcome>,
  ): Promise<GroundOutcome> {
    this.inFlight = true;
    const t0 = Date.now();
    try {
      const outcome = await run();
      console.debug(
        `[rest-ground] ${tag} ${model} ${Date.now() - t0}ms -> ${describeOutcome(outcome)}`,
      );
      return outcome;
    } catch (err) {
      console.debug(`[rest-ground] ${tag} failed after ${Date.now() - t0}ms: ${reason(err)}`);
      return nullOutcome(tag);
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Run `fn` with an abort signal that fires after the per-call budget. The
   * timer deliberately covers the WHOLE exchange — fetch AND body read — so a
   * response that streams slower than the budget still aborts.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

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
    const doFetch = this.options.fetchImpl ?? fetch;
    const { instructions, ask } = buildGroundingPrompt(query, 'codex');
    return this.withTimeout(async (signal) => {
      let trace: ModelExecutionTrace | null = null;
      try {
        const body = {
          model: this.codexModel,
          instructions,
          input: [{ type: 'message', role: 'user', content: groundingContent(ask, query) }],
          stream: true,
          store: false,
          reasoning: { effort: CODEX_GROUNDING_EFFORT },
        };
        trace = beginModelExecution({
          transport: 'chatgpt-codex-grounding',
          model: this.codexModel,
          operation: 'grounding.responses.create',
          endpoint: CODEX_RESPONSES_URL,
          context: { imageW: query.imageW, imageH: query.imageH, label: query.label },
        });
        trace?.request(body);
        const res = await doFetch(CODEX_RESPONSES_URL, {
          method: 'POST',
          headers: buildCodexHeaders(bearer, accountId),
          signal,
          body: JSON.stringify(body),
        });

        const usedPercent = parseUsedPercent(res.headers);
        trace?.response({
          httpStatus: res.status,
          headers: Object.fromEntries(res.headers.entries()),
        });
        if (!res.ok) {
          // 429 (and 403/402 usage rejections) = plan quota — fail closed.
          const quota = isQuotaStatus(res.status);
          console.debug(`[rest-ground] codex http ${res.status}${quota ? ' (quota)' : ''}`);
          const outcome = {
            point: null,
            source: 'codex' as const,
            quotaExhausted: quota,
            usedPercent,
          };
          trace?.fail(new Error(`codex grounding http ${res.status}`), outcome);
          return outcome;
        }

        const responseBody = await res.text();
        trace?.response({ rawBody: responseBody });
        forEachSseEvent(responseBody, (event) => trace?.event('server', event));
        const parsed = parseCodexStream(responseBody, query.imageW, query.imageH);
        const outcome = {
          point: parsed.point,
          source: 'codex' as const,
          quotaExhausted: parsed.quotaExhausted,
          usedPercent,
          ...(parsed.usage !== null ? { usage: parsed.usage } : {}),
        };
        if (parsed.quotaExhausted) {
          trace?.fail(new Error('codex grounding quota exhausted'), outcome);
        } else {
          trace?.complete(outcome);
        }
        return outcome;
      } catch (error) {
        if (signal.aborted) trace?.cancel('grounding request timed out');
        else trace?.fail(error);
        throw error;
      }
    });
  }

  /**
   * Metered-key transport. COORD-STUDY §8 winning protocol: bare image, terse
   * instruction, PIXEL coordinates of the provided image, strict JSON out.
   */
  private async requestApiKey(
    query: RestGroundQuery,
    key: string,
  ): Promise<RestGroundResult | null> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const { instructions, ask } = buildGroundingPrompt(query, 'apiKey');
    return this.withTimeout(async (signal) => {
      let trace: ModelExecutionTrace | null = null;
      try {
        const body = {
          model: this.model,
          reasoning: { effort: this.effort },
          instructions,
          input: [{ role: 'user', content: groundingContent(ask, query) }],
          text: {
            format: {
              type: 'json_schema',
              name: 'pixel_point',
              strict: true,
              schema: POINT_SCHEMA,
            },
          },
          max_output_tokens: MAX_OUTPUT_TOKENS,
        };
        trace = beginModelExecution({
          transport: 'openai-responses-grounding',
          model: this.model,
          operation: 'grounding.responses.create',
          endpoint: RESPONSES_URL,
          context: { imageW: query.imageW, imageH: query.imageH, label: query.label },
        });
        trace?.request(body);
        const res = await doFetch(RESPONSES_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify(body),
        });
        trace?.response({
          httpStatus: res.status,
          headers: Object.fromEntries(res.headers.entries()),
        });
        if (!res.ok) {
          console.debug(`[rest-ground] http ${res.status}`);
          trace?.fail(new Error(`OpenAI grounding http ${res.status}`));
          return null;
        }
        const payload: unknown = await res.json();
        trace?.response({ body: payload });
        const result = parseGroundingResponse(payload, query.imageW, query.imageH);
        trace?.complete({ result });
        return result;
      } catch (error) {
        if (signal.aborted) trace?.cancel('grounding request timed out');
        else trace?.fail(error);
        throw error;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Prompt + request-shape helpers
// ---------------------------------------------------------------------------

/**
 * The grounding prompt, per transport. The two variants are deliberately NOT
 * identical — each is the wording proven live for its backend (COORD-STUDY §8
 * vs §11) and is pinned byte-for-byte by tests:
 *  - `codex` adds "— no prose, no code fence —" to the instructions and a
 *    "reply with only {…}." reminder to the ask, because that endpoint has no
 *    request-level `text.format` (JSON is prompt-enforced),
 *  - `apiKey` relies on the strict `json_schema` response format instead.
 */
function buildGroundingPrompt(
  query: RestGroundQuery,
  variant: 'apiKey' | 'codex',
): { instructions: string; ask: string } {
  const { imageW, imageH, label, spokenContext } = query;
  const instructions =
    'You are a precise UI grounding model. The user names an on-screen target in the ' +
    `attached screenshot (${imageW}x${imageH} pixels, origin top-left). Respond with ONLY ` +
    'a JSON object {"x": <int>, "y": <int>}' +
    (variant === 'codex' ? ' — no prose, no code fence —' : '') +
    ' giving the pixel coordinates of the CENTER of the target.';
  const ask =
    `return the pixel coordinates of the center of: ${label}. ` +
    `the screenshot is ${imageW}x${imageH} pixels.` +
    (variant === 'codex' ? ' reply with only {"x": <int>, "y": <int>}.' : '') +
    (spokenContext !== undefined && spokenContext.length > 0 ? ` context: ${spokenContext}` : '');
  return { instructions, ask };
}

/** The user-message content both transports send: the ask + the bare image. */
function groundingContent(ask: string, query: RestGroundQuery): UserContentPart[] {
  return [
    { type: 'input_text', text: ask },
    { type: 'input_image', image_url: `data:image/jpeg;base64,${query.jpegBase64}` },
  ];
}

/** A failure outcome for the given source (point null, no quota signal). */
function nullOutcome(source: GroundSource): GroundOutcome {
  return { point: null, source, quotaExhausted: false, usedPercent: null };
}

/** Debug-log formatting of an outcome (point, or null with a quota marker). */
function describeOutcome(outcome: GroundOutcome): string {
  return outcome.point === null
    ? `null${outcome.quotaExhausted ? ' (quota)' : ''}`
    : `(${outcome.point.x},${outcome.point.y})`;
}

// ---------------------------------------------------------------------------
// Pure parsers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Shared coordinate gate: 'invalid' when x/y are not finite numbers, 'oob'
 * when the point lies outside the image (= the model grounded something that
 * is not in this image), else the point. The two outcomes stay distinct
 * because `parseTolerantPoint` treats them differently (see there).
 */
function validatePoint(
  x: unknown,
  y: unknown,
  imageW: number,
  imageH: number,
): RestGroundResult | 'invalid' | 'oob' {
  if (typeof x !== 'number' || typeof y !== 'number') return 'invalid';
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'invalid';
  if (x < 0 || y < 0 || x > imageW || y > imageH) return 'oob';
  return { x, y };
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
    text = extractMessageText(body['output']);
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
  const point = validatePoint(pt['x'], pt['y'], imageW, imageH);
  return typeof point === 'string' ? null : point;
}

/** Short, token-free reason string for a caught error (never a message body). */
function reason(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
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

  forEachSseEvent(body, (evt) => {
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
        if (isQuotaErrorEvent(evt)) quotaExhausted = true;
        break;
      }
      default:
        break;
    }
  });

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

/**
 * Tolerant {x,y} extraction from prompt-enforced JSON output. Strips code
 * fences, then tries a whole-string parse, then the first balanced object
 * containing numeric x/y. An 'invalid' candidate (wrong types) moves on to
 * the next candidate; an out-of-bounds candidate is TERMINAL — the model
 * answered confidently but off-image, so no nested block gets cherry-picked.
 * Returns null on no match or out-of-bounds coords. Exported for tests.
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
    const point = validatePoint(pt['x'], pt['y'], imageW, imageH);
    if (point === 'invalid') continue;
    if (point === 'oob') return null;
    return point;
  }
  return null;
}
