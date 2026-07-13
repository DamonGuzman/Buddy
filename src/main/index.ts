/**
 * App bootstrap — WIRING ONLY. All behavior lives in the owned modules
 * (docs/ARCHITECTURE.md §5); this file just constructs them and connects
 * events to actions.
 *
 * Env flags handled here (must run before app ready):
 * - CLICKY_USER_DATA=<dir>   separate userData dir (parallel dev/QA instances).
 * - CLICKY_FAKE_MIC=<path.wav>  (M8.5 eval harness) route getUserMedia to
 *   Chromium's fake capture device playing this file instead of a real mic.
 *   The file MUST be a 16-bit PCM WAV (mono 24kHz preferred — matches the
 *   session's audio format so no resampling artifacts). Chromium LOOPS the
 *   file continuously; the push-to-talk hold window defines what is actually
 *   sent, so keep utterances ~2-3s and holds ~3.5s. Also auto-grants the mic
 *   permission prompt (use-fake-ui-for-media-stream).
 */

import { app, ipcMain, powerMonitor, shell } from 'electron';
import type { Tray } from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureAllDisplays } from './capture';
import { getCodexAuthProvider } from './auth/codex-auth';
import { CodexOAuthLoopback } from './auth/oauth-loopback';
import { CodexAgentBackend } from './agents/backend';
import { AgentManager } from './agents/manager';
import { MockAgentBackend } from './agents/mock-backend';
import type { AgentBackend } from './agents/types';
import { Conversation } from './conversation';
import { startDebugServer } from './debug-server';
import { describeKind } from './errors';
import { HotkeyManager } from './hotkey';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { OverlayManager } from './windows/overlay';
import { PanelManager } from './windows/panel';
import { PhoneAudioBridgeClient } from './phone-audio-bridge';
import { ENV_DEBUG } from '../shared/constants';
import type { InvokeArgs, InvokeChannel, InvokeResult } from '../shared/ipc';
import type {
  AudioDeviceError,
  DebugState,
  MicDevice,
  PlaybackStatsUpdate,
  RuntimeFlags,
} from '../shared/types';

// CLICKY_USER_DATA=<dir>: separate userData dir (settings + the
// single-instance lock) so parallel dev/QA instances don't fight over the
// lock. MUST run before requestSingleInstanceLock below.
if (process.env['CLICKY_USER_DATA']) {
  app.setPath('userData', process.env['CLICKY_USER_DATA']);
} else {
  // Preserve settings and sign-in state for users upgrading from the legacy
  // heyclicky package name. Fresh installs use Electron's new Buddy path.
  const legacyUserData = join(app.getPath('appData'), 'heyclicky');
  const currentSettings = join(app.getPath('userData'), 'settings.json');
  const legacySettings = join(legacyUserData, 'settings.json');
  if (!existsSync(currentSettings) && existsSync(legacySettings)) {
    app.setPath('userData', legacyUserData);
  }
}

// M8.5 (orchestrator-approved): fake-mic audio injection for the audio eval
// harness — real getUserMedia path, fake device fed from a WAV file. See the
// file header for the contract. MUST run before app ready.
if (process.env['CLICKY_FAKE_MIC']) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env['CLICKY_FAKE_MIC']);
}

