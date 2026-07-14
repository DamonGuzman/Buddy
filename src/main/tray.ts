/**
 * Tray icon + menu. Left-click toggles the panel; context menu has
 * Open Panel / Quit.
 */

import { app, Menu, Tray, nativeImage } from 'electron';
import type { NativeImage, Rectangle } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAME } from '../shared/constants';

/**
 * 32x32 blue triangle PNG (generated programmatically; #3b82f6 on transparent).
 * Kept inline so the scaffold has zero binary assets.
 */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR42u3WMQ7AIAhGYe/V23norjYOJg61KQK+Af6E+X0jpeRyyl31bnEBPT4uHmCOIwgU8BY/ikABX/EjCBTwJ+6KQAGSuAsCBezETREoQBM3QaAAi7gKgQIs41sIFOARFyFQgGcc/aBzqz18k0vQsHKADQAAAABJRU5ErkJggg==';

export interface TrayCallbacks {
  onTogglePanel: (anchor?: Rectangle) => void;
  onOpenPanel: (anchor?: Rectangle) => void;
  onOpenPermissions?: (anchor?: Rectangle) => void;
  onQuit: () => void;
}

export function createTray(callbacks: TrayCallbacks): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip(
    process.platform === 'darwin'
      ? `${APP_NAME} — hold Control + left Option and talk`
      : `${APP_NAME} — hold Ctrl + left Alt and talk`,
  );

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Buddy', click: () => callbacks.onOpenPanel(tray.getBounds()) },
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
    // A configured macOS tray menu opens on every click. Wire events directly
    // so primary click toggles Buddy and secondary click opens the menu.
    tray.on('click', (_event, bounds) => callbacks.onTogglePanel(bounds));
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
  } else {
    tray.setContextMenu(contextMenu);
    tray.on('click', (_event, bounds) => callbacks.onTogglePanel(bounds));
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
  // Windows tray wants a 16x16 variant; nativeImage handles DPI from the 32px source.
  return nativeImage
    .createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
    .resize({ width: 16, height: 16 });
}
