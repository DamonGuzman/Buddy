/**
 * M18 agent-mode tuning constants — every knob for the research-agent loop in
 * one place (docs/AGENT-MODE.md). The pure contracts stay in agents/types.ts;
 * this module carries only values.
 */

export const AGENT_MAX_CONCURRENT = 3;
export const AGENT_STEP_LOG_CAP = 30;
export const AGENT_RUN_WALL_CLOCK_MS = 4 * 60_000;
export const AGENT_BACKEND_TIMEOUT_MS = 90_000; // per backend request (search rounds can be slow)
export const AGENT_TOOL_TIMEOUT_MS = 15_000;
export const AGENT_FETCH_TIMEOUT_MS = 20_000;
export const AGENT_FETCH_MAX_CHARS = 8_000;
export const AGENT_FETCH_MAX_CALLS = 6; // per run
export const AGENT_DEFAULT_MODEL = 'gpt-5.6-sol'; // CLICKY_AGENT_MODEL env overrides
export const AGENT_REASONING_EFFORT = 'medium';

/** Backend request attempts per loop round (1 original + 1 retry). */
export const AGENT_REQUEST_MAX_ATTEMPTS = 2;
/** Linear retry backoff: attempt n waits n × this before re-requesting. */
export const AGENT_RETRY_BASE_DELAY_MS = 500;

/** Terminal summaries retained in agents.json across restarts. */
export const PERSISTED_SUMMARY_CAP = 50;
