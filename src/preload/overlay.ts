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
};

contextBridge.exposeInMainWorld('clicky', api);
