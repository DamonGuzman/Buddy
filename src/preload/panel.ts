/**
 * Panel preload: exposes the narrow typed `window.clicky` PanelApi.
 * contextIsolation is ON; the raw API key never crosses this boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  MainToPanelChannel,
  MainToPanelEvents,
  PanelApi,
  Unsubscribe,
} from '../shared/ipc';

function subscribe<C extends MainToPanelChannel>(
  channel: C,
  cb: (payload: MainToPanelEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToPanelEvents[C]): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: PanelApi = {
  onTranscript: (cb) => subscribe('panel:transcript', cb),
  onSessionStatus: (cb) => subscribe('panel:session-status', cb),
  onAssistantState: (cb) => subscribe('panel:assistant-state', cb),
  onSettings: (cb) => subscribe('panel:settings', cb),
  onAudioOutput: (cb) => subscribe('audio:output', cb),
  onPlayback: (cb) => subscribe('audio:playback', cb),
  // M5 addition (orchestrator-approved): mic capture start/stop from main.
  onCaptureCommand: (cb) => subscribe('audio:capture', cb),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  askText: (text) => ipcRenderer.invoke('panel:ask-text', text),
  listMics: () => ipcRenderer.invoke('mic:list'),
  selectMic: (deviceId) => ipcRenderer.invoke('mic:select', deviceId),

  sendAudioChunk: (chunk) => ipcRenderer.send('audio:chunk', chunk),

  // M8.5 addition (orchestrator-approved): playback tap reporting.
  sendPlaybackStats: (stats) => ipcRenderer.send('audio:playback-stats', stats),
  sendPlaybackRing: (ring) => ipcRenderer.send('audio:playback-ring', ring),
};

contextBridge.exposeInMainWorld('clicky', api);
