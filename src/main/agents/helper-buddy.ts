import { describeKind } from '../errors';
import { helperBuddyModelOverride } from '../env';
import { asRecord, errorMessage, pushCapped } from '../util/guards';
import { recordModelToolExecution } from '../model-execution-recorder';
import type { HelperBuddySummary, HelperBuddyStep } from '../../shared/types';
import type { CaptureResult } from '../capture';
import { helperBuddyToolDefinitions, findHelperBuddyTool, isBrowserTool } from './tools';
import type {
  HelperBuddyBackend,
  HelperBuddyBackendResult,
  HelperBuddyBrief,
  HelperBuddyToolContext,
  HelperBuddyBrowserDeps,
  HelperBuddyModelImage,
  HelperBuddyToolResult,
  HelperBuddyFilesystemToolPort,
  ResponseItem,
} from './types';
import {
  HELPER_BUDDY_DEFAULT_MODEL,
  HELPER_BUDDY_REASONING_EFFORT,
  HELPER_BUDDY_REQUEST_MAX_ATTEMPTS,
  HELPER_BUDDY_RETRY_BASE_DELAY_MS,
  HELPER_BUDDY_STEP_LOG_CAP,
} from './helper-buddy-config';
import {
  buildInitialMessage,
  cloneHelperBuddySummary,
  concise,
  delay,
  isTerminal,
  stripLinks,
} from './helper-buddy-summary-text';
import { HelperBuddyBrowserRuntime } from './helper-buddy-browser-runtime';
import { compactHelperBuddyHistory } from './helper-buddy-history';
import { readActivityDescription } from './tools/activity-description';
import { requireCanonicalHelperBuddyId } from '../helper-buddy-id';
import { HELPER_BUDDY_INSTRUCTIONS } from './helper-buddy-instructions';

/**
 * Pure retry policy for one backend round: retry only failed results the
 * backend marked retryable (or generic backend-down blips), and never past
 * HELPER_BUDDY_REQUEST_MAX_ATTEMPTS. Quota / sign-in failures stop immediately.
 */
export function shouldRetry(result: HelperBuddyBackendResult, attempt: number): boolean {
  if (result.ok || attempt >= HELPER_BUDDY_REQUEST_MAX_ATTEMPTS - 1) return false;
  return result.retryable || result.errorKind === 'helper_buddy_backend_down';
}

export interface HelperBuddyRunnerOptions {
  brief: HelperBuddyBrief;
  backend: HelperBuddyBackend;
  onUpdate(summary: HelperBuddySummary): void;
  /** Backend model id; defaults to CLICKY_HELPER_BUDDY_MODEL, then HELPER_BUDDY_DEFAULT_MODEL. */
  model?: string;
  now?: () => number;
  browser: HelperBuddyBrowserDeps;
  filesystem: HelperBuddyFilesystemToolPort;
  firecrawl?: HelperBuddyToolContext['firecrawl'];
  memory: HelperBuddyToolContext['memory'];
}

export class HelperBuddyRunner {
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly model: string;
  private readonly sources = new Set<string>();
  private scratchpad = '';
  private shutdownWhileWaiting = false;
  private readonly browser: HelperBuddyBrowserRuntime;
  readonly summary: HelperBuddySummary;

  constructor(private readonly options: HelperBuddyRunnerOptions) {
    requireCanonicalHelperBuddyId(options.brief.id);
    this.now = options.now ?? Date.now;
    this.model = options.model ?? helperBuddyModelOverride() ?? HELPER_BUDDY_DEFAULT_MODEL;
    this.summary = {
      id: options.brief.id,
      task: options.brief.task,
      status: 'queued',
      createdAt: options.brief.createdAt,
      steps: [],
      spoken: false,
      unseen: false,
    };
    this.browser = new HelperBuddyBrowserRuntime({
      brief: options.brief,
      deps: options.browser,
      signal: this.controller.signal,
      getSteps: () => [...this.summary.steps],
      onPark: () => {
        if (this.controller.signal.aborted) return;
        this.patch({ status: 'waiting_approval' });
      },
      onResume: () => {
        if (this.controller.signal.aborted) return;
        this.patch({ status: 'running' });
      },
      onActivity: (kind, label) => this.addStep(kind, label),
    });
  }

  cancel(): void {
    if (isTerminal(this.summary.status)) return;
    this.controller.abort();
    void this.browser.dispose().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.shutdownWhileWaiting = this.summary.status === 'waiting_approval';
    this.cancel();
    await this.browser.dispose();
  }

  usesBrowser(): boolean {
    return true;
  }

