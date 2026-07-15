/**
 * Agent mode types (M18, docs/AGENT-MODE.md).
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §5, §9).
 */

/** Lifecycle of one background agent (docs/AGENT-MODE.md §2.4, §5.3). */
export type AgentStatus = 'queued' | 'running' | 'done' | 'failed' | 'timed_out' | 'cancelled';

/** One activity-log line on the agent Card (docs/AGENT-MODE.md §5.2). */
export interface AgentStep {
  kind: 'search' | 'fetch' | 'note' | 'think';
  /** e.g. 'searched "best 27 inch monitor 2026"', 'read rtings.com/…'. */
  label: string;
  /** Epoch ms. */
  at: number;
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
  /** Tool-round ceiling, or null when the agent may continue until stopped or timed out. */
  maxSteps: number | null;
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
