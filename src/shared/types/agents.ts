/**
 * Agent mode types (M18, docs/AGENT-MODE.md).
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

/** Lifecycle of one background agent (docs/AGENT-MODE.md §2.4, §5.3). */
export type AgentStatus =
  'queued' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled';

/** One activity-log line on the agent Card (docs/AGENT-MODE.md §5.2). */
export interface AgentStep {
  kind: 'search' | 'fetch' | 'note' | 'think' | 'browse' | 'action' | 'review' | 'shell' | 'file';
  /** e.g. 'searched "best 27 inch monitor 2026"', 'read rtings.com/…'. */
  label: string;
  /** Epoch ms. */
  at: number;
}

/** A remembered consequence approval; alignment is still reviewed for every action. */
export interface ApprovalGrant {
  id: string;
  /** Registrable domain, never a full host or URL. */
  domain: string;
  actionKind: 'form-submit' | 'button' | 'keyboard-submit' | 'navigation';
  /** Normalized element descriptor, for example "create issue". */
  target: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  lastUsedAt: number;
  timesUsed: number;
}

/** Renderer-safe evidence for a buddy action that requires a human verdict. */
export interface ApprovalRequest {
  agentId: string;
  /** Immutable identifier for this exact pending assessment. */
  approvalId: string;
  kind: 'browser-capability' | 'browser-action' | 'needs-user' | 'live-action';
  /** Exact original request that authorizes this helper run; never derived from page or payload. */
  userRequest: string;
  /** Whether this assessment has a safe normalized signature for standing permission memory. */
  allowAlways: boolean;
  /** Human-readable normalized signature; null when standing permission is unavailable. */
  grantScope: string | null;
  /** Whether showing the controlled browser is meaningful for this request. */
  allowTakeover: boolean;
  /** Driver-derived ASCII registrable domain for controlled-browser actions. */
  browserDomain: string | null;
  actionText: string;
  concern: string;
  /** PNG data URL for the marked screenshot. */
  screenshotPng: string;
  /** Capped, credential-elided summary of the pending payload. */
  payloadDigest: string[];
}

/** Renderer-safe summary of authenticated state in the shared buddy browser profile. */
export interface EnrolledSite {
  domain: string;
  cookieCount: number;
}

/**
 * Renderer-safe agent record — the ONLY agent shape that crosses to the panel
 * (over `panel:agents` / `agents:list`). Screenshot bytes and the raw brief
 * NEVER cross; they stay in main's internal AgentBrief (src/main/agents).
 */
export interface AgentSummary {
  id: string;
  task: string;
  status: AgentStatus;
  createdAt: number;
  finishedAt?: number;
  /** Current loop round while running (1-based). */
  step?: number;
  /** Capped activity log (cap 30, oldest dropped). */
  steps: AgentStep[];
  /** Short recap — also the text voice speaks. */
  summary?: string;
  /** Full findings (scratchpad, light markdown). */
  output?: string;
  /** Urls (fetched + citations), deduped. */
  sources?: string[];
  /** Lowercase catalog copy when failed. */
  error?: string;
  /** Has voice delivered it yet (at-most-once spoken delivery). */
  spoken: boolean;
  /** Panel badge: finished but not yet viewed. */
  unseen: boolean;
}
