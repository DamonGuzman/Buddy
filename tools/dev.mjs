/**
 * `npm run dev` — the dev-mode runner. Two independent jobs, composed in
 * main():
 *
 *  1. Dev runner: spawn electron-vite dev/--watch against the "Buddy Dev"
 *     profile, importing the local OPENAI_API_KEY (env or HKCU registry).
 *  2. Optional iPhone audio bridge supervision — DEV MODE ONLY and enabled
 *     explicitly with CLICKY_PHONE_AUDIO_AUTOSTART=1. Packaged builds use the
 *     same exact opt-in through src/main/phone-audio-bridge-supervisor.ts.
 *
 * CLICKY_PHONE_AUDIO_URL=<url> connects to an externally managed bridge on
 * any platform. With neither flag, Buddy uses the normal panel microphone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const cliArgs = process.argv.slice(2);

// ---------------------------------------------------------------------------
// Child-process lifecycle (shared by both jobs)
// ---------------------------------------------------------------------------

let bridgeProcess = null;
let electronProcess = null;
let shuttingDown = false;

function terminateProcess(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGTERM');
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminateProcess(electronProcess);
  terminateProcess(bridgeProcess);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Job 1 — dev runner: profile env + API-key import + electron-vite spawn
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const electronVitePackage = require.resolve('electron-vite/package.json');
const electronViteCli = join(dirname(electronVitePackage), 'bin', 'electron-vite.js');

const appData =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : (process.env.APPDATA ?? join(process.env.USERPROFILE ?? process.cwd(), 'AppData', 'Roaming'));
const devUserData = join(appData, 'Buddy Dev');
const activeDevUserData = process.env.CLICKY_USER_DATA ?? devUserData;

function readLocalApiKey() {
  const processKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  if (processKey !== '') return processKey;
  if (process.platform !== 'win32') return '';

  const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'OPENAI_API_KEY'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return '';
  const match = result.stdout.match(/OPENAI_API_KEY\s+REG_[A-Z_]+\s+([^\r\n]+)/);
  return match?.[1]?.trim() ?? '';
}

/**
 * Spawn electron-vite dev/--watch with the dev profile. `phoneAudioUrl` is
 * what CLICKY_PHONE_AUDIO_URL should be for the app ('' = phone audio off).
 */
function spawnElectron(phoneAudioUrl) {
  const localApiKey = readLocalApiKey();
  console.log(`[dev] profile: ${activeDevUserData}`);
  console.log('[dev] renderer edits hot-reload; main and preload edits restart Electron');
  console.log(
    process.platform === 'darwin'
      ? '[dev] quit the installed Buddy from its menu-bar icon before testing Control+Option'
      : '[dev] quit the installed Buddy from its tray icon before testing Ctrl+Alt',
  );
  if (localApiKey !== '') {
    console.log('[dev] local OPENAI_API_KEY will be encrypted into the development profile');
  } else {
    console.warn('[dev] OPENAI_API_KEY is not set; no API key can be imported automatically');
  }

  electronProcess = spawn(process.execPath, [electronViteCli, 'dev', '--watch', ...cliArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CLICKY_USER_DATA: activeDevUserData,
      CLICKY_SHOW_PANEL: process.env.CLICKY_SHOW_PANEL ?? '1',
      CLICKY_PHONE_AUDIO_URL: phoneAudioUrl,
      CLICKY_IMPORT_API_KEY_FROM_ENV: localApiKey !== '' ? '1' : '0',
    },
  });

  electronProcess.on('error', (error) => {
    console.error('[dev] failed to start Electron:', error);
    shutdown(1);
  });
  electronProcess.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`[dev] Electron exited (${signal ?? code ?? 'unknown'})`);
    shutdown(code ?? 1);
  });
}

// ---------------------------------------------------------------------------
// Job 2 — iPhone audio bridge supervision (dev mode only)
// ---------------------------------------------------------------------------

