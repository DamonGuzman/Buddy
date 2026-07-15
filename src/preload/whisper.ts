/**
 * Whisper preload: exposes the narrow typed `window.clicky` WhisperApi.
 * contextIsolation is ON; the raw API key never crosses this boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { MainToWhisperEvents, Unsubscribe, WhisperApi } from '../shared/ipc';

// SANDBOX CONSTRAINT: duplicated per preload ON PURPOSE — a shared value
// import becomes a rollup chunk sandboxed preloads cannot require (the
// preload silently fails to load and the renderer is dead). See overlay.ts.
function subscribe<C extends Extract<keyof MainToWhisperEvents, string>>(
  channel: C,
  cb: (payload: MainToWhisperEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToWhisperEvents[C]): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: WhisperApi = {
  onTranscript: (cb) => subscribe('whisper:transcript', cb),
  onAssistantState: (cb) => subscribe('whisper:assistant-state', cb),
  onSettings: (cb) => subscribe('whisper:settings', cb),
  onShown: (cb) => subscribe('whisper:shown', () => cb()),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  getAssistantState: () => ipcRenderer.invoke('overlay:get-state'),

  askText: (text) => ipcRenderer.invoke('panel:ask-text', text),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  hide: () => ipcRenderer.send('whisper:hide', null),
};

contextBridge.exposeInMainWorld('clicky', api);
