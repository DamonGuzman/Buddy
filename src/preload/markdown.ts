/** Sandboxed bridge for Buddy's rich-only Markdown document window. */

import { contextBridge, ipcRenderer } from 'electron';
import type { MarkdownApi } from '../shared/ipc';

const api: MarkdownApi = {
  getDocument: () => ipcRenderer.invoke('markdown:get-document'),
  ready: () => ipcRenderer.invoke('markdown:ready'),
  renderFailed: (detail) => ipcRenderer.invoke('markdown:render-failed', detail),
  openExternal: (url) => ipcRenderer.invoke('markdown:open-external', url),
};

contextBridge.exposeInMainWorld('clicky', api);
