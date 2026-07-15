/**
 * SendQueue unit tests: FIFO order, the F1 (M7) capacity cap with
 * audio-first shedding, and the stale-turn append hygiene.
 */

import { describe, expect, it } from 'vitest';
import { SendQueue } from '../src/main/realtime/send-queue';
import type { ClientEvent } from '../src/main/realtime/protocol';

const append = (n: number): ClientEvent => ({
  type: 'input_audio_buffer.append',
  audio: `chunk${n}`,
});
const COMMIT: ClientEvent = { type: 'input_audio_buffer.commit' };
const RESPONSE: ClientEvent = { type: 'response.create' };

describe('SendQueue', () => {
  it('preserves FIFO order and drains to empty', () => {
    const queue = new SendQueue(8);
    queue.push(append(1));
    queue.push(COMMIT);
    queue.push(RESPONSE);
    expect(queue.length).toBe(3);
    expect(queue.drain()).toEqual([append(1), COMMIT, RESPONSE]);
    expect(queue.length).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('dropAudioAppends() removes only mic-audio frames', () => {
    const queue = new SendQueue(8);
    queue.push(append(1));
    queue.push(COMMIT);
    queue.push(append(2));
    queue.dropAudioAppends();
    expect(queue.drain()).toEqual([COMMIT]);
  });

  it('at capacity, sheds the OLDEST queued append before anything else', () => {
    const queue = new SendQueue(3);
    queue.push(COMMIT);
    queue.push(append(1));
    queue.push(append(2));
    queue.push(RESPONSE); // full: append(1) is shed, not COMMIT
    expect(queue.drain()).toEqual([COMMIT, append(2), RESPONSE]);
  });

  it('at capacity, an incoming append still enters after shedding an older one', () => {
    const queue = new SendQueue(2);
    queue.push(append(1));
    queue.push(append(2));
    queue.push(append(3));
    expect(queue.drain()).toEqual([append(2), append(3)]);
  });

  it('at capacity with no queued appends, an incoming append is dropped outright', () => {
    const queue = new SendQueue(2);
    queue.push(COMMIT);
    queue.push(RESPONSE);
    queue.push(append(1)); // control frames are worth more than stale audio
    expect(queue.drain()).toEqual([COMMIT, RESPONSE]);
  });

  it('at capacity with no queued appends, a control frame sheds the oldest frame', () => {
    const queue = new SendQueue(2);
    queue.push(COMMIT);
    queue.push(RESPONSE);
    queue.push({ type: 'input_audio_buffer.clear' });
    expect(queue.drain()).toEqual([RESPONSE, { type: 'input_audio_buffer.clear' }]);
  });

  it('clear() empties the queue', () => {
    const queue = new SendQueue(4);
    queue.push(append(1));
    queue.push(COMMIT);
    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.drain()).toEqual([]);
  });
});
