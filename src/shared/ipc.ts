/**
 * The typed IPC contract — the single source of truth for every channel that
 * crosses a process boundary, plus the `window.clicky` API shapes exposed by
 * the preloads.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §4, §5, §9).
 * Later helper-buddy work adds channels here through the shared contract.
 *
 * Naming: `<area>:<event>`. Channel string literal = the key in the maps below.
 */

import type {
  ActionableErrorState,
  ActionableErrorIdentity,
  ApprovalGrant,
  ApprovalRequest,
  HelperBuddyBrowserPreviewSnapshot,
  HelperBuddyBrowserPreviewUpdate,
  HelperBuddySummary,
  AssistantState,
  AudioDeviceError,
  AudioOutputDelta,
  BuddyRestFraction,
  CaptionUpdate,
  CaptureControl,
  CaptureIndicatorUpdate,
  CodexSignInState,
  EnrolledSite,
  FilesystemSelection,
  FilesystemTaskView,
  MicDevice,
  OverlayDisplaySurface,
  OverlayGlassRegion,
  OverlayHoverConfig,
  OverlayHoverEvent,
  OverlayInteractiveUpdate,
  PlaybackControl,
  PlaybackStatsUpdate,
  PermissionAction,
  PermissionActionResult,
  PermissionHealth,
  PointerCommand,
  RuntimeFlags,
  SessionStatus,
  Settings,
  SettingsPatch,
  SignInResult,
  TranscriptEntry,
} from './types';

// ===========================================================================
// 1. Main -> Overlay renderer (webContents.send / clicky.on*)
// ===========================================================================

export interface MainToOverlayEvents {
  /** Drive the buddy pointer: fly to points, return to rest, or hide. */
  'overlay:pointer': PointerCommand;
  /** Assistant state changes (drives listening/thinking/speaking indicator). */
  'overlay:assistant-state': AssistantState;
  /** Streamed caption text for the bubble (full text so far, not deltas). */
  'overlay:caption': CaptionUpdate;
  /** Show/hide the "capture in progress" indicator (always signposted). */
  'overlay:capture-indicator': CaptureIndicatorUpdate;
  // M15 additions: buddy hover.
  /** Hover config (hotkey label + rest position) on load and settings change. */
  'overlay:hover-config': OverlayHoverConfig;
  /** This overlay window's click-through state flipped (dwell-to-interact). */
  'overlay:interactive': OverlayInteractiveUpdate;
  /** Main confirmed whether bounded native popup glass is active. */
  'overlay:glass-regions-ready': { enabled: boolean };
  /** Native top-of-display geometry for this overlay's display. */
  'overlay:display-surface': OverlayDisplaySurface;
  // M19 addition: helper buddies on the overlay — a full-list renderer-safe
  // snapshot broadcast on every helper-buddy state change. Browser frames use
  // the separate ephemeral preview channel below and are never persisted.
  // Every overlay receives both; only the buddy-hosting overlay renders them.
  'overlay:helper-buddies': HelperBuddySummary[];
  /** Latest observed browser frame, or a close tombstone, for one helper buddy. */
  'overlay:helper-buddy-browser-preview': HelperBuddyBrowserPreviewUpdate;
  // M20 addition: main-side cursor feed for the buddy-hosting overlay.
  // Electron's setIgnoreMouseEvents(true, {forward:true}) proved unreliable
  // on Windows (zero mousemove delivery on some setups), which silently
  // killed hover/click on the buddy. Main polls the cursor and streams
  // window-local DIP positions; null = the cursor left this display.
  'overlay:cursor': { x: number; y: number } | null;
}

// ===========================================================================
// 2. Main -> Panel renderer (webContents.send / clicky.on*)
// ===========================================================================

