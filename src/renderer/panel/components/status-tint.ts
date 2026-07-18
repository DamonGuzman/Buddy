/**
 * One owner of the tinted status badge/pill idiom (border + background at
 * low alpha + bright text) shared by the header state badge, the settings
 * key/sign-in badges, and helper-buddy status pills.
 */
export const STATUS_TINT = {
  /** Success: key saved, signed in, speaking, helper buddy done. */
  positive: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  /** Attention: expired session, thinking, mock server. */
  warning: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  /** Failure: errors, unreadable key, failed/timed-out agents. */
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  /** Buddy-blue activity: listening, running agents. */
  accent: 'border-clicky/40 bg-clicky/10 text-clicky',
  /** Dev/QA flags. */
  dev: 'border-violet-400/40 bg-violet-400/10 text-violet-300',
} as const;

export type StatusTone = keyof typeof STATUS_TINT;
