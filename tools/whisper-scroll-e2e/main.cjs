'use strict';

const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

app.setPath('userData', requiredEnvironment('BUDDY_WHISPER_E2E_USER_DATA'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 340,
    height: 390,
    frame: false,
    transparent: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'whisper', 'index.html'));
  win.show();
  win.focus();
});

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}