export interface MainToPanelEvents {
  /**
   * Transcript upsert: a new entry, or an in-place update of an existing id
   * while it streams (entry.text is the full text so far).
   */
  'panel:transcript': TranscriptEntry;
  /** Realtime session status for the status row. */
  'panel:session-status': SessionStatus;
  /** Assistant state mirror (same value the overlays get). */
  'panel:assistant-state': AssistantState;
  /** Settings changed (from any source) — renderer-safe view only. */
  'panel:settings': Settings;
  // M17 addition: the ChatGPT-subscription (Codex CLI) sign-in snapshot,
  // pushed on ready and whenever it changes (the CLI's auth.json can rotate
  // under us). NEVER carries a token. The codex* fields also ride on
  // 'panel:settings'; this is the lower-latency dedicated push.
  'panel:codex-signin': CodexSignInState;
  /** Model audio output for the panel's playback queue. */
  'audio:output': AudioOutputDelta;
  /** Playback control (stop / flush + the M2 playback-epoch floor). */
  'audio:playback': PlaybackControl;
  // M5 addition: main tells the panel renderer to start/stop mic capture
  // when the push-to-talk hotkey goes down/up.
  'audio:capture': CaptureControl;
  // M11 addition: runtime flags for the panel — hookAlive (hero hint adapts)
  // + CLICKY_* dev flags (header dev chip).
  'panel:runtime': RuntimeFlags;
  /** Live macOS privacy and native-hotkey health. */
  'panel:permissions': PermissionHealth;
  /** Latest user-repairable failure; null means the relevant recovery succeeded. */
  'panel:actionable-error': ActionableErrorState;
  /** Standing browser grants changed outside Settings; refresh the settings card. */
  'panel:grants-revision': number;
  // M21: 'panel:helper-buddies' and 'panel:show-helper-buddies' retired with the control
  // panel (the helper-buddy view is gone; overlay helper clicks summon the
  // whisper). The remaining panel:* channels serve the settings window +
  // hidden audio host that inherited the panel's BrowserWindow.
}

// ===========================================================================
// 2b. Main -> Approval renderer (webContents.send / clicky.on*)
// ===========================================================================

export interface MainToApprovalEvents {
  /** Complete raise-hand queue; full-list snapshots prevent lost concurrent requests. */
  'approval:requests': ApprovalRequest[];
}

// ===========================================================================
// 2c. Main -> Whisper renderer (webContents.send / clicky.on*)
// ===========================================================================

// M20: the whisper — a small floating composer for talking to buddy by text
// (hotkey tap / buddy click). It mirrors the conversation surfaces the panel
// already receives; main owns the mirroring (index.ts panel-port wrapper).
export interface MainToWhisperEvents {
  /** Transcript upsert mirror (same payloads as 'panel:transcript'). */
  'whisper:transcript': TranscriptEntry;
  /** Assistant state mirror (drives the composer's thinking pulse). */
  'whisper:assistant-state': AssistantState;
  /** Settings changed — renderer-safe view (voiceMuted + apiKeyPresent). */
  'whisper:settings': Settings;
  /** The window was just shown — focus the composer input. */
  'whisper:shown': null;
  /** Every active or retained filesystem task, newest first. */
  'whisper:filesystem-state': FilesystemTaskView[];
  /** Folder currently authorized for newly delegated helper buddies. */
  'whisper:filesystem-selection': FilesystemSelection | null;
}

/** Main-read, renderer-safe Markdown payload. Native filesystem paths stay in main. */
export interface MarkdownDocumentView {
  title: string;
  markdown: string;
}

// ===========================================================================
// 3. Renderer -> Main, fire-and-forget (ipcRenderer.send / ipcMain.on)
// ===========================================================================

export interface RendererSendEvents {
  /** Mic PCM16 (24kHz mono) chunk captured while the hotkey is held. */
  'audio:chunk': ArrayBuffer;
  // M8.5 addition: playback tap — the panel reports per-item played-audio
  // stats (on first play, ~1s cadence, and on done).
  'audio:playback-stats': PlaybackStatsUpdate;
  // M8.5 addition: ring buffer of the last ~15s of PLAYED audio as Int16 PCM
  // (24kHz mono), sent when an item finishes.
  'audio:playback-ring': ArrayBuffer;
  // M11 addition: the panel renderer reports audio device failures (mic
  // capture start / playback init) so main can surface mic_unavailable /
  // audio_output_failed from the error catalog.
  'audio:capture-error': AudioDeviceError;
  // M15 additions: buddy hover.
  /** Hover state machine events: dwell (make interactive) / exit / status. */
  'overlay:hover': OverlayHoverEvent;
  /** Exact popup backgrounds to mirror with bounded native Liquid Glass. */
  'overlay:glass-regions': OverlayGlassRegion[];
  /** The buddy was clicked while interactive -> main toggles the whisper. */
  'overlay:buddy-click': null;
  /** The buddy was right-clicked while interactive -> main opens Settings. */
  'overlay:buddy-settings': null;
  /** Drag-reposition finished: persist this rest fraction for this overlay. */
  'overlay:buddy-move': BuddyRestFraction;
  // M19 additions: helper buddies on the overlay.
  /** A helper sprite/card was clicked after local expansion; main may reveal related UI. */
  'overlay:helper-buddy-click': { id: string };
  /** The helper buddy card's stop affordance was clicked -> cancel it. */
  'overlay:helper-buddy-cancel': { id: string };
  // M20 addition: the whisper composer.
  /** The whisper asked to tuck away (esc / explicit close). */
  'whisper:hide': null;
  /** Natural standalone approval-card height; main clamps it to the work area. */
  'approval:content-height': number;
}