const bridgeEntry = join(repoRoot, 'tools', 'phone-audio-bridge', 'start.mjs');

/** Default setup/health/WS port of tools/phone-audio-bridge (its SETUP_PORT). */
const DEFAULT_BRIDGE_SETUP_PORT = 3211;
const bridgePort = Number(process.env.CLICKY_PHONE_AUDIO_SETUP_PORT ?? DEFAULT_BRIDGE_SETUP_PORT);
const bridgeHealthUrl = `http://127.0.0.1:${bridgePort}/health`;
const bridgeSocketUrl = `ws://127.0.0.1:${bridgePort}/clicky`;

async function readBridgeHealth() {
  try {
    const response = await fetch(bridgeHealthUrl, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitForBridge(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readBridgeHealth();
    if (health !== null && predicate(health)) return health;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Reuse a healthy bridge or spawn one and wait for it to become healthy.
 * Returns true when a healthy bridge is up; hard-fails dev otherwise.
 */
async function ensureBridgeHealthy() {
  const existingBridge = await readBridgeHealth();
  if (existingBridge?.ok === true) {
    console.log(`[dev] reusing iPhone audio bridge at ${bridgeHealthUrl}`);
    return true;
  }

  console.log('[dev] starting iPhone audio bridge');
  bridgeProcess = spawn(process.execPath, [bridgeEntry, '--no-launch'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  bridgeProcess.on('error', (error) => {
    console.error('[dev] failed to start iPhone audio bridge:', error);
    shutdown(1);
  });
  bridgeProcess.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[dev] iPhone audio bridge exited (${signal ?? code ?? 'unknown'})`);
    shutdown(code ?? 1);
  });

  const bridgeReady = await waitForBridge((health) => health.ok === true, 30_000);
  if (bridgeReady === null) {
    console.error(`[dev] iPhone audio bridge did not become healthy at ${bridgeHealthUrl}`);
    shutdown(1);
    return false;
  }
  return true;
}

/** Background nicety: report when Buddy actually connects to the bridge. */
function watchBuddyBridgeConnection() {
  void waitForBridge((health) => health.clickyConnected === true, 15_000).then((health) => {
    if (health !== null) {
      console.log('[dev] Buddy connected to the iPhone audio bridge');
    } else if (!shuttingDown) {
      console.warn('[dev] Buddy has not connected to the iPhone audio bridge yet; it will retry');
    }
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

async function main() {
  const explicitPhoneAudioUrl = process.env.CLICKY_PHONE_AUDIO_URL;
  const trimmedExplicitPhoneAudioUrl = explicitPhoneAudioUrl?.trim() ?? '';
  const autostartPhoneBridge = process.env.CLICKY_PHONE_AUDIO_AUTOSTART === '1';

  if (cliArgs.some((arg) => ['--help', '-h', '--version', '-v'].includes(arg))) {
    spawnElectron(trimmedExplicitPhoneAudioUrl);
    return;
  }

  // An explicit URL always denotes an externally managed bridge. Do not
  // launch a second local server even when autostart is also set.
  if (trimmedExplicitPhoneAudioUrl !== '') {
    spawnElectron(trimmedExplicitPhoneAudioUrl);
    return;
  }

  // The default production/development path is always the panel mic.
  if (!autostartPhoneBridge) {
    spawnElectron('');
    return;
  }

  // The bundled harness invokes PowerShell and is intentionally Windows-only.
  if (process.platform !== 'win32') {
    throw new Error(
      `CLICKY_PHONE_AUDIO_AUTOSTART=1 is supported only on Windows (current platform: ${process.platform}); ` +
        'set CLICKY_PHONE_AUDIO_URL to use an externally managed bridge',
    );
  }

  if (!(await ensureBridgeHealthy())) return;

  spawnElectron(bridgeSocketUrl);
  watchBuddyBridgeConnection();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

void main().catch((error) => {
  console.error('[dev] startup failed:', error);
  shutdown(1);
});
