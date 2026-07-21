/** Dedicated click-through window for Buddy's transient hover hint. */

import type { BrowserWindow, Rectangle } from 'electron';
import type { MainToHoverHintChannel, MainToHoverHintEvents } from '../../shared/ipc';
import type { OverlayHoverHintPresentation, OverlayHoverHintRenderState } from '../../shared/types';
import {
  createHardenedWindow,
  hardenedWebPreferences,
  loadRendererPage,
  TASKBAR_SAFE_TOPMOST_LEVEL,
} from './common';
import {
  CRASH_LOOP_MAX_RECREATES,
  CRASH_LOOP_WINDOW_MS,
  CrashLoopGuard,
  recoverOnRenderProcessGone,
} from './harden';
import { applyMacLiquidGlass } from './mac-liquid-glass';

const INITIAL_SIZE = 1;
const GLASS_CORNER_RADIUS = 14;
// Keep the foreground copy readable without painting over AppKit's adaptive
// highlights and refraction. The former 56% tint made regular glass read as
// an opaque dark tooltip.
const GLASS_TINT = '#11182740';

/**
 * One preloaded child window per display overlay. AppKit owns both the glass
 * and this window's Chromium content, so no cross-window background/text
 * race is possible and the complete hint stays above the parent overlay PiP.
 */
export class HoverHintWindow {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private presentation: OverlayHoverHintPresentation | null = null;
  private renderState: OverlayHoverHintRenderState | null = null;
  private revision = 0;
  private pendingPaintRevision: number | null = null;
  private readonly crashGuard = new CrashLoopGuard(
    CRASH_LOOP_MAX_RECREATES,
    CRASH_LOOP_WINDOW_MS,
    'hover hint',
  );

  constructor(private readonly parent: BrowserWindow) {}

  /** Preload glass while hidden so first hover never waits on window creation. */
  start(): void {
    if (process.platform === 'darwin' && !this.parent.isDestroyed()) this.ensureWindow();
  }

  update(presentation: OverlayHoverHintPresentation | null): void {
    const nextPresentation = freezePresentationDuringFade(this.presentation, presentation);
    this.presentation = nextPresentation;
    if (nextPresentation === null) {
      this.renderState = null;
      this.pendingPaintRevision = null;
      this.send('hover-hint:update', null);
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }

    const win = this.ensureWindow();
    this.revision += 1;
    this.renderState = toRenderState(nextPresentation, this.revision);
    this.pendingPaintRevision = this.revision;
    this.position(win, nextPresentation.bounds);
    this.send('hover-hint:update', this.renderState);
  }

  ownsSender(senderId: number): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.webContents.id === senderId;
  }

  stateForSender(senderId: number): OverlayHoverHintRenderState | null {
    return this.ownsSender(senderId) ? this.renderState : null;
  }

  didPaint(revision: number, senderId: number): void {
    if (
      !this.ownsSender(senderId) ||
      this.presentation === null ||
      this.renderState === null ||
      revision !== this.pendingPaintRevision ||
      revision !== this.renderState.revision
    ) {
      return;
    }
    this.pendingPaintRevision = null;
    const win = this.win;
    if (!win || win.isDestroyed() || this.presentation.fading) return;
    if (!win.isVisible()) win.showInactive();
    this.reassertTopmost(win);
  }

  destroy(): void {
    this.presentation = null;
    this.renderState = null;
    this.pendingPaintRevision = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.loaded = false;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    if (this.parent.isDestroyed()) {
      throw new Error('Buddy cannot create a hover hint for a destroyed overlay window');
    }

    this.loaded = false;
    const win = createHardenedWindow({
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      parent: this.parent,
      width: INITIAL_SIZE,
      height: INITIAL_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      webPreferences: hardenedWebPreferences('hover-hint.js'),
    });

    let nativeGlass: boolean;
    try {
      nativeGlass = applyMacLiquidGlass(win, {
        style: 'regular',
        cornerRadius: GLASS_CORNER_RADIUS,
        tintColor: GLASS_TINT,
      });
    } catch (error) {
      win.destroy();
      throw error;
    }

    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    recoverOnRenderProcessGone(
      win,
      this.crashGuard,
      'hover hint',
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        this.loaded = false;
        if (this.presentation !== null && !this.parent.isDestroyed()) {
          const replacement = this.ensureWindow();
          this.position(replacement, this.presentation.bounds);
        }
      },
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        this.loaded = false;
      },
    );

    win.webContents.on('did-finish-load', () => {
      if (this.win !== win) return;
      this.loaded = true;
      this.send('hover-hint:update', this.renderState);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[hover-hint] renderer failed to load: ${code} ${description} ${url}`);
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.loaded = false;
      }
    });

    loadRendererPage(win, 'hover-hint', nativeGlass ? '?nativeGlass=1' : undefined);
    this.win = win;
    return win;
  }

  private position(win: BrowserWindow, localBounds: Rectangle): void {
    const parentBounds = this.parent.getContentBounds();
    win.setBounds({
      x: Math.round(parentBounds.x + localBounds.x),
      y: Math.round(parentBounds.y + localBounds.y),
      width: Math.max(1, Math.ceil(localBounds.width)),
      height: Math.max(1, Math.ceil(localBounds.height)),
    });
  }

  private send<C extends MainToHoverHintChannel>(
    channel: C,
    payload: MainToHoverHintEvents[C],
  ): void {
    if (this.loaded && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  private reassertTopmost(win: BrowserWindow): void {
    win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
  }
}

function toRenderState(
  presentation: OverlayHoverHintPresentation,
  revision: number,
): OverlayHoverHintRenderState {
  return {
    revision,
    text: presentation.text,
    fading: presentation.fading,
    placement: presentation.placement,
    ...(presentation.sub === undefined ? {} : { sub: presentation.sub }),
  };
}

/** Exit-state copy may change after interactivity is revoked; fade the last committed box unchanged. */
function freezePresentationDuringFade(
  current: OverlayHoverHintPresentation | null,
  incoming: OverlayHoverHintPresentation | null,
): OverlayHoverHintPresentation | null {
  if (incoming === null || !incoming.fading || current === null) return incoming;
  return { ...current, fading: true };
}
