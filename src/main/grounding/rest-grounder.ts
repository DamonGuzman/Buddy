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
 */

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
  /** Env override for the mock-mode check (tests). Default: process.env. */
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_EFFORT = 'low';
/** Reasoning models burn hidden tokens before the ~10-token answer. */
const MAX_OUTPUT_TOKENS = 1_500;

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

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
  private inFlight = false;

  constructor(options: RestGrounderOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.reasoningEffort ?? DEFAULT_EFFORT;
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
