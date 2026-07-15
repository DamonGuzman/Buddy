/**
 * Mic capture worklet: consumes mono Float32 input at the context sample rate
 * (24kHz — the AudioContext is created with that rate, Chromium resamples the
 * mic stream) and posts ~60ms chunks of Int16 PCM to the main thread.
 *
 * 60ms @ 24kHz = 1440 samples = 2880 bytes per chunk. Int16Array uses the
 * platform's byte order, which is little-endian on every platform Electron
 * ships on — matching the `pcm16` (LE) wire format.
 *
 * Message shapes are mirrored as TS types in ../audio/worklet-messages.ts,
 * and CHUNK_SAMPLES mirrors ../audio/pcm.ts — kept in sync by hand, because
 * this file loads standalone via audioWorklet.addModule and cannot import.
 */

const CHUNK_SAMPLES = 1440; // 60ms @ 24kHz — mirrors audio/pcm.ts CHUNK_SAMPLES

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.offset = 0;
    this.port.onmessage = (e) => {
      // 'reset' at the start of each hold: drop any partial chunk left over
      // from the previous turn so stale audio never leaks into a new one.
      if (e.data && e.data.type === 'reset') this.offset = 0;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true; // keep alive; input may attach later
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === CHUNK_SAMPLES) {
        const out = this.buffer.buffer.slice(0);
        this.port.postMessage(out, [out]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
