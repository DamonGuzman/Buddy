/**
 * Tray icon + menu. M21: left-click toggles the WHISPER composer (the chat
 * panel is gone); the context menu opens the whisper, Settings, or quits.
 * Also the single owner of the tray tooltip copy — index.ts sets
 * state-dependent hints through setTrayHint.
 */

import { Menu, Tray, nativeImage } from 'electron';
import { APP_NAME } from '../shared/constants';

// --- Tooltip copy (user-facing, byte-exact) --------------------------------

/** Initial tooltip before any settings-driven hint lands. */
export const TRAY_HINT_DEFAULT = `${APP_NAME} — hold Ctrl + left Alt and talk`;
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
  onToggleWhisper: () => void;
  onOpenSettings: () => void;
  onQuit: () => void;
}

export function createTray(callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'));
  // Windows tray wants a 16x16 variant; nativeImage handles DPI from the 32px source.
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(TRAY_HINT_DEFAULT);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Whisper to Buddy', click: () => callbacks.onToggleWhisper() },
    { label: 'Settings', click: () => callbacks.onOpenSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => callbacks.onQuit() },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => callbacks.onToggleWhisper());

  return tray;
}
