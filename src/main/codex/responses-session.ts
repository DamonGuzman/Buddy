/**
 * CodexResponsesSession (M18): a REUSABLE conversational client for the
 * ChatGPT-subscription "Codex" Responses backend
 * (`chatgpt.com/backend-api/codex/responses`).
 *
 * It is the text-brain counterpart to `realtime/session.ts`: text in, text
 * out, function-calling, vision — all sub-billed through the user's ChatGPT
 * plan (works even when the metered OpenAI API key is out of credit). It is
 * deliberately app-agnostic (no screens/pointers here) so agent mode (M14) can
 * reuse the exact same transport and event surface.
 *
 * Event surface MIRRORS the realtime session so the orchestrator can treat
 * both uniformly:
 *   - onTextDelta(itemId, fullSoFar)   — streamed assistant text (full so far)
 *   - onTextDone(itemId, text)         — a text item finished
 *   - onFunctionCall({callId,name,argsJson}) — a complete tool call
 *   - onCompleted({responseId,usage,usedPercent}) — the response finished
 *   - onError(err)                     — transport/protocol error (never thrown)
 *
 * Tool round-trips work like voice: `sendToolOutput(callId, output)` buffers a
 * `function_call_output`, then `continue()` POSTs the complete client-side
 * history plus those outputs. The ChatGPT Codex backend requires `store:false`
 * and rejects `previous_response_id`, so multi-turn memory is maintained here.
 *
 * Robustness contract (matches rest-grounder's posture):
 *   - NEVER throws across the stream; every failure routes to onError + a
 *     returned CodexTurnResult whose `error`/`quotaExhausted` is set.
 *   - Per-request AbortController timeout; `cancel()` aborts in-flight work and
 *     drops buffered outputs (a superseding turn / voice barge-in).
 *   - 429 / 402 / 403 and streamed usage-limit errors set `quotaExhausted` so
 *     the caller can FAIL CLOSED (never silently spend the metered key).
 *   - The bearer token is used ONLY as an Authorization header value — never
 *     logged, never placed in a body, never persisted here.
 */

import type { ChatGptCodexAuthSource } from '../auth/auth-source';
import type { CodexUsedPercent } from '../../shared/types';

// --- proven request shape (COORD-STUDY §11) --------------------------------
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
/** COORD-STUDY §11 winner: pixel-exact, cheapest, free under the ChatGPT plan. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
/** The exact originator/UA the Codex CLI uses — the backend gates on these. */
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_USER_AGENT = 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown';
/** Generous per-request budget for a streamed text answer (not a one-shot). */
const DEFAULT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A function/tool definition (structurally identical to the realtime one). */
export interface CodexToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One image part for a user turn (JPEG bytes, base64 — NOT a data URL). */
export interface CodexInputImage {
  jpegBase64: string;
}

/** A user turn: an optional context/framing part, the text, and image parts. */
export interface CodexUserTurn {
  /** Prepended factual context/framing part (screens, coord rules, ...). */
  context?: string;
  /** The main user text (the typed question). */
  text: string;
  /** Image parts attached between the context and the question. */
  images?: CodexInputImage[];
}

/** Token usage surfaced from a response (subset we care about). */
export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
}

/** A complete tool call the model produced. */
export interface CodexFunctionCall {
  callId: string;
  name: string;
  /** Raw JSON string of the arguments (parse at the call site). */
  argsJson: string;
}

/** onCompleted payload. */
export interface CodexCompletedInfo {
  responseId: string | null;
  usage: CodexUsage | null;
  usedPercent: CodexUsedPercent | null;
}

/** Streaming callbacks — all optional; mirror the realtime session surface. */
export interface CodexResponsesCallbacks {
  onTextDelta?(itemId: string, fullSoFar: string): void;
  onTextDone?(itemId: string, text: string): void;
  onFunctionCall?(call: CodexFunctionCall): void;
  onCompleted?(info: CodexCompletedInfo): void;
  onError?(err: Error): void;
}

