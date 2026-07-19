/**
 * Overlay preload: exposes the narrow typed `window.clicky` OverlayApi.
 * contextIsolation is ON; nothing but this surface reaches the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { MainToOverlayEvents, OverlayApi, Unsubscribe } from '../shared/ipc';
import { parseOverlayParams } from '../renderer/overlay/query-params';

// SANDBOX CONSTRAINT: sandboxed preloads must bundle to a SINGLE file. A
// value import shared by more than one preload entry becomes a rollup chunk
// ("./chunks/subscribe-*.js") the sandbox cannot require — the preload then
// silently fails to load, window.clicky never exists, and the renderer is
// dead (invisible buddy / dead panel). So the tiny subscriber idiom is
// duplicated per preload instead of shared. Type-only imports are safe.
function subscribe<C extends Extract<keyof MainToOverlayEvents, string>>(
  channel: C,
  cb: (payload: MainToOverlayEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToOverlayEvents[C]): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// Preload runs in the renderer context, so `location` exists at runtime, but
// this file is typechecked under the node tsconfig (no DOM lib) — hence the cast.
const pageSearch =
  (globalThis as unknown as { location?: { search: string } }).location?.search ?? '';

const api: OverlayApi = {
  screenIndex: parseOverlayParams(pageSearch).screenIndex,
  isMacOS: process.platform === 'darwin',
  onPointer: (cb) => subscribe('overlay:pointer', cb),
  onAssistantState: (cb) => subscribe('overlay:assistant-state', cb),
  onCaption: (cb) => subscribe('overlay:caption', cb),
  onCaptureIndicator: (cb) => subscribe('overlay:capture-indicator', cb),
  getAssistantState: () => ipcRenderer.invoke('overlay:get-state'),
  // M15 additions (orchestrator-approved): buddy hover.
  onHoverConfig: (cb) => subscribe('overlay:hover-config', cb),
  onInteractive: (cb) => subscribe('overlay:interactive', cb),
  getHoverConfig: () => ipcRenderer.invoke('overlay:get-hover-config'),
  onDisplaySurface: (cb) => subscribe('overlay:display-surface', cb),
  getDisplaySurface: () => ipcRenderer.invoke('overlay:get-display-surface'),
  sendHover: (evt) => ipcRenderer.send('overlay:hover', evt),
  sendBuddyClick: () => ipcRenderer.send('overlay:buddy-click', null),
  sendBuddySettings: () => ipcRenderer.send('overlay:buddy-settings', null),
  sendBuddyMove: (rest) => ipcRenderer.send('overlay:buddy-move', rest),
  // M20 addition: main-side cursor feed (forward:true fallback).
  onCursor: (cb) => subscribe('overlay:cursor', cb),
  // M19 additions: helper buddies on the overlay.
  onHelperBuddies: (cb) => subscribe('overlay:helper-buddies', cb),
  getHelperBuddies: () => ipcRenderer.invoke('helper-buddies:list'),
  onHelperBuddyBrowserPreview: (cb) => subscribe('overlay:helper-buddy-browser-preview', cb),
  getHelperBuddyBrowserPreviews: () => ipcRenderer.invoke('helper-buddies:list-browser-previews'),
  markHelperBuddySeen: (id) => ipcRenderer.invoke('helper-buddies:mark-seen', id),
  sendHelperBuddyClick: (id) => ipcRenderer.send('overlay:helper-buddy-click', { id }),
  sendHelperBuddyCancel: (id) => ipcRenderer.send('overlay:helper-buddy-cancel', { id }),
};

contextBridge.exposeInMainWorld('clicky', api);
