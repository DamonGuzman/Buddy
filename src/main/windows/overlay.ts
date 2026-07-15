/**
 * Overlay window management: one transparent, click-through, always-on-top
 * window per display, covering the full display bounds. Handles display
 * hotplug (add/remove/metrics change).
 *
 * Overlays are NEVER focusable and never intercept mouse input (hard rule) —
 * with ONE narrow, self-restoring M15 exception: while the cursor DWELLS on
 * the buddy footprint, the hosting overlay flips interactive
 * (setIgnoreMouseEvents(false)) so the buddy can be clicked/dragged, and
 * flips back to click-through the INSTANT the cursor leaves the small padded
 * buddy region (renderer 'exit' events + a belt-and-braces cursor poll in
 * hover-controller.ts — the user's clicks elsewhere must never be eaten).
 * Overlays still NEVER take focus.
 *
 * Buddy residency rule (M2, amended M15): at rest the buddy lives on the REST
 * display's overlay only — the primary display unless the user drag-
 * repositioned the buddy (Settings.buddyRest). A pointer 'animate' command
 * shows/moves it on the addressed display and hides it everywhere else;
 * 'idle' returns it to the rest corner; 'hide' fades it out everywhere.
 * `routePointer` is the single entry point that enforces this — production
 * dispatch and the debug server both go through it. The routing itself is
 * pure (pointer-routing.ts).
 *
 * M15 mouse observation: the window currently showing the buddy gets
 * setIgnoreMouseEvents(true, { forward: true }) so its renderer receives
 * mousemove while remaining fully click-through; all other overlays keep
 * plain setIgnoreMouseEvents(true) (no forwarding = zero mousemove cost).
 */

import { ipcMain, screen } from 'electron';
import type { BrowserWindow, Display, Rectangle, WebContents } from 'electron';
import type { MainToOverlayChannel, MainToOverlayEvents } from '../../shared/ipc';
import type {
  AssistantState,
  BuddyRest,
  OverlayDisplaySurface,
  OverlayHoverConfig,
  OverlayHoverEvent,
  OverlayHoverStatus,
  PointerCommand,
  Rect,
} from '../../shared/types';
import { bobIdleMsOverride } from '../env';
import type { SettingsStore } from '../settings';
import { toggleWhisper } from './whisper';
import { showPanelNearBuddy } from './panel';
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
import { HoverController } from './hover-controller';
import { listeningBlocksHover } from './hover-policy';
import { markNativeWindowNonRude } from './non-rude';
import { computePointerRouting, forwardingModeFor } from './pointer-routing';
import { BUDDY_CLICK_RADIUS, isBuddyClick } from './buddy-click';
import { resolveDisplaySurface } from './display-surface';
import { coverMacDisplayWithWindow, getMacDisplaySurface } from './mac-screen-permission';
import { offsetPointerForWindow } from './overlay-offset';

/**
 * Module-level handle to the started manager so sibling main modules (e.g.
 * the debug server) can reach the overlays without bootstrap wiring changes.
 */
let activeManager: OverlayManager | null = null;

export function getOverlayManager(): OverlayManager | null {
  return activeManager;
}

/** M15: reject hover regions larger than any plausible buddy footprint. */
const MAX_HOVER_REGION_DIP = 400;

/** One overlay window + the screenIndex used in capture labeling. */
interface OverlayEntry {
  win: BrowserWindow;
  screenIndex: number;
}

/** Per-window slice of `OverlayManager.hoverDebugInfo()` (debug-server JSON). */
export interface OverlayWindowHoverDebug {
  displayId: number;
  screenIndex: number;
  bounds: Rectangle | null;
  scaleFactor: number | null;
  forwarding: boolean;
  interactive: boolean;
  rendererPid: number | null;
  hover: OverlayHoverStatus | null;
}

