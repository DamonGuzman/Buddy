import type { CodexProvider } from '../auth/auth-source';
import { getCodexAuthProvider } from '../auth/codex-auth';
import { asFiniteNumber, asRecord, asString, errorMessage } from '../util/guards';
import {
  CODEX_RESPONSES_URL,
  buildCodexHeaders,
  isQuotaStatus,
  parseSseEventLine,
  parseUsedPercent,
  readSseLines,
} from '../codex/transport';
import { beginModelExecution, type ModelExecutionTrace } from '../model-execution-recorder';
import { requireCanonicalHelperBuddyId } from '../helper-buddy-id';
import { HELPER_BUDDY_BACKEND_IDLE_TIMEOUT_MS } from './helper-buddy-config';
import type {
  HelperBuddyBackend,
  HelperBuddyBackendRequest,
  HelperBuddyBackendResult,
  HelperBuddyFunctionCall,
  ResponseItem,
} from './types';

/**
 * The helper-buddy loop's OWN quota classifier for streamed error events. It is
 * deliberately NOT `transport.isQuotaErrorEvent`: this one scans the whole
 * JSON-serialized error record (nested fields included) but does not treat
 * "too many requests" / "insufficient..." as quota — and the loop's retry
 * behavior (quota = not retryable) was tuned against exactly this match.
 */
const HELPER_BUDDY_QUOTA_RE = /quota|usage.?limit|rate.?limit/i;

export interface CodexHelperBuddyBackendOptions {
  /** Maximum wait for HTTP response headers. */
  responseStartTimeoutMs?: number;
  /** Maximum silence between response-body chunks. */
  streamIdleTimeoutMs?: number;
}

export class CodexHelperBuddyBackend implements HelperBuddyBackend {
  private readonly responseStartTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(
    private readonly provider: CodexProvider = getCodexAuthProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
    options: CodexHelperBuddyBackendOptions = {},
  ) {
    this.responseStartTimeoutMs = positiveTimeout(
      options.responseStartTimeoutMs ?? HELPER_BUDDY_BACKEND_IDLE_TIMEOUT_MS,
      'response-start',
    );
    this.streamIdleTimeoutMs = positiveTimeout(
      options.streamIdleTimeoutMs ?? HELPER_BUDDY_BACKEND_IDLE_TIMEOUT_MS,
      'stream-idle',
    );
  }

  isReady(): boolean {
    try {
      return this.provider.getCodexAuth() !== null;
    } catch {
      return false;
    }
  }

