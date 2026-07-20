/** Narrow preload for the detached, click-through hover-hint renderer. */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { HoverHintApi, MainToHoverHintEvents, Unsubscribe } from '../shared/ipc';

function subscribe<C extends Extract<keyof MainToHoverHintEvents, string>>(
  channel: C,
  cb: (payload: MainToHoverHintEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToHoverHintEvents[C]): void =>
    cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: HoverHintApi = {
  onUpdate: (cb) => subscribe('hover-hint:update', cb),
  getState: () => ipcRenderer.invoke('hover-hint:get-state'),
  painted: (revision) => ipcRenderer.send('hover-hint:painted', { revision }),
};

contextBridge.exposeInMainWorld('clicky', api);
