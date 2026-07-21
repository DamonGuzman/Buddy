/** Dedicated, self-contained human-approval window. */

import { app, screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MainToApprovalChannel, MainToApprovalEvents } from '../../shared/ipc';
import type { ApprovalRequest } from '../../shared/types';
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

const APPROVAL_WIDTH = 420;
const APPROVAL_HEIGHT = 600;
const MIN_APPROVAL_HEIGHT = 240;
const MARGIN = 12;

type PendingPresentation = 'active' | 'inactive' | null;

export class ApprovalManager {
  private win: BrowserWindow | null = null;
  private loaded = false;
  private requests: ApprovalRequest[] = [];
  private pendingPresentation: PendingPresentation = null;
  private readonly crashGuard = new CrashLoopGuard(
    CRASH_LOOP_MAX_RECREATES,
    CRASH_LOOP_WINDOW_MS,
    'approval',
  );

  update(requests: ApprovalRequest[]): void {
    this.requests = requests;
    this.send('approval:requests', requests);
    if (requests.length === 0) this.hide();
  }

  show(): void {
    this.present('active');
  }

  showInactive(): void {
    this.present('inactive');
  }

  hide(): void {
    this.pendingPresentation = null;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  setContentHeight(requestedHeight: number, senderId: number): void {
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.id !== senderId) return;
    if (!Number.isFinite(requestedHeight) || requestedHeight <= 0) return;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const height = Math.min(
      Math.max(Math.ceil(requestedHeight), MIN_APPROVAL_HEIGHT),
      Math.max(MIN_APPROVAL_HEIGHT, workArea.height - MARGIN * 2),
    );
    const [currentWidth, currentHeight] = win.getContentSize();
    if (currentWidth === APPROVAL_WIDTH && currentHeight === height) return;
    win.setContentSize(APPROVAL_WIDTH, height);
    this.positionNearTray(win);
  }

  /** Hide Buddy before the gate re-inspects the real desktop receiver. */
  async prepareForLiveActionDispatch(): Promise<void> {
    this.hide();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (this.isVisible()) {
      throw new Error('approval window could not be hidden before desktop input');
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.loaded = false;
    this.pendingPresentation = null;
  }

  private present(mode: Exclude<PendingPresentation, null>): void {
    if (this.requests.length === 0) return;
    const win = this.ensureWindow();
    if (!this.loaded) {
      this.pendingPresentation = mode;
      return;
    }
    this.positionNearTray(win);
    if (mode === 'active') {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
    this.positionNearTray(win);
    this.reassertTopmost(win);
  }

  private send<C extends MainToApprovalChannel>(
    channel: C,
    payload: MainToApprovalEvents[C],
  ): void {
    if (this.loaded && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.loaded = false;

    const iconPath = join(
      app.getAppPath(),
      'build',
      process.platform === 'darwin' ? 'icon.icns' : 'icon.ico',
    );
    const win = createHardenedWindow({
      width: APPROVAL_WIDTH,
      height: APPROVAL_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      ...(existsSync(iconPath) ? { icon: iconPath } : {}),
      webPreferences: hardenedWebPreferences('approval.js'),
    });

    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    recoverOnRenderProcessGone(
      win,
      this.crashGuard,
      'approval',
      () => {
        const wasVisible = !win.isDestroyed() && win.isVisible();
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        if (wasVisible && this.requests.length > 0) this.present('inactive');
      },
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = null;
        console.error('[approval] renderer crash recovery exhausted');
      },
    );

    win.webContents.on('did-finish-load', () => {
      if (this.win !== win) return;
      this.loaded = true;
      this.send('approval:requests', this.requests);
      const pending = this.pendingPresentation;
      this.pendingPresentation = null;
      if (pending !== null) this.present(pending);
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.loaded = false;
      }
    });

    loadRendererPage(win, 'approval');
    this.win = win;
    return win;
  }

  private positionNearTray(win: BrowserWindow): void {
    const display = screen.getPrimaryDisplay();
    const height = win.getContentSize()[1] ?? APPROVAL_HEIGHT;
    if (process.platform === 'darwin') {
      const { bounds, workArea } = display;
      win.setPosition(
        Math.round(bounds.x + bounds.width - APPROVAL_WIDTH - MARGIN),
        Math.round(Math.max(bounds.y, workArea.y) + MARGIN),
      );
      return;
    }
    const { workArea } = display;
    win.setPosition(
      Math.round(workArea.x + workArea.width - APPROVAL_WIDTH - MARGIN),
      Math.round(workArea.y + workArea.height - height - MARGIN),
    );
  }

  private reassertTopmost(win: BrowserWindow): void {
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
    setTimeout(() => {
      if (!win.isDestroyed() && win.isVisible() && !win.isAlwaysOnTop()) {
        win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
      }
    }, 300);
  }
}
