/**
 * Renderer-safe repair state for failures the user can act on in Settings.
 *
 * This is deliberately narrower than the main process's complete error
 * catalog: transient failures stay on the lightweight conversation surfaces,
 * while these kinds persist until their relevant recovery signal arrives.
 */
export type ActionableErrorKind =
  | 'no_api_key'
  | 'api_key_rejected'
  | 'api_key_unreadable'
  | 'insufficient_quota'
  | 'model_unavailable'
  | 'api_access_forbidden'
  | 'mic_unavailable'
  | 'audio_output_failed'
  | 'capture_failed'
  | 'codex_plan_limit'
  | 'hotkey_dead'
  | 'settings_reset'
  | 'settings_save_failed'
  | 'helper_buddy_not_signed_in'
  | 'helper_buddy_quota';

/** Settings destination that can help resolve an actionable failure. */
export type ActionableErrorTarget =
  'permissions' | 'openai' | 'firecrawl' | 'chatgpt' | 'voice' | 'microphone' | 'settings';

/** Latest actionable failure, retained by main and replayed after renderer reloads. */
export interface ActionableErrorNotice {
  kind: ActionableErrorKind;
  message: string;
  target: ActionableErrorTarget;
  occurredAt: number;
}

/**
 * Monotonic envelope used to merge the renderer bootstrap snapshot with live
 * pushes without allowing a delayed older snapshot to win.
 */
export interface ActionableErrorState {
  revision: number;
  notice: ActionableErrorNotice | null;
}

/**
 * Compare-and-set token for acknowledging one exact notice. Recovery work is
 * often asynchronous; carrying both fields prevents an older success from
 * clearing a newer failure, including a newer failure with the same target.
 */
export interface ActionableErrorIdentity {
  revision: number;
  kind: ActionableErrorKind;
}
