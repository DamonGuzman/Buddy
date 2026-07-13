#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const HTTPS_PORT = Number(process.env.CLICKY_PHONE_AUDIO_HTTPS_PORT ?? 3210);
const SETUP_PORT = Number(process.env.CLICKY_PHONE_AUDIO_SETUP_PORT ?? 3211);
const certDir = join(process.env.LOCALAPPDATA ?? repoRoot, 'ClickyPhoneAudioBridge');
const args = new Set(process.argv.slice(2));

function powershell(script, options = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function findLanIp() {
  const override = process.env.CLICKY_PHONE_AUDIO_HOST?.trim();
  if (override) return override;
  try {
    const result = powershell(
      "$c=Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up'} | Sort-Object {$_.NetIPv4Interface.RouteMetric} | Select-Object -First 1; $c.IPv4Address.IPAddress",
    );
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(result)) return result;
  } catch { /* fall back to Node's adapter list */ }
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('169.254.')) {
        return entry.address;
      }
    }
  }
  throw new Error('Could not find a LAN IPv4 address. Set CLICKY_PHONE_AUDIO_HOST explicitly.');
}

function ensureCertificates(ipAddress) {
  const metadataPath = join(certDir, 'metadata.json');
  const pfxPath = join(certDir, 'server.pfx');
  const passPath = join(certDir, 'server-pass.txt');
  const caPath = join(certDir, 'clicky-audio-ca.cer');
  let currentIp = '';
  try { currentIp = JSON.parse(readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, '')).ipAddress; } catch { /* regenerate */ }
  if (currentIp !== ipAddress || !existsSync(pfxPath) || !existsSync(passPath) || !existsSync(caPath)) {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', join(here, 'setup-cert.ps1'),
        '-IpAddress', ipAddress,
        '-OutputDir', certDir,
      ],
      { cwd: repoRoot, stdio: 'inherit' },
    );
  }
  return {
    pfx: readFileSync(pfxPath),
    passphrase: readFileSync(passPath, 'utf8').trim(),
    caPath,
  };
}

