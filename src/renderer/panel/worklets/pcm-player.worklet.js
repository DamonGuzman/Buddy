/**
 * Gapless PCM player worklet: the main thread posts Float32 sample chunks;
 * process() renders them **contiguously** from an internal queue (no
 * per-chunk AudioBufferSourceNodes), so chunk boundaries can never click or
 * gap — an underrun simply renders silence until the next chunk arrives.
 *
 * Messages in:  { type: 'chunk', samples: ArrayBuffer /* Float32 * / }
 *               { type: 'clear' }  — drop everything queued, immediately
 * Messages out: { type: 'drained' } — queue just ran empty (playback ended)
 */

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.queue = [];
    this.readOffset = 0; // read position inside queue[0]
    this.wasPlaying = false;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'chunk') {
        this.queue.push(new Float32Array(msg.samples));
      } else if (msg.type === 'clear') {
        this.queue.length = 0;
        this.readOffset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      const n = Math.min(head.length - this.readOffset, out.length - i);
      out.set(head.subarray(this.readOffset, this.readOffset + n), i);
      i += n;
      this.readOffset += n;
      if (this.readOffset >= head.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }
    const playing = i > 0;
    for (; i < out.length; i++) out[i] = 0;

    if (this.wasPlaying && !playing && this.queue.length === 0) {
      this.port.postMessage({ type: 'drained' });
    }
    this.wasPlaying = playing;
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor);