  async showBrowserForUser(): Promise<void> {
    await this.browser.showForUser();
  }

  async hideBrowserFromUser(): Promise<void> {
    await this.browser.hideFromUser();
  }

  finishUnexpected(error: unknown): HelperBuddySummary {
    return this.finish({ status: 'failed', error: `something went wrong: ${errorMessage(error)}` });
  }

  async run(): Promise<HelperBuddySummary> {
    this.patch({ status: 'running', step: 1 });
    try {
      const memoryCatalog = {
        directory: this.options.memory.directory,
        memories: await this.options.memory.list(),
      };
      const history: ResponseItem[] = [buildInitialMessage(this.options.brief, memoryCatalog)];
      for (let step = 1; ; step += 1) {
        if (this.controller.signal.aborted) return this.finishStopped();
        this.patch({ step });
        const result = await this.requestWithRetry(history);
        if (this.controller.signal.aborted) return this.finishStopped();
        if (!result.ok) return this.finishFailure(result.errorKind);
        history.push(...result.outputItems);
        for (const query of result.searchQueries)
          this.addStep('search', `searching for “${query.slice(0, 100)}”`);
        for (const url of result.citations) this.sources.add(url);

        if (result.functionCalls.length === 0) {
          return this.finishDone(
            result.text || this.scratchpad || 'i finished, but there was no written result.',
          );
        }

        const executions = await Promise.all(
          result.functionCalls.map(async (call) => ({
            call,
            execution: await this.executeTool(call.callId, call.name, call.argsJson),
          })),
        );
        const observations: ResponseItem[] = [];
        for (const { call, execution } of executions) {
          history.push({
            type: 'function_call_output',
            call_id: call.callId,
            output: execution.output,
          });
          if (execution.observation?.length) {
            observations.push(browserObservation(execution.observation));
          }
          if (execution.modelImages?.length) {
            observations.push(filesystemImageObservation(execution.modelImages));
          }
          if (execution.halt) {
            return this.finish({
              status: 'failed',
              error:
                parseToolReason(execution.output) ||
                "i kept proposing actions the reviewer wouldn't pass, so i stopped — the details are on my card.",
            });
          }
        }
        history.push(...observations);
      }
    } finally {
      await this.browser.dispose();
    }
  }

  private async requestWithRetry(history: ResponseItem[]): Promise<HelperBuddyBackendResult> {
    const compactedHistory = compactHelperBuddyHistory(history);
    for (let attempt = 0; attempt < HELPER_BUDDY_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      const result = await this.options.backend.request({
        model: this.model,
        instructions: HELPER_BUDDY_INSTRUCTIONS,
        input: compactedHistory,
        tools: helperBuddyToolDefinitions(),
        effort: HELPER_BUDDY_REASONING_EFFORT,
        runContext: {
          helperBuddyId: this.options.brief.id,
          requestAttempt: attempt + 1,
        },
        // The backend enforces response-start and stream-idle deadlines. The
        // runner signal is intentionally only the run/cancellation boundary:
        // a fixed whole-response timeout would kill a healthy long stream.
        signal: this.controller.signal,
      });
      if (!shouldRetry(result, attempt) || this.controller.signal.aborted) return result;
      await delay(HELPER_BUDDY_RETRY_BASE_DELAY_MS * (attempt + 1), this.controller.signal);
    }
    return {
      ok: false,
      errorKind: 'helper_buddy_backend_down',
      detail: 'retry exhausted',
      retryable: false,
    };
  }