/** The outcome of one request (submit or continue) — for control flow. */
export interface CodexTurnResult {
  responseId: string | null;
  usage: CodexUsage | null;
  usedPercent: CodexUsedPercent | null;
  /** Plan quota hit (429/402/403 or streamed usage-limit) — FAIL CLOSED. */
  quotaExhausted: boolean;
  /** The request was aborted (cancel()/timeout) before completing. */
  aborted: boolean;
  /** Number of complete tool calls emitted during this response. */
  functionCalls: number;
  /** Non-null when the request failed (also delivered via onError). */
  error: Error | null;
}

export interface CodexResponsesSessionOptions {
  /** The ChatGPT-subscription auth arm (getBearer() is awaited per request). */
  auth: ChatGptCodexAuthSource;
  /** System instructions (persona). */
  instructions: string;
  /** Tool/function definitions. Default: none. */
  tools?: CodexToolDef[];
  /** 'auto' | 'none' | 'required' | a named-tool choice. Default 'auto'. */
  toolChoice?: unknown;
  /** Model id. Default gpt-5.6-sol. */
  model?: string;
  /** Reasoning effort. Default 'low'. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Optional Responses `include` array. */
  include?: string[];
  /** Per-request budget, ms. Default 60s. */
  timeoutMs?: number;
  /** fetch injection (tests). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Env override for the mock-mode guard (tests). Default: process.env. */
  env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------

export class CodexResponsesSession {
  private readonly auth: ChatGptCodexAuthSource;
  private readonly instructions: string;
  private readonly tools: CodexToolDef[];
  private readonly toolChoice: unknown;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly include: string[] | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;

  /** Most recent response id (diagnostics only; the backend cannot continue it). */
  private previousResponseId: string | null = null;
  /** Full stateless Responses input history, excluding the next request input. */
  private history: unknown[] = [];
  /** Buffered function_call_output items awaiting continue(). */
  private pendingOutputs: { type: 'function_call_output'; call_id: string; output: string }[] = [];
  /** In-flight request controller (for cancel()/supersede). */
  private controller: AbortController | null = null;
  /** Bumped by cancel(); stream handlers past a bump stop emitting. */
  private cancelEpoch = 0;
  /** Most recent plan-usage telemetry (debug surface). */
  private lastUsedPercentValue: CodexUsedPercent | null = null;

  constructor(options: CodexResponsesSessionOptions) {
    this.auth = options.auth;
    this.instructions = options.instructions;
    this.tools = options.tools ?? [];
    this.toolChoice = options.toolChoice ?? 'auto';
    this.model = options.model ?? DEFAULT_CODEX_MODEL;
    this.effort = options.reasoningEffort ?? 'low';
    this.include = options.include;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
  }

  /** The last parsed x-codex-*-used-percent telemetry (or null). */
  lastUsedPercent(): CodexUsedPercent | null {
    return this.lastUsedPercentValue;
  }

  /** The server thread anchor (for debugging / continuity assertions). */
  responseId(): string | null {
    return this.previousResponseId;
  }

  /** Buffer a function_call_output; sent on the next continue(). */
  sendToolOutput(callId: string, output: object): void {
    this.pendingOutputs.push({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    });
  }

  hasPendingToolOutputs(): boolean {
    return this.pendingOutputs.length > 0;
  }

  /**
   * Abort any in-flight request, drop buffered tool outputs, and stop the
   * current stream from emitting further callbacks. Client-side history is
   * preserved; use reset() to start a brand-new conversation.
   */
  cancel(): void {
    this.cancelEpoch += 1;
    this.pendingOutputs = [];
    const c = this.controller;
    this.controller = null;
    if (c !== null) {
      try {
        c.abort();
      } catch {
        /* already aborted */
      }
    }
  }

  /** Forget the conversation thread (next submit starts fresh). */
  reset(): void {
    this.cancel();
    this.previousResponseId = null;
    this.history = [];
  }

  /** Send a new user turn with the complete client-side history for memory. */
  async submit(
    turn: CodexUserTurn,
    cb: CodexResponsesCallbacks = {},
  ): Promise<CodexTurnResult> {
    const userItem = this.buildUserItem(turn);
    const result = await this.runRequest([...this.history, userItem], cb);
    if (shouldCommit(result)) this.history.push(userItem, ...result.outputItems);
    return result;
  }

