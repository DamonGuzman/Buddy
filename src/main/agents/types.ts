/**
 * M18 helper-buddy internal contracts — see docs/HELPER-BUDDY-MODE.md. NOT
 * renderer-visible: nothing here crosses an IPC boundary. The renderer-safe
 * shapes (HelperBuddySummary/HelperBuddyStatus/HelperBuddyStep) live in src/shared/types.ts;
 * this file is the seam between the helper-buddy modules built in parallel —
 * helper-buddy-manager.ts / helper-buddy.ts / helper-buddy-backend.ts /
 * mock-helper-buddy-backend.ts / tools/*.
 *
 * Backend reality (live probe of chatgpt.com/backend-api/codex/responses,
 * overriding HELPER-BUDDY-MODE.md §2.1 where they conflict):
 * - `store` MUST be false; `previous_response_id` is REJECTED. The loop keeps
 *   CLIENT-SIDE history and re-sends the full `input` list every round.
 * - Web access is client-executed through Firecrawl v2 function tools. The
 *   provider-owned hosted web_search tool is deliberately never registered.
 * - Streaming SSE is the operating mode; response.completed may arrive with
 *   an EMPTY output array — output items must be accumulated from
 *   response.output_item.added/done events.
 */

import type {
  HelperBuddyStep,
  HelperBuddySummary,
  ApprovalRequest,
  CaptureMeta,
} from '../../shared/types';
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

// Tuning constants live in agents/helper-buddy-config.ts — this file is the pure
// type contract only.

// --- brief (built by conversation.ts at spawn) ---
export interface HelperBuddyBrief {
  id: string; // "helper_buddy_<uuid>"
  /** Exact latest typed/ASR user request; the reviewer trust anchor. */
  userRequest: string;
  /** Foreground-model rewrite used as the helper's working brief, never as user authority. */
  task: string;
  why?: string;
  screenshot?: { jpegBase64: string; meta: CaptureMeta }; // active display's turn capture
  recentTranscript: string; // last ~6 entries flattened "user:/clicky:", capped ~1500 chars
  createdAt: number;
  /** Picker-authorized transactional workspace available alongside the shared browser. */
  filesystem: { taskId: string; rootName: string };
}

export interface HelperBuddyFilesystemToolPort {
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
  /** Read one selected-folder-relative image for multimodal model inspection. */
  viewImage(taskId: string, path: string): Promise<HelperBuddyModelImage>;
  /** Select the finished regular file Buddy should present after the transaction commits. */
  presentFile(taskId: string, path: string): Promise<string>;
}

export interface HelperBuddyModelImage {
  path: string;
  mimeType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
  bytes: number;
}

export interface HelperBuddyMemoryMetadata {
  name: string;
  usage: string;
  fileName: string;
  path: string;
}

export interface HelperBuddyMemorySaveInput {
  name: string;
  usage: string;
  content: string;
}

/** Durable Markdown memory shared by every background helper buddy. */
export interface HelperBuddyMemoryToolPort {
  /** Absolute owner-only directory exposed in the progressive-disclosure catalog. */
  readonly directory: string;
  list(): Promise<HelperBuddyMemoryMetadata[]>;
  save(input: HelperBuddyMemorySaveInput): Promise<HelperBuddyMemoryMetadata>;
  load(name: string): Promise<string>;
  delete(name: string): Promise<void>;
}

export type HelperBuddyBrowserAction = Exclude<TriggerAction, { kind: 'screenshot' }>;

/** Adapter boundary around the mechanical trigger + independent reviewer. */
export interface HelperBuddyActionGatePort {
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
  cancelHelperBuddy(helperBuddyId: string): void;
}

export type HelperBuddyApprovalVerdict = 'once' | 'always' | 'deny' | 'handled';

/**
 * One delivered human verdict. The parked executor must acknowledge only
 * after its downstream gate/dispatch work succeeds. Reject keeps the same
 * request visible and retryable; replace atomically swaps stale evidence.
 */
export interface HelperBuddyApprovalResolution {
  verdict: HelperBuddyApprovalVerdict;
  acknowledge(): void;
  reject(error: Error): void;
  replace(request: ApprovalRequest): Promise<HelperBuddyApprovalResolution>;
}

/** Parking/resume boundary owned by main-process approval UI wiring. */
export interface HelperBuddyApprovalPort {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<HelperBuddyApprovalResolution>;
  cancelHelperBuddy(helperBuddyId: string): void;
  get(approvalId: string): ApprovalRequest | null;
  /** Resolves only after the parked executor acknowledges successful downstream handling. */
  resolve(approvalId: string, verdict: HelperBuddyApprovalVerdict): Promise<void>;
}

export interface HelperBuddyBrowserDeps {
  createDriver(helperBuddyId: string): Promise<ComputerDriver & GateDriverPort>;
  gate: HelperBuddyActionGatePort;
  approvals: HelperBuddyApprovalPort;
  settleMs?: number;
  /** Electron-free test seam; production defaults to nativeImage JPEG→PNG conversion. */
  captureToPngDataUrl?(capture: CaptureResult): Promise<string>;
}

// --- Responses-API wire shapes (client-side history; store:false) ---
// Re-homed to codex/wire-types.ts so all Codex-backend consumers share one
// definition (kept loose on purpose: backend items are appended VERBATIM).
export type { ResponseItem };

export interface HelperBuddyFunctionCall {
  callId: string;
  name: string;
  argsJson: string;
}