/** M15 debug/QA snapshot shape (GET /hover/state on the debug server). */
export interface OverlayHoverDebugInfo {
  assistantState: AssistantState;
  buddyHostIndex: number | null;
  interactiveDisplayId: number | null;
  interactiveRegion: Rect | null;
  buddyRest: BuddyRest | null;
  restScreenIndex: number;
  windows: OverlayWindowHoverDebug[];
}

export class OverlayManager {
  /** displayId -> { window, screenIndex } (screenIndex = capture labeling). */
  private overlays = new Map<number, OverlayEntry>();
  private started = false;
  /** Crash recovery budget shared across ALL overlay windows. */
  private crashGuard = new CrashLoopGuard(
    CRASH_LOOP_MAX_RECREATES,
    CRASH_LOOP_WINDOW_MS,
    'overlay',
  );

  // --- M15 buddy-hover state ------------------------------------------------
  /** Last assistant state (every change flows through setAssistantState). */
  private lastAssistantState: AssistantState = 'idle';
  /** screenIndex of the window currently showing the buddy; null = hidden. */
  private buddyHostIndex: number | null = null;
  private buddyAtRest = true;
  /** The dwell-to-interact state machine (owns the interactive flip + poll). */
  private readonly hover = new HoverController({
    isWindowLive: (displayId) => {
      const entry = this.overlays.get(displayId);
      return entry !== undefined && !entry.win.isDestroyed();
    },
    makeWindowInteractive: (displayId) => {
      const entry = this.overlays.get(displayId);
      if (!entry || entry.win.isDestroyed()) return;
      entry.win.setIgnoreMouseEvents(false);
      entry.win.webContents.send('overlay:interactive', { interactive: true });
    },
    restoreWindowClickThrough: (displayId) => {
      const entry = this.overlays.get(displayId);
      if (!entry || entry.win.isDestroyed()) return;
      // The buddy-hosting window keeps mousemove forwarding on restore.
      this.applyMouseMode(entry, displayId, null);
      entry.win.webContents.send('overlay:interactive', { interactive: false });
    },
    windowBounds: (displayId) => {
      const entry = this.overlays.get(displayId);
      return entry && !entry.win.isDestroyed() ? entry.win.getBounds() : null;
    },
    cursorPoint: () => screen.getCursorScreenPoint(), // global DIP
  });
  /** Latest renderer hover status per display (debug/QA). */
  private hoverStatusByDisplay = new Map<number, OverlayHoverStatus>();
  private unsubscribeSettings: (() => void) | null = null;
  /**
   * M20: cursor feed for the buddy-hosting overlay. Windows' mousemove
   * forwarding (setIgnoreMouseEvents forward:true) proved unreliable — zero
   * delivery on some machines — which silently killed buddy hover/click.
   * Main polls the cursor instead and streams window-local positions; the
   * renderer's HoverMachine consumes them exactly like DOM mousemoves. The
   * poll pauses while a window is interactive (real events flow there).
   */
  private cursorFeed: NodeJS.Timeout | null = null;
  private lastCursorSent = '';

  /**
   * The store is injected by the composition root (index.ts constructs it
   * before overlays.start() runs — boot-order invariant).
   */
  constructor(private readonly settings: SettingsStore) {}

