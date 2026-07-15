/**
 * Turn-supersede bookkeeping — the one owner of the four counters every async
 * continuation in the conversation checks against:
 *
 * - `turnToken` (F1 M1/m1): bumped whenever a new turn supersedes the current
 *   one (hold-start, askText, forced cancel, settings rebuild). Continuations
 *   capture it and bail after each await if it moved on.
 * - `epoch` (M3/M5): bumped on any turn/response activity; guards the
 *   idle-grace timer against settling a superseded episode.
 * - `playbackEpoch` / `deltaEpoch` (F1 M2): main-owned playback epoch.
 *   `playbackEpoch` bumps on every cancel/supersede/session-rebuild;
 *   `deltaEpoch` is the epoch stamped onto forwarded audio deltas, locked in
 *   when a response is requested — so a cancelled response's late deltas
 *   always carry a stale epoch.
 * - `closed`: app shutdown folds into the same staleness check.
 */

export class TurnGuard {
  private turnToken = 0;
  private epochValue = 0;
  private playbackEpochValue = 0;
  private deltaEpochValue = 0;
  private closedValue = false;

  /** App shutdown: every captured token is stale from here on. */
  close(): void {
    this.closedValue = true;
  }

  get closed(): boolean {
    return this.closedValue;
  }

  /** Start a new episode (supersedes everything in flight); returns its token. */
  beginEpisode(): number {
    return (this.turnToken += 1);
  }

  currentToken(): number {
    return this.turnToken;
  }

  /** True when a continuation holding `token` must bail (superseded/closed). */
  isStale(token: number): boolean {
    return this.closedValue || token !== this.turnToken;
  }

  /**
   * Token-only currency check — deliberately IGNORES `closed`. Failure paths
   * use it so a turn that dies during shutdown still runs its fail-soft
   * surfacing (matching the original `token === this.turnToken` sites).
   */
  isCurrent(token: number): boolean {
    return token === this.turnToken;
  }

  /** Bumped on any turn/response activity; guards the idle-grace timer. */
  bumpEpoch(): number {
    return (this.epochValue += 1);
  }

  epoch(): number {
    return this.epochValue;
  }

  /** Cancel/supersede/rebuild: audio queued under older epochs goes stale. */
  bumpPlaybackEpoch(): number {
    return (this.playbackEpochValue += 1);
  }

  playbackEpoch(): number {
    return this.playbackEpochValue;
  }

  /**
   * F1 (M2): deltas of the response being requested belong to the playback
   * epoch that is current NOW.
   */
  lockDeltaEpoch(): void {
    this.deltaEpochValue = this.playbackEpochValue;
  }

  deltaEpoch(): number {
    return this.deltaEpochValue;
  }
}
