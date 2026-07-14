import type { CodexProvider } from '../auth/auth-source';
import { getCodexAuthProvider } from '../auth/codex-auth';
import type {
  AgentBackend,
  AgentBackendRequest,
  AgentBackendResult,
  AgentFunctionCall,
  ResponseItem,
} from './types';

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ORIGINATOR = 'codex_cli_rs';
const USER_AGENT = 'codex_cli_rs/0.48.0 (Windows 11; x86_64) unknown';

export class CodexAgentBackend implements AgentBackend {
  constructor(
    private readonly provider: CodexProvider = getCodexAuthProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
        detail: messageOf(error),
        retryable: false,
      };
    }
    try {
      const response = await this.fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'ChatGPT-Account-Id': auth.accountId,
          Accept: 'text/event-stream',
          'OpenAI-Beta': 'responses=experimental',
          originator: ORIGINATOR,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          instructions: req.instructions,
          input: req.input,
          tools: req.tools,
          tool_choice: 'auto',
          stream: true,
          store: false,
          reasoning: { effort: req.effort },
          service_tier: 'priority',
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        const quota = response.status === 402 || response.status === 403 || response.status === 429;
        return {
          ok: false,
          errorKind: quota ? 'agent_quota' : 'agent_backend_down',
          detail: `http ${response.status}: ${detail}`,
          retryable: !quota && response.status >= 500,
        };
      }
      return await parseAgentStream(response);
    } catch (error) {
      return {
        ok: false,
        errorKind: 'agent_backend_down',
        detail: messageOf(error),
        retryable: !req.signal.aborted,
      };
    }
  }
}

async function parseAgentStream(response: Response): Promise<AgentBackendResult> {
  const state = new AgentStreamState();
  const consume = (line: string): void => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      state.handle(event);
    } catch {
      // Ignore malformed/unknown SSE lines; a terminal event still decides the result.
    }
  };
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer) consume(buffer);
  } else {
    for (const line of (await response.text()).split(/\r?\n/)) consume(line);
  }
  return state.result(response.headers);
}

class AgentStreamState {
  private text = '';
  private failed: { detail: string; quota: boolean } | null = null;
  private readonly calls = new Map<string, AgentFunctionCall>();
  private readonly queries = new Set<string>();
  private readonly citations = new Set<string>();
  private usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

  handle(event: Record<string, unknown>): void {
    const type = stringOf(event['type']);
    if (type === 'response.output_text.delta') this.text += stringOf(event['delta']);
    if (type === 'response.output_text.done' && typeof event['text'] === 'string')
      this.text = event['text'];
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = recordOf(event['item']);
      if (item?.['type'] === 'function_call') this.captureCall(item);
      this.captureSearch(item);
    }
    if (type === 'response.function_call_arguments.done') {
      const id = stringOf(event['item_id']);
      const existing = this.calls.get(id);
      const callId = existing?.callId || stringOf(event['call_id']);
      const name = existing?.name || stringOf(event['name']);
      if (callId && name)
        this.calls.set(id, { callId, name, argsJson: stringOf(event['arguments']) });
    }
    if (type.startsWith('response.web_search_call.'))
      this.captureSearch(recordOf(event['item']) ?? event);
    if (type === 'response.output_text.annotation.added') {
      const annotation = recordOf(event['annotation']);
      const url = stringOf(annotation?.['url']);
      if (url) this.citations.add(url);
    }
    if (type === 'response.completed') {
      const usage = recordOf(recordOf(event['response'])?.['usage']);
      if (usage) {
        this.usage = {
          inputTokens: numberOf(usage['input_tokens']),
          outputTokens: numberOf(usage['output_tokens']),
          totalTokens: numberOf(usage['total_tokens']),
        };
      }
    }
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      const error = recordOf(event['error']) ?? event;
      const detail = stringOf(error['message']) || type;
      this.failed = {
        detail,
        quota: /quota|usage.?limit|rate.?limit/i.test(JSON.stringify(error)),
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
      searchQueries: [...this.queries],
      citations: [...this.citations],
      usedPercent: {
        primary: nullableNumber(headers.get('x-codex-primary-used-percent')),
        secondary: nullableNumber(headers.get('x-codex-secondary-used-percent')),
      },
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }

  private captureCall(item: Record<string, unknown>): void {
    const id = stringOf(item['id']) || stringOf(item['call_id']);
    const callId = stringOf(item['call_id']);
    const name = stringOf(item['name']);
    if (id && callId && name) {
      this.calls.set(id, { callId, name, argsJson: stringOf(item['arguments']) });
    }
  }

  private captureSearch(item: Record<string, unknown> | null): void {
    if (!item) return;
    const action = recordOf(item['action']);
    const query = stringOf(action?.['query']) || stringOf(item['query']);
    if (query) this.queries.add(query);
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function nullableNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