  /** Continue after tool outputs were buffered (function_call_output items). */
  async continue(cb: CodexResponsesCallbacks = {}): Promise<CodexTurnResult> {
    if (this.pendingOutputs.length === 0) {
      return emptyResult();
    }
    const outputs = this.pendingOutputs;
    this.pendingOutputs = [];
    const result = await this.runRequest([...this.history, ...outputs], cb);
    if (shouldCommit(result)) this.history.push(...outputs, ...result.outputItems);
    return result;
  }

  // -------------------------------------------------------------------------

  private buildUserItem(turn: CodexUserTurn): unknown {
    const content: unknown[] = [];
    if (turn.context !== undefined && turn.context.length > 0) {
      content.push({ type: 'input_text', text: turn.context });
    }
    for (const img of turn.images ?? []) {
      content.push({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${img.jpegBase64}`,
      });
    }
    content.push({ type: 'input_text', text: turn.text });
    return { type: 'message', role: 'user', content };
  }

  private buildBody(input: unknown[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: this.instructions,
      input,
      tools: this.tools,
      tool_choice: this.toolChoice,
      stream: true,
      // Proven live contract: this backend rejects store:true.
      store: false,
      reasoning: { effort: this.effort },
    };
    if (this.include !== undefined) body['include'] = this.include;
    return body;
  }

  /**
   * POST + stream one request. Never throws; returns a CodexTurnResult and
   * fires callbacks along the way.
   */
  private async runRequest(
    input: unknown[],
    cb: CodexResponsesCallbacks,
  ): Promise<InternalTurnResult> {
    // Snapshot the cancel epoch up front so a cancel() that lands during the
    // pre-fetch async gap (token refresh) still short-circuits the request.
    const epoch = this.cancelEpoch;
    const alivePre = (): boolean => epoch === this.cancelEpoch;

    // Mock mode: the app talks to the in-process mock realtime server; there
    // is no Codex REST endpoint and unit tests must never hit the network.
    const mock = this.env['CLICKY_MOCK_URL'];
    if (mock !== undefined && mock !== '') {
      const err = new Error('codex responses unavailable in mock mode');
      cb.onError?.(err);
      return { ...emptyInternalResult(), error: err };
    }

    let bearer: string;
    try {
      bearer = await this.auth.getBearer();
    } catch (err) {
      const e = asError(err);
      if (alivePre()) cb.onError?.(e);
      return { ...emptyInternalResult(), aborted: !alivePre(), error: alivePre() ? e : null };
    }
    // Superseded (cancel()/reset()) while resolving the bearer — don't fetch.
    if (!alivePre()) return { ...emptyInternalResult(), aborted: true };
    if (bearer.length === 0) {
      const e = new Error('codex sub not signed in');
      cb.onError?.(e);
      return { ...emptyInternalResult(), error: e };
    }

    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const alive = (): boolean => epoch === this.cancelEpoch;

    try {
      const res = await this.fetchImpl(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'ChatGPT-Account-Id': this.auth.accountId,
          Accept: 'text/event-stream',
          'OpenAI-Beta': 'responses=experimental',
          originator: CODEX_ORIGINATOR,
          'User-Agent': CODEX_USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(this.buildBody(input)),
      });

      const usedPercent = parseUsedPercent(res.headers);
      this.lastUsedPercentValue = usedPercent;

      if (!res.ok) {
        // 429 / 402 / 403 usage rejections = plan quota — FAIL CLOSED.
        const quota = res.status === 429 || res.status === 402 || res.status === 403;
        const e = new Error(`codex responses http ${res.status}`);
        if (alive()) cb.onError?.(e);
        return {
          responseId: null,
          usage: null,
          usedPercent,
          quotaExhausted: quota,
          aborted: false,
          functionCalls: 0,
          error: e,
          outputItems: [],
        };
      }

      const result = await this.consumeStream(res, epoch, cb);
      return { ...result, usedPercent: result.usedPercent ?? usedPercent };
    } catch (err) {
      const aborted = isAbortError(err);
      const e = asError(err);
      // An abort from cancel() is expected supersede/barge-in, not an error to
      // surface; a timeout abort is also delivered as aborted (caller decides).
      if (!aborted && alive()) cb.onError?.(e);
      return {
        responseId: null,
        usage: null,
        usedPercent: this.lastUsedPercentValue,
        quotaExhausted: false,
        aborted,
        functionCalls: 0,
        error: aborted ? null : e,
        outputItems: [],
      };
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }

  /**
   * Incrementally parse the SSE stream, firing callbacks. Falls back to a
   * whole-body read when the response has no streamable body (test fakes).
   */
  private async consumeStream(
    res: Response,
    epoch: number,
    cb: CodexResponsesCallbacks,
  ): Promise<InternalTurnResult> {
    const state = new StreamState();
    const alive = (): boolean => epoch === this.cancelEpoch;

    const handleLine = (line: string): void => {
      const trimmed = line.replace(/^﻿/, '').trimStart();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice('data:'.length).trim();
      if (data.length === 0 || data === '[DONE]') return;
      let evt: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data);
        if (parsed === null || typeof parsed !== 'object') return;
        evt = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (alive()) this.dispatchEvent(evt, state, cb);
    };

    const body = res.body as ReadableStream<Uint8Array> | null | undefined;
    if (body !== null && body !== undefined && typeof body.getReader === 'function') {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
        if (!alive()) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
      buf += decoder.decode();
      if (buf.length > 0) handleLine(buf);
    } else {
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) handleLine(line);
    }

    // Flush any text item that streamed deltas but never got an explicit done.
    if (alive()) {
      for (const [itemId, text] of state.textAccum) {
        if (!state.textDone.has(itemId)) cb.onTextDone?.(itemId, text);
      }
    }

    if (state.responseId !== null) this.previousResponseId = state.responseId;
    const info: CodexCompletedInfo = {
      responseId: state.responseId,
      usage: state.usage,
      usedPercent: this.lastUsedPercentValue,
    };
    if (alive() && state.completed) cb.onCompleted?.(info);

    return {
      responseId: state.responseId,
      usage: state.usage,
      usedPercent: this.lastUsedPercentValue,
      quotaExhausted: state.quotaExhausted,
      aborted: !alive(),
      functionCalls: state.functionCallCount,
      error: null,
      outputItems: state.outputItems(),
    };
  }

  private dispatchEvent(
    evt: Record<string, unknown>,
    state: StreamState,
    cb: CodexResponsesCallbacks,
  ): void {
    const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : '';
    switch (type) {
      case 'response.created': {
        const id = responseIdOf(evt['response']);
        if (id !== null) state.responseId = id;
        break;
      }
      case 'response.output_item.added': {
        const item = evt['item'];
        if (item !== null && typeof item === 'object') {
          const it = item as Record<string, unknown>;
          if (it['type'] === 'function_call') {
            const itemId = str(it['id']);
            state.markOutput(itemId, 'function_call');
            state.callMeta.set(itemId, {
              callId: str(it['call_id']),
              name: str(it['name']),
            });
            state.argAccum.set(itemId, str(it['arguments']));
          }
        }
        break;
      }
      case 'response.output_text.delta': {
        const itemId = str(evt['item_id']);
        state.markOutput(itemId, 'message');
        const full = (state.textAccum.get(itemId) ?? '') + str(evt['delta']);
        state.textAccum.set(itemId, full);
        cb.onTextDelta?.(itemId, full);
        break;
      }
      case 'response.output_text.done': {
        const itemId = str(evt['item_id']);
        state.markOutput(itemId, 'message');
        const text = typeof evt['text'] === 'string' ? evt['text'] : (state.textAccum.get(itemId) ?? '');
        state.textAccum.set(itemId, text);
        state.textDone.add(itemId);
        cb.onTextDone?.(itemId, text);
        break;
      }
      case 'response.function_call_arguments.delta': {
        const itemId = str(evt['item_id']);
        state.argAccum.set(itemId, (state.argAccum.get(itemId) ?? '') + str(evt['delta']));
        break;
      }
      case 'response.function_call_arguments.done': {
        const itemId = str(evt['item_id']);
        const meta = state.callMeta.get(itemId);
        const argsJson =
          typeof evt['arguments'] === 'string' && evt['arguments'].length > 0
            ? (evt['arguments'] as string)
            : (state.argAccum.get(itemId) ?? '');
        state.argAccum.set(itemId, argsJson);
        const callId = meta?.callId ?? str(evt['call_id']);
        const name = meta?.name ?? str(evt['name']);
        if (callId.length > 0 && name.length > 0) {
          state.functionCallCount += 1;
          cb.onFunctionCall?.({ callId, name, argsJson });
        }
        break;
      }
      case 'response.completed': {
        state.completed = true;
        const response = evt['response'];
        if (response !== null && typeof response === 'object') {
          const r = response as Record<string, unknown>;
          const id = str(r['id']);
          if (id.length > 0) state.responseId = id;
          state.usage = parseUsage(r['usage']);
        }
        break;
      }
      case 'response.failed':
      case 'response.incomplete':
      case 'error': {
        if (isQuotaError(evt)) state.quotaExhausted = true;
        cb.onError?.(new Error(errorMessageOf(evt)));
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-request stream accumulation
// ---------------------------------------------------------------------------

class StreamState {
  responseId: string | null = null;
  usage: CodexUsage | null = null;
  completed = false;
  quotaExhausted = false;
  functionCallCount = 0;
  readonly textAccum = new Map<string, string>();
  readonly textDone = new Set<string>();
  readonly argAccum = new Map<string, string>();
  readonly callMeta = new Map<string, { callId: string; name: string }>();
  private readonly outputOrder: { itemId: string; type: 'message' | 'function_call' }[] = [];

  markOutput(itemId: string, type: 'message' | 'function_call'): void {
    if (itemId.length === 0 || this.outputOrder.some((item) => item.itemId === itemId)) return;
    this.outputOrder.push({ itemId, type });
  }

  outputItems(): unknown[] {
    const items: unknown[] = [];
    for (const item of this.outputOrder) {
      if (item.type === 'message') {
        const text = this.textAccum.get(item.itemId) ?? '';
        if (text.length === 0) continue;
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
        continue;
      }
      const meta = this.callMeta.get(item.itemId);
      if (meta === undefined) continue;
      const args = this.argAccum.get(item.itemId) ?? '';
      if (meta.callId.length > 0 && meta.name.length > 0) {
        items.push({
          type: 'function_call',
          call_id: meta.callId,
          name: meta.name,
          arguments: args,
        });
      }
    }
    return items;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function emptyResult(): CodexTurnResult {
  return {
    responseId: null,
    usage: null,
    usedPercent: null,
    quotaExhausted: false,
    aborted: false,
    functionCalls: 0,
    error: null,
  };
}

interface InternalTurnResult extends CodexTurnResult {
  outputItems: unknown[];
}

function emptyInternalResult(): InternalTurnResult {
  return { ...emptyResult(), outputItems: [] };
}

function shouldCommit(result: InternalTurnResult): boolean {
  return !result.aborted && !result.quotaExhausted && result.error === null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function responseIdOf(response: unknown): string | null {
  if (response === null || typeof response !== 'object') return null;
  const id = (response as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Parse Responses-API usage (input/output/total + reasoning tokens). */
export function parseUsage(usage: unknown): CodexUsage | null {
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = u['output_tokens_details'];
  const reasoning =
    details !== null && typeof details === 'object'
      ? n((details as Record<string, unknown>)['reasoning_tokens'])
      : 0;
  return {
    inputTokens: n(u['input_tokens']),
    outputTokens: n(u['output_tokens']),
    totalTokens: n(u['total_tokens']),
    reasoningTokens: reasoning,
  };
}

/**
 * Parse the ChatGPT-plan rate-limit headers into used-% telemetry. A missing
 * or unparsable value yields null for that field. Exported for tests.
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

function errorMessageOf(evt: Record<string, unknown>): string {
  const err = evt['error'];
  if (err !== null && typeof err === 'object') {
    const m = (err as Record<string, unknown>)['message'];
    if (typeof m === 'string' && m.length > 0) return m;
  }
  const top = evt['message'];
  if (typeof top === 'string' && top.length > 0) return top;
  const type = evt['type'];
  return typeof type === 'string' ? `codex ${type}` : 'codex responses error';
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
