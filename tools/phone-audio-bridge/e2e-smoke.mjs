#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const debugToken = process.env.CLICKY_DEBUG_TOKEN?.trim() || readFileSync(
  process.env.CLICKY_DEBUG_TOKEN_FILE ??
    join(process.env.TEMP ?? process.cwd(), 'clicky-phone-audio-e2e', 'debug-token.txt'),
  'utf8',
).trim();

async function waitForDebug(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:8199/state', {
        headers: { 'X-Debug-Token': debugToken },
      });
      if (response.ok) return;
    } catch { /* Buddy still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Buddy debug server did not start');
}

async function debugPost(path) {
  const response = await fetch(`http://127.0.0.1:8199${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Token': debugToken },
    body: '{}',
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
}

function makeToneChunk(phase) {
  const samples = 1_440;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * (phase + i)) / 24_000) * 8_000);
  }
  return Buffer.from(pcm.buffer);
}

await waitForDebug();
const phone = new WebSocket('wss://127.0.0.1:3210/phone', {
  rejectUnauthorized: false,
  perMessageDeflate: false,
});
await new Promise((resolve, reject) => {
  phone.once('open', resolve);
  phone.once('error', reject);
});

let captureStarted = false;
let outputBytes = 0;
phone.on('message', (data, isBinary) => {
  if (isBinary) {
    outputBytes += Buffer.byteLength(data);
    return;
  }
  try {
    const message = JSON.parse(data.toString());
    if (message.type === 'capture' && message.command === 'start') captureStarted = true;
  } catch { /* diagnostic only */ }
});

await debugPost('/hotkey/press');
const captureDeadline = Date.now() + 2_000;
while (!captureStarted && Date.now() < captureDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!captureStarted) throw new Error('phone did not receive capture-start');

for (let i = 0; i < 7; i += 1) {
  phone.send(makeToneChunk(i * 1_440));
  await new Promise((resolve) => setTimeout(resolve, 60));
}
await debugPost('/hotkey/release');

const outputDeadline = Date.now() + 15_000;
while (outputBytes === 0 && Date.now() < outputDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
if (outputBytes === 0) throw new Error('Buddy response audio did not reach the phone');

const state = await (
  await fetch('http://127.0.0.1:8199/state', { headers: { 'X-Debug-Token': debugToken } })
).json();
if ((state.audio?.chunksIn ?? 0) < 7 || (state.audio?.chunksOut ?? 0) < 1) {
  throw new Error(`unexpected Buddy audio ledger: ${JSON.stringify(state.audio)}`);
}
console.log(
  `phone-audio Buddy E2E passed: ${state.audio.chunksIn} mic chunks in, ` +
    `${state.audio.chunksOut} model chunks out, ${outputBytes} bytes reached phone`,
);
phone.close();
