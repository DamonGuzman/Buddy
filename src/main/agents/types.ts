/**
 * M18 agent-mode internal contracts — see docs/AGENT-MODE.md. NOT
 * renderer-visible: nothing here crosses an IPC boundary. The renderer-safe
 * shapes (AgentSummary/AgentStatus/AgentStep) live in src/shared/types.ts;
 * this file is the seam between the agent modules built in parallel —
 * manager.ts / agent.ts / backend.ts / mock-backend.ts / tools/*.
 *
 * Backend reality (live probe of chatgpt.com/backend-api/codex/responses,
 * overriding AGENT-MODE.md §2.1 where they conflict):
 * - `store` MUST be false; `previous_response_id` is REJECTED. The loop keeps
 *   CLIENT-SIDE history and re-sends the full `input` list every round.
 * - The hosted `{"type":"web_search"}` tool IS supported server-side (with
 *   response.web_search_call.* SSE events and URL-citation annotation
 *   events) — there is NO client-side web_search executor. Client-side
 *   function tools: web_fetch, scratchpad_write, read_screen.
 * - Streaming SSE is the operating mode; response.completed may arrive with
 *   an EMPTY output array — output items must be accumulated from
 *   response.output_item.added/done events.
 */

import type { AgentStep, AgentSummary, CaptureMeta } from '../../shared/types';
import type { ResponseItem } from '../codex/wire-types';

// Tuning constants (AGENT_*) live in agents/config.ts — this file is the pure
// type contract only.

// --- brief (built by conversation.ts at spawn) ---
export interface AgentBrief {
  id: string; // "agent_<seq>_<ts>"
  task: string;
  why?: string;
  screenshot?: { jpegBase64: string; meta: CaptureMeta }; // active display's turn capture
  recentTranscript: string; // last ~6 entries flattened "user:/clicky:", capped ~1500 chars
  createdAt: number;
}

// --- Responses-API wire shapes (client-side history; store:false) ---
// Re-homed to codex/wire-types.ts so all Codex-backend consumers share one
// definition (kept loose on purpose: backend items are appended VERBATIM).
export type { ResponseItem };

export interface AgentFunctionCall {
  callId: string;
  name: string;
  argsJson: string;
}

export type AgentToolDefinition =
  | { type: 'web_search' } // hosted, server-side
  | { type: 'function'; name: string; description: string; parameters: Record<string, unknown> };

// --- backend (implemented by agents/backend.ts; faked by agents/mock-backend.ts) ---
export interface AgentBackendRequest {
  model: string;
  instructions: string;
  input: ResponseItem[]; // FULL history each round (store:false backend)
  tools: AgentToolDefinition[];
  effort: 'low' | 'medium' | 'high';
  signal: AbortSignal;
}
export type AgentBackendErrorKind = 'agent_not_signed_in' | 'agent_quota' | 'agent_backend_down';
export type AgentBackendResult =
  | {
      ok: true;
      outputItems: ResponseItem[]; // accumulated from output_item.done events — append to history verbatim
      text: string; // assistant message text ('' if none this round)
      functionCalls: AgentFunctionCall[];
      searchQueries: string[]; // from response.web_search_call events (for the activity log)
      citations: string[]; // urls from output_text.annotation.added events
      usedPercent: { primary: number | null; secondary: number | null } | null;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | { ok: false; errorKind: AgentBackendErrorKind; detail: string; retryable: boolean };
export interface AgentBackend {
  /** Never throws; classifies failures into AgentBackendResult. Aborting `signal` yields ok:false agent_backend_down retryable:false. */
  request(req: AgentBackendRequest): Promise<AgentBackendResult>;
  /** Current readiness to accept a run (Codex: signed in; mock: always). */
  isReady(): boolean;
}

// --- tools (implemented by agents/tools/*; registry in agents/tools/index.ts) ---
export interface AgentToolContext {
  brief: AgentBrief;
  signal: AbortSignal; // aborts on cancel/wall-clock
  scratchpad: { get(): string; set(text: string): void; append(text: string): void };
  addSource(url: string): void;
  fetchCount(): number; // web_fetch budget bookkeeping
  noteFetch(): void;
}
export interface AgentToolSpec {
  definition: Extract<AgentToolDefinition, { type: 'function' }>;
  timeoutMs: number;
  stepKind: AgentStep['kind']; // activity-log kind for this tool
  stepLabel(args: Record<string, unknown>): string;
  /** Returns the function_call_output string handed back to the model. Throws/rejects → the loop wraps as {error}. */
  execute(args: Record<string, unknown>, ctx: AgentToolContext): Promise<string>;
}

// --- manager surfaces (implemented by agents/manager.ts; consumed by index.ts/conversation.ts) ---

/**
 * Where completed summaries are retained across restarts. The default
 * file-backed implementation (agents/manager.ts createFilePersistence) writes
 * tmp+rename with mode 0o600; tests inject in-memory ports.
 */
export interface AgentPersistencePort {
  /** Raw parsed JSON (validated by the manager), or null when nothing is stored. May throw. */
  load(): unknown;
  /** Replace the stored list. May throw (the manager treats failures as non-fatal). */
  save(records: AgentSummary[]): void;
}

export interface AgentManagerDeps {
  backend: AgentBackend;
  /** Current ChatGPT-subscription readiness; checked before accepting a run. */
  isReady(): boolean;
  /** Push the full renderer-safe list (→ panel.send('panel:agents', …)). */
  onAgentsChanged(list: AgentSummary[]): void;
  /** Fires once per agent reaching a terminal status. */
  onFinished(summary: AgentSummary): void;
  /** Tray balloon nudge; injected so manager stays Electron-free in tests. */
  notify?(title: string, body: string): void;
  /** Optional JSON file used to retain completed summaries across restarts. */
  persistencePath?: string;
  /** Overrides persistencePath with a custom store (tests / future backends). */
  persistence?: AgentPersistencePort;
  now?(): number;
}
export type SpawnResult =
  { ok: true; agentId: string } | { ok: false; reason: 'at_capacity' | 'not_signed_in' };
