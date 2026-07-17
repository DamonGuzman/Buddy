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
import { beginModelExecution, type ModelExecutionTrace } from '../model-execution-recorder';
import {
  CODEX_RESPONSES_URL,
  buildCodexHeaders,
  isQuotaErrorEvent,
  isQuotaStatus,
  parseSseEventLine,
  parseUsedPercent,
  readSseLines,
} from './transport';
import type {
  AssistantMessageItem,
  CodexToolChoice,
  FunctionCallItem,
  FunctionCallOutputItem,
  ResponseInputItem,
  UserContentPart,
  UserMessageItem,
} from './wire-types';

// --- proven request shape (COORD-STUDY §11) --------------------------------
/** COORD-STUDY §11 winner: pixel-exact, cheapest, free under the ChatGPT plan. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
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
  toolChoice?: CodexToolChoice;
  /** Model id. Default gpt-5.6-sol. */
  model?: string;
  /** Reasoning effort. Default 'low'. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** ChatGPT Codex service tier. `priority` is Codex fast mode (~1.5x). */
  serviceTier?: 'default' | 'priority';
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
  private readonly toolChoice: CodexToolChoice;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly serviceTier: 'default' | 'priority';
  private readonly include: string[] | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;

  /** Most recent response id (diagnostics only; the backend cannot continue it). */
  private previousResponseId: string | null = null;
  /** Full stateless Responses input history, excluding the next request input. */
  private history: ResponseInputItem[] = [];
  /** Buffered function_call_output items awaiting continue(). */
  private pendingOutputs: FunctionCallOutputItem[] = [];
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
    this.serviceTier = options.serviceTier ?? 'priority';
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
  async submit(turn: CodexUserTurn, cb: CodexResponsesCallbacks = {}): Promise<CodexTurnResult> {
    return this.runAndCommit([buildUserItem(turn)], cb);
  }

  /** Continue after tool outputs were buffered (function_call_output items). */
  async continue(cb: CodexResponsesCallbacks = {}): Promise<CodexTurnResult> {
    if (this.pendingOutputs.length === 0) return emptyResult();
    return this.runAndCommit(this.takePendingOutputs(), cb);
  }

  /** Continue a tool round-trip and attach a fresh user/screenshot observation. */
  async continueWithTurn(
    turn: CodexUserTurn,
    cb: CodexResponsesCallbacks = {},
  ): Promise<CodexTurnResult> {
    if (this.pendingOutputs.length === 0) return emptyResult();
    return this.runAndCommit([...this.takePendingOutputs(), buildUserItem(turn)], cb);
  }

  // -------------------------------------------------------------------------

  /** Drain the buffered tool outputs (cleared BEFORE the request goes out). */
  private takePendingOutputs(): FunctionCallOutputItem[] {
    const outputs = this.pendingOutputs;
    this.pendingOutputs = [];
    return outputs;
  }

  /**
   * Run one request with `history + newItems` as the input, and — only on a
   * clean completion (not aborted, not quota, no error) — commit the new
   * items plus the response's output items to the client-side history.
   */
  private async runAndCommit(
    newItems: ResponseInputItem[],
    cb: CodexResponsesCallbacks,
  ): Promise<CodexTurnResult> {
    const result = await this.runRequest([...this.history, ...newItems], cb);
    if (shouldCommit(result)) this.history.push(...newItems, ...result.outputItems);
    return result;
  }

  private buildBody(input: ResponseInputItem[]): Record<string, unknown> {
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
      // ChatGPT subscription fast mode. This is the same priority tier used
      // by Codex when its fast-mode toggle is enabled.
      service_tier: this.serviceTier,
    };
    if (this.include !== undefined) body['include'] = this.include;
    return body;
  }

  /**
   * Resolve the bearer for one request, or a failure result when the request
   * must not go out: mock mode (the app talks to the in-process mock realtime
   * server; there is no Codex REST endpoint and unit tests must never hit the
   * network), a cancel() landing during the async token refresh, a rejected
   * refresh, or an empty token (not signed in). Failure callbacks fire here.
   */
  private async resolveBearer(
    alivePre: () => boolean,
    cb: CodexResponsesCallbacks,
  ): Promise<{ bearer: string } | { failure: InternalTurnResult }> {
    const mock = this.env['CLICKY_MOCK_URL'];
    if (mock !== undefined && mock !== '') {
      const err = new Error('codex responses unavailable in mock mode');
      cb.onError?.(err);
      return { failure: makeErrorResult({ error: err }) };
    }

    let bearer: string;
    try {
      bearer = await this.auth.getBearer();
    } catch (err) {
      const e = asError(err);
      if (alivePre()) cb.onError?.(e);
      return { failure: makeErrorResult({ aborted: !alivePre(), error: alivePre() ? e : null }) };
    }
    // Superseded (cancel()/reset()) while resolving the bearer — don't fetch.
    if (!alivePre()) return { failure: makeErrorResult({ aborted: true }) };
    if (bearer.length === 0) {
      const e = new Error('codex sub not signed in');
      cb.onError?.(e);
      return { failure: makeErrorResult({ error: e }) };
    }
    return { bearer };
  }

  /**
   * POST + stream one request. Never throws; returns a CodexTurnResult and
   * fires callbacks along the way.
   */
  private async runRequest(
    input: ResponseInputItem[],
    cb: CodexResponsesCallbacks,
  ): Promise<InternalTurnResult> {
    // Snapshot the cancel epoch up front so a cancel() that lands during the
    // pre-fetch async gap (token refresh) still short-circuits the request.
    const epoch = this.cancelEpoch;
    const alivePre = (): boolean => epoch === this.cancelEpoch;

    const resolved = await this.resolveBearer(alivePre, cb);
    if ('failure' in resolved) return resolved.failure;

    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const alive = (): boolean => epoch === this.cancelEpoch;
    let trace: ModelExecutionTrace | null = null;

    try {
      const body = this.buildBody(input);
      trace = beginModelExecution({
        transport: 'chatgpt-codex-responses',
        model: this.model,
        operation: 'responses.create',
        endpoint: CODEX_RESPONSES_URL,
        context: { serviceTier: this.serviceTier, reasoningEffort: this.effort },
      });
      trace?.request(body);
      const res = await this.fetchImpl(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: buildCodexHeaders(resolved.bearer, this.auth.accountId),
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      const usedPercent = parseUsedPercent(res.headers);
      this.lastUsedPercentValue = usedPercent;
      trace?.response({
        httpStatus: res.status,
        headers: Object.fromEntries(res.headers.entries()),
      });

      if (!res.ok) {
        // 429 / 402 / 403 usage rejections = plan quota — FAIL CLOSED.
        const quota = isQuotaStatus(res.status);
        const e = new Error(`codex responses http ${res.status}`);
        trace?.fail(e, { httpStatus: res.status, usedPercent, quotaExhausted: quota });
        if (alive()) cb.onError?.(e);
        return makeErrorResult({ usedPercent, quotaExhausted: quota, error: e });
      }

      const result = await this.consumeStream(res, epoch, cb, trace);
      const completed = { ...result, usedPercent: result.usedPercent ?? usedPercent };
      if (completed.aborted) {
        trace?.cancel('request superseded or timed out', completed);
      } else if (completed.error !== null || completed.quotaExhausted) {
        trace?.fail(completed.error ?? new Error('codex quota exhausted'), completed);
      } else {
        trace?.complete(completed);
      }
      return completed;
    } catch (err) {
      const aborted = isAbortError(err);
      const e = asError(err);
      if (aborted) trace?.cancel('request aborted', { timeoutMs: this.timeoutMs });
      else trace?.fail(e);
      // An abort from cancel() is expected supersede/barge-in, not an error to
      // surface; a timeout abort is also delivered as aborted (caller decides).
      if (!aborted && alive()) cb.onError?.(e);
      return makeErrorResult({
        usedPercent: this.lastUsedPercentValue,
        aborted,
        error: aborted ? null : e,
      });
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
    trace: ModelExecutionTrace | null,
  ): Promise<InternalTurnResult> {
    const state = new StreamState();
    const alive = (): boolean => epoch === this.cancelEpoch;

    await readSseLines(
      res,
      (line) => {
        const evt = parseSseEventLine(line);
        if (evt !== null && alive()) {
          trace?.event('server', evt);
          this.dispatchEvent(evt, state, cb);
        }
      },
      { shouldStop: () => !alive() },
    );

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
        const text =
          typeof evt['text'] === 'string' ? evt['text'] : (state.textAccum.get(itemId) ?? '');
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
        if (isQuotaErrorEvent(evt)) state.quotaExhausted = true;
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

  outputItems(): (AssistantMessageItem | FunctionCallItem)[] {
    const items: (AssistantMessageItem | FunctionCallItem)[] = [];
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

function buildUserItem(turn: CodexUserTurn): UserMessageItem {
  const content: UserContentPart[] = [];
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
  outputItems: ResponseInputItem[];
}

/** An error-shaped result: everything empty except the given overrides. */
function makeErrorResult(overrides: Partial<InternalTurnResult>): InternalTurnResult {
  return { ...emptyResult(), outputItems: [], ...overrides };
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