// ===========================================================================
// 4. Renderer -> Main, request/response (ipcRenderer.invoke / ipcMain.handle)
// ===========================================================================

export interface InvokeChannels {
  /** Renderer-safe settings snapshot (never contains the raw API key). */
  'settings:get': { args: []; result: Settings };
  /** Apply a patch (apiKey is write-only); resolves to the new snapshot. */
  'settings:set': { args: [patch: SettingsPatch]; result: Settings };
  /** Submit a typed question (text fallback -> same pipeline as voice). */
  'panel:ask-text': { args: [text: string]; result: void };
  /** Explicitly pick one folder and receive a non-forgeable capability persisted by the main process. */
  'filesystem:select-root': { args: []; result: FilesystemSelection | null };
  /** Start a full-capability helper buddy in the picker-authorized folder. */
  'filesystem:start': {
    args: [grantId: string, request: string];
    result: FilesystemTaskView;
  };
  'filesystem:get-state': { args: []; result: FilesystemTaskView[] };
  'filesystem:get-selection': { args: []; result: FilesystemSelection | null };
  'filesystem:clear-root': { args: []; result: void };
  /** Open a failed task's retained staging directory in Finder or Explorer. */
  'filesystem:open-safe-copy': { args: [taskId: string]; result: void };
  /** Delete a failed unpublished workspace without touching the selected folder. */
  'filesystem:discard': { args: [taskId: string]; result: FilesystemTaskView };
  /** Restore the durable before-image, after verifying no later edits would be lost. */
  'filesystem:undo': { args: [taskId: string]; result: FilesystemTaskView };
  /** Accept a published transaction and delete its retained Undo snapshot. */
  'filesystem:keep': { args: [taskId: string]; result: FilesystemTaskView };
  'filesystem:cancel': { args: [taskId: string]; result: void };
  /** Microphone devices as enumerated by the panel-visible renderer. */
  'mic:list': { args: []; result: MicDevice[] };
  /** Select the preferred mic ('' = system default); persisted in settings. */
  'mic:select': { args: [deviceId: string]; result: void };
  /** Overlay bootstrap: current assistant state (for late-created windows). */
  'overlay:get-state': { args: []; result: AssistantState };
  // M11 addition: panel bootstrap for runtime flags (push updates ride on
  // 'panel:runtime').
  'panel:get-runtime': { args: []; result: RuntimeFlags };
  /** Current macOS privacy and native-hotkey health (safe on other platforms). */
  'permissions:get': { args: []; result: PermissionHealth };
  /** Run one explicit permission repair action. */
  'permissions:action': { args: [action: PermissionAction]; result: PermissionActionResult };
  /** Latest persistent repair notice for Settings renderer bootstrap. */
  'panel:get-actionable-error': { args: []; result: ActionableErrorState };
  /** Clear one exact notice after the corresponding repair has succeeded. */
  'panel:resolve-actionable-error': { args: [expected: ActionableErrorIdentity]; result: boolean };
  /** Explicitly hide one exact notice without claiming that its failure was repaired. */
  'panel:dismiss-actionable-error': { args: [expected: ActionableErrorIdentity]; result: boolean };
  // M17 addition: panel bootstrap for the Codex sign-in snapshot (push
  // updates ride on 'panel:codex-signin').
  'codex:signin-state': { args: []; result: CodexSignInState };
  /** Start system-browser ChatGPT sign-in through the local PKCE callback. */
  'codex:sign-in': { args: []; result: SignInResult };
  // M15 addition: overlay bootstrap for hover config (belt-and-braces vs the
  // did-finish-load push; handled in windows/overlay.ts).
  'overlay:get-hover-config': { args: []; result: OverlayHoverConfig };
  /** Overlay bootstrap: native top-of-display geometry for this display. */
  'overlay:get-display-surface': { args: []; result: OverlayDisplaySurface };
  // M18 additions: helper buddies (docs/HELPER-BUDDY-MODE.md §6.2).
  /** Renderer bootstrap: current helper-buddy list. */
  'helper-buddies:list': { args: []; result: HelperBuddySummary[] };
  /** Race-safe bootstrap of active helper-buddy browser previews. */
  'helper-buddies:list-browser-previews': {
    args: [];
    result: HelperBuddyBrowserPreviewSnapshot;
  };
  /** Stop one helper buddy (card "stop" affordance). */
  'helper-buddies:cancel': { args: [id: string]; result: void };
  /** Stop every running helper buddy. */
  'helper-buddies:cancel-all': { args: []; result: void };
  /** The user viewed this helper buddy's card — clear its unseen badge. */
  'helper-buddies:mark-seen': { args: [id: string]; result: void };
  /** Resolve a buddy's pending raise-hand request. */
  'approval:resolve': {
    args: [helperBuddyId: string, approvalId: string, verdict: 'once' | 'always' | 'deny'];
    result: void;
  };
  /** Show the buddy's browser so the user can handle sign-in or a CAPTCHA. */
  'approval:show-window': { args: [helperBuddyId: string, approvalId: string]; result: void };
  /** Hide the user-assisted browser and let the buddy re-observe it. */
  'approval:hide-window': { args: [helperBuddyId: string, approvalId: string]; result: void };
  /** Bootstrap the complete pending approval queue after renderer reload. */
  'approvals:list': { args: []; result: ApprovalRequest[] };
  /** Renderer-safe standing approval grants. */
  'grants:list': { args: []; result: ApprovalGrant[] };
  /** Revoke one standing approval grant. */
  'grants:revoke': { args: [id: string]; result: void };
  /** Open the visible browser enrollment window for user-managed sign-in. */
  'buddy-browser:open-enroll': { args: [url: string]; result: void };
  /** Sites with cookies in the shared buddy browser profile. */
  'buddy-browser:list-enrolled-sites': { args: []; result: EnrolledSite[] };
  /** Clear one enrolled site's cookies and storage. */
  'buddy-browser:sign-out-site': { args: [domain: string]; result: void };
  /** Clear all cookies and storage from the shared buddy browser profile. */
  'buddy-browser:clear': { args: []; result: void };
  /** Bootstrap the document owned by the invoking Markdown window. */
  'markdown:get-document': { args: []; result: MarkdownDocumentView };
  /** Confirm that React committed the rich document; main may now show the window. */
  'markdown:ready': { args: []; result: void };
  /** Fail a hidden document window without ever exposing raw source. */
  'markdown:render-failed': { args: [detail: string]; result: void };
  /** Open a renderer-selected external link after main revalidates its scheme. */
  'markdown:open-external': { args: [url: string]; result: void };
}

