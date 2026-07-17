/**
 * M18 agent-mode tuning constants — every knob for the research-agent loop in
 * one place (docs/AGENT-MODE.md). The pure contracts stay in agents/types.ts;
 * this module carries only values.
 */

export const AGENT_STEP_LOG_CAP = 30;
/** Let a browser repaint/network handlers settle before the mandatory fresh observation. */
export const AGENT_BROWSER_SETTLE_MS = 350;
/** Browser act/capture/load boundary. Human approval waits deliberately do not use it. */
export const AGENT_BROWSER_TOOL_TIMEOUT_MS = 45_000;
/** Quit must not wait indefinitely for a backend/renderer that ignored abort. */
export const AGENT_MANAGER_DISPOSE_TIMEOUT_MS = 5_000;
/** Maximum silence while opening or consuming one backend response. */
export const AGENT_BACKEND_IDLE_TIMEOUT_MS = 90_000;
export const AGENT_TOOL_TIMEOUT_MS = 15_000;
/** Firecrawl search/scrape/map requests may render dynamic pages before returning. */
export const AGENT_FIRECRAWL_TIMEOUT_MS = 90_000;
/** Keep full articles useful while bounding a single function output in model history. */
export const AGENT_FIRECRAWL_MAX_CHARS = 60_000;
export const AGENT_DEFAULT_MODEL = 'gpt-5.6-sol'; // CLICKY_AGENT_MODEL env overrides
export const AGENT_REASONING_EFFORT = 'medium';

/** Backend request attempts per loop round (1 original + 1 retry). */
export const AGENT_REQUEST_MAX_ATTEMPTS = 2;
/** Linear retry backoff: attempt n waits n × this before re-requesting. */
export const AGENT_RETRY_BASE_DELAY_MS = 500;

/** Terminal summaries retained in agents.json across restarts. */
export const PERSISTED_SUMMARY_CAP = 50;
