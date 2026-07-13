const TARGET_RATE = 24000;
const CHUNK_SAMPLES = 1440;

class PhonePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.offset = 0;
    this.phase = 0;
    this.active = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'active') {
        this.active = event.data.active === true;
        this.offset = 0;
        this.phase = 0;
      }
    };
  }

  process(inputs) {
    if (!this.active) return true;
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Phase-accumulator resampling keeps the wire format at exactly 24 kHz
    // even when iOS insists on a 44.1/48 kHz hardware AudioContext.
    const step = TARGET_RATE / sampleRate;
    for (let i = 0; i < channel.length; i += 1) {
      this.phase += step;
      if (this.phase < 1) continue;
      this.phase -= 1;
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (this.offset === CHUNK_SAMPLES) {
        const out = this.buffer.buffer.slice(0);
        this.port.postMessage(out, [out]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('phone-pcm-capture', PhonePcmCaptureProcessor);
