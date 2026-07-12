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

import { app, ipcMain, powerMonitor } from 'electron';
import { captureAllDisplays } from './capture';
import { Conversation } from './conversation';
import { startDebugServer } from './debug-server';
import { HotkeyManager } from './hotkey';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { OverlayManager } from './windows/overlay';
import { PanelManager } from './windows/panel';
import type { InvokeArgs, InvokeChannel, InvokeResult } from '../shared/ipc';
import type { DebugState, MicDevice, PlaybackStatsUpdate } from '../shared/types';

// CLICKY_USER_DATA=<dir>: separate userData dir (settings + the
// single-instance lock) so parallel dev/QA instances don't fight over the
// lock. MUST run before requestSingleInstanceLock below.
if (process.env['CLICKY_USER_DATA']) {
  app.setPath('userData', process.env['CLICKY_USER_DATA']);
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
  const conversation = new Conversation({ settings, overlays, panel });

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

  ipcMain.on('audio:chunk', (_event, chunk: ArrayBuffer) => {
    conversation.handleAudioChunk(chunk);
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
  });

  hotkey.on('hold-start', () => conversation.holdStart());
  hotkey.on('hold-end', () => conversation.holdEnd());
  // F1 fix (C1): forced release (max-hold watchdog / lock / suspend) cancels
  // the hold — mic released, held audio cleared, NO turn committed.
  hotkey.on('hold-cancel', () => conversation.cancelHold());

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  await app.whenReady();
  app.setAppUserModelId('ai.fastyr.clicky');

  overlays.start();
  hotkey.start();

  // F1 fix (C1 + sleep/resume): the secure desktop (Ctrl+Alt+Del) and lock
  // screen swallow keyups — force-cancel any live hold and reset modifier
  // state so the mic can never stay hot on a locked machine. On resume, the
  // realtime socket may be half-open; reset it so the next turn reconnects.
  powerMonitor.on('lock-screen', () => hotkey.forceCancel());
  powerMonitor.on('suspend', () => hotkey.forceCancel());
  powerMonitor.on('resume', () => conversation.onSystemResume());

  const tray = createTray({
    onTogglePanel: () => panel.toggle(),
    onOpenPanel: () => panel.show(),
    onQuit: () => app.quit(),
  });
  // Keep a reference so the tray isn't garbage-collected.
  void tray;

  app.on('second-instance', () => panel.show());

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
  });

  // Tray app: stay alive with zero visible windows.
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
  app.on('will-quit', () => {
    hotkey.stop();
    conversation.close();
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
