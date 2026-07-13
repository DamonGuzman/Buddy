/**
 * Overlay preload: exposes the narrow typed `window.clicky` OverlayApi.
 * contextIsolation is ON; nothing but this surface reaches the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  MainToOverlayChannel,
  MainToOverlayEvents,
  OverlayApi,
  Unsubscribe,
} from '../shared/ipc';

function subscribe<C extends MainToOverlayChannel>(
  channel: C,
  cb: (payload: MainToOverlayEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToOverlayEvents[C]): void =>
    cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Preload runs in the renderer context, so `location` exists at runtime, but
// this file is typechecked under the node tsconfig (no DOM lib) — hence the cast.
const pageSearch =
  (globalThis as unknown as { location?: { search: string } }).location?.search ?? '';
const screenIndex = Number(new URLSearchParams(pageSearch).get('screenIndex') ?? '0');

const api: OverlayApi = {
  screenIndex: Number.isFinite(screenIndex) ? screenIndex : 0,
  onPointer: (cb) => subscribe('overlay:pointer', cb),
  onAssistantState: (cb) => subscribe('overlay:assistant-state', cb),
  onCaption: (cb) => subscribe('overlay:caption', cb),
  onCaptureIndicator: (cb) => subscribe('overlay:capture-indicator', cb),
  getAssistantState: () => ipcRenderer.invoke('overlay:get-state'),
  // M15 additions (orchestrator-approved): buddy hover.
  onHoverConfig: (cb) => subscribe('overlay:hover-config', cb),
  onInteractive: (cb) => subscribe('overlay:interactive', cb),
  getHoverConfig: () => ipcRenderer.invoke('overlay:get-hover-config'),
  sendHover: (evt) => ipcRenderer.send('overlay:hover', evt),
  sendBuddyClick: () => ipcRenderer.send('overlay:buddy-click', null),
  sendBuddyMove: (rest) => ipcRenderer.send('overlay:buddy-move', rest),
  // M19 additions (integration-approved): agent helpers on the overlay.
  onAgents: (cb) => subscribe('overlay:agents', cb),
  getAgents: () => ipcRenderer.invoke('agents:list'),
  sendAgentClick: (id) => ipcRenderer.send('overlay:agent-click', { id }),
  sendAgentCancel: (id) => ipcRenderer.send('overlay:agent-cancel', { id }),
};

contextBridge.exposeInMainWorld('clicky', api);