  private async executeTool(
    callId: string,
    name: string,
    argsJson: string,
  ): Promise<HelperBuddyToolResult> {
    const startedAt = this.now();
    const finish = (
      args: Record<string, unknown> | null,
      result: HelperBuddyToolResult,
    ): HelperBuddyToolResult => {
      recordModelToolExecution({
        helperBuddyId: this.options.brief.id,
        task: this.options.brief.task,
        callId,
        tool: name,
        rawArguments: argsJson,
        parsedArguments: args,
        result,
        startedAt,
        finishedAt: this.now(),
      });
      return result;
    };
    const tool = findHelperBuddyTool(name);
    if (!tool) return finish(null, { output: JSON.stringify({ error: `unknown tool: ${name}` }) });
    let args: Record<string, unknown>;
    try {
      args = asRecord(JSON.parse(argsJson || '{}')) ?? {};
    } catch {
      return finish(null, {
        output: JSON.stringify({ error: 'arguments were not valid json' }),
      });
    }
    const activity = readActivityDescription(args);
    if (!activity.ok) return finish(args, { output: JSON.stringify({ error: activity.error }) });
    this.addStep(tool.stepKind, activity.description);
    if (isBrowserTool(name)) {
      try {
        const result =
          name === 'needs_user'
            ? await this.browser.requestUser(args)
            : await this.browser.execute(name, args);
        return finish(args, result);
      } catch (error) {
        return finish(args, { output: JSON.stringify({ error: errorMessage(error) }) });
      }
    }
    const timeout = tool.timeoutMs === undefined ? null : AbortSignal.timeout(tool.timeoutMs);
    const ctx: HelperBuddyToolContext = {
      brief: this.options.brief,
      signal:
        timeout === null
          ? this.controller.signal
          : AbortSignal.any([this.controller.signal, timeout]),
      scratchpad: {
        get: () => this.scratchpad,
        set: (text) => {
          this.scratchpad = text;
        },
        append: (text) => {
          this.scratchpad = this.scratchpad ? `${this.scratchpad}\n${text}` : text;
        },
      },
      addSource: (url) => this.sources.add(url),
      memory: this.options.memory,
      ...(this.options.firecrawl ? { firecrawl: this.options.firecrawl } : {}),
      browser: this.browser,
      filesystem: this.options.filesystem,
    };
    try {
      const result = await tool.execute(args, ctx);
      return finish(args, typeof result === 'string' ? { output: result } : result);
    } catch (error) {
      return finish(args, { output: JSON.stringify({ error: errorMessage(error) }) });
    }
  }

  private addStep(kind: HelperBuddyStep['kind'], label: string): void {
    const step: HelperBuddyStep = { kind, label, at: this.now() };
    this.patch({ steps: pushCapped([...this.summary.steps], step, HELPER_BUDDY_STEP_LOG_CAP) });
  }

  private finishDone(text: string): HelperBuddySummary {
    return this.finish({
      status: 'done',
      summary: concise(stripLinks(text)),
      output: this.scratchpad || text,
    });
  }
  private finishFailure(
    kind: 'helper_buddy_not_signed_in' | 'helper_buddy_quota' | 'helper_buddy_backend_down',
  ): HelperBuddySummary {
    return this.finish({ status: 'failed', error: describeKind(kind).message });
  }
  private finishStopped(): HelperBuddySummary {
    return this.finish({
      status: 'cancelled',
      ...(this.shutdownWhileWaiting
        ? { summary: 'i was waiting on your ok when the app closed.' }
        : {}),
    });
  }
  private finish(
    patch: Partial<HelperBuddySummary> & {
      status: Extract<HelperBuddySummary['status'], 'done' | 'failed' | 'cancelled'>;
    },
  ): HelperBuddySummary {
    // Cancelled runs have no terminal card: the overlay deliberately removes
    // them immediately. Keeping one unseen would strand Buddy's result badge
    // with no visible card (and therefore no mark-seen IPC path) to clear it.
    const unseen = patch.status !== 'cancelled';
    this.patch({ ...patch, finishedAt: this.now(), sources: [...this.sources], unseen });
    return cloneHelperBuddySummary(this.summary);
  }
  private patch(patch: Partial<HelperBuddySummary>): void {
    Object.assign(this.summary, patch);
    this.options.onUpdate(cloneHelperBuddySummary(this.summary));
  }
}

function browserObservation(captures: CaptureResult[]): ResponseItem {
  const content: ResponseItem[] = [
    {
      type: 'input_text',
      text:
        'fresh buddy-browser observation returned by a previous tool call. inspect it before making browser decisions.\n' +
        captures
          .map(
            ({ meta }) =>
              `screen${meta.screenIndex}: ${meta.imageW}x${meta.imageH} screenshot pixels`,
          )
          .join('\n'),
    },
    ...captures.map((capture) => ({
      type: 'input_image',
      image_url: `data:image/jpeg;base64,${capture.jpegBase64}`,
    })),
  ];
  return { type: 'message', role: 'user', content };
}

function filesystemImageObservation(images: HelperBuddyModelImage[]): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text:
          'filesystem image selected by the previous tool call. inspect the attached image directly.\n' +
          images
            .map(
              (image) => `${JSON.stringify(image.path)} (${image.mimeType}, ${image.bytes} bytes)`,
            )
            .join('\n'),
      },
      ...images.map((image) => ({
        type: 'input_image',
        image_url: `data:${image.mimeType};base64,${image.base64}`,
      })),
    ],
  };
}

function parseToolReason(output: string): string {
  try {
    const parsed = asRecord(JSON.parse(output));
    return typeof parsed?.['reason'] === 'string' ? parsed['reason'] : '';
  } catch {
    return '';
  }
}
