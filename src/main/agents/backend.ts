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
import { AGENT_BACKEND_IDLE_TIMEOUT_MS } from './config';
import type {
  AgentBackend,
  AgentBackendRequest,
  AgentBackendResult,
  AgentFunctionCall,
  ResponseItem,
} from './types';

/**
 * The agent loop's OWN quota classifier for streamed error events. It is
 * deliberately NOT `transport.isQuotaErrorEvent`: this one scans the whole
 * JSON-serialized error record (nested fields included) but does not treat
 * "too many requests" / "insufficient..." as quota — and the loop's retry
 * behavior (quota = not retryable) was tuned against exactly this match.
 */
const AGENT_QUOTA_RE = /quota|usage.?limit|rate.?limit/i;

export interface CodexAgentBackendOptions {
  /** Maximum wait for HTTP response headers. */
  responseStartTimeoutMs?: number;
  /** Maximum silence between response-body chunks. */
  streamIdleTimeoutMs?: number;
}

export class CodexAgentBackend implements AgentBackend {
  private readonly responseStartTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(
    private readonly provider: CodexProvider = getCodexAuthProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
    options: CodexAgentBackendOptions = {},
  ) {
    this.responseStartTimeoutMs = positiveTimeout(
      options.responseStartTimeoutMs ?? AGENT_BACKEND_IDLE_TIMEOUT_MS,
      'response-start',
    );
    this.streamIdleTimeoutMs = positiveTimeout(
      options.streamIdleTimeoutMs ?? AGENT_BACKEND_IDLE_TIMEOUT_MS,
      'stream-idle',
    );
  }

  isReady(): boolean {
    return this.provider.getCodexAuth() !== null;
  }

  async request(req: AgentBackendRequest): Promise<AgentBackendResult> {
    const auth = this.provider.getCodexAuth();
    if (auth === null) {
      return {
        ok: false,
        errorKind: 'agent_not_signed_in',
        detail: 'codex sign-in unavailable',
        retryable: false,
      };
    }
    let bearer: string;
    try {
      bearer = await this.provider.getBearer();
    } catch (error) {
      return {
        ok: false,
        errorKind: 'agent_not_signed_in',
        detail: errorMessage(error),
        retryable: false,
      };
    }
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
        transport: 'chatgpt-codex-agent',
        model: req.model,
        operation: 'agent.responses.create',
        endpoint: CODEX_RESPONSES_URL,
        context: {
          ...req.runContext,
          reasoningEffort: req.effort,
          serviceTier: 'priority',
        },
      });
      trace?.request(body);
      const response = await this.fetchImpl(CODEX_RESPONSES_URL, {
        method: 'POST',
        headers: buildCodexHeaders(bearer, auth.accountId),
        signal: AbortSignal.any([req.signal, responseStartTimeout.signal]),
        body: JSON.stringify(body),
      });
      clearTimeout(timer);
      trace?.response({
        httpStatus: response.status,
        headers: Object.fromEntries(response.headers.entries()),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        const quota = isQuotaStatus(response.status);
        trace?.fail(new Error(`http ${response.status}: ${detail}`), {
          quotaExhausted: quota,
        });
        return {
          ok: false,
          errorKind: quota ? 'agent_quota' : 'agent_backend_down',
          detail: `http ${response.status}: ${detail}`,
          retryable: !quota && response.status >= 500,
        };
      }
      const result = await parseAgentStream(response, this.streamIdleTimeoutMs, trace);
      if (result.ok) trace?.complete(result);
      else trace?.fail(new Error(result.detail), result);
      return result;
    } catch (error) {
      const responseStartTimedOut = responseStartTimeout.signal.aborted && !req.signal.aborted;
      if (req.signal.aborted) trace?.cancel('agent request cancelled');
      else trace?.fail(error, { responseStartTimedOut });
      return {
        ok: false,
        errorKind: 'agent_backend_down',
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

async function parseAgentStream(
  response: Response,
  streamIdleTimeoutMs: number,
  trace: ModelExecutionTrace | null,
): Promise<AgentBackendResult> {
  const state = new AgentStreamState();
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
    },
  );
  return state.result(response.headers);
}

class AgentStreamState {
  private text = '';
  private failed: { detail: string; quota: boolean } | null = null;
  private readonly calls = new Map<string, AgentFunctionCall>();
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
        quota: AGENT_QUOTA_RE.test(JSON.stringify(error)),
      };
    }
  }

  result(headers: Headers): AgentBackendResult {
    if (this.failed) {
      return {
        ok: false,
        errorKind: this.failed.quota ? 'agent_quota' : 'agent_backend_down',
        detail: this.failed.detail,
        retryable: !this.failed.quota,
      };
    }
    if (!this.terminal) {
      return {
        ok: false,
        errorKind: 'agent_backend_down',
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
