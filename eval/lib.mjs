/**
 * Shared plumbing for the M8.5 audio-experience eval harness:
 * debug-HTTP client (token-aware), app/mock process management, WAV parsing,
 * and small statistics helpers. Node 24, no external deps.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(EVAL_DIR);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function newToken() {
  return randomBytes(12).toString('hex');
}

/**
 * Debug-server auth is mandatory now: when the app isn't given an explicit
 * CLICKY_DEBUG_TOKEN it generates one per launch and writes it to
 * <userData>/debug-token.txt. For --attach runs (token env not exported in
 * this shell) read it from there: CLICKY_USER_DATA first, then the default
 * userData dirs (dev app name, then packaged productName). Returns null when
 * no token file is found.
 */
export function readTokenFile() {
  const candidates = [
    process.env.CLICKY_USER_DATA,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'heyclicky') : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Clicky') : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      const token = readFileSync(path.join(dir, 'debug-token.txt'), 'utf8').trim();
      if (token) return token;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Debug HTTP client
// ---------------------------------------------------------------------------

export function debugApi(base, token) {
  const headers = token ? { 'x-debug-token': token } : {};
  return {
    base,
    async get(p) {
      const res = await fetch(`${base}${p}`, { headers });
      if (!res.ok) throw new Error(`GET ${p} -> ${res.status}: ${await res.text()}`);
      return res.json();
    },
    async getBinary(p) {
      const res = await fetch(`${base}${p}`, { headers });
      if (!res.ok) throw new Error(`GET ${p} -> ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async post(p, body) {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST ${p} -> ${res.status}: ${await res.text()}`);
      return res.json();
    },
    /** True when the server answers /state with 200. */
    async alive() {
      try {
        await this.get('/state');
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Poll `fn` until it returns a truthy value or `timeoutMs` elapses. */
export async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
    await sleep(intervalMs);
  }
}

/** Wait until the assistant is idle (turn fully finished). */
export async function waitForIdle(api, timeoutMs = 20_000) {
  await waitFor(async () => (await api.get('/state')).assistantState === 'idle', {
    timeoutMs,
    intervalMs: 150,
    label: 'assistant idle',
  });
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

/** Resolve the Electron binary without shell trickery. */
export function electronBinary() {
  const require = createRequire(path.join(ROOT, 'package.json'));
  return require('electron'); // the module's export IS the binary path
}

/**
 * Live mode (M8.5): CLICKY_SEED_USERDATA=<dir> — top-level files in that dir
 * (settings.json with the safeStorage-encrypted API key + the matching
 * "Local State" os_crypt key file) are copied into every fresh userData dir
 * before launch, so `--live` runs have the key without ever passing it
 * through env or IPC. Existing files in the target are overwritten.
 */
function seedUserData(userDataDir) {
  const seedDir = process.env.CLICKY_SEED_USERDATA;
  if (!seedDir) return;
  if (!existsSync(seedDir)) throw new Error(`CLICKY_SEED_USERDATA dir not found: ${seedDir}`);
  for (const name of readdirSync(seedDir)) {
    const src = path.join(seedDir, name);
    if (statSync(src).isFile()) copyFileSync(src, path.join(userDataDir, name));
  }
}

/**
 * Launch the built app (out/main/index.js) with an isolated userData dir and
 * the debug server enabled. Returns { proc, kill }.
 */
export function launchApp({ token, mockUrl, fakeMicWav, userDataDir, debugPort, extraEnv = {}, logFile }) {
  if (!existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('out/main/index.js missing — run `npm run build` first');
  }
  mkdirSync(userDataDir, { recursive: true });
  seedUserData(userDataDir);
  const env = {
    ...process.env,
    CLICKY_DEBUG: '1',
    CLICKY_DEBUG_TOKEN: token,
    CLICKY_USER_DATA: userDataDir,
    ...(debugPort ? { CLICKY_DEBUG_PORT: String(debugPort) } : {}),
    ...(mockUrl ? { CLICKY_MOCK_URL: mockUrl } : {}),
    ...(fakeMicWav ? { CLICKY_FAKE_MIC: fakeMicWav } : {}),
    ...extraEnv,
  };
  // In --live mode the app must NOT see a stale mock URL from the shell.
  if (!mockUrl) delete env.CLICKY_MOCK_URL;
  const proc = spawn(electronBinary(), ['.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = (chunk) => {
    if (logFile) logFile.write(chunk);
  };
  proc.stdout.on('data', log);
  proc.stderr.on('data', log);
  return {
    proc,
    kill: () => killTree(proc.pid),
  };
}

/**
 * M9: force the kiosk window to the FOREGROUND (best-effort, never throws).
 * When the eval runs while the user is actively working, a spawned Edge
 * kiosk can open BEHIND the user's focused window — then both the capture
 * and UIA grounding see the wrong window. Finds the first visible top-level
 * window owned by the pid's process tree and foregrounds it (the brief
 * synthetic Alt tap is the documented unlock for SetForegroundWindow from a
 * background process).
 */
export function focusWindowOfTree(rootPid) {
  if (!rootPid) return;
  const script = [
    `$rootPid = ${Number(rootPid)}`,
    `$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId`,
    `$set = New-Object 'System.Collections.Generic.HashSet[int]'`,
    `[void]$set.Add([int]$rootPid)`,
    `do { $added = $false; foreach ($p in $procs) { if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) { [void]$set.Add([int]$p.ProcessId); $added = $true } } } while ($added)`,
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FG{[DllImport("user32.dll")]public static extern IntPtr GetTopWindow(IntPtr h);[DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr h, uint cmd);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);[DllImport("user32.dll")]public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);}'`,
    `$h = [FG]::GetTopWindow([IntPtr]::Zero); $target = [IntPtr]::Zero`,
    `while ($h -ne [IntPtr]::Zero) { if ([FG]::IsWindowVisible($h)) { [uint32]$wpid = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$wpid); if ($set.Contains([int]$wpid)) { $target = $h; break } }; $h = [FG]::GetWindow($h, 2) }`,
    // Z-order raise via TOPMOST pin (not subject to foreground-permission
    // rules) so the kiosk stays above the user's windows for the scene; the
    // Alt-tap + SetForegroundWindow additionally moves keyboard focus when
    // allowed. The kiosk is killed right after the scene, unpinning is moot.
    `if ($target -ne [IntPtr]::Zero) { [void][FG]::SetWindowPos($target, (New-Object IntPtr(-1)), 0, 0, 0, 0, 0x0053); [FG]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [void][FG]::SetForegroundWindow($target); [FG]::keybd_event(0x12,0,2,[UIntPtr]::Zero) }`,
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {
    /* best effort */
  }
}

/** Kill a process tree on Windows (best-effort, never throws). */
export function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/** Start the mock realtime server in-process. Returns { url, close }. */
export async function startMock({ port = 8123 } = {}) {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const { createMockServer } = require(path.join(ROOT, 'tools', 'mock-realtime', 'server.js'));
  // Fall back to nearby ports if another agent's mock holds the default.
  let lastErr;
  for (const candidate of [port, port + 1, port + 2, 0]) {
    try {
      const server = await createMockServer({ port: candidate, log: () => {} });
      return { url: server.url, port: server.port, close: () => server.close() };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Locate msedge.exe (kiosk scenes). Returns null when not installed. */
export function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Locate chrome.exe as the kiosk fallback. */
export function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// WAV + stats helpers
// ---------------------------------------------------------------------------

/** Parse a PCM16 mono WAV buffer -> { sampleRate, samples: Float32Array }. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      data = buf.subarray(offset + 8, offset + 8 + size);
    }
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');
  if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}`);
  const frames = Math.floor(data.length / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    // Mono-mix if needed (channel 0 only — eval audio is mono anyway).
    samples[i] = data.readInt16LE(i * 2 * channels) / 32768;
  }
  return { sampleRate, channels, samples };
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function fmtMs(v) {
  return v === null || v === undefined ? 'n/a' : `${Math.round(v)}ms`;
}