  async request(req: HelperBuddyBackendRequest): Promise<HelperBuddyBackendResult> {
    if (req.runContext) {
      try {
        requireCanonicalHelperBuddyId(req.runContext.helperBuddyId);
      } catch (error) {
        return invalidRequestBackendResult(error);
      }
    }
    // Cancellation is an admission boundary. In particular, do not inspect
    // auth or start telemetry/timers for work that was cancelled before this
    // method received it.
    if (req.signal.aborted) return cancelledBackendResult(req.signal.reason);
    let authAtAdmission: ReturnType<CodexProvider['getCodexAuth']>;
    try {
      authAtAdmission = this.provider.getCodexAuth();
    } catch (error) {
      return signedOutBackendResult(error);
    }
    if (authAtAdmission === null) {
      return {
        ok: false,
        errorKind: 'helper_buddy_not_signed_in',
        detail: 'codex sign-in unavailable',
        retryable: false,
      };
    }
    let bearer: string;
    try {
      bearer = await withAbort(this.provider.getBearer(), req.signal);
    } catch (error) {
      if (req.signal.aborted) return cancelledBackendResult(req.signal.reason);
      return {
        ok: false,
        errorKind: 'helper_buddy_not_signed_in',
        detail: errorMessage(error),
        retryable: false,
      };
    }
    if (!bearer.trim()) return signedOutBackendResult('codex bearer is unavailable');
    // Credential refresh is asynchronous. Cancellation can overtake it even
    // though the request was live at admission.
    if (req.signal.aborted) return cancelledBackendResult(req.signal.reason);
    let auth: ReturnType<CodexProvider['getCodexAuth']>;
    try {
      auth = this.provider.getCodexAuth();
    } catch (error) {
      return signedOutBackendResult(error);
    }
    // getBearer() may refresh credentials or overlap an account/sign-out
    // transition. Never pair the returned bearer with stale account metadata.
    if (auth === null) return signedOutBackendResult('codex sign-in unavailable');
    const responseStartTimeout = new AbortController();
    const timer = setTimeout(() => responseStartTimeout.abort(), this.responseStartTimeoutMs);
    timer.unref?.();
    let trace: ModelExecutionTrace | null = null;
    try {
      const body = {
        model: req.model,
        instructions: req.instructions,
        input: req.input,
        tools: req.tools,
        tool_choice: 'auto',
        stream: true,
        store: false,
        reasoning: { effort: req.effort },
        service_tier: 'priority',
      };
      trace = beginModelExecution({
        transport: 'chatgpt-codex-helper-buddy',
        model: req.model,
        operation: 'helper_buddy.responses.create',
        endpoint: CODEX_RESPONSES_URL,
        context: {
          ...req.runContext,
          reasoningEffort: req.effort,
          serviceTier: 'priority',
        },
      });
      trace?.request(body);
      const transportSignal = AbortSignal.any([req.signal, responseStartTimeout.signal]);
      const response = await withAbort(
        this.fetchImpl(CODEX_RESPONSES_URL, {
          method: 'POST',
          headers: buildCodexHeaders(bearer, auth.accountId),
          signal: transportSignal,
          body: JSON.stringify(body),
        }),
        transportSignal,
      );
      clearTimeout(timer);
      trace?.response({
        httpStatus: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });
      if (!response.ok) {
        const quota = isQuotaStatus(response.status);
        let detail: string;
        try {
          detail = await readResponseSnippet(response, 500, this.streamIdleTimeoutMs, req.signal);
        } catch (error) {
          if (req.signal.aborted) {
            trace?.cancel('helper buddy request cancelled while reading the error response');
            return cancelledBackendResult(req.signal.reason);
          }
          detail = `response body unavailable: ${errorMessage(error)}`;
        }
        trace?.fail(new Error(`http ${response.status}: ${detail}`), {
          quotaExhausted: quota,
        });
        return {
          ok: false,
          errorKind: quota ? 'helper_buddy_quota' : 'helper_buddy_backend_down',
          detail: `http ${response.status}: ${detail}`,
          retryable: !quota && response.status >= 500,
        };
      }
      const result = await parseHelperBuddyStream(
        response,
        this.streamIdleTimeoutMs,
        req.signal,
        trace,
      );
      if (result.ok) trace?.complete(result);
      else trace?.fail(new Error(result.detail), result);
      return result;
    } catch (error) {
      const responseStartTimedOut = responseStartTimeout.signal.aborted && !req.signal.aborted;
      if (req.signal.aborted) {
        trace?.cancel('helper buddy request cancelled');
        return cancelledBackendResult(error);
      }
      trace?.fail(error, { responseStartTimedOut });
      return {
        ok: false,
        errorKind: 'helper_buddy_backend_down',
        detail: responseStartTimedOut
          ? `backend response did not start within ${this.responseStartTimeoutMs}ms`
          : errorMessage(error),
        retryable: !req.signal.aborted,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function cancelledBackendResult(reason: unknown): HelperBuddyBackendResult {
  return {
    ok: false,
    errorKind: 'helper_buddy_backend_down',
    detail: errorMessage(reason),
    retryable: false,
  };
}

function signedOutBackendResult(reason: unknown): HelperBuddyBackendResult {
  return {
    ok: false,
    errorKind: 'helper_buddy_not_signed_in',
    detail: errorMessage(reason),
    retryable: false,
  };
}

function invalidRequestBackendResult(reason: unknown): HelperBuddyBackendResult {
  return {
    ok: false,
    errorKind: 'helper_buddy_backend_down',
    detail: errorMessage(reason),
    retryable: false,
  };
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseSnippet(
  response: Response,
  maxCharacters: number,
  idleTimeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    return (await withAbortAndIdleTimeout(response.text(), signal, idleTimeoutMs)).slice(
      0,
      maxCharacters,
    );
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < maxCharacters) {
      const { done, value } = await withAbortAndIdleTimeout(reader.read(), signal, idleTimeoutMs);
      if (done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (text.length >= maxCharacters) {
      await withAbortAndIdleTimeout(reader.cancel(), signal, idleTimeoutMs);
    }
    return text.slice(0, maxCharacters);
  } catch (error) {
    try {
      await withAbortAndIdleTimeout(reader.cancel(error), signal, idleTimeoutMs);
    } catch {
      // Preserve the admission cancellation or idle-timeout failure.
    }
    throw error;
  }
}

function withAbortAndIdleTimeout<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const timer = setTimeout(
      () =>
        finish(() => reject(new Error(`backend response body was idle for ${idleTimeoutMs}ms`))),
      idleTimeoutMs,
    );
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function parseHelperBuddyStream(
  response: Response,
  streamIdleTimeoutMs: number,
  signal: AbortSignal,
  trace: ModelExecutionTrace | null,
): Promise<HelperBuddyBackendResult> {
  const state = new HelperBuddyStreamState();
  await readSseLines(
    response,
    (line) => {
      // Malformed/unknown SSE lines are skipped; a terminal event still decides
      // the result.
      const event = parseSseEventLine(line);
      if (event !== null) {
        trace?.event('server', event);
        state.handle(event);
      }
    },
    {
      shouldStop: () => state.isTerminal(),
      idleTimeoutMs: streamIdleTimeoutMs,
      signal,
    },
  );
  return state.result(response.headers);
}

class HelperBuddyStreamState {
  private text = '';
  private failed: { detail: string; quota: boolean } | null = null;
  private readonly calls = new Map<string, HelperBuddyFunctionCall>();
  private usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
  private terminal = false;

  isTerminal(): boolean {
    return this.terminal;
  }

  handle(event: Record<string, unknown>): void {
    const type = asString(event['type']);
    if (type === 'response.output_text.delta') this.text += asString(event['delta']);
    if (type === 'response.output_text.done' && typeof event['text'] === 'string')
      this.text = event['text'];
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = asRecord(event['item']);
      if (item?.['type'] === 'function_call') this.captureCall(item);
    }
    if (type === 'response.function_call_arguments.done') {
      const id = asString(event['item_id']);
      const existing = this.calls.get(id);
      const callId = existing?.callId || asString(event['call_id']);
      const name = existing?.name || asString(event['name']);
      if (callId && name)
        this.calls.set(id, { callId, name, argsJson: asString(event['arguments']) });
    }
    if (type === 'response.completed') {
      this.terminal = true;
      const usage = asRecord(asRecord(event['response'])?.['usage']);
      if (usage) {
        this.usage = {
          inputTokens: asFiniteNumber(usage['input_tokens']) ?? 0,
          outputTokens: asFiniteNumber(usage['output_tokens']) ?? 0,
          totalTokens: asFiniteNumber(usage['total_tokens']) ?? 0,
        };
      }
    }
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      this.terminal = true;
      const error = asRecord(event['error']) ?? event;
      const detail = asString(error['message']) || type;
      this.failed = {
        detail,
        quota: HELPER_BUDDY_QUOTA_RE.test(JSON.stringify(error)),
      };
    }
  }

  result(headers: Headers): HelperBuddyBackendResult {
    if (this.failed) {
      return {
        ok: false,
        errorKind: this.failed.quota ? 'helper_buddy_quota' : 'helper_buddy_backend_down',
        detail: this.failed.detail,
        retryable: !this.failed.quota,
      };
    }
    if (!this.terminal) {
      return {
        ok: false,
        errorKind: 'helper_buddy_backend_down',
        detail: 'backend stream ended before a terminal event',
        retryable: true,
      };
    }
    const calls = [...this.calls.values()];
    const outputItems: ResponseItem[] = [];
    if (this.text)
      outputItems.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.text }],
      });
    for (const call of calls) {
      outputItems.push({
        type: 'function_call',
        call_id: call.callId,
        name: call.name,
        arguments: call.argsJson,
      });
    }
    return {
      ok: true,
      outputItems,
      text: this.text,
      functionCalls: calls,
      searchQueries: [],
      citations: [],
      usedPercent: parseUsedPercent(headers),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private captureCall(item: Record<string, unknown>): void {
    const id = asString(item['id']) || asString(item['call_id']);
    const callId = asString(item['call_id']);
    const name = asString(item['name']);
    if (id && callId && name) {
      this.calls.set(id, { callId, name, argsJson: asString(item['arguments']) });
    }
  }
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${label} timeout must be a positive finite number`);
  return value;
}
