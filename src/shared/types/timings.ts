/**
 * Per-turn latency instrumentation (M8.5 — audio-experience eval).
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

/**
 * Per-turn latency instrumentation collected by the conversation orchestrator.
 * All `t*` fields are epoch ms; optional fields stay absent until (unless)
 * the corresponding event happens for the turn.
 */
export interface TurnTimings {
  turnId: string;
  kind: 'voice' | 'text';
  /** Voice: hotkey went down. */
  tHoldStart?: number;
  /** Voice: hotkey released (== the "ask" moment for voice turns). */
  tHoldEnd?: number;
  /** Text: /ask (or panel composer) submitted. */
  tAsk?: number;
  /** Screenshot capture for this turn finished. */
  tCaptureDone?: number;
  /** Capture duration: tCaptureDone minus the capture kick-off. */
  captureMs?: number;
  /** input_audio_buffer.commit / conversation.item.create sent to the server. */
  tCommitSent?: number;
  /** First ASR transcript of the user's audio arrived. */
  tFirstUserTranscript?: number;
  /** First assistant transcript delta arrived. */
  tFirstAssistantTranscript?: number;
  /** First model audio delta arrived from the server. */
  tFirstAudioDelta?: number;
  /** First sample of the response actually rendered to the output device. */
  tFirstAudioPlayed?: number;
  /** First tool call (point_at) of the response arrived. */
  tFirstToolCall?: number;
  /**
   * M9: the pointer command actually reached the overlays (after the async
   * element-snap query). The eval must gate on this, not tFirstToolCall.
   */
  tPointerDispatched?: number;
  /** M9: wall time the first snap query of the turn took (incl. fallback). */
  snapMs?: number;
  /** Final response.done for the turn (after tool continuations). */
  tResponseDone?: number;
  /** Mic chunks appended during this turn's hold. */
  chunksIn: number;
  /** Model audio chunks received for this turn. */
  chunksOut: number;
  /** Barge-in: cancel requested -> playback actually stopped (ms). */
  bargeInStopMs?: number;
  /**
   * M8.5 live eval: token usage summed over every response.done of the turn
   * (a tool-call continuation is a second response). Absent until the first
   * response.done that carries a usage block (the mock sends none).
   */
  usage?: TurnUsage;
}

/** Accumulated token usage for one turn (from response.done usage blocks). */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  inputImageTokens: number;
  cachedTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  /** Number of response.done events accumulated. */
  responses: number;
}