  /** Create overlays for all current displays and start watching hotplug. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level singleton handle (see getOverlayManager)
    activeManager = this;
    this.registerHoverIpc();
    // Push a fresh hover config whenever settings change (hotkey label /
    // buddyRest).
    this.unsubscribeSettings = this.settings.onChange(() => this.pushHoverConfig());
    this.syncDisplays();
    // At boot the buddy rests on the rest display (did-finish-load sends it
    // 'idle'), so that window hosts the buddy for mouse forwarding.
    this.buddyHostIndex = this.restScreenIndex();
    this.updateMouseForwarding();
    screen.on('display-added', () => this.syncDisplays());
    screen.on('display-removed', () => this.syncDisplays());
    screen.on('display-metrics-changed', () => this.syncDisplays());
    // M20: see cursorFeed. 90ms comfortably resolves the 500ms dwell while
    // costing one getCursorScreenPoint per tick; positions dedupe below.
    this.cursorFeed = setInterval(() => this.pollCursorFeed(), 90);
    this.cursorFeed.unref?.();
  }

  /** M20: stream the cursor to the buddy-hosting overlay (see cursorFeed). */
  private pollCursorFeed(): void {
    if (this.buddyHostIndex === null) return;
    // While a window is interactive it receives REAL mouse events — the
    // synthetic feed pauses so the two streams never interleave.
    if (this.hover.displayId !== null) return;
    const entry = [...this.overlays.values()].find(
      (e) => e.screenIndex === this.buddyHostIndex && !e.win.isDestroyed(),
    );
    if (!entry) return;
    const pt = screen.getCursorScreenPoint(); // global DIP
    const b = entry.win.getBounds(); // DIP
    const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
    const payload = inside ? { x: pt.x - b.x, y: pt.y - b.y } : null;
    const key = payload === null ? 'out' : `${payload.x},${payload.y}`;
    if (key === this.lastCursorSent) return; // idle cursor costs nothing
    this.lastCursorSent = key;
    entry.win.webContents.send('overlay:cursor', payload);
  }

  /** Number of live overlay windows (debug /state). */
  count(): number {
    return [...this.overlays.values()].filter((e) => !e.win.isDestroyed()).length;
  }

  /**
   * M20: the buddy's rest spot in GLOBAL DIP plus its display's work area —
   * the whisper composer window anchors next to it. Mirrors the renderer's
   * rest math (hover.ts defaultRest / fraction rest) closely enough for
   * window placement; the caller clamps to the work area anyway. null before
   * start() or when no overlay window is live.
   */
  restAnchor(): { x: number; y: number; workArea: Rectangle } | null {
    const restIndex = this.restScreenIndex();
    const entry = [...this.overlays.entries()].find(
      ([, e]) => e.screenIndex === restIndex && !e.win.isDestroyed(),
    );
    if (!entry) return null;
    const display = screen.getAllDisplays().find((d) => d.id === entry[0]);
    if (!display) return null;
    const { bounds, workArea } = display;
    const rest = this.settings.get().buddyRest;
    const frac = rest && rest.screenIndex === restIndex ? rest : null;
    // Renderer default rest: bottom-right corner minus the hover margins.
    const x = frac ? bounds.x + frac.xFrac * bounds.width : bounds.x + bounds.width - 76;
    const y = frac ? bounds.y + frac.yFrac * bounds.height : bounds.y + bounds.height - 120;
    return { x: Math.round(x), y: Math.round(y), workArea };
  }

  /** Hit-test a macOS primary click before the dwell interaction has armed. */
  openWhisperIfBuddyClicked(): boolean {
    const anchor = this.buddyAnchorIfClicked();
    if (anchor === null) return false;
    toggleWhisper();
    return true;
  }

  /**
   * Return Buddy's global-DIP footprint only when the current pointer click
   * is eligible for a Buddy action. Shared by the macOS pre-dwell primary
   * fallback and the cross-platform context-click Settings gesture.
   */
  buddyAnchorIfClicked(): Rectangle | null {
    for (const [displayId, entry] of this.overlays) {
      const anchor = this.buddyAnchorForDisplay(displayId);
      if (anchor === null) continue;
      const status = this.hoverStatusByDisplay.get(displayId);
      if (!status) return null;
      const bounds = entry.win.getBounds();
      if (!isBuddyClick(screen.getCursorScreenPoint(), bounds, status.buddy)) return null;
      return anchor;
    }
    return null;
  }