function contentType(pathname) {
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'text/html; charset=utf-8';
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function configurationProfile(caPath) {
  const certificate = readFileSync(caPath).toString('base64').match(/.{1,68}/g)?.join('\n') ?? '';
  const profileUuid = randomUUID().toUpperCase();
  const certificateUuid = randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>clicky-audio-ca.cer</string>
      <key>PayloadContent</key>
      <data>${certificate}</data>
      <key>PayloadDescription</key>
      <string>Installs the temporary local CA used by the Buddy iPhone audio test bridge.</string>
      <key>PayloadDisplayName</key>
      <string>Buddy Throwaway Audio CA</string>
      <key>PayloadIdentifier</key>
      <string>ai.fastyr.buddy.throwaway-audio.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${certificateUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Temporary certificate for testing Buddy audio through this iPhone. Remove it after testing.</string>
  <key>PayloadDisplayName</key>
  <string>Buddy Throwaway Audio CA</string>
  <key>PayloadIdentifier</key>
  <string>ai.fastyr.buddy.throwaway-audio</string>
  <key>PayloadOrganization</key>
  <string>Fastyr</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${profileUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;
}

function setupPage(ipAddress) {
  const secureUrl = `https://${ipAddress}:${HTTPS_PORT}/`;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set up Buddy phone audio</title>
<style>body{margin:0;background:#081321;color:#edf7ff;font:16px -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:560px;margin:auto;padding:34px 22px}h1{font-size:34px;letter-spacing:-.04em}li{margin:16px 0;line-height:1.5}a{display:inline-block;padding:14px 18px;border-radius:12px;background:#38aefb;color:#03101b;font-weight:700;text-decoration:none}.secondary{background:#152c40;color:#bfe5ff}code{word-break:break-all;color:#78c9ff}</style>
<main><p>throwaway test bridge</p><h1>set up iPhone audio</h1><ol>
<li><a href="/clicky-audio.mobileconfig">download iPhone profile</a></li>
<li>When Safari says <b>Profile Downloaded</b>, open iPhone <b>Settings</b>, tap <b>Profile Downloaded</b>, then tap <b>Install</b>. If that shortcut is absent, use <b>Settings → General → VPN &amp; Device Management</b>.</li>
<li>Open <b>Settings → General → About → Certificate Trust Settings</b> and enable full trust for <b>Buddy Throwaway Audio CA</b>.</li>
<li><a class="secondary" href="${secureUrl}">open secure audio page</a>, then tap <b>connect audio</b>.</li>
</ol><p>The certificate and server are local to this PC. Remove the profile after this throwaway test is no longer needed.</p>
<p><small>Secure URL: <code>${secureUrl}</code></small></p></main>`;
}

function isPhonePath(requestUrl) {
  try {
    const url = new URL(requestUrl, 'https://clicky-audio.local');
    return url.pathname === '/phone';
  } catch {
    return false;
  }
}

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function killExistingClicky() {
  try {
    powershell("Get-Process -Name 'Buddy','Buddy App','Clicky' -ErrorAction SilentlyContinue | Stop-Process -Force");
  } catch { /* no existing process */ }
}

function launchClicky() {
  if (args.has('--no-launch')) return null;
  killExistingClicky();
  const env = {
    ...process.env,
    CLICKY_PHONE_AUDIO_URL: `ws://127.0.0.1:${SETUP_PORT}/clicky`,
    CLICKY_DEBUG: process.env.CLICKY_DEBUG ?? '1',
  };
  const programsDir = join(process.env.LOCALAPPDATA ?? '', 'Programs');
  const installedCandidates = [
    join(programsDir, 'buddy', 'Buddy.exe'),
    join(programsDir, 'heyclicky', 'Buddy App.exe'),
    join(programsDir, 'heyclicky', 'Clicky.exe'),
  ];
  const installed = installedCandidates.find((candidate) => existsSync(candidate)) ?? installedCandidates[0];
  const useDev = args.has('--dev') || !existsSync(installed);
  const command = useDev ? 'npm.cmd' : installed;
  const commandArgs = useDev ? ['run', 'dev'] : [];
  console.log(`[phone-audio] launching ${useDev ? 'Buddy dev mode' : installed}`);
  return spawn(command, commandArgs, { cwd: repoRoot, env, stdio: 'inherit', windowsHide: false });
}

const ipAddress = findLanIp();
const certificates = ensureCertificates(ipAddress);
const mobileConfiguration = configurationProfile(certificates.caPath);
let clickySocket = null;
let phoneSocket = null;
let captureActive = false;
let micChunks = 0;
let outputChunks = 0;

function sendJson(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

const setupServer = createHttpServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (pathname === '/clicky-audio-ca.cer') {
    const body = readFileSync(certificates.caPath);
    send(res, 200, body, { 'Content-Type': 'application/x-x509-ca-cert' });
    return;
  }
  if (pathname === '/clicky-audio.mobileconfig') {
    send(res, 200, mobileConfiguration, {
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': 'attachment; filename="clicky-audio.mobileconfig"',
      'X-Content-Type-Options': 'nosniff',
    });
    return;
  }
  if (pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, clickyConnected: clickySocket !== null, phoneConnected: phoneSocket !== null, captureActive, micChunks, outputChunks }), { 'Content-Type': 'application/json' });
    return;
  }
  send(res, 200, setupPage(ipAddress), { 'Content-Type': 'text/html; charset=utf-8' });
});

const secureServer = createHttpsServer(
  { pfx: certificates.pfx, passphrase: certificates.passphrase, minVersion: 'TLSv1.2' },
  (req, res) => {
    const pathname = new URL(req.url ?? '/', `https://${req.headers.host ?? 'localhost'}`).pathname;
    const asset = pathname === '/' ? 'phone.html' : pathname.slice(1);
    if (!['phone.html', 'phone.js', 'styles.css', 'capture-worklet.js'].includes(asset)) {
      send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const body = readFileSync(join(here, asset));
    send(res, 200, body, {
      'Content-Type': contentType(asset),
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss:; media-src 'self'; style-src 'self'; script-src 'self'; worker-src 'self' blob:;",
      'Permissions-Policy': 'microphone=(self)',
      'X-Content-Type-Options': 'nosniff',
    });
  },
);

const clickyWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
const phoneWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });

setupServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
  if (pathname !== '/clicky' || !isLoopback(req.socket.remoteAddress)) {
    socket.destroy();
    return;
  }
  clickyWss.handleUpgrade(req, socket, head, (ws) => clickyWss.emit('connection', ws, req));
});

secureServer.on('upgrade', (req, socket, head) => {
  if (!isPhonePath(req.url ?? '')) {
    socket.destroy();
    return;
  }
  phoneWss.handleUpgrade(req, socket, head, (ws) => phoneWss.emit('connection', ws, req));
});

clickyWss.on('connection', (ws) => {
  clickySocket?.close(1012, 'new Buddy connection');
  clickySocket = ws;
  console.log('[phone-audio] Buddy connected');
  sendJson(phoneSocket, { type: 'status', clickyConnected: true });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      outputChunks += 1;
      if (phoneSocket?.readyState === WebSocket.OPEN) phoneSocket.send(data, { binary: true });
      return;
    }
    try {
      const message = JSON.parse(data.toString());
      if (message.type === 'capture' && ['start', 'stop'].includes(message.command)) {
        captureActive = message.command === 'start';
        sendJson(phoneSocket, message);
      }
      if (message.type === 'playback' && ['stop', 'flush'].includes(message.command)) {
        sendJson(phoneSocket, message);
      }
    } catch { /* ignore invalid local diagnostics */ }
  });
  ws.on('close', () => {
    if (clickySocket !== ws) return;
    clickySocket = null;
    captureActive = false;
    sendJson(phoneSocket, { type: 'capture', command: 'stop' });
    sendJson(phoneSocket, { type: 'status', clickyConnected: false });
    console.log('[phone-audio] Buddy disconnected');
  });
});

phoneWss.on('connection', (ws) => {
  phoneSocket?.close(1008, 'only one phone may be paired');
  phoneSocket = ws;
  console.log('[phone-audio] iPhone page connected');
  sendJson(ws, { type: 'status', clickyConnected: clickySocket !== null });
  sendJson(ws, { type: 'capture', command: captureActive ? 'start' : 'stop' });
  ws.on('message', (data, isBinary) => {
    if (!isBinary || !captureActive || clickySocket?.readyState !== WebSocket.OPEN) return;
    micChunks += 1;
    clickySocket.send(data, { binary: true });
  });
  ws.on('close', () => {
    if (phoneSocket !== ws) return;
    phoneSocket = null;
    console.log('[phone-audio] iPhone page disconnected');
  });
});

setupServer.listen(SETUP_PORT, '0.0.0.0');
secureServer.listen(HTTPS_PORT, '0.0.0.0');

const setupUrl = `http://${ipAddress}:${SETUP_PORT}/`;
const secureUrl = `https://${ipAddress}:${HTTPS_PORT}/`;
console.log('\nBuddy throwaway phone-audio bridge');
console.log(`1. On the iPhone, open: ${setupUrl}`);
console.log('2. Download, install, and fully trust the iPhone profile, then use the secure-page link.');
console.log(`3. Direct secure URL: ${secureUrl}`);
console.log('4. Tap "connect audio", then use Ctrl+Alt on this PC.\n');

writeFileSync(join(certDir, 'last-url.txt'), `${setupUrl}\n${secureUrl}\n`);
const clickyProcess = launchClicky();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  phoneSocket?.close(1001, 'bridge shutting down');
  clickySocket?.close(1001, 'bridge shutting down');
  setupServer.close();
  secureServer.close();
  if (clickyProcess && !clickyProcess.killed) clickyProcess.kill();
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
clickyProcess?.on('exit', (code) => console.log(`[phone-audio] Buddy exited (${code ?? 'signal'})`));
