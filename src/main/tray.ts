/**
 * Tray icon + menu. M21: left-click toggles the WHISPER composer (the chat
 * panel is gone); the context menu opens the whisper, Settings, or quits.
 * Also the single owner of the tray tooltip copy — index.ts sets
 * state-dependent hints through setTrayHint.
 */

import { app, Menu, Tray, nativeImage } from 'electron';
import type { NativeImage, Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME } from '../shared/constants';

// --- Tooltip copy (user-facing, byte-exact) --------------------------------

/** Initial tooltip before any settings-driven hint lands. */
export const TRAY_HINT_DEFAULT =
  process.platform === 'darwin'
    ? `${APP_NAME} — hold Control + left Option and talk`
    : `${APP_NAME} — hold Ctrl + left Alt and talk`;
/** Push-to-talk mode (settings.fullRealtimeMode off). */
export const TRAY_HINT_PUSH_TO_TALK = 'buddy - hold Ctrl + left Alt and talk';
/** Full realtime mode (the hotkey toggles an open-mic session). */
export const TRAY_HINT_FULL_REALTIME = 'buddy - press Ctrl + left Alt to start or stop realtime';
/** M11 hotkey_dead: points at the typing fallback. */
export const TRAY_HINT_HOTKEY_DEAD = 'buddy — hotkey unavailable, click to type';
/** M11 last-resort crash handler: the app survived an uncaught throw. */
export const TRAY_HINT_CRASHED = 'buddy tripped over something — a restart will fix it';

/** The ptt/realtime tooltip pair, selected by the current mode. */
export function trayHintForMode(fullRealtimeMode: boolean): string {
  if (process.platform === 'darwin') {
    return fullRealtimeMode
      ? 'buddy - press Control + left Option to start or stop realtime'
      : 'buddy - hold Control + left Option and talk';
  }
  return fullRealtimeMode ? TRAY_HINT_FULL_REALTIME : TRAY_HINT_PUSH_TO_TALK;
}

/** Set the tray tooltip (no-op while the tray doesn't exist yet). */
export function setTrayHint(tray: Tray | null, hint: string): void {
  tray?.setToolTip(hint);
}

// ----------------------------------------------------------------------------

/**
 * 32x32 blue triangle PNG (generated programmatically; #3b82f6 on transparent).
 * Kept inline so the scaffold has zero binary assets.
 */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR42u3WMQ7AIAhGYe/V23norjYOJg61KQK+Af6E+X0jpeRyyl31bnEBPT4uHmCOIwgU8BY/ikABX/EjCBTwJ+6KQAGSuAsCBezETREoQBM3QaAAi7gKgQIs41sIFOARFyFQgGcc/aBzqz18k0vQsHKADQAAAABJRU5ErkJggg==';

export interface TrayCallbacks {
  onToggleWhisper: (anchor?: Rectangle) => void;
  onOpenSettings: (anchor?: Rectangle) => void;
  onOpenPermissions?: (anchor?: Rectangle) => void;
  onQuit: () => void;
}

export function createTray(callbacks: TrayCallbacks): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip(TRAY_HINT_DEFAULT);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Whisper to Buddy', click: () => callbacks.onToggleWhisper(tray.getBounds()) },
    { label: 'Settings', click: () => callbacks.onOpenSettings(tray.getBounds()) },
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Permissions…',
            click: () => callbacks.onOpenPermissions?.(tray.getBounds()),
          } as const,
        ]
      : []),
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => callbacks.onQuit() },
  ]);
  if (process.platform === 'darwin') {
    tray.on('click', (_event, bounds) => callbacks.onToggleWhisper(bounds));
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
  } else {
    tray.setContextMenu(contextMenu);
    tray.on('click', (_event, bounds) => callbacks.onToggleWhisper(bounds));
  }

  return tray;
}

function trayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const templatePath = app.isPackaged
      ? join(process.resourcesPath, 'trayTemplate.png')
      : join(app.getAppPath(), 'build', 'trayTemplate.png');
    if (existsSync(templatePath)) {
      const image = nativeImage.createFromPath(templatePath);
      image.setTemplateImage(true);
      return image;
    }
    const fallback = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64')).resize({
      width: 18,
      height: 18,
    });
    fallback.setTemplateImage(true);
    return fallback;
  }
  return nativeImage
    .createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
    .resize({ width: 16, height: 16 });
}