  private buddyAnchorForDisplay(displayId: number): Rectangle | null {
    if (!this.buddyAtRest || this.buddyHostIndex === null || this.pushToTalkHoldActive())
      return null;
    const entry = this.overlays.get(displayId);
    if (!entry || entry.win.isDestroyed() || entry.screenIndex !== this.buddyHostIndex) return null;
    const status = this.hoverStatusByDisplay.get(displayId);
    if (!status || status.dragging) return null;
    const bounds = entry.win.getBounds();
    return {
      x: Math.round(bounds.x + status.buddy.x - BUDDY_CLICK_RADIUS),
      y: Math.round(bounds.y + status.buddy.y - BUDDY_CLICK_RADIUS),
      width: BUDDY_CLICK_RADIUS * 2,
      height: BUDDY_CLICK_RADIUS * 2,
    };
  }

  /** Whether Buddy's narrow dwell region currently owns mouse events. */
  isBuddyInteractive(): boolean {
    return this.hover.displayId !== null;
  }

  /**
   * M15: the one entry point for assistant-state changes (production and
   * debug both route through broadcast) — the dwell flip must be suppressed
   * while the user is physically holding push-to-talk.
   */
  setAssistantState(state: AssistantState): void {
    this.lastAssistantState = state;
    if (this.pushToTalkHoldActive()) this.hover.restoreClickThrough();
    this.sendToAll('overlay:assistant-state', state);
  }

  /** Send a typed event to every overlay window. */
  broadcast<C extends MainToOverlayChannel>(channel: C, payload: MainToOverlayEvents[C]): void {
    if (channel === 'overlay:assistant-state') {
      this.setAssistantState(payload as unknown as AssistantState);
      return;
    }
    this.sendToAll(channel, payload);
  }

  /** Send a typed event to the overlay covering one screenIndex. */
  sendTo<C extends MainToOverlayChannel>(
    screenIndex: number,
    channel: C,
    payload: MainToOverlayEvents[C],
  ): void {
    for (const entry of this.overlays.values()) {
      if (entry.screenIndex !== screenIndex) continue;
      if (!entry.win.isDestroyed()) entry.win.webContents.send(channel, payload);
    }
  }

  /**
   * Route a pointer command per the buddy residency rule (see the module
   * header + pointer-routing.ts).
   */
  routePointer(cmd: PointerCommand): void {
    const routing = computePointerRouting(cmd, this.restScreenIndex());
    this.buddyAtRest = cmd.type === 'idle';
    if (routing.targetIndex === null) {
      for (const [displayId, entry] of this.entriesByScreenIndex()) {
        if (!entry.win.isDestroyed()) {
          entry.win.webContents.send(
            'overlay:pointer',
            this.pointerForEntry(displayId, entry, cmd),
          );
        }
      }
    } else {
      for (const [displayId, entry] of this.entriesByScreenIndex()) {
        if (entry.win.isDestroyed()) continue;
        const routed =
          entry.screenIndex === routing.targetIndex
            ? cmd
            : ({ type: 'hide' } satisfies PointerCommand);
        entry.win.webContents.send(
          'overlay:pointer',
          this.pointerForEntry(displayId, entry, routed),
        );
      }
    }
    this.buddyHostIndex = routing.buddyHostIndex;
    // M15: a pointer command can move the buddy off the interactive window
    // (or into a flight) — hover must never fight the flight engine.
    this.hover.restoreClickThrough();
    this.updateMouseForwarding();
  }

  private pointerForEntry(
    displayId: number,
    entry: OverlayEntry,
    cmd: PointerCommand,
  ): PointerCommand {
    const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
    if (!display || entry.win.isDestroyed()) return cmd;
    return offsetPointerForWindow(cmd, display.bounds, entry.win.getBounds());
  }

  destroy(): void {
    if (activeManager === this) activeManager = null;
    // M15: hover teardown.
    if (this.cursorFeed !== null) clearInterval(this.cursorFeed); // M20
    this.cursorFeed = null;
    this.hover.dispose();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    ipcMain.removeAllListeners('overlay:hover');
    ipcMain.removeAllListeners('overlay:buddy-click');
    ipcMain.removeAllListeners('overlay:buddy-move');
    ipcMain.removeHandler('overlay:get-hover-config');
    ipcMain.removeHandler('overlay:get-display-surface');
    for (const entry of this.overlays.values()) {
      if (!entry.win.isDestroyed()) entry.win.destroy();
    }
    this.overlays.clear();
    this.hoverStatusByDisplay.clear();
  }