// Single instance: a second launch just pops the panel of the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  // Known limitation: mic devices are enumerated by the panel renderer
  // locally; this main-side cache is never populated (mic:list returns []).
  const micDevices: MicDevice[] = [];

  const settings = new SettingsStore();
  const overlays = new OverlayManager();
  const panel = new PanelManager();
  const hotkey = new HotkeyManager();
  let tray: Tray | null = null;
  const codexAuth = getCodexAuthProvider();
  const codexAgentBackend = new CodexAgentBackend(codexAuth);
  const agentMock = process.env['CLICKY_AGENT_MOCK'] === '1';
  const agentBackend: AgentBackend = agentMock ? new MockAgentBackend() : codexAgentBackend;
  let conversation!: Conversation;
  const phoneAudioUrl = process.env['CLICKY_PHONE_AUDIO_URL']?.trim() ?? '';
  const phoneAudio = phoneAudioUrl ? new PhoneAudioBridgeClient(phoneAudioUrl) : null;
  const agents = new AgentManager({
    backend: agentBackend,
    isReady: () => agentMock || codexAgentBackend.isReady(),
    persistencePath: join(app.getPath('userData'), 'agents.json'),
    onAgentsChanged: (list) => panel.send('panel:agents', list),
    onFinished: (summary) => conversation.deliverAgentResult(summary),
    notify: (title, body) => {
      try { tray?.displayBalloon({ title, content: body }); } catch { /* unavailable on some systems */ }
    },
  });
  conversation = new Conversation({
    settings,
    overlays,
    panel,
    codexAuth,
    agents,
    ...(phoneAudio !== null ? { phoneAudio } : {}),
  });
  phoneAudio?.on('audio', (chunk) => conversation.handleAudioChunk(chunk));
  phoneAudio?.start();

  // ---------------------------------------------------------------------
  // M11: last-resort crash handling. An uncaught main-process exception used
  // to pop Electron's raw dialog (or kill the tray app outright). Log it to
  // <userData>/clicky.log, keep the app alive, and let the tray tooltip say
  // what to do. Registered FIRST so even boot-time throws are covered.
  // ---------------------------------------------------------------------
  const logFatal = (kind: string, err: unknown): void => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[fatal] ${kind}:`, detail);
    try {
      appendFileSync(
        join(app.getPath('userData'), 'clicky.log'),
        `[${new Date().toISOString()}] ${kind}: ${detail}\n`,
      );
    } catch {
      /* the crash logger must never crash */
    }
    try {
      tray?.setToolTip('buddy tripped over something — a restart will fix it');
    } catch {
      /* tray may be gone during shutdown */
    }
  };
  process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => logFatal('unhandledRejection', reason));

  // M11: runtime flags for the panel — hookAlive (the hero hint adapts when
  // the hook is dead) + CLICKY_* dev/QA flags besides CLICKY_DEBUG (generic
  // dev chip in the header, extending the old mock-only badge).
  const devFlags = Object.keys(process.env)
    .filter((k) => k.startsWith('CLICKY_') && k !== ENV_DEBUG && (process.env[k] ?? '') !== '')
    .map((k) => k.slice('CLICKY_'.length).toLowerCase())
    .sort();
  const runtimeFlags = (): RuntimeFlags => ({ hookAlive: hotkey.status().hookAlive, devFlags });
  const pushRuntime = (): void => panel.send('panel:runtime', runtimeFlags());

  // M17 (integration): push the Codex ChatGPT-subscription sign-in snapshot to
  // the panel — on ready, and whenever it changes (the CLI's auth.json can
  // rotate out from under us, so a light 60s poll refreshes it). The codex*
  // fields also ride on 'panel:settings'; we re-push that on change so the
  // settings "ChatGPT" card updates without a fresh settings:get().
  let lastCodexSignin = '';
  const pushCodexSignin = (force: boolean): void => {
    let state;
    try {
      state = getCodexAuthProvider().codexSignInState();
    } catch (err) {
      console.warn('[boot] codex sign-in state unavailable:', err instanceof Error ? err.name : 'unknown');
      return;
    }
    const key = JSON.stringify(state);
    if (!force && key === lastCodexSignin) return;
    lastCodexSignin = key;
    panel.send('panel:codex-signin', state);
    panel.send('panel:settings', settings.get());
    conversation.onAgentAvailabilityChanged();
  };
  const codexOAuth = new CodexOAuthLoopback({
    auth: codexAuth,
    openExternal: (url) => shell.openExternal(url),
    onComplete: () => pushCodexSignin(true),
  });

  // ---------------------------------------------------------------------
  // Typed invoke handlers (single registration point for InvokeChannels)
  // ---------------------------------------------------------------------
  function handle<C extends InvokeChannel>(
    channel: C,
    handler: (...args: InvokeArgs<C>) => InvokeResult<C> | Promise<InvokeResult<C>>,
  ): void {
    ipcMain.handle(channel, (_event, ...args) => handler(...(args as InvokeArgs<C>)));
  }

  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => settings.set(patch));
  handle('panel:ask-text', (text) => conversation.askText(text));
  handle('mic:list', () => micDevices);
  handle('mic:select', (deviceId) => {
    settings.set({ micDeviceId: deviceId });
  });
  handle('overlay:get-state', () => conversation.assistantState());
  // M11 addition (orchestrator-approved): runtime flags bootstrap.
  handle('panel:get-runtime', () => runtimeFlags());
  // M17 addition (integration-approved): Codex sign-in snapshot bootstrap.
  handle('codex:signin-state', () => getCodexAuthProvider().codexSignInState());
  handle('codex:sign-in', () => codexOAuth.start());
  handle('agents:list', () => agents.list());
  handle('agents:cancel', (id) => agents.cancel(id));
  handle('agents:cancel-all', () => agents.cancelAll());
  handle('agents:mark-seen', (id) => agents.markSeen(id));

  ipcMain.on('audio:chunk', (_event, chunk: ArrayBuffer) => {
    conversation.handleAudioChunk(chunk);
  });
  // M11 addition (orchestrator-approved): audio device failure reports from
  // the panel renderer (mic capture start / playback init).
  ipcMain.on('audio:capture-error', (_event, payload: AudioDeviceError) => {
    if (!payload || (payload.source !== 'mic' && payload.source !== 'playback')) return;
    conversation.handleAudioDeviceError({
      source: payload.source,
      name: typeof payload.name === 'string' ? payload.name : 'Error',
      message: typeof payload.message === 'string' ? payload.message : '',
    });
  });
  // M8.5 (orchestrator-approved): playback tap reporting from the panel.
  ipcMain.on('audio:playback-stats', (_event, stats: PlaybackStatsUpdate) => {
    conversation.handlePlaybackStats(stats);
  });
  ipcMain.on('audio:playback-ring', (_event, ring: ArrayBuffer) => {
    conversation.handlePlaybackRing(ring);
  });

  // ---------------------------------------------------------------------
  // Module event wiring
  // ---------------------------------------------------------------------
  settings.onChange((snapshot) => {
    panel.send('panel:settings', snapshot);
    conversation.onSettingsChanged(snapshot);
    tray?.setToolTip(
      snapshot.fullRealtimeMode
        ? 'buddy - press Ctrl + left Alt to start or stop realtime'
        : 'buddy - hold Ctrl + left Alt and talk',
    );
  });

  hotkey.on('hold-start', () => {
    if (settings.get().fullRealtimeMode) void conversation.toggleFullRealtime();
    else conversation.holdStart();
  });
  hotkey.on('hold-end', () => {
    if (!settings.get().fullRealtimeMode) conversation.holdEnd();
  });
  // F1 fix (C1): forced release (max-hold watchdog / lock / suspend) cancels
  // the hold — mic released, held audio cleared, NO turn committed.
  // M11 (hold_too_long): the 30s watchdog cancel additionally TELLS the user
  // (it used to be silent — the answer just never came).
  hotkey.on('hold-cancel', (reason) => {
    if (settings.get().fullRealtimeMode) return;
    conversation.cancelHold();
    if (reason === 'watchdog') conversation.reportError('hold_too_long');
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  await app.whenReady();
  app.setAppUserModelId('ai.fastyr.buddy');

  overlays.start();

  // M11 CRASH FIX: the tray AND the hotkey 'error' listener must exist
  // BEFORE hotkey.start(). A failing keyboard hook emits 'error', and an
  // EventEmitter 'error' with no listener THROWS — which used to escape here
  // and abort the rest of boot (tray, powerMonitor, debug server never ran):
  // a hook failure left the app running with no UI entry point at all.
  tray = createTray({
    onTogglePanel: () => panel.toggle(),
    onOpenPanel: () => panel.show(),
    onQuit: () => app.quit(),
  });
  if (settings.get().fullRealtimeMode) {
    tray.setToolTip('buddy - press Ctrl + left Alt to start or stop realtime');
  }

  hotkey.on('error', () => {
    // hotkey_dead: transcript entry + one-time panel auto-show (catalog
    // policy) + a tray tooltip that points at the typing fallback.
    conversation.reportError('hotkey_dead');
    tray?.setToolTip('buddy — hotkey unavailable, click to type');
    pushRuntime(); // the panel hero hint adapts to hookAlive === false
  });

  hotkey.start();

  // M11 (renderer_dead): panel crash recovery gave up — the window has been
  // torn down (a tray click builds a fresh one); tell the user via the tray.
  panel.onFatal(() => {
    const dead = describeKind('renderer_dead');
    try {
      tray?.displayBalloon({ title: 'buddy', content: dead.message });
    } catch {
      /* balloons can be unavailable; the tooltip below still lands */
    }
    tray?.setToolTip(`buddy — ${dead.message}`);
  });

  // M11: every panel renderer load (boot + crash-recreate) gets the current
  // transcript ring, status snapshots and runtime flags replayed — boot-time
  // errors (hotkey_dead, settings_reset) no longer vanish because they were
  // pushed before the renderer existed.
  panel.onRendererReady(() => {
    conversation.replayToPanel();
    panel.send('panel:settings', settings.get());
    pushRuntime();
    // M17: hand the (re)loaded panel the current Codex sign-in snapshot.
    pushCodexSignin(true);
    panel.send('panel:agents', agents.list());
  });

  // M17 (integration): warm the Codex auth provider at boot so the first
  // grounding call (and the first panel snapshot) doesn't pay the token-store
  // / auth.json read latency, and push the initial snapshot. A light 60s poll
  // catches the CLI's auth.json rotating (sign-in/out/refresh) out from under
  // us and re-pushes to the panel only when it actually changed.
  try {
    getCodexAuthProvider().codexSignInState();
  } catch (err) {
    console.warn('[boot] codex warm failed:', err instanceof Error ? err.name : 'unknown');
  }
  pushCodexSignin(true);
  const codexPoll = setInterval(() => pushCodexSignin(false), 60_000);
  codexPoll.unref?.();

  // F1 fix (C1 + sleep/resume): the secure desktop (Ctrl+Alt+Del) and lock
  // screen swallow keyups — force-cancel any live hold and reset modifier
  // state so the mic can never stay hot on a locked machine. On resume, the
  // realtime socket may be half-open; reset it so the next turn reconnects.
  powerMonitor.on('lock-screen', () => {
    hotkey.forceCancel();
    conversation.deactivateFullRealtime();
  });
  powerMonitor.on('suspend', () => {
    hotkey.forceCancel();
    conversation.deactivateFullRealtime();
  });
  powerMonitor.on('resume', () => conversation.onSystemResume());

  app.on('second-instance', () => panel.show());

  // M11: last-resort-handler verification hook (headless QA only):
  // CLICKY_TEST_THROW=exception|rejection blows up 3s after boot so the
  // harness can assert the app SURVIVES and the crash landed in clicky.log.
  if (process.env['CLICKY_TEST_THROW']) {
    const kind = process.env['CLICKY_TEST_THROW'];
    setTimeout(() => {
      if (kind === 'rejection') {
        void Promise.reject(new Error('debug-injected unhandled rejection'));
      } else {
        throw new Error('debug-injected uncaught exception');
      }
    }, 3_000);
  }

  const getDebugState = (): DebugState => ({
    appVersion: app.getVersion(),
    assistantState: conversation.assistantState(),
    overlayWindowCount: overlays.count(),
    panelVisible: panel.isVisible(),
    hotkey: hotkey.status(),
    session: conversation.sessionStatus(),
    ...conversation.debugInfo(),
    // M8.5 additions (orchestrator-approved): audio-experience eval.
    lastTurnTimings: conversation.lastTurnTimings(),
    turnTimingsHistory: conversation.turnTimingsHistory(),
  });
  startDebugServer({
    getState: getDebugState,
    pipeline: {
      // EXACT hold-start/hold-end code paths: simulate() runs the same
      // FSM -> 'hold-start'/'hold-end' handlers as real key events.
      pressHotkey: () => hotkey.simulate('press'),
      releaseHotkey: () => hotkey.simulate('release'),
      askText: (text) => conversation.askText(text),
      getTranscript: () => conversation.transcript(),
      playback: (command) => conversation.playback(command),
    },
    // M8.5 (orchestrator-approved): audio eval surface.
    audioEval: {
      getOutputStats: () => conversation.outputStats(),
      getLastOutputRing: () => conversation.lastOutputRing(),
      getTimings: () => ({
        last: conversation.lastTurnTimings(),
        history: conversation.turnTimingsHistory(),
      }),
    },
    // M9: drive the element-snap grounding daemon directly (no model).
    grounding: {
      query: (q) => conversation.debugGroundingQuery(q),
    },
    agents: {
      spawn: (task) => agents.spawn({
        id: `agent_debug_${Date.now()}`,
        task,
        recentTranscript: '',
        createdAt: Date.now(),
      }),
      list: () => agents.list(),
      cancel: (id) => agents.cancel(id),
    },
  });

  // Tray app: stay alive with zero visible windows.
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
  app.on('will-quit', () => {
    clearInterval(codexPoll); // M17: stop the Codex sign-in refresh poll
    codexOAuth.stop();
    hotkey.stop();
    conversation.close();
    phoneAudio?.close();
    agents.dispose();
    overlays.destroy();
    panel.destroy();
  });

  // --- M3 capture self-test ---
  // CLICKY_CAPTURE_TEST=1: headed verification of the capture pipeline.
  // Writes screenN.jpg + meta.json to CLICKY_CAPTURE_OUT, prints the display
  // dump and capture timing, then quits. Two extra windows prove the
  // content-protection self-exclusion: a protected red window (must be
  // ABSENT from the jpeg) and an exempted lime control window (must be
  // VISIBLE). Everything is dynamically imported to keep this block fully
  // self-contained and dead in normal runs.
  if (process.env['CLICKY_CAPTURE_TEST'] === '1') {
    const { BrowserWindow, screen } = await import('electron');
    const { exemptFromCaptureProtection } = await import('./capture');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const outDir = process.env['CLICKY_CAPTURE_OUT'] ?? join(app.getPath('temp'), 'clicky-capture-test');
    mkdirSync(outDir, { recursive: true });

    const makeTestWin = (x: number, y: number, color: string, label: string) => {
      const win = new BrowserWindow({
        x,
        y,
        width: 640,
        height: 420,
        frame: false,
        skipTaskbar: true,
        focusable: false,
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      void win.loadURL(
        `data:text/html,<body style="margin:0;background:${color};color:black;` +
          `font:bold 90px sans-serif;display:grid;place-items:center">${label}</body>`,
      );
      return win;
    };
    const protectedWin = makeTestWin(120, 160, 'red', 'PROTECTED');
    protectedWin.setContentProtection(true);
    const controlWin = makeTestWin(820, 160, 'lime', 'CONTROL');
    exemptFromCaptureProtection(controlWin);

    // Let the overlays and test windows paint before grabbing.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const displayDump = screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      rotation: d.rotation,
    }));
    console.log('[self-test] displays:', JSON.stringify(displayDump, null, 2));

    const t0 = performance.now();
    const results = await captureAllDisplays();
    const elapsedMs = Math.round(performance.now() - t0);
    console.log(`[self-test] captured ${results.length} display(s) in ${elapsedMs}ms`);

    for (const r of results) {
      writeFileSync(
        join(outDir, `screen${r.meta.screenIndex}.jpg`),
        Buffer.from(r.jpegBase64, 'base64'),
      );
    }
    writeFileSync(
      join(outDir, 'meta.json'),
      JSON.stringify({ elapsedMs, captures: results.map((r) => r.meta), displays: displayDump }, null, 2),
    );
    console.log(`[self-test] wrote output to ${outDir}`);
    protectedWin.destroy();
    controlWin.destroy();
    app.quit();
  }
}