export type HelperBuddyToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// --- backend (implemented by agents/helper-buddy-backend.ts; faked by agents/mock-helper-buddy-backend.ts) ---
export interface HelperBuddyBackendRequest {
  model: string;
  instructions: string;
  input: ResponseItem[]; // FULL history each round (store:false backend)
  tools: HelperBuddyToolDefinition[];
  effort: 'low' | 'medium' | 'high';
  signal: AbortSignal;
  /** Stable correlation metadata for reconstructing one helper run across model requests. */
  runContext?: { helperBuddyId: string; requestAttempt: number };
}
export type HelperBuddyBackendErrorKind =
  'helper_buddy_not_signed_in' | 'helper_buddy_quota' | 'helper_buddy_backend_down';
export type HelperBuddyBackendResult =
  | {
      ok: true;
      outputItems: ResponseItem[]; // accumulated from output_item.done events — append to history verbatim
      text: string; // assistant message text ('' if none this round)
      functionCalls: HelperBuddyFunctionCall[];
      searchQueries: string[]; // retained for mock/debug summaries; Firecrawl calls are function tools
      citations: string[]; // retained for mock/debug summaries; live URLs enter through addSource
      usedPercent: { primary: number | null; secondary: number | null } | null;
      usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  | { ok: false; errorKind: HelperBuddyBackendErrorKind; detail: string; retryable: boolean };
export interface HelperBuddyBackend {
  /** Never throws; classifies failures into HelperBuddyBackendResult. Aborting `signal` yields ok:false helper_buddy_backend_down retryable:false. */
  request(req: HelperBuddyBackendRequest): Promise<HelperBuddyBackendResult>;
  /** Current readiness to accept a run (Codex: signed in; mock: always). */
  isReady(): boolean;
}

// --- tools (implemented by agents/tools/*; registry in agents/tools/index.ts) ---
export interface HelperBuddyToolContext {
  brief: HelperBuddyBrief;
  signal: AbortSignal; // aborts on explicit cancellation or an operation-level timeout
  scratchpad: { get(): string; set(text: string): void; append(text: string): void };
  addSource(url: string): void;
  memory: HelperBuddyMemoryToolPort;
  /** Firecrawl v2 transport. Present for every helper buddy in production. */
  firecrawl?: FirecrawlClientPort;
  /** Shared persistent-browser capability, guarded by ActionGate. */
  browser: HelperBuddyBrowserToolPort;
  /** Picker-authorized staged filesystem capability. */
  filesystem: HelperBuddyFilesystemToolPort;
}

/** A tool result plus optional model-visible content for the next loop round. */
export interface HelperBuddyToolResult {
  output: string;
  /** Fresh browser screenshots represented in Buddy's capture contract. */
  observation?: CaptureResult[];
  /** Filesystem images selected explicitly by the helper. */
  modelImages?: HelperBuddyModelImage[];
  halt?: boolean;
}

export interface HelperBuddyBrowserToolPort {
  execute(name: string, args: Record<string, unknown>): Promise<HelperBuddyToolResult>;
  requestUser(args: Record<string, unknown>): Promise<HelperBuddyToolResult>;
  dispose(): Promise<void>;
}
export interface HelperBuddyToolSpec {
  definition: Extract<HelperBuddyToolDefinition, { type: 'function' }>;
  /** Omitted for locally parked tools such as needs_user; runner cancellation still applies. */
  timeoutMs?: number;
  stepKind: HelperBuddyStep['kind']; // activity-log kind for this tool
  /** Returns the function output and, when needed, model-visible image content for the next round. */
  execute(
    args: Record<string, unknown>,
    ctx: HelperBuddyToolContext,
  ): Promise<string | HelperBuddyToolResult>;
}

// --- manager surfaces (implemented by agents/helper-buddy-manager.ts; consumed by index.ts/conversation.ts) ---

/**
 * Where completed summaries are retained across restarts. The default
 * file-backed implementation (agents/helper-buddy-manager.ts createFilePersistence) writes
 * tmp+rename with mode 0o600; tests inject in-memory ports.
 */
export interface HelperBuddyPersistencePort {
  /** Raw parsed JSON (validated by the manager), or null when nothing is stored. May throw. */
  load(): unknown;
  /** Replace the stored list. May throw (the manager treats failures as non-fatal). */
  save(records: HelperBuddySummary[]): void;
}

export interface HelperBuddyManagerDeps {
  backend: HelperBuddyBackend;
  memory: HelperBuddyMemoryToolPort;
  /** Current ChatGPT-subscription readiness; checked before accepting a run. */
  isReady(): boolean;
  /** Push the full renderer-safe list to the overlay helper-buddy surface. */
  onHelperBuddiesChanged(list: HelperBuddySummary[]): void;
  /** Fires once per helper buddy reaching a terminal status. */
  onFinished(summary: HelperBuddySummary): void;
  /** Tray balloon nudge; injected so manager stays Electron-free in tests. */
  notify?(title: string, body: string): void;
  /** Optional JSON file used to retain completed summaries across restarts. */
  persistencePath?: string;
  /** Overrides persistencePath with a custom store (tests / future backends). */
  persistence?: HelperBuddyPersistencePort;
  now?(): number;
  /** Web-data transport; omitted only by isolated tests or web-disabled runtimes. */
  firecrawl?: FirecrawlClientPort;
  /** Absent means browser tasks fail closed and cannot be accepted. */
  browser?: HelperBuddyBrowserDeps;
  /** Absent means filesystem tasks fail closed and cannot be accepted. */
  filesystem?: HelperBuddyFilesystemToolPort;
}
export type HelperBuddySpawnResult =
  | { ok: true; helperBuddyId: string }
  | {
      ok: false;
      reason: 'not_signed_in' | 'browser_unavailable' | 'filesystem_unavailable';
    };
