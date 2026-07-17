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
 * - Web access is client-executed through Firecrawl v2 function tools. The
 *   provider-owned hosted web_search tool is deliberately never registered.
 * - Streaming SSE is the operating mode; response.completed may arrive with
 *   an EMPTY output array — output items must be accumulated from
 *   response.output_item.added/done events.
 */

import type { AgentStep, AgentSummary, ApprovalRequest, CaptureMeta } from '../../shared/types';
import type { ResponseItem } from '../codex/wire-types';
import type { CaptureResult } from '../capture';
import type { ComputerDriver } from '../computer/driver';
import type {
  GateDispatch,
  GateDriverPort,
  GateExecutionResult,
  GatedActionRequest,
  HumanApprovalDecision,
} from './gate/action-gate';
import type { TriggerAction } from './gate/trigger';
import type { FirecrawlClientPort } from '../firecrawl/client';

// Tuning constants (AGENT_*) live in agents/config.ts — this file is the pure
// type contract only.

// --- brief (built by conversation.ts at spawn) ---
export interface AgentBrief {
  id: string; // "agent_<seq>_<ts>"
  /** Exact latest typed/ASR user request; the reviewer trust anchor. */
  userRequest: string;
  /** Foreground-model rewrite used as the helper's working brief, never as user authority. */
  task: string;
  why?: string;
  screenshot?: { jpegBase64: string; meta: CaptureMeta }; // active display's turn capture
  recentTranscript: string; // last ~6 entries flattened "user:/clicky:", capped ~1500 chars
  createdAt: number;
  /** Explicit per-task capability grant. False keeps every acting tool out of the model request. */
  browserEnabled: boolean;
  /** Present only for a picker-authorized, no-web staged filesystem task. */
  filesystem?: { taskId: string; rootName: string };
}

export interface AgentFilesystemToolPort {
  /** Unsandboxed host shell starting in the picker-authorized folder. */
  runShell(
    taskId: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Materialize only explicitly requested relative paths into the private staging area. */
  stagePaths(taskId: string, paths: string[]): Promise<string>;
  /** Unsandboxed host shell starting in the sparse staging area. */
  runStagedShell(
    taskId: string,
    script: string,
    cwdRelative: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  describeChanges(taskId: string): Promise<string>;
  /** Select the finished regular file Buddy should present after the transaction commits. */
  presentFile(taskId: string, path: string): Promise<string>;
}

export type AgentBrowserAction = Exclude<TriggerAction, { kind: 'screenshot' }>;

/** Adapter boundary around the mechanical trigger + independent reviewer. */
export interface AgentActionGatePort {
  /** The gate is the only execution path and owns final TOCTOU re-inspection before dispatch. */
  execute(
    input: GatedActionRequest,
    dispatch: GateDispatch<void>,
  ): Promise<GateExecutionResult<void>>;
  /** Re-inspects immutable pending evidence before executing an explicitly approved action. */
  resolveEscalation(
    assessmentId: string,
    verdict: HumanApprovalDecision,
  ): Promise<GateExecutionResult<void>>;
  cancelAgent(agentId: string): void;
}

export type AgentApprovalVerdict = 'once' | 'always' | 'deny' | 'handled';

/**
 * One delivered human verdict. The parked executor must acknowledge only
 * after its downstream gate/dispatch work succeeds. Reject keeps the same
 * request visible and retryable; replace atomically swaps stale evidence.
 */
export interface AgentApprovalResolution {
  verdict: AgentApprovalVerdict;
  acknowledge(): void;
  reject(error: Error): void;
  replace(request: ApprovalRequest): Promise<AgentApprovalResolution>;
}

/** Parking/resume boundary owned by main-process approval UI wiring. */
export interface AgentApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<AgentApprovalResolution>;
  cancelAgent(agentId: string): void;
  get(approvalId: string): ApprovalRequest | null;
  /** Resolves only after the parked executor acknowledges successful downstream handling. */
  resolve(approvalId: string, verdict: AgentApprovalVerdict): Promise<void>;
}

export interface AgentBrowserDeps {
  createDriver(agentId: string): Promise<ComputerDriver & GateDriverPort>;
  gate: AgentActionGatePort;
  approvals: AgentApprovalPort;
  settleMs?: number;
  /** Electron-free test seam; production defaults to nativeImage JPEG→PNG conversion. */
  captureToPngDataUrl?(capture: CaptureResult): Promise<string>;
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

export type AgentToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// --- backend (implemented by agents/backend.ts; faked by agents/mock-backend.ts) ---
export interface AgentBackendRequest {
  model: string;
  instructions: string;
  input: ResponseItem[]; // FULL history each round (store:false backend)
  tools: AgentToolDefinition[];
  effort: 'low' | 'medium' | 'high';
  signal: AbortSignal;
  /** Stable correlation metadata for reconstructing one helper run across model requests. */
  runContext?: { agentId: string; requestAttempt: number };
}
export type AgentBackendErrorKind = 'agent_not_signed_in' | 'agent_quota' | 'agent_backend_down';
export type AgentBackendResult =
  | {
      ok: true;
      outputItems: ResponseItem[]; // accumulated from output_item.done events — append to history verbatim
      text: string; // assistant message text ('' if none this round)
      functionCalls: AgentFunctionCall[];
      searchQueries: string[]; // retained for mock/debug summaries; Firecrawl calls are function tools
      citations: string[]; // retained for mock/debug summaries; live URLs enter through addSource
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
  signal: AbortSignal; // aborts on explicit cancellation or an operation-level timeout
  scratchpad: { get(): string; set(text: string): void; append(text: string): void };
  addSource(url: string): void;
  /** Firecrawl v2 transport. Present for every non-filesystem helper in production. */
  firecrawl?: FirecrawlClientPort;
  /** Present only when this task was explicitly granted browser use. */
  browser?: AgentBrowserToolPort;
  /** Present only for a picker-authorized staged filesystem task. */
  filesystem?: AgentFilesystemToolPort;
}

export interface AgentBrowserToolResult {
  output: string;
  observation?: CaptureResult[];
  halt?: boolean;
}

export interface AgentBrowserToolPort {
  execute(name: string, args: Record<string, unknown>): Promise<AgentBrowserToolResult>;
  requestUser(args: Record<string, unknown>): Promise<AgentBrowserToolResult>;
  dispose(): Promise<void>;
}
export interface AgentToolSpec {
  definition: Extract<AgentToolDefinition, { type: 'function' }>;
  /** Omitted for locally parked tools such as needs_user; runner cancellation still applies. */
  timeoutMs?: number;
  stepKind: AgentStep['kind']; // activity-log kind for this tool
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
  /** Web-data transport; omitted only by isolated tests or web-disabled runtimes. */
  firecrawl?: FirecrawlClientPort;
  /** Absent means browser tasks fail closed and cannot be accepted. */
  browser?: AgentBrowserDeps;
  /** Absent means filesystem tasks fail closed and cannot be accepted. */
  filesystem?: AgentFilesystemToolPort;
}
export type SpawnResult =
  | { ok: true; agentId: string }
  | {
      ok: false;
      reason: 'not_signed_in' | 'browser_unavailable' | 'filesystem_unavailable';
    };