// ===========================================================================
// Channel name unions + tiny helpers
// ===========================================================================

export type MainToOverlayChannel = keyof MainToOverlayEvents;
export type MainToPanelChannel = keyof MainToPanelEvents;
export type MainToApprovalChannel = keyof MainToApprovalEvents;
export type MainToWhisperChannel = keyof MainToWhisperEvents;
export type RendererSendChannel = keyof RendererSendEvents;
export type InvokeChannel = keyof InvokeChannels;

export type InvokeArgs<C extends InvokeChannel> = InvokeChannels[C]['args'];
export type InvokeResult<C extends InvokeChannel> = InvokeChannels[C]['result'];

/** Unsubscribe function returned by every `on*` subscription. */
export type Unsubscribe = () => void;

// ===========================================================================
// window.clicky API shapes (implemented by src/preload/*, consumed by renderers)
// ===========================================================================

/** Exposed to the overlay renderer as `window.clicky`. */
export interface OverlayApi {
  /** Which display this overlay covers (from ?screenIndex=N). */
  readonly screenIndex: number;
  /** Platform seam for native Control-click context-menu semantics. */
  readonly isMacOS: boolean;
  onPointer(cb: (cmd: PointerCommand) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onCaption(cb: (update: CaptionUpdate) => void): Unsubscribe;
  onCaptureIndicator(cb: (payload: CaptureIndicatorUpdate) => void): Unsubscribe;
  getAssistantState(): Promise<AssistantState>;

  // M15 additions: buddy hover.
  onHoverConfig(cb: (cfg: OverlayHoverConfig) => void): Unsubscribe;
  onInteractive(cb: (payload: OverlayInteractiveUpdate) => void): Unsubscribe;
  onGlassRegionsReady(cb: (payload: { enabled: boolean }) => void): Unsubscribe;
  getHoverConfig(): Promise<OverlayHoverConfig>;
  onDisplaySurface(cb: (surface: OverlayDisplaySurface) => void): Unsubscribe;
  getDisplaySurface(): Promise<OverlayDisplaySurface>;
  /** Fire-and-forget hover events (dwell/exit/status). */
  sendHover(evt: OverlayHoverEvent): void;
  /** Replace this overlay's bounded native popup backgrounds. */
  sendGlassRegions(regions: OverlayGlassRegion[]): void;
  /** The buddy was clicked while interactive (main toggles the whisper). */
  sendBuddyClick(): void;
  /** The buddy was right-clicked while interactive (main opens Settings). */
  sendBuddySettings(): void;
  /** Drag finished: persist the new rest fraction for this overlay. */
  sendBuddyMove(rest: BuddyRestFraction): void;

  // M20 addition: main-side cursor feed (see 'overlay:cursor').
  onCursor(cb: (pos: { x: number; y: number } | null) => void): Unsubscribe;

  // M19 additions: helper buddies on the overlay.
  onHelperBuddies(cb: (helperBuddies: HelperBuddySummary[]) => void): Unsubscribe;
  /** Helper-buddy list bootstrap (push updates ride on 'overlay:helper-buddies'). */
  getHelperBuddies(): Promise<HelperBuddySummary[]>;
  /** Ephemeral live-frame updates for helper buddies with an active browser surface. */
  onHelperBuddyBrowserPreview(cb: (update: HelperBuddyBrowserPreviewUpdate) => void): Unsubscribe;
  /** Bootstrap active preview frames without racing incremental updates. */
  getHelperBuddyBrowserPreviews(): Promise<HelperBuddyBrowserPreviewSnapshot>;
  /** Clear the unseen result indicator once a terminal card is expanded in place. */
  markHelperBuddySeen(id: string): Promise<void>;
  /** A waiting-approval helper buddy was clicked; main reveals its approval surface. */
  sendHelperBuddyClick(id: string): void;
  /** The helper buddy card's stop affordance was clicked. */
  sendHelperBuddyCancel(id: string): void;
}

/**
 * Exposed to the panel renderer as `window.clicky`. M21: the panel window is
 * now the hidden AUDIO HOST + the tray-opened SETTINGS surface — the chat
 * panel's transcript/composer/helper-buddy accessors retired with it.
 */
export interface PanelApi {
  onSessionStatus(cb: (status: SessionStatus) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onSettings(cb: (settings: Settings) => void): Unsubscribe;
  onAudioOutput(cb: (delta: AudioOutputDelta) => void): Unsubscribe;
  // F1 fix, M2: the payload carries the optional playback-epoch floor.
  onPlayback(cb: (payload: PlaybackControl) => void): Unsubscribe;
  // M5 addition: mic capture start/stop from main.
  onCaptureCommand(cb: (payload: CaptureControl) => void): Unsubscribe;
  // M11 addition: runtime flags (hookAlive + dev flags).
  onRuntime(cb: (flags: RuntimeFlags) => void): Unsubscribe;
  onPermissions(cb: (health: PermissionHealth) => void): Unsubscribe;
  onActionableError(cb: (state: ActionableErrorState) => void): Unsubscribe;
  onGrantsRevision(cb: (revision: number) => void): Unsubscribe;
  // M17 addition: Codex sign-in state push.
  onCodexSignin(cb: (state: CodexSignInState) => void): Unsubscribe;

  getSettings(): Promise<Settings>;
  // M11 addition: runtime flags bootstrap.
  getRuntime(): Promise<RuntimeFlags>;
  getPermissionHealth(): Promise<PermissionHealth>;
  permissionAction(action: PermissionAction): Promise<PermissionActionResult>;
  getActionableError(): Promise<ActionableErrorState>;
  resolveActionableError(expected: ActionableErrorIdentity): Promise<boolean>;
  dismissActionableError(expected: ActionableErrorIdentity): Promise<boolean>;
  // M17 addition: Codex sign-in state bootstrap.
  getCodexSigninState(): Promise<CodexSignInState>;
  signInToCodex(): Promise<SignInResult>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  listMics(): Promise<MicDevice[]>;
  selectMic(deviceId: string): Promise<void>;

  /** Stream a mic PCM16 chunk to main (fire-and-forget). */
  sendAudioChunk(chunk: ArrayBuffer): void;

  // M8.5 additions: playback tap reporting.
  /** Report played-audio stats for a response item (fire-and-forget). */
  sendPlaybackStats(stats: PlaybackStatsUpdate): void;
  /** Ship the last ~15s of played audio (Int16 PCM 24kHz mono). */
  sendPlaybackRing(ring: ArrayBuffer): void;

  // M11 addition: audio device failure report (mic capture start failed /
  // playback init failed) — fire-and-forget.
  reportAudioError(payload: AudioDeviceError): void;

  listGrants(): Promise<ApprovalGrant[]>;
  revokeGrant(id: string): Promise<void>;
  openBuddyBrowserEnrollment(url: string): Promise<void>;
  listEnrolledSites(): Promise<EnrolledSite[]>;
  signOutBuddyBrowserSite(domain: string): Promise<void>;
  clearBuddyBrowser(): Promise<void>;
}

/** Exposed only to the standalone approval renderer. */
export interface ApprovalApi {
  onRequests(cb: (requests: ApprovalRequest[]) => void): Unsubscribe;
  /** Resize the transparent host to the card's natural height. */
  setContentHeight(height: number): void;
  /** Resolve a buddy's pending raise-hand request. */
  resolveApproval(
    helperBuddyId: string,
    approvalId: string,
    verdict: 'once' | 'always' | 'deny',
  ): Promise<void>;
  /** Let the user act in the buddy's browser for sign-in or a CAPTCHA. */
  showApprovalWindow(helperBuddyId: string, approvalId: string): Promise<void>;
  /** Return the user-assisted browser to the buddy and trigger re-observation. */
  hideApprovalWindow(helperBuddyId: string, approvalId: string): Promise<void>;
  listApprovals(): Promise<ApprovalRequest[]>;
}

/** M20: exposed to the whisper renderer as `window.clicky`. */
export interface WhisperApi {
  onTranscript(cb: (entry: TranscriptEntry) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onSettings(cb: (settings: Settings) => void): Unsubscribe;
  /** The window was just shown — focus the composer input. */
  onShown(cb: () => void): Unsubscribe;
  onFilesystemState(cb: (states: FilesystemTaskView[]) => void): Unsubscribe;
  onFilesystemSelection(cb: (selection: FilesystemSelection | null) => void): Unsubscribe;

  /** Bootstrap snapshots (push updates ride on the whisper:* channels). */
  getSettings(): Promise<Settings>;
  getAssistantState(): Promise<AssistantState>;
  getFilesystemState(): Promise<FilesystemTaskView[]>;
  getFilesystemSelection(): Promise<FilesystemSelection | null>;

  /** Same pipeline as the panel composer ('panel:ask-text'). */
  askText(text: string): Promise<void>;
  selectFilesystemRoot(): Promise<FilesystemSelection | null>;
  clearFilesystemRoot(): Promise<void>;
  startFilesystemTask(grantId: string, request: string): Promise<FilesystemTaskView>;
  openFilesystemSafeCopy(taskId: string): Promise<void>;
  discardFilesystemTask(taskId: string): Promise<FilesystemTaskView>;
  undoFilesystemTask(taskId: string): Promise<FilesystemTaskView>;
  keepFilesystemTask(taskId: string): Promise<FilesystemTaskView>;
  cancelFilesystemTask(taskId: string): Promise<void>;
  /** Toggle quiet mode etc. — only voiceMuted is expected from here. */
  setSettings(patch: SettingsPatch): Promise<Settings>;
  /** Tuck the whisper away (esc / close affordance). */
  hide(): void;
}

/** Exposed only to the rich Markdown document renderer. */
export interface MarkdownApi {
  getDocument(): Promise<MarkdownDocumentView>;
  ready(): Promise<void>;
  renderFailed(detail: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}
