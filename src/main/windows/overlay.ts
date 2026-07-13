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
 * buddy region (renderer 'exit' events + a belt-and-braces 150ms cursor poll
 * here in main — the user's clicks elsewhere must never be eaten). Overlays
 * still NEVER take focus.
 *
 * Buddy residency rule (M2, amended M15): at rest the buddy lives on the REST
 * display's overlay only — the primary display unless the user drag-
 * repositioned the buddy (Settings.buddyRest). A pointer 'animate' command
 * shows/moves it on the addressed display and hides it everywhere else;
 * 'idle' returns it to the rest corner; 'hide' fades it out everywhere.
 * `routePointer` is the single entry point that enforces this — production
 * dispatch and the debug server both go through it.
 *
 * M15 mouse observation: the window currently showing the buddy gets
 * setIgnoreMouseEvents(true, { forward: true }) so its renderer receives
 * mousemove while remaining fully click-through; all other overlays keep
 * plain setIgnoreMouseEvents(true) (no forwarding = zero mousemove cost).
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import type { Display, WebContents } from 'electron';
import { join } from 'node:path';
import type { MainToOverlayChannel, MainToOverlayEvents } from '../../shared/ipc';
import type {
  AssistantState,
  OverlayHoverConfig,
  OverlayHoverEvent,
  OverlayHoverStatus,
  PointerCommand,
  Rect,
} from '../../shared/types';
import { getSettingsStore } from '../settings';
import { togglePanel } from './panel';
import { CrashLoopGuard, lockdownNavigation, recoverOnRenderProcessGone } from './harden';
import { listeningBlocksHover } from './hover-policy';

/**
 * Module-level handle to the started manager so sibling main modules (e.g.
 * the debug server) can reach the overlays without bootstrap wiring changes.
 */
let activeManager: OverlayManager | null = null;

export function getOverlayManager(): OverlayManager | null {
  return activeManager;
}

/** M15: belt-and-braces cursor poll cadence while an overlay is interactive. */
const INTERACTIVE_POLL_MS = 150;

export class OverlayManager {
  /** displayId -> window */
  private windows = new Map<number, BrowserWindow>();
  /** displayId -> screenIndex used in capture labeling. */
  private indexByDisplayId = new Map<number, number>();
  private started = false;
  /** Crash recovery budget shared across ALL overlay windows. */
  private crashGuard = new CrashLoopGuard(3, 5 * 60_000, 'overlay');

  // --- M15 buddy-hover state ------------------------------------------------
  /** Mirror of the last broadcast assistant state (snooped in broadcast()). */
  private lastAssistantState: AssistantState = 'idle';
  /** screenIndex of the window currently showing the buddy; null = hidden. */
  private buddyHostIndex: number | null = null;
  /** displayId of the overlay currently interactive (dwell), or null. */
  private interactiveDisplayId: number | null = null;
  /** Latest padded buddy region for the interactive overlay, window-local DIP. */
  private interactiveRegion: Rect | null = null;
  private interactivePoll: ReturnType<typeof setInterval> | null = null;
  /** Latest renderer hover status per display (debug/QA). */
  private hoverStatusByDisplay = new Map<number, OverlayHoverStatus>();
  private unsubscribeSettings: (() => void) | null = null;

  /** Create overlays for all current displays and start watching hotplug. */
  start(): void {
    if (this.started) return;
    this.started = true;
    activeManager = this;
    this.registerHoverIpc();
    // Push a fresh hover config whenever settings change (hotkey label /
    // buddyRest). getSettingsStore() is the M15 module-level handle —
    // index.ts constructs the store before overlays.start() runs.
    this.unsubscribeSettings = getSettingsStore()?.onChange(() => this.pushHoverConfig()) ?? null;
    this.syncDisplays();
    // At boot the buddy rests on the rest display (did-finish-load sends it
    // 'idle'), so that window hosts the buddy for mouse forwarding.
    this.buddyHostIndex = this.restScreenIndex();
    this.updateMouseForwarding();
    screen.on('display-added', () => this.syncDisplays());
    screen.on('display-removed', () => this.syncDisplays());
    screen.on('display-metrics-changed', () => this.syncDisplays());
  }

  /** Number of live overlay windows (debug /state). */
  count(): number {
    return [...this.windows.values()].filter((w) => !w.isDestroyed()).length;
  }

  /** Send a typed event to every overlay window. */
  broadcast<C extends MainToOverlayChannel>(channel: C, payload: MainToOverlayEvents[C]): void {
    // M15: every assistant-state change flows through here (production and
    // debug), so snoop it — the dwell flip must be suppressed while the user
    // is physically holding push-to-talk.
    if (channel === 'overlay:assistant-state') {
      this.lastAssistantState = payload as unknown as AssistantState;
      if (this.pushToTalkHoldActive()) this.restoreClickThrough();
    }
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  /** Send a typed event to the overlay covering one screenIndex. */
  sendTo<C extends MainToOverlayChannel>(
    screenIndex: number,
    channel: C,
    payload: MainToOverlayEvents[C],
  ): void {
    for (const [displayId, index] of this.indexByDisplayId) {
      if (index !== screenIndex) continue;
      const win = this.windows.get(displayId);
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  /**
   * Route a pointer command per the buddy residency rule:
   * - 'animate' → addressed screenIndex gets the command, all others 'hide'
   * - 'idle'    → rest display gets 'idle' (rest corner), others 'hide'
   *               (M15: rest display = Settings.buddyRest, default primary)
   * - 'hide'    → everyone hides
   */
  routePointer(cmd: PointerCommand): void {
    if (cmd.type === 'animate') {
      for (const [displayId, index] of this.indexByDisplayId) {
        const win = this.windows.get(displayId);
        if (!win || win.isDestroyed()) continue;
        win.webContents.send(
          'overlay:pointer',
          index === cmd.screenIndex ? cmd : ({ type: 'hide' } satisfies PointerCommand),
        );
      }
      this.buddyHostIndex = cmd.screenIndex;
    } else if (cmd.type === 'idle') {
      const restIndex = this.restScreenIndex();
      for (const [displayId, index] of this.indexByDisplayId) {
        const win = this.windows.get(displayId);
        if (!win || win.isDestroyed()) continue;
        win.webContents.send(
          'overlay:pointer',
          index === restIndex ? cmd : ({ type: 'hide' } satisfies PointerCommand),
        );
      }
      this.buddyHostIndex = restIndex;
    } else {
      this.broadcast('overlay:pointer', cmd);
      this.buddyHostIndex = null;
    }
    // M15: a pointer command can move the buddy off the interactive window
    // (or into a flight) — hover must never fight the flight engine.
    this.restoreClickThrough();
    this.updateMouseForwarding();
  }

  destroy(): void {
    if (activeManager === this) activeManager = null;
    // M15: hover teardown.
    this.stopInteractivePoll();
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    ipcMain.removeAllListeners('overlay:hover');
    ipcMain.removeAllListeners('overlay:buddy-click');
    ipcMain.removeAllListeners('overlay:buddy-move');
    ipcMain.removeHandler('overlay:get-hover-config');
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
    this.indexByDisplayId.clear();
    this.hoverStatusByDisplay.clear();
  }

  // -------------------------------------------------------------------------

  /** Reconcile windows with the current display set. */
  private syncDisplays(): void {
    const displays = screen.getAllDisplays();
    const liveIds = new Set(displays.map((d) => d.id));

    // Remove overlays for departed displays.
    for (const [displayId, win] of this.windows) {
      if (!liveIds.has(displayId)) {
        if (this.interactiveDisplayId === displayId) this.restoreClickThrough();
        if (!win.isDestroyed()) win.destroy();
        this.windows.delete(displayId);
        this.hoverStatusByDisplay.delete(displayId);
      }
    }

    // Stable screenIndex assignment: order of screen.getAllDisplays().
    this.indexByDisplayId.clear();
    displays.forEach((display, index) => {
      this.indexByDisplayId.set(display.id, index);
      const existing = this.windows.get(display.id);
      if (existing && !existing.isDestroyed()) {
        existing.setBounds(display.bounds);
      } else {
        this.windows.set(display.id, this.createWindow(display, index));
      }
    });
    // M15: re-assert forwarding after hotplug (indices may have shifted).
    this.updateMouseForwarding();
  }

  private createWindow(display: Display, screenIndex: number): BrowserWindow {
    const isPrimary = screen.getPrimaryDisplay().id === display.id;
    const win = new BrowserWindow({
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
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep animations running while the (never-focused) overlay is "unfocused".
        backgroundThrottling: false,
      },
    });

    lockdownNavigation(win);
    // Crash recovery: a dead overlay renderer = invisible buddy. Drop the dead
    // window and let syncDisplays build a fresh one (bounded by crashGuard).
    recoverOnRenderProcessGone(
      win,
      this.crashGuard,
      `overlay(display ${display.id})`,
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.windows.get(display.id) === win) this.windows.delete(display.id);
        this.syncDisplays();
      },
      // Guard gave up: still destroy the zombie window (renderer is gone, the
      // BrowserWindow isn't) and drop it from the map so overlayWindowCount
      // stays accurate. No syncDisplays here — that would recreate it.
      () => {
        if (!win.isDestroyed()) win.destroy();
        if (this.windows.get(display.id) === win) this.windows.delete(display.id);
      },
    );

    win.setAlwaysOnTop(true, 'screen-saver');
    // Click-through at the OS level. M15: forwarding is enabled ONLY on the
    // window currently showing the buddy (updateMouseForwarding) so its
    // renderer sees mousemove for hover awareness; other overlays skip
    // forwarding entirely (no mousemove stream = zero idle cost).
    win.setIgnoreMouseEvents(true);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Belt-and-braces: bounds again after frameless quirks on scaled displays.
    win.setBounds(display.bounds);

    // Known limitation: ?screenIndex/?primary are creation-time snapshots and
    // go stale if displays are re-ordered while the window lives. Harmless
    // today — routing/residency are enforced main-side (routePointer +
    // did-finish-load below); the renderer only uses ?primary as its
    // pre-subscription default. A live update would need a new shared IPC
    // channel (src/shared/ipc.ts is frozen), so it is documented instead.
    // CLICKY_BOB_IDLE_MS: test hook to shrink the renderer's idle bob-pause
    // timeout (default 5min) without a rebuild.
    const bobIdleMs = Number(process.env['CLICKY_BOB_IDLE_MS']);
    const query =
      `?screenIndex=${screenIndex}&primary=${isPrimary ? '1' : '0'}` +
      (Number.isFinite(bobIdleMs) && bobIdleMs > 0 ? `&bobIdleMs=${bobIdleMs}` : '');
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay/index.html${query}`);
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay/index.html'), {
        search: query,
      });
    }

    // Authoritative initial residency (the ?primary flag is the renderer's
    // pre-subscription default; this message settles any race).
    // M15: rest display = Settings.buddyRest (default primary), and the
    // hover config (hotkey label + rest fraction) rides along.
    win.webContents.on('did-finish-load', () => {
      const index = this.indexByDisplayId.get(display.id);
      const hostsRest = index !== undefined && index === this.restScreenIndex();
      win.webContents.send('overlay:pointer', {
        type: hostsRest ? 'idle' : 'hide',
      } satisfies PointerCommand);
      if (index !== undefined) {
        win.webContents.send('overlay:hover-config', this.hoverConfigFor(index));
      }
      this.updateMouseForwarding();
    });

    win.once('ready-to-show', () => win.showInactive());
    return win;
  }

  // ===========================================================================
  // M15 buddy hover: mouse forwarding, dwell-to-interact, click, drag-rest
  // ===========================================================================

  /** screenIndex hosting the buddy at rest: Settings.buddyRest or primary. */
  private restScreenIndex(): number {
    const rest = getSettingsStore()?.get().buddyRest ?? null;
    if (rest && [...this.indexByDisplayId.values()].includes(rest.screenIndex)) {
      return rest.screenIndex;
    }
    return this.indexByDisplayId.get(screen.getPrimaryDisplay().id) ?? 0;
  }

  /** Hover config for one overlay (rest fraction only on the rest host). */
  private hoverConfigFor(screenIndex: number): OverlayHoverConfig {
    const settings = getSettingsStore()?.get() ?? null;
    const rest = settings?.buddyRest ?? null;
    return {
      hotkeyLabel: settings?.hotkeyLabel ?? 'Ctrl+Alt (left alt)',
      fullRealtimeMode: settings?.fullRealtimeMode ?? false,
      rest:
        rest && rest.screenIndex === screenIndex && screenIndex === this.restScreenIndex()
          ? { xFrac: rest.xFrac, yFrac: rest.yFrac }
          : null,
    };
  }

  /** Push the hover config to every overlay (settings changed / drag moved). */
  private pushHoverConfig(): void {
    for (const [displayId, index] of this.indexByDisplayId) {
      const win = this.windows.get(displayId);
      if (!win || win.isDestroyed()) continue;
      win.webContents.send('overlay:hover-config', this.hoverConfigFor(index));
    }
  }

  /**
   * Mouse-forwarding gate: ONLY the window currently showing the buddy
   * forwards mousemove to its renderer; everyone else stays plain
   * click-through. Skips the interactive window (it is not ignoring mouse
   * events at all right now).
   */
  private updateMouseForwarding(): void {
    for (const [displayId, index] of this.indexByDisplayId) {
      const win = this.windows.get(displayId);
      if (!win || win.isDestroyed()) continue;
      if (displayId === this.interactiveDisplayId) continue;
      if (index === this.buddyHostIndex) {
        win.setIgnoreMouseEvents(true, { forward: true });
      } else {
        win.setIgnoreMouseEvents(true);
      }
    }
  }

  private registerHoverIpc(): void {
    ipcMain.on('overlay:hover', (event, evt: OverlayHoverEvent) => {
      this.onHoverEvent(event.sender, evt);
    });
    ipcMain.on('overlay:buddy-click', () => togglePanel());
    ipcMain.on('overlay:buddy-move', (event, rest: { xFrac: number; yFrac: number }) => {
      this.onBuddyMove(event.sender, rest);
    });
    ipcMain.handle('overlay:get-hover-config', (event) => {
      const displayId = this.displayIdFor(event.sender);
      const index = displayId === null ? undefined : this.indexByDisplayId.get(displayId);
      return this.hoverConfigFor(index ?? 0);
    });
  }

  private displayIdFor(sender: WebContents): number | null {
    for (const [displayId, win] of this.windows) {
      if (!win.isDestroyed() && win.webContents.id === sender.id) return displayId;
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
      if (this.interactiveDisplayId === displayId) this.restoreClickThrough();
      return;
    }
    if (evt.kind === 'dwell' && evt.region && isFiniteRect(evt.region)) {
      // Suppress the interactive flip while the user is physically holding
      // push-to-talk, and never flip a
      // window that isn't hosting the buddy.
      if (this.pushToTalkHoldActive()) return;
      if (this.indexByDisplayId.get(displayId) !== this.buddyHostIndex) return;
      this.makeInteractive(displayId, evt.region);
    }
  }

  /**
   * `listening` is a physical hold only in push-to-talk mode. In full
   * realtime it is the persistent open-mic ready state, so using it alone as
   * a hold proxy strands a resting Buddy with hover disabled indefinitely.
   */
  private pushToTalkHoldActive(): boolean {
    return listeningBlocksHover(
      this.lastAssistantState,
      getSettingsStore()?.get().fullRealtimeMode ?? false,
    );
  }

  /** Flip one overlay interactive; poll the cursor as a fallback exit path. */
  private makeInteractive(displayId: number, region: Rect): void {
    const win = this.windows.get(displayId);
    if (!win || win.isDestroyed()) return;
    this.interactiveRegion = region;
    if (this.interactiveDisplayId === displayId) return; // region refresh only
    if (this.interactiveDisplayId !== null) this.restoreClickThrough();
    this.stopInteractivePoll(); // defensive: never two polls
    this.interactiveDisplayId = displayId;
    win.setIgnoreMouseEvents(false);
    win.webContents.send('overlay:interactive', { interactive: true });
    // Belt-and-braces: the renderer's mousemove/mouseleave exit events are
    // the primary path; this poll force-restores click-through if they ever
    // go missing (renderer hang, missed events at display edges).
    this.interactivePoll = setInterval(() => {
      const w = this.windows.get(displayId);
      if (!w || w.isDestroyed() || this.interactiveRegion === null) {
        this.restoreClickThrough();
        return;
      }
      const cursor = screen.getCursorScreenPoint(); // global DIP
      const bounds = w.getBounds(); // global DIP
      const r = this.interactiveRegion; // window-local DIP
      const inside =
        cursor.x >= bounds.x + r.x &&
        cursor.x <= bounds.x + r.x + r.width &&
        cursor.y >= bounds.y + r.y &&
        cursor.y <= bounds.y + r.y + r.height;
      if (!inside) this.restoreClickThrough();
    }, INTERACTIVE_POLL_MS);
  }

  /** Restore click-through on whatever window is interactive (idempotent). */
  private restoreClickThrough(): void {
    this.stopInteractivePoll();
    if (this.interactiveDisplayId === null) return;
    const displayId = this.interactiveDisplayId;
    this.interactiveDisplayId = null;
    this.interactiveRegion = null;
    const win = this.windows.get(displayId);
    if (win && !win.isDestroyed()) {
      const hostsBuddy = this.indexByDisplayId.get(displayId) === this.buddyHostIndex;
      if (hostsBuddy) {
        win.setIgnoreMouseEvents(true, { forward: true });
      } else {
        win.setIgnoreMouseEvents(true);
      }
      win.webContents.send('overlay:interactive', { interactive: false });
    }
  }

  private stopInteractivePoll(): void {
    if (this.interactivePoll !== null) {
      clearInterval(this.interactivePoll);
      this.interactivePoll = null;
    }
  }

  /** Drag-reposition finished: persist the rest spot and re-push configs. */
  private onBuddyMove(sender: WebContents, rest: { xFrac: number; yFrac: number }): void {
    const displayId = this.displayIdFor(sender);
    if (displayId === null) return;
    const screenIndex = this.indexByDisplayId.get(displayId);
    if (screenIndex === undefined) return;
    const clamp01 = (v: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
    getSettingsStore()?.set({
      buddyRest: { screenIndex, xFrac: clamp01(rest.xFrac), yFrac: clamp01(rest.yFrac) },
    });
    // settings.onChange -> pushHoverConfig handles the config broadcast; the
    // buddy is already resting on this display, so residency is consistent.
    this.buddyHostIndex = screenIndex;
    this.updateMouseForwarding();
  }

  /** M15 debug/QA snapshot (GET /hover/state on the debug server). */
  hoverDebugInfo(): unknown {
    const displays = screen.getAllDisplays();
    return {
      assistantState: this.lastAssistantState,
      buddyHostIndex: this.buddyHostIndex,
      interactiveDisplayId: this.interactiveDisplayId,
      interactiveRegion: this.interactiveRegion,
      buddyRest: getSettingsStore()?.get().buddyRest ?? null,
      restScreenIndex: this.restScreenIndex(),
      windows: [...this.windows.entries()].map(([displayId, win]) => {
        const display = displays.find((d) => d.id === displayId);
        const index = this.indexByDisplayId.get(displayId);
        return {
          displayId,
          screenIndex: index,
          bounds: win.isDestroyed() ? null : win.getBounds(),
          scaleFactor: display?.scaleFactor ?? null,
          forwarding: index === this.buddyHostIndex && displayId !== this.interactiveDisplayId,
          interactive: displayId === this.interactiveDisplayId,
          rendererPid: win.isDestroyed() ? null : win.webContents.getOSProcessId(),
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
    r.width <= 400 &&
    r.height <= 400
  );
}
