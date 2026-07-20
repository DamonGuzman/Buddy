/** Scroll-following policy for the Whisper conversation history. */

export const SCROLL_BOTTOM_TOLERANCE_PX = 1;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Follow streamed/new replies only while the reader remains at the bottom. */
export function shouldFollowLatest(
  { scrollTop, scrollHeight, clientHeight }: ScrollMetrics,
  tolerance = SCROLL_BOTTOM_TOLERANCE_PX,
): boolean {
  return scrollHeight - clientHeight - Math.max(0, scrollTop) <= tolerance;
}

function hasOverflow({ scrollHeight, clientHeight }: ScrollMetrics): boolean {
  return scrollHeight - clientHeight > SCROLL_BOTTOM_TOLERANCE_PX;
}

/**
 * Stateful policy that separates explicit upward user intent from scroll
 * events caused by layout/programmatic movement. That distinction matters for
 * high-resolution trackpads: even a sub-pixel upward gesture must pause a
 * streaming reply before React can render its next token.
 */
export class WhisperScrollFollower {
  private following = true;
  private previousScrollTop = 0;

  shouldFollow(): boolean {
    return this.following;
  }

  resume(metrics?: ScrollMetrics): void {
    this.following = true;
    if (metrics) this.previousScrollTop = Math.max(0, metrics.scrollTop);
  }

  noteWheel(deltaY: number, metrics: ScrollMetrics): void {
    this.previousScrollTop = Math.max(0, metrics.scrollTop);
    if (deltaY < 0 && hasOverflow(metrics)) this.following = false;
  }

  noteKey(key: string, shiftKey: boolean, metrics: ScrollMetrics): void {
    this.previousScrollTop = Math.max(0, metrics.scrollTop);
    const movesUp =
      key === 'ArrowUp' || key === 'PageUp' || key === 'Home' || (key === ' ' && shiftKey);
    if (movesUp && hasOverflow(metrics)) this.following = false;
  }

  noteScroll(metrics: ScrollMetrics): void {
    const scrollTop = Math.max(0, metrics.scrollTop);
    const movedUp = scrollTop < this.previousScrollTop;
    if (movedUp) {
      this.following = false;
    } else if (shouldFollowLatest(metrics)) {
      this.following = true;
    }
    this.previousScrollTop = scrollTop;
  }

  synchronized(metrics: ScrollMetrics): void {
    this.previousScrollTop = Math.max(0, metrics.scrollTop);
  }
}
