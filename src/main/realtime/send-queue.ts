/**
 * Capped queue for outbound client events while the WebSocket is
 * (re)connecting; drained on session.created.
 *
 * F1 (M7): the cap sheds audio first — 60ms mic chunks dominate any backlog
 * and are worthless once this stale — then the oldest frame. A brand-new
 * append against a full, append-free queue is dropped outright rather than
 * displacing a control frame.
 */

import type { ClientEvent } from './protocol';

export class SendQueue {
  private queue: ClientEvent[] = [];

  constructor(private readonly capacity: number) {}

  get length(): number {
    return this.queue.length;
  }

  /** Queue `evt`, shedding audio first (then the oldest frame) at capacity. */
  push(evt: ClientEvent): void {
    if (this.queue.length >= this.capacity) {
      const appendIdx = this.queue.findIndex((e) => e.type === 'input_audio_buffer.append');
      if (appendIdx === -1 && evt.type === 'input_audio_buffer.append') return; // drop the newcomer
      this.queue.splice(appendIdx !== -1 ? appendIdx : 0, 1);
    }
    this.queue.push(evt);
  }

  /** Remove and return every queued event, oldest first. */
  drain(): ClientEvent[] {
    const queue = this.queue;
    this.queue = [];
    return queue;
  }

  /** F1 (M7): drop queued mic-audio frames (stale-turn hygiene). */
  dropAudioAppends(): void {
    if (this.queue.length === 0) return;
    this.queue = this.queue.filter((evt) => evt.type !== 'input_audio_buffer.append');
  }

  clear(): void {
    this.queue = [];
  }
}
