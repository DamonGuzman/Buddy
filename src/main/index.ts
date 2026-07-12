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
}
