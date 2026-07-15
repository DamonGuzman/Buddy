/**
 * Canonical narrowing guards for untrusted JSON — wire events, HTTP bodies,
 * tool-call arguments. One owner for the per-file helpers hand-rolled across
 * main: agents/backend.ts (`recordOf`/`stringOf`/`numberOf`/`messageOf`),
 * codex/responses-session.ts (`str`/`asError`), computer/operator.ts
 * (`finiteNumber`), debug-server.ts (`asRecord`).
 *
 * Adoption notes for later waves (semantic deltas to be aware of):
 * - `asRecord` REJECTS arrays (matches debug-server.ts). agents/backend.ts's
 *   `recordOf` accepted any non-null object, arrays included; for the
 *   Responses wire events it parses, an array is never a valid record, but
 *   verify that before swapping it in.
 * - agents/backend.ts's `numberOf` falls back to 0, not null:
 *   `numberOf(v)` === `asFiniteNumber(v) ?? 0`.
 * - codex/responses-session.ts's `asError` returns the original Error (stack
 *   preserved) — it is NOT `new Error(errorMessage(err))`; keep it local.
 */

/**
 * Narrow to a plain string-keyed record, or null. Arrays and null are
 * rejected — an untrusted `[]` must not pass as `{}`.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The string itself, or '' for any non-string (never coerces). */
export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A finite number, or null for anything else (never coerces; NaN/±Inf → null). */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The one idiom for logging a caught `unknown`: message of an Error, else String(). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Append to a capped history list, matching the hand-rolled ring idiom used
 * across main (`arr.push(item); if (arr.length > LIMIT) arr = arr.slice(-LIMIT)`):
 * mutates `arr` in place while under the cap, returns a fresh last-`limit`
 * slice once it overflows. Always reassign: `this.list = pushCapped(this.list, x, N)`.
 */
export function pushCapped<T>(arr: T[], item: T, limit: number): T[] {
  arr.push(item);
  return arr.length > limit ? arr.slice(-limit) : arr;
}
