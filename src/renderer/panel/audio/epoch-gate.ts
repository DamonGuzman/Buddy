/**
 * F1 fix (M2): main-owned playback epoch gate.
 *
 * Main tags every 'audio:output' delta with the playback epoch of the
 * response it belongs to, and bumps the epoch whenever a response is
 * cancelled or superseded (sent along with the 'audio:playback' flush).
 * A delta tagged with an epoch older than the newest flush is stale: it
 * belongs to a cancelled response whose first chunk never reached the
 * renderer, so the itemId-based stale list cannot catch it — without the
 * gate, that pre-cancel burst would play over the user's new hold.
 *
 * Pure logic (no DOM/audio deps) so it is unit-testable in node.
 */
export class PlaybackEpochGate {
  private floor = 0;

  /** A flush arrived: raise the floor to its epoch. */
  flush(epoch?: number): void {
    if (epoch !== undefined && epoch > this.floor) this.floor = epoch;
  }

  /**
   * Should this delta play? Untagged deltas (dev/QA tones) always pass.
   * A delta from a NEWER epoch also raises the floor (missed flush).
   */
  admitDelta(epoch?: number): boolean {
    if (epoch === undefined) return true;
    if (epoch < this.floor) return false;
    this.floor = epoch;
    return true;
  }

  /** Current floor (diagnostics/tests). */
  currentFloor(): number {
    return this.floor;
  }
}
