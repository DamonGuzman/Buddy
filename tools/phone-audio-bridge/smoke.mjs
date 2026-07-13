#!/usr/bin/env node

import WebSocket from 'ws';

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function nextMessage(socket, predicate, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for bridge message'));
    }, timeoutMs);
    const handler = (data, isBinary) => {
      if (!predicate(data, isBinary)) return;
      cleanup();
      resolve({ data, isBinary });
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', handler);
    };
    socket.on('message', handler);
  });
}

const phone = new WebSocket('wss://127.0.0.1:3210/phone', {
  rejectUnauthorized: false,
  perMessageDeflate: false,
});
const clicky = new WebSocket('ws://127.0.0.1:3211/clicky', { perMessageDeflate: false });

try {
  await Promise.all([opened(phone), opened(clicky)]);

  const captureStart = nextMessage(phone, (data, isBinary) => {
    if (isBinary) return false;
    const message = JSON.parse(data.toString());
    return message.type === 'capture' && message.command === 'start';
  });
  clicky.send(JSON.stringify({ type: 'capture', command: 'start' }));
  await captureStart;

  const mic = Buffer.from([1, 2, 3, 4]);
  const micRelayed = nextMessage(
    clicky,
    (data, isBinary) => isBinary && Buffer.from(data).equals(mic),
  );
  phone.send(mic);
  await micRelayed;

  const output = Buffer.from([5, 6, 7, 8]);
  const outputRelayed = nextMessage(
    phone,
    (data, isBinary) => isBinary && Buffer.from(data).equals(output),
  );
  clicky.send(output);
  await outputRelayed;

  const playbackFlush = nextMessage(phone, (data, isBinary) => {
    if (isBinary) return false;
    const message = JSON.parse(data.toString());
    return message.type === 'playback' && message.command === 'flush';
  });
  clicky.send(JSON.stringify({ type: 'playback', command: 'flush' }));
  await playbackFlush;

  console.log('phone-audio bridge smoke passed: controls + mic PCM + output PCM');
} finally {
  phone.close();
  clicky.close();
}
