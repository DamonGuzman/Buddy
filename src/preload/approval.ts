/** Standalone approval preload: exposes only the approval queue and decisions. */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { ApprovalApi, MainToApprovalEvents, Unsubscribe } from '../shared/ipc';

function subscribe<C extends Extract<keyof MainToApprovalEvents, string>>(
  channel: C,
  cb: (payload: MainToApprovalEvents[C]) => void,
): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: MainToApprovalEvents[C]): void =>
    cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ApprovalApi = {
  onRequests: (cb) => subscribe('approval:requests', cb),
  setContentHeight: (height) => ipcRenderer.send('approval:content-height', height),
  resolveApproval: (helperBuddyId, approvalId, verdict) =>
    ipcRenderer.invoke('approval:resolve', helperBuddyId, approvalId, verdict),
  showApprovalWindow: (helperBuddyId, approvalId) =>
    ipcRenderer.invoke('approval:show-window', helperBuddyId, approvalId),
  hideApprovalWindow: (helperBuddyId, approvalId) =>
    ipcRenderer.invoke('approval:hide-window', helperBuddyId, approvalId),
  listApprovals: () => ipcRenderer.invoke('approvals:list'),
};

contextBridge.exposeInMainWorld('clicky', api);
