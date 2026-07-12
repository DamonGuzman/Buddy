/**
 * Tray icon + menu. Left-click toggles the panel; context menu has
 * Open Panel / Quit.
 */

import { Menu, Tray, nativeImage } from 'electron';
import { APP_NAME } from '../shared/constants';

/**
 * 32x32 blue triangle PNG (generated programmatically; #3b82f6 on transparent).
 * Kept inline so the scaffold has zero binary assets.
 */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR42u3WMQ7AIAhGYe/V23norjYOJg61KQK+Af6E+X0jpeRyyl31bnEBPT4uHmCOIwgU8BY/ikABX/EjCBTwJ+6KQAGSuAsCBezETREoQBM3QaAAi7gKgQIs41sIFOARFyFQgGcc/aBzqz18k0vQsHKADQAAAABJRU5ErkJggg==';

export interface TrayCallbacks {
  onTogglePanel: () => void;
  onOpenPanel: () => void;
  onQuit: () => void;
}

export function createTray(callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'));
  // Windows tray wants a 16x16 variant; nativeImage handles DPI from the 32px source.
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(`${APP_NAME} — hold Ctrl + left Alt and talk`);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Panel', click: () => callbacks.onOpenPanel() },
    { type: 'separator' },
    { label: 'Quit', click: () => callbacks.onQuit() },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => callbacks.onTogglePanel());

  return tray;
}
