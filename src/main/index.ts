/**
 * App bootstrap — WIRING ONLY. All behavior lives in the owned modules
 * (docs/ARCHITECTURE.md §5); this file just constructs them and connects
 * events to actions.
 */

import { app, ipcMain } from 'electron';
import { captureAllDisplays } from './capture';
import { startDebugServer } from './debug-server';
import { HotkeyManager } from './hotkey';
import { SYSTEM_PROMPT } from './persona';
import { RealtimeSession } from './realtime/session';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { OverlayManager } from './windows/overlay';
import { PanelManager } from './windows/panel';
import type { InvokeArgs, InvokeChannel, InvokeResult } from '../shared/ipc';
import type { AssistantState, CaptureMeta, DebugState, MicDevice } from '../shared/types';

// Single instance: a second launch just pops the panel of the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------
  // App-level state (read by the debug server; mutated only via setters)
  // ---------------------------------------------------------------------
  let assistantState: AssistantState = 'idle';
  let lastCapture: CaptureMeta[] | null = null;
  let micDevices: MicDevice[] = [];

  const settings = new SettingsStore();
  const overlays = new OverlayManager();
  const panel = new PanelManager();
  const hotkey = new HotkeyManager();
  const session = new RealtimeSession({
    model: settings.get().model,
    voice: settings.get().voice,
    getApiKey: () => settings.getApiKey(),
    instructions: SYSTEM_PROMPT,
  });

  function setAssistantState(next: AssistantState): void {
    if (assistantState === next) return;
    assistantState = next;
    overlays.broadcast('overlay:assistant-state', next);
    panel.send('panel:assistant-state', next);
  }

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
  handle('panel:ask-text', (text) => {
    // TODO(realtime milestone): route into session.askText with fresh captures.
    console.log('[main] text question (pipeline lands in realtime milestone):', text);
  });
  handle('mic:list', () => micDevices);
  handle('mic:select', (deviceId) => {
    settings.set({ micDeviceId: deviceId });
  });
  handle('overlay:get-state', () => assistantState);

  ipcMain.on('audio:chunk', (_event, chunk: ArrayBuffer) => {
    session.appendAudio(chunk);
  });

  // ---------------------------------------------------------------------
  // Module event wiring
  // ---------------------------------------------------------------------
  settings.onChange((snapshot) => panel.send('panel:settings', snapshot));
  session.on('status', (status) => panel.send('panel:session-status', status));

  hotkey.on('hold-start', () => {
    setAssistantState('listening');
    overlays.broadcast('overlay:capture-indicator', { active: true });
    void captureAllDisplays().then((results) => {
      lastCapture = results.map((r) => r.meta);
    });
  });
  hotkey.on('hold-end', () => {
    overlays.broadcast('overlay:capture-indicator', { active: false });
    // TODO(realtime milestone): session.commitTurn(...) then 'thinking'.
    setAssistantState('idle');
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  await app.whenReady();
  app.setAppUserModelId('ai.fastyr.clicky');

  overlays.start();
  hotkey.start();

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
    assistantState,
    overlayWindowCount: overlays.count(),
    panelVisible: panel.isVisible(),
    hotkey: hotkey.status(),
    session: session.status(),
    lastCapture,
  });
  startDebugServer({ getState: getDebugState });

  // Tray app: stay alive with zero visible windows.
  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
  app.on('will-quit', () => {
    hotkey.stop();
    session.close();
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
