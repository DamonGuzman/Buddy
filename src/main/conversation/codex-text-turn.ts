/**
 * M18: the TEXT panel path — a typed question runs on gpt-5.6-sol over the
 * user's ChatGPT (Codex) subscription: stream text to the transcript
 * (+ caption), hand complete tool calls to the shared router, and round-trip
 * buffered tool outputs through continue() like voice. Fails closed on plan
 * quota (codex_plan_limit) instead of spending the metered key.
 *
 * The runner owns the session cache (reused across turns so the session's
 * client-side history gives memory), the turn's tool promises, and the
 * plan-usage telemetry of the most recent text turn.
 */

import type { CaptionUpdate } from '../../shared/types';
import type { ChatGptCodexAuthSource } from '../auth/auth-source';
import type { CaptureResult } from '../capture';
import type {
  CodexFunctionCall,
  CodexResponsesCallbacks,
  CodexTurnResult,
  CodexUserTurn,
} from '../codex/responses-session';
import type { CodexUsedPercent } from '../grounding/rest-grounder';
import { buildScreenshotFraming } from '../realtime/framing';
import type { TurnTimings } from '../../shared/types';
import { MAX_CODEX_CONTINUES } from './constants';
import type { RecorderPort } from './ports';
import type { TranscriptStore } from './transcript-store';
import type { TurnGuard } from './turn-guard';
import type { TurnTelemetry } from './turn-telemetry';

/**
 * M18: the narrow slice of `CodexResponsesSession` the conversation drives for
 * the TEXT panel path. Kept as an interface so tests can inject a fake without
 * the real transport (see `ConversationDeps.buildCodexSession`).
 */
export interface CodexTextSession {
  submit(turn: CodexUserTurn, cb: CodexResponsesCallbacks): Promise<CodexTurnResult>;
  continue(cb: CodexResponsesCallbacks): Promise<CodexTurnResult>;
  sendToolOutput(callId: string, output: object): void;
  hasPendingToolOutputs(): boolean;
  cancel(): void;
  lastUsedPercent(): CodexUsedPercent | null;
}

export interface CodexTextTurnDeps {
  guard: TurnGuard;
  transcript: TranscriptStore;
  telemetry: TurnTelemetry;
  recorder: RecorderPort | null;
  /** Build a fresh session (persona + tools resolved at build time). */
  buildSession: (auth: ChatGptCodexAuthSource) => CodexTextSession;
  captionsEnabled: () => boolean;
  broadcastCaption: (update: CaptionUpdate) => void;
  /** A complete tool call from the text model (routed by the conversation). */
  onFunctionCall: (call: CodexFunctionCall, captures: CaptureResult[], token: number) => void;
  /** M17: fail-closed plan-limit copy, once per episode. */
  surfacePlanLimitOnce: (token: number) => void;
  failTurn: (err: unknown) => void;
  /** Turn settled cleanly: back to idle unless an error pill is showing. */
  setIdleUnlessError: () => void;
}

export class CodexTextTurnRunner {
  /** Reused across text turns so the session's client-side history gives memory. */
  private session: CodexTextSession | null = null;
  /** Plan-usage telemetry of the most recent text turn (debug surface). */
  private usedPercent: CodexUsedPercent | null = null;
  private toolPromises: Promise<void>[] = [];

  constructor(private readonly deps: CodexTextTurnDeps) {}

  /**
   * M18: the TEXT-path Codex session (built once, reused so multi-turn memory
   * replays through its client-side history).
   */
  private getSession(auth: ChatGptCodexAuthSource): CodexTextSession {
    if (this.session === null) this.session = this.deps.buildSession(auth);
    return this.session;
  }

  /** The live session, or null (callbacks may outlive a reset). */
  currentSession(): CodexTextSession | null {
    return this.session;
  }

  /** Abort any in-flight text turn (its stream stops emitting). */
  cancelActive(): void {
    this.session?.cancel();
  }

  /** Settings/persona changed: abort and drop the cached session. */
  reset(): void {
    this.session?.cancel();
    this.session = null;
  }

  lastUsedPercent(): CodexUsedPercent | null {
    return this.usedPercent;
  }

  /** Async tool output (use_computer) the turn must drain before settling. */
  trackToolPromise(pending: Promise<void>): void {
    this.toolPromises.push(pending);
  }

