const connectButton = document.querySelector('#connect');
const status = document.querySelector('#status');
const detail = document.querySelector('#detail');
const dot = document.querySelector('#dot');
const meter = document.querySelector('#meter');
const errorBox = document.querySelector('#error');
const volume = document.querySelector('#volume');
const volumeValue = document.querySelector('#volume-value');
let socket = null;
let audioContext = null;
let micStream = null;
let micSource = null;
let captureNode = null;
let silentGain = null;
let outputGain = null;
let captureActive = false;
let nextPlayAt = 0;
const playingSources = new Set();
const PLAYBACK_PREROLL_SECONDS = 0.04;

function setStatus(title, message, mode = '') {
  status.textContent = title;
  detail.textContent = message;
  dot.className = `dot ${mode}`;
}

function showError(error) {
  errorBox.hidden = false;
  errorBox.textContent = error instanceof Error ? error.message : String(error);
}

function setCapture(active) {
  captureActive = active;
  for (const track of micStream?.getAudioTracks() ?? []) track.enabled = active;
  captureNode?.port.postMessage({ type: 'active', active });
  meter.style.width = '0';
  if (active) {
    setStatus('listening', 'speak now — release Ctrl+Alt when you’re done', 'listening');
  } else if (socket?.readyState === WebSocket.OPEN) {
    setStatus('connected', 'microphone gated off until the next hold', 'connected');
  }
}

function clearPlayback() {
  for (const source of playingSources) {
    try { source.stop(); } catch { /* already ended */ }
  }
  playingSources.clear();
  nextPlayAt = audioContext?.currentTime ?? 0;
}

/**
 * Reserve one non-overlapping slot on the phone's Web Audio timeline.
 *
 * Realtime often delivers PCM faster than wall-clock playback. Never clamp a
 * healthy future cursor back toward `now`: doing that starts later chunks on
 * top of already-scheduled AudioBufferSourceNodes and scrambles speech.
 */
function schedulePlaybackSlot(now, duration) {
  const startAt = Math.max(nextPlayAt, now + PLAYBACK_PREROLL_SECONDS);
  nextPlayAt = startAt + duration;
  return startAt;
}

function enqueuePlayback(buffer) {
  if (!audioContext || !outputGain) return;
  const pcm = new Int16Array(buffer);
  if (pcm.length === 0) return;
  const audioBuffer = audioContext.createBuffer(1, pcm.length, 24000);
  const samples = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(outputGain);
  const now = audioContext.currentTime;
  source.start(schedulePlaybackSlot(now, audioBuffer.duration));
  playingSources.add(source);
  source.onended = () => playingSources.delete(source);
}

async function prepareAudio() {
  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.resume();
  await audioContext.audioWorklet.addModule('/capture-worklet.js');

  outputGain = audioContext.createGain();
  outputGain.gain.value = Number(volume.value) / 100;
  outputGain.connect(audioContext.destination);

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  for (const track of micStream.getAudioTracks()) track.enabled = false;
  micSource = audioContext.createMediaStreamSource(micStream);
  captureNode = new AudioWorkletNode(audioContext, 'phone-pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  micSource.connect(captureNode).connect(silentGain).connect(audioContext.destination);
  captureNode.port.onmessage = (event) => {
    if (!captureActive || socket?.readyState !== WebSocket.OPEN) return;
    const chunk = event.data;
    if (!(chunk instanceof ArrayBuffer)) return;
    const pcm = new Int16Array(chunk);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 24) peak = Math.max(peak, Math.abs(pcm[i]));
    meter.style.width = `${Math.min(100, Math.round((peak / 32768) * 180))}%`;
    socket.send(chunk);
  };
}

function connectSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/phone`);
  socket.binaryType = 'arraybuffer';
  socket.onopen = () => {
    connectButton.textContent = 'audio connected';
    setStatus('connected', 'waiting for Ctrl+Alt on the Windows PC', 'connected');
  };
  socket.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      enqueuePlayback(event.data);
      return;
    }
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'capture') setCapture(message.command === 'start');
      if (message.type === 'playback') clearPlayback();
      if (message.type === 'status' && message.clickyConnected === false) {
        setStatus('phone connected', 'waiting for Buddy on the Windows PC', 'connected');
      }
    } catch { /* ignore unknown diagnostic messages */ }
  };
  socket.onclose = () => {
    setCapture(false);
    setStatus('disconnected', 'reload the page to reconnect');
    connectButton.disabled = false;
    connectButton.textContent = 'reconnect audio';
  };
  socket.onerror = () => showError('Could not reach the Buddy bridge. Check that the tool is still running.');
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  errorBox.hidden = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Safari does not trust this page yet. Install and fully trust the Buddy test certificate first.');
    }
    if (!audioContext) await prepareAudio();
    else await audioContext.resume();
    connectSocket();
  } catch (error) {
    connectButton.disabled = false;
    showError(error);
  }
});

volume.addEventListener('input', () => {
  volumeValue.value = `${volume.value}%`;
  if (outputGain) outputGain.gain.value = Number(volume.value) / 100;
});

window.addEventListener('pagehide', () => {
  setCapture(false);
  clearPlayback();
  socket?.close();
  for (const track of micStream?.getTracks() ?? []) track.stop();
});
