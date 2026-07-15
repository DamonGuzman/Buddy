/**
 * Caption bubble lifecycle: streamed text upserts, the linger-then-fade
 * countdown after done:true, and the error-state flush (a failed/cancelled
 * turn must not leave a stale caption on screen).
 *
 * Pure logic over an injected TimerBag — no DOM, no React (the caption view
 * is pushed through a setter that main.tsx binds to useState). Unit-tested
 * with fake time in tests/overlay-controllers.test.ts.
 */

import type { CaptionUpdate } from '../../shared/types';
import type { TimerBag } from './timer-bag';

/** Caption bubble lingers this long after done:true, then fades. */
export const CAPTION_LINGER_MS = 4000;
/** Caption fade-out transition time (matches overlay.css). */
export const CAPTION_FADE_MS = 500;

export interface CaptionView {
  itemId: string;
  text: string;
  fading: boolean;
}

/** useState-compatible setter: a value or a functional updater. */
export type CaptionSetter = (
  update: CaptionView | null | ((prev: CaptionView | null) => CaptionView | null),
) => void;

export class CaptionController {
  constructor(
    private readonly setCaption: CaptionSetter,
    private readonly timers: TimerBag,
  ) {}

  /** Streaming caption upsert from main ('overlay:caption'). */
  handleUpdate(update: CaptionUpdate): void {
    this.timers.clear('linger');
    this.timers.clear('fade');
    if (update.text.length === 0 && !update.done) {
      this.setCaption(null);
      return;
    }
    this.setCaption({ itemId: update.itemId, text: update.text, fading: false });
    if (update.done) {
      this.timers.set('linger', CAPTION_LINGER_MS, () => {
        this.setCaption((c) => (c && c.itemId === update.itemId ? { ...c, fading: true } : c));
        this.timers.set('fade', CAPTION_FADE_MS, () => {
          this.setCaption((c) => (c && c.itemId === update.itemId ? null : c));
        });
      });
    }
  }

  /**
   * A failed/cancelled turn must not leave a stale caption on screen: fade
   * whatever is showing and drop it.
   */
  flushForError(): void {
    this.timers.clear('linger');
    this.timers.clear('fade');
    this.setCaption((c) => (c && !c.fading ? { ...c, fading: true } : c));
    this.timers.set('errorFade', CAPTION_FADE_MS, () => this.setCaption(null));
  }

  dispose(): void {
    this.timers.clearAll();
  }
}
