/**
 * Gapless PCM player worklet: the main thread posts Float32 sample chunks;
 * process() renders them **contiguously** from an internal queue (no
 * per-chunk AudioBufferSourceNodes), so chunk boundaries can never click or
 * gap — an underrun simply renders silence until the next chunk arrives.
 *
 * M8.5 addition (orchestrator-approved): a playback tap. Chunks now carry an
 * `itemId`; the worklet accounts every sample it actually renders per item
 * (samplesPlayed / underruns / first-played wall time) and streams the PLAYED
 * Float32 back to the main thread in blocks, so the app can prove audio
 * reached the output stage and measure the queue→output latency.
 *
 * Messages in:  { type: 'chunk', samples: ArrayBuffer /* Float32 * /, itemId: string }
 *               { type: 'clear' }  — drop everything queued, immediately
 * Messages out: { type: 'drained' } — queue just ran empty (playback ended)
 *               { type: 'played', itemId, samples: ArrayBuffer /* Float32 * /,
 *                 underruns, firstPlayedAt, done }
 *                 — sent on an item's first rendered quantum, every ~0.25s of
 *                   rendered audio, and once with done=true when the item
 *                   ends (superseded, cleared, or silent for >0.5s).
 */

/** Post a 'played' block after this many accumulated samples (~0.25s @24kHz). */
const BLOCK_SAMPLES = 6000;
/** Render quanta of continuous silence after which the current item is done. */
const DONE_SILENCE_QUANTA = 94; // ~0.5s at 128 samples / 24kHz

class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{samples: Float32Array, itemId: string}[]} */
    this.queue = [];
    this.readOffset = 0; // read position inside queue[0]
    this.wasPlaying = false;

    // ---- playback tap state (per current item) ----
    this.curItemId = null;
    this.curUnderruns = 0;
    this.curFirstPlayedAt = 0;
    this.curStarted = false; // first block for this item not yet posted
    /** @type {Float32Array[]} rendered samples since the last 'played' post */
    this.acc = [];
    this.accLen = 0;
    this.silentQuanta = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'chunk') {
        this.queue.push({ samples: new Float32Array(msg.samples), itemId: msg.itemId || '' });
      } else if (msg.type === 'clear') {
        this.queue.length = 0;
        this.readOffset = 0;
        this.finishItem(); // barge-in / flush: finalize stats immediately
      }
    };
  }

  /** Post accumulated played samples for the current item. */
  postBlock(done) {
    if (this.curItemId === null) return;
    let merged;
    if (this.acc.length === 1) {
      merged = this.acc[0];
    } else {
      merged = new Float32Array(this.accLen);
      let off = 0;
      for (const part of this.acc) {
        merged.set(part, off);
        off += part.length;
      }
    }
    this.port.postMessage(
      {
        type: 'played',
        itemId: this.curItemId,
        samples: merged.buffer,
        underruns: this.curUnderruns,
        firstPlayedAt: this.curFirstPlayedAt,
        done,
      },
      [merged.buffer],
    );
    this.acc = [];
    this.accLen = 0;
    this.curStarted = true;
  }

  /** Final 'played' post for the current item, then reset the tap state. */
  finishItem() {
    if (this.curItemId === null) return;
    this.postBlock(true);
    this.curItemId = null;
    this.curUnderruns = 0;
    this.curStarted = false;
    this.silentQuanta = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;

    let i = 0;
    while (i < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      if (head.itemId !== this.curItemId) {
        // A new item starts rendering: finalize the previous one first.
        this.finishItem();
        this.curItemId = head.itemId;
        this.curUnderruns = 0;
        this.curFirstPlayedAt = Date.now();
        this.curStarted = false;
      } else if (this.silentQuanta > 0) {
        // Same item resumed after a mid-item silence gap: that was an underrun.
        this.curUnderruns += 1;
      }
      this.silentQuanta = 0;

      const n = Math.min(head.samples.length - this.readOffset, out.length - i);
      const rendered = head.samples.subarray(this.readOffset, this.readOffset + n);
      out.set(rendered, i);
      this.acc.push(rendered.slice()); // copy: subarray aliases queue memory
      this.accLen += n;
      i += n;
      this.readOffset += n;
      if (this.readOffset >= head.samples.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }
    const playing = i > 0;
    for (; i < out.length; i++) out[i] = 0;

    if (playing) {
      // First rendered quantum of an item posts immediately (accurate
      // first-audio-played timing); afterwards post every BLOCK_SAMPLES.
      if (!this.curStarted || this.accLen >= BLOCK_SAMPLES) this.postBlock(false);
    } else if (this.curItemId !== null) {
      this.silentQuanta += 1;
      if (this.silentQuanta >= DONE_SILENCE_QUANTA && this.queue.length === 0) {
        this.finishItem();
      }
    }

    if (this.wasPlaying && !playing && this.queue.length === 0) {
      this.port.postMessage({ type: 'drained' });
    }
    this.wasPlaying = playing;
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayerProcessor);