  // -------------------------------------------------------------------------

  private sendToAll<C extends MainToOverlayChannel>(
    channel: C,
    payload: MainToOverlayEvents[C],
  ): void {
    for (const entry of this.overlays.values()) {
      if (!entry.win.isDestroyed()) entry.win.webContents.send(channel, payload);
    }
  }

  /**
   * Entries in ascending screenIndex order — i.e. screen.getAllDisplays()
   * order, matching the historical per-display iteration (the map itself
   * keeps window CREATION order, which broadcast/debug output preserve).
   */
  private entriesByScreenIndex(): [number, OverlayEntry][] {
    return [...this.overlays.entries()].sort((a, b) => a[1].screenIndex - b[1].screenIndex);
  }

  /** Reconcile windows with the current display set. */
  private syncDisplays(): void {
    const displays = screen.getAllDisplays();
    const liveIds = new Set(displays.map((d) => d.id));

    // Remove overlays for departed displays.
    for (const [displayId, entry] of this.overlays) {
      if (!liveIds.has(displayId)) {
        if (this.hover.isInteractive(displayId)) this.hover.restoreClickThrough();
        if (!entry.win.isDestroyed()) entry.win.destroy();
        this.overlays.delete(displayId);
        this.hoverStatusByDisplay.delete(displayId);
      }
    }

    // Stable screenIndex assignment: order of screen.getAllDisplays().
    displays.forEach((display, index) => {
      const existing = this.overlays.get(display.id);
      if (existing && !existing.win.isDestroyed()) {
        existing.screenIndex = index;
        existing.win.setBounds(display.bounds);
        if (process.platform === 'darwin') {
          coverMacDisplayWithWindow(existing.win.getNativeWindowHandle(), display.id);
        }
      } else {
        this.overlays.set(display.id, {
          win: this.createWindow(display, index),
          screenIndex: index,
        });
      }
    });
    this.pushDisplaySurfaces();
    // M15: re-assert forwarding after hotplug (indices may have shifted).
    this.updateMouseForwarding();
  }