  private async drainToolPromises(): Promise<void> {
    while (this.toolPromises.length > 0) {
      const batch = this.toolPromises.splice(0);
      await Promise.allSettled(batch);
    }
  }

  /**
   * Run one typed turn on the Codex Responses backend. Returns true when the
   * turn ran to completion (the caller then knows the answer was delivered).
   */
  async run(
    text: string,
    captures: CaptureResult[],
    contextText: string,
    token: number,
    turn: TurnTimings,
    auth: ChatGptCodexAuthSource,
  ): Promise<boolean> {
    const { guard } = this.deps;
    const session = this.getSession(auth);
    const framing = buildScreenshotFraming(
      captures.map((c) => c.meta),
      contextText,
    );
    const input: CodexUserTurn = {
      text,
      ...(framing.length > 0 ? { context: framing } : {}),
      images: captures.map((c) => ({ jpegBase64: c.jpegBase64 })),
    };
    const cb: CodexResponsesCallbacks = {
      onTextDelta: (itemId, full) => this.onTextDelta(itemId, full, token),
      onTextDone: (itemId, done) => this.onTextDone(itemId, done, token),
      onFunctionCall: (call) => this.deps.onFunctionCall(call, captures, token),
      onCompleted: (info) => {
        this.usedPercent = info.usedPercent;
      },
      // Transport/protocol errors surface via the returned result below.
      onError: () => undefined,
    };

    let result: CodexTurnResult;
    try {
      result = await session.submit(input, cb);
    } catch (err) {
      if (guard.isCurrent(token)) this.deps.failTurn(err);
      return false;
    }
    turn.tCommitSent ??= Date.now();
    this.usedPercent = result.usedPercent ?? this.usedPercent;
    if (guard.isStale(token)) return false;
    if (result.quotaExhausted) {
      this.deps.surfacePlanLimitOnce(token);
      return false;
    }
    await this.drainToolPromises();
    if (result.aborted) return false; // superseded mid-stream
    if (result.error !== null) {
      this.deps.failTurn(result.error);
      return false;
    }

    // Tool round-trip: buffered function_call_output(s) -> continue, like voice.
    let continues = 0;
    while (
      session.hasPendingToolOutputs() &&
      !guard.isStale(token) &&
      continues < MAX_CODEX_CONTINUES
    ) {
      continues += 1;
      let next: CodexTurnResult;
      try {
        next = await session.continue(cb);
      } catch (err) {
        if (guard.isCurrent(token)) this.deps.failTurn(err);
        return false;
      }
      await this.drainToolPromises();
      this.usedPercent = next.usedPercent ?? this.usedPercent;
      if (guard.isStale(token)) return false;
      if (next.quotaExhausted) {
        this.deps.surfacePlanLimitOnce(token);
        return false;
      }
      if (next.aborted) return false;
      if (next.error !== null) {
        this.deps.failTurn(next.error);
        return false;
      }
    }

    this.finish(token);
    return true;
  }

  /** Streamed assistant text (full-so-far) -> transcript + caption (streaming). */
  private onTextDelta(itemId: string, full: string, token: number): void {
    if (this.deps.guard.isStale(token)) return;
    const turn = this.deps.telemetry.active();
    if (turn && turn.tFirstAssistantTranscript === undefined) {
      turn.tFirstAssistantTranscript = Date.now();
    }
    if (this.deps.captionsEnabled()) {
      this.deps.broadcastCaption({ itemId, text: full, done: false });
    }
    this.deps.transcript.upsertAssistantText(itemId, full, true);
  }

  /** A text item finished -> finalize transcript + caption. */
  private onTextDone(itemId: string, done: string, token: number): void {
    if (this.deps.guard.isStale(token)) return;
    if (this.deps.captionsEnabled()) {
      this.deps.broadcastCaption({ itemId, text: done, done: true });
    }
    this.deps.transcript.upsertAssistantText(itemId, done, false);
  }

  /** Settle a completed text turn: finalize any streaming entry, back to idle. */
  private finish(token: number): void {
    if (this.deps.guard.isStale(token)) return;
    this.deps.transcript.finalizeStreaming('assistant');
    const turn = this.deps.telemetry.active();
    if (turn) {
      turn.tResponseDone = Date.now();
      this.deps.recorder?.record('turn_finished', turn);
      this.deps.recorder?.flush();
    }
    this.deps.setIdleUnlessError();
  }
}
