'use strict';

const { contextBridge } = require('electron');

const subscribe = () => () => {};
contextBridge.exposeInMainWorld('clicky', {
  onTranscript: subscribe,
  onAssistantState: subscribe,
  onSettings: subscribe,
  onShown: subscribe,
  onFilesystemState: subscribe,
  onFilesystemSelection: subscribe,
  getSettings: async () => ({ apiKeyPresent: false, voiceMuted: false }),
  getAssistantState: async () => 'idle',
  getFilesystemState: async () => [],
  getFilesystemSelection: async () => null,
  askText: async () => {},
  selectFilesystemRoot: async () => null,
  clearFilesystemRoot: async () => {},
  startFilesystemTask: async () => {
    throw new Error('filesystem task is unavailable in the Whisper E2E fixture');
  },
  openFilesystemSafeCopy: async () => {},
  discardFilesystemTask: async () => {},
  undoFilesystemTask: async () => {},
  keepFilesystemTask: async () => {},
  cancelFilesystemTask: async () => {},
  setSettings: async () => ({ apiKeyPresent: false, voiceMuted: false }),
  hide: () => {},
});