  private createWindow(display: Display, screenIndex: number): BrowserWindow {
    const isPrimary = screen.getPrimaryDisplay().id === display.id;
    const win = createHardenedWindow({
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: true,
      focusable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      // Keep animations running while the (never-focused) overlay is "unfocused".
      webPreferences: hardenedWebPreferences('overlay.js'),
    });

    // Crash recovery: a dead overlay renderer = invisible buddy. Drop the dead
    // window and let syncDisplays build a fresh one (bounded by crashGuard).
    recoverOnRenderProcessGone(
      win,
      this.crashGuard,
      `overlay(display ${display.id})`,
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.overlays.get(display.id)?.win === win) this.overlays.delete(display.id);
        this.syncDisplays();
      },
      // Guard gave up: still destroy the zombie window (renderer is gone, the
      // BrowserWindow isn't) and drop it from the map so overlayWindowCount
      // stays accurate. No syncDisplays here — that would recreate it.
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.overlays.get(display.id)?.win === win) this.overlays.delete(display.id);
      },
    );

    // `screen-saver` is above the Windows taskbar. Because this window spans
    // the full display, using that band can make the shell treat it like a
    // fullscreen app and let ordinary windows cover the taskbar.
    win.setAlwaysOnTop(true, TASKBAR_SAFE_TOPMOST_LEVEL);
    // Click-through at the OS level. M15: forwarding is enabled ONLY on the
    // window currently showing the buddy (updateMouseForwarding) so its
    // renderer sees mousemove for hover awareness; other overlays skip
    // forwarding entirely (no mousemove stream = zero idle cost).
    win.setIgnoreMouseEvents(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Belt-and-braces: bounds again after frameless quirks on scaled displays.
    win.setBounds(display.bounds);
    if (process.platform === 'darwin') {
      coverMacDisplayWithWindow(win.getNativeWindowHandle(), display.id);
    }
    // Must settle before the first show: otherwise Explorer can classify this
    // full-monitor transparent window as fullscreen and demote the taskbar.
    const nonRudeReady = markNativeWindowNonRude(win.getNativeWindowHandle());

    // Known limitation: ?screenIndex/?primary are creation-time snapshots and
    // go stale if displays are re-ordered while the window lives. Harmless
    // today — routing/residency are enforced main-side (routePointer +
    // did-finish-load below); the renderer only uses ?primary as its
    // pre-subscription default. A live update would need a new shared IPC
    // channel (src/shared/ipc.ts is frozen), so it is documented instead.
    // CLICKY_BOB_IDLE_MS: test hook to shrink the renderer's idle bob-pause
    // timeout (default 5min) without a rebuild.
    const bobIdleMs = bobIdleMsOverride();
    const query =
      `?screenIndex=${screenIndex}&primary=${isPrimary ? '1' : '0'}` +
      (bobIdleMs !== null ? `&bobIdleMs=${bobIdleMs}` : '');
    loadRendererPage(win, 'overlay', query);

    // Authoritative initial residency (the ?primary flag is the renderer's
    // pre-subscription default; this message settles any race).
    // M15: rest display = Settings.buddyRest (default primary), and the
    // hover config (hotkey label + rest fraction) rides along.
    win.webContents.on('did-finish-load', () => {
      const index = this.overlays.get(display.id)?.screenIndex;
      const hostsRest = index !== undefined && index === this.restScreenIndex();
      win.webContents.send('overlay:pointer', {
        type: hostsRest ? 'idle' : 'hide',
      } satisfies PointerCommand);
      if (index !== undefined) {
        win.webContents.send('overlay:hover-config', this.hoverConfigFor(index));
      }
      win.webContents.send('overlay:display-surface', this.displaySurfaceFor(display.id));
      this.updateMouseForwarding();
    });

    win.once('ready-to-show', () => {
      void nonRudeReady.then((marked) => {
        if (win.isDestroyed()) return;
        // If the native marker fails, protecting the user's taskbar wins over
        // keeping the buddy above every application window.
        if (!marked && process.platform === 'win32') win.setAlwaysOnTop(false);
        win.showInactive();
        if (process.platform === 'darwin') {
          coverMacDisplayWithWindow(win.getNativeWindowHandle(), display.id);
        }
      });
    });
    return win;
  }

  // ===========================================================================
  // M15 buddy hover: mouse forwarding, dwell-to-interact, click, drag-rest
  // ===========================================================================

  /** screenIndex hosting the buddy at rest: Settings.buddyRest or primary. */
  private restScreenIndex(): number {
    const rest = this.settings.get().buddyRest;
    if (rest && [...this.overlays.values()].some((e) => e.screenIndex === rest.screenIndex)) {
      return rest.screenIndex;
    }
    return this.overlays.get(screen.getPrimaryDisplay().id)?.screenIndex ?? 0;
  }

  /** Hover config for one overlay (rest fraction only on the rest host). */
  private hoverConfigFor(screenIndex: number): OverlayHoverConfig {
    const settings = this.settings.get();
    const rest = settings.buddyRest;
    return {
      hotkeyLabel: settings.hotkeyLabel,
      fullRealtimeMode: settings.fullRealtimeMode,
      rest:
        rest && rest.screenIndex === screenIndex && screenIndex === this.restScreenIndex()
          ? { xFrac: rest.xFrac, yFrac: rest.yFrac }
          : null,
    };
  }

  /** Push the hover config to every overlay (settings changed / drag moved). */
  private pushHoverConfig(): void {
    for (const [, entry] of this.entriesByScreenIndex()) {
      if (entry.win.isDestroyed()) continue;
      entry.win.webContents.send('overlay:hover-config', this.hoverConfigFor(entry.screenIndex));
    }
  }

  /**
   * Mouse-forwarding gate: ONLY the window currently showing the buddy
   * forwards mousemove to its renderer; everyone else stays plain
   * click-through. Skips the interactive window (it is not ignoring mouse
   * events at all right now).
   */
  private updateMouseForwarding(): void {
    for (const [displayId, entry] of this.entriesByScreenIndex()) {
      if (entry.win.isDestroyed()) continue;
      this.applyMouseMode(entry, displayId, this.hover.displayId);
    }
  }

  /** Apply the pure forwardingModeFor decision to one window. */
  private applyMouseMode(
    entry: OverlayEntry,
    displayId: number,
    interactiveDisplayId: number | null,
  ): void {
    if (process.platform === 'darwin') {
      entry.win.setIgnoreMouseEvents(true);
      return;
    }
    const mode = forwardingModeFor({
      displayId,
      screenIndex: entry.screenIndex,
      buddyHostIndex: this.buddyHostIndex,
      interactiveDisplayId,
    });
    if (mode === 'interactive') return; // the HoverController owns this window
    if (mode === 'forward') {
      entry.win.setIgnoreMouseEvents(true, { forward: true });
    } else {
      entry.win.setIgnoreMouseEvents(true);
    }
  }

  private registerHoverIpc(): void {
    ipcMain.on('overlay:hover', (event, evt: OverlayHoverEvent) => {
      this.onHoverEvent(event.sender, evt);
    });
    // M20: clicking the buddy summons the whisper composer (was: the panel —
    // the panel is retiring to a settings surface; the tray still opens it).
    ipcMain.on('overlay:buddy-click', () => toggleWhisper());
    ipcMain.on('overlay:buddy-settings', (event) => {
      const displayId = this.displayIdFor(event.sender);
      if (displayId === null || !this.hover.isInteractive(displayId)) return;
      const anchor = this.buddyAnchorForDisplay(displayId);
      if (anchor !== null) showPanelNearBuddy(anchor);
    });
    ipcMain.on('overlay:buddy-move', (event, rest: { xFrac: number; yFrac: number }) => {
      this.onBuddyMove(event.sender, rest);
    });
    ipcMain.handle('overlay:get-hover-config', (event) => {
      const displayId = this.displayIdFor(event.sender);
      const index = displayId === null ? undefined : this.overlays.get(displayId)?.screenIndex;
      return this.hoverConfigFor(index ?? 0);
    });
    ipcMain.handle('overlay:get-display-surface', (event) => {
      const displayId = this.displayIdFor(event.sender);
      return displayId === null
        ? ({
            kind: 'off',
            notchWidth: 0,
            notchHeight: 0,
            menuBarHeight: 0,
          } satisfies OverlayDisplaySurface)
        : this.displaySurfaceFor(displayId);
    });
  }

  private displaySurfaceFor(displayId: number): OverlayDisplaySurface {
    const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
    if (!display) return { kind: 'off', notchWidth: 0, notchHeight: 0, menuBarHeight: 0 };
    return resolveDisplaySurface(process.platform, display, getMacDisplaySurface(displayId));
  }

  private pushDisplaySurfaces(): void {
    for (const [displayId, entry] of this.overlays) {
      if (!entry.win.isDestroyed() && !entry.win.webContents.isLoadingMainFrame()) {
        entry.win.webContents.send('overlay:display-surface', this.displaySurfaceFor(displayId));
      }
    }
  }

  private displayIdFor(sender: WebContents): number | null {
    for (const [displayId, entry] of this.overlays) {
      if (!entry.win.isDestroyed() && entry.win.webContents.id === sender.id) return displayId;
    }
    return null;
  }

  private onHoverEvent(sender: WebContents, evt: OverlayHoverEvent): void {
    const displayId = this.displayIdFor(sender);
    if (displayId === null) return;
    if (evt.kind === 'status' && evt.status) {
      this.hoverStatusByDisplay.set(displayId, evt.status);
      return;
    }
    if (evt.kind === 'exit') {
      // SAFETY-CRITICAL: restore click-through the instant the renderer
      // reports the cursor left the padded buddy region.
      if (this.hover.isInteractive(displayId)) this.hover.restoreClickThrough();
      return;
    }
    if (evt.kind === 'dwell' && evt.region && isFiniteRect(evt.region)) {
      // Suppress the interactive flip while the user is physically holding
      // push-to-talk, and never flip a
      // window that isn't hosting the buddy.
      if (this.pushToTalkHoldActive()) return;
      if (this.overlays.get(displayId)?.screenIndex !== this.buddyHostIndex) return;
      this.hover.makeInteractive(displayId, evt.region);
    }
  }

  /**
   * `listening` is a physical hold only in push-to-talk mode. In full
   * realtime it is the persistent open-mic ready state, so using it alone as
   * a hold proxy strands a resting Buddy with hover disabled indefinitely.
   */
  private pushToTalkHoldActive(): boolean {
    return listeningBlocksHover(this.lastAssistantState, this.settings.get().fullRealtimeMode);
  }

  /** Drag-reposition finished: persist the rest spot and re-push configs. */
  private onBuddyMove(sender: WebContents, rest: { xFrac: number; yFrac: number }): void {
    const displayId = this.displayIdFor(sender);
    if (displayId === null) return;
    const screenIndex = this.overlays.get(displayId)?.screenIndex;
    if (screenIndex === undefined) return;
    const clamp01 = (v: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
    this.settings.set({
      buddyRest: { screenIndex, xFrac: clamp01(rest.xFrac), yFrac: clamp01(rest.yFrac) },
    });
    // settings.onChange -> pushHoverConfig handles the config broadcast; the
    // buddy is already resting on this display, so residency is consistent.
    this.buddyHostIndex = screenIndex;
    this.updateMouseForwarding();
  }

  /** M15 debug/QA snapshot (GET /hover/state on the debug server). */
  hoverDebugInfo(): OverlayHoverDebugInfo {
    const displays = screen.getAllDisplays();
    return {
      assistantState: this.lastAssistantState,
      buddyHostIndex: this.buddyHostIndex,
      interactiveDisplayId: this.hover.displayId,
      interactiveRegion: this.hover.region,
      buddyRest: this.settings.get().buddyRest,
      restScreenIndex: this.restScreenIndex(),
      windows: [...this.overlays.entries()].map(([displayId, entry]) => {
        const display = displays.find((d) => d.id === displayId);
        const mode = forwardingModeFor({
          displayId,
          screenIndex: entry.screenIndex,
          buddyHostIndex: this.buddyHostIndex,
          interactiveDisplayId: this.hover.displayId,
        });
        return {
          displayId,
          screenIndex: entry.screenIndex,
          bounds: entry.win.isDestroyed() ? null : entry.win.getBounds(),
          scaleFactor: display?.scaleFactor ?? null,
          forwarding: mode === 'forward',
          interactive: mode === 'interactive',
          rendererPid: entry.win.isDestroyed() ? null : entry.win.webContents.getOSProcessId(),
          hover: this.hoverStatusByDisplay.get(displayId) ?? null,
        };
      }),
    };
  }
}

/** M15: reject NaN/Infinity regions from a (possibly hosed) renderer. */
function isFiniteRect(r: Rect): boolean {
  return (
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height) &&
    r.width > 0 &&
    r.height > 0 &&
    r.width <= MAX_HOVER_REGION_DIP &&
    r.height <= MAX_HOVER_REGION_DIP
  );
}
