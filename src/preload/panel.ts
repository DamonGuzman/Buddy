/**
 * Panel preload: exposes the narrow typed `window.clicky` PanelApi.
 * contextIsolation is ON; the raw API key never crosses this boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { MainToPanelEvents, PanelApi, Unsubscribe } from '../shared/ipc';

// SANDBOX CONSTRAINT: duplicated per preload ON PURPOSE — a shared value
// import becomes a rollup chunk sandboxed preloads cannot require (the
// preload silently fails to load and the renderer is dead). See overlay.ts.
function subscribe<C extends Extract<keyof MainToPanelEvents, string>>(
  channel: C,
  cb: (payload: MainToPanelEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToPanelEvents[C]): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// M21: the chat panel's transcript/composer/agents accessors retired with
// the panel — this window is the hidden audio host + settings surface.
const api: PanelApi = {
  onSessionStatus: (cb) => subscribe('panel:session-status', cb),
  onAssistantState: (cb) => subscribe('panel:assistant-state', cb),
  onSettings: (cb) => subscribe('panel:settings', cb),
  onAudioOutput: (cb) => subscribe('audio:output', cb),
  onPlayback: (cb) => subscribe('audio:playback', cb),
  // M5 addition (orchestrator-approved): mic capture start/stop from main.
  onCaptureCommand: (cb) => subscribe('audio:capture', cb),
  // M11 addition (orchestrator-approved): runtime flags (hookAlive + dev flags).
  onRuntime: (cb) => subscribe('panel:runtime', cb),
  onPermissions: (cb) => subscribe('panel:permissions', cb),
  // M17 addition (integration-approved): Codex sign-in state push.
  onCodexSignin: (cb) => subscribe('panel:codex-signin', cb),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  getRuntime: () => ipcRenderer.invoke('panel:get-runtime'),
  getPermissionHealth: () => ipcRenderer.invoke('permissions:get'),
  permissionAction: (action) => ipcRenderer.invoke('permissions:action', action),
  getCodexSigninState: () => ipcRenderer.invoke('codex:signin-state'),
  signInToCodex: () => ipcRenderer.invoke('codex:sign-in'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listMics: () => ipcRenderer.invoke('mic:list'),
  selectMic: (deviceId) => ipcRenderer.invoke('mic:select', deviceId),

  sendAudioChunk: (chunk) => ipcRenderer.send('audio:chunk', chunk),

  // M8.5 addition (orchestrator-approved): playback tap reporting.
  sendPlaybackStats: (stats) => ipcRenderer.send('audio:playback-stats', stats),
  sendPlaybackRing: (ring) => ipcRenderer.send('audio:playback-ring', ring),

  // M11 addition (orchestrator-approved): audio device failure reporting.
  reportAudioError: (payload) => ipcRenderer.send('audio:capture-error', payload),
};

contextBridge.exposeInMainWorld('clicky', api);
