/**
 * The typed IPC contract — the single source of truth for every channel that
 * crosses a process boundary, plus the `window.clicky` API shapes exposed by
 * the preloads.
 *
 * Part of the frozen `src/shared/*` contract (docs/ARCHITECTURE.md §4, §5, §9).
 * Later agents: add channels here via integration-approved edits only.
 *
 * Naming: `<area>:<event>`. Channel string literal = the key in the maps below.
 */

import type {
  AgentSummary,
  AssistantState,
  AudioDeviceError,
  AudioOutputDelta,
  BuddyRestFraction,
  CaptionUpdate,
  CaptureControl,
  CaptureIndicatorUpdate,
  CodexSignInState,
  MicDevice,
  OverlayHoverConfig,
  OverlayHoverEvent,
  OverlayInteractiveUpdate,
  PlaybackControl,
  PlaybackStatsUpdate,
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
  // M19 addition: agent helpers on the overlay — the same renderer-safe list
  // the panel gets (full-list upsert, broadcast on every agent state change;
  // NEVER carries screenshot bytes). Every overlay receives it; only the
  // buddy-hosting overlay renders the helper sprites.
  'overlay:agents': AgentSummary[];
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
  // M21: 'panel:agents' and 'panel:show-agents' retired with the control
  // panel (the agents view is gone; overlay helper clicks summon the
  // whisper). The remaining panel:* channels serve the settings window +
  // hidden audio host that inherited the panel's BrowserWindow.
}

// ===========================================================================
// 2b. Main -> Whisper renderer (webContents.send / clicky.on*)
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
  /** The buddy was clicked while interactive -> main toggles the panel. */
  'overlay:buddy-click': null;
  /** Drag-reposition finished: persist this rest fraction for this overlay. */
  'overlay:buddy-move': BuddyRestFraction;
  // M19 additions: agent helpers on the overlay.
  /** A helper sprite / agent card was clicked -> open the panel agents view. */
  'overlay:agent-click': { id: string };
  /** The agent card's stop affordance was clicked -> cancel that agent. */
  'overlay:agent-cancel': { id: string };
  // M20 addition: the whisper composer.
  /** The whisper asked to tuck away (esc / explicit close). */
  'whisper:hide': null;
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
  /** Microphone devices as enumerated by the panel-visible renderer. */
  'mic:list': { args: []; result: MicDevice[] };
  /** Select the preferred mic ('' = system default); persisted in settings. */
  'mic:select': { args: [deviceId: string]; result: void };
  /** Overlay bootstrap: current assistant state (for late-created windows). */
  'overlay:get-state': { args: []; result: AssistantState };
  // M11 addition: panel bootstrap for runtime flags (push updates ride on
  // 'panel:runtime').
  'panel:get-runtime': { args: []; result: RuntimeFlags };
  // M17 addition: panel bootstrap for the Codex sign-in snapshot (push
  // updates ride on 'panel:codex-signin').
  'codex:signin-state': { args: []; result: CodexSignInState };
  /** Start system-browser ChatGPT sign-in through the local PKCE callback. */
  'codex:sign-in': { args: []; result: SignInResult };
  // M15 addition: overlay bootstrap for hover config (belt-and-braces vs the
  // did-finish-load push; handled in windows/overlay.ts).
  'overlay:get-hover-config': { args: []; result: OverlayHoverConfig };
  // M18 additions: agent mode (docs/AGENT-MODE.md §6.2).
  /** Panel bootstrap: current agent list (push updates ride on 'panel:agents'). */
  'agents:list': { args: []; result: AgentSummary[] };
  /** Stop one agent (Card "stop" affordance). */
  'agents:cancel': { args: [id: string]; result: void };
  /** Stop every running agent (agents-header "stop all"). */
  'agents:cancel-all': { args: []; result: void };
  /** The user viewed this agent's Card — clear its unseen badge. */
  'agents:mark-seen': { args: [id: string]; result: void };
}

// ===========================================================================
// Channel name unions + tiny helpers
// ===========================================================================

export type MainToOverlayChannel = keyof MainToOverlayEvents;
export type MainToPanelChannel = keyof MainToPanelEvents;
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
  onPointer(cb: (cmd: PointerCommand) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onCaption(cb: (update: CaptionUpdate) => void): Unsubscribe;
  onCaptureIndicator(cb: (payload: CaptureIndicatorUpdate) => void): Unsubscribe;
  getAssistantState(): Promise<AssistantState>;

  // M15 additions: buddy hover.
  onHoverConfig(cb: (cfg: OverlayHoverConfig) => void): Unsubscribe;
  onInteractive(cb: (payload: OverlayInteractiveUpdate) => void): Unsubscribe;
  getHoverConfig(): Promise<OverlayHoverConfig>;
  /** Fire-and-forget hover events (dwell/exit/status). */
  sendHover(evt: OverlayHoverEvent): void;
  /** The buddy was clicked while interactive (main toggles the panel). */
  sendBuddyClick(): void;
  /** Drag finished: persist the new rest fraction for this overlay. */
  sendBuddyMove(rest: BuddyRestFraction): void;

  // M20 addition: main-side cursor feed (see 'overlay:cursor').
  onCursor(cb: (pos: { x: number; y: number } | null) => void): Unsubscribe;

  // M19 additions: agent helpers on the overlay.
  onAgents(cb: (agents: AgentSummary[]) => void): Unsubscribe;
  /** Agent list bootstrap (push updates ride on 'overlay:agents'). */
  getAgents(): Promise<AgentSummary[]>;
  /** A helper sprite / agent card was clicked (main opens the agents view). */
  sendAgentClick(id: string): void;
  /** The agent card's stop affordance was clicked. */
  sendAgentCancel(id: string): void;
}

/**
 * Exposed to the panel renderer as `window.clicky`. M21: the panel window is
 * now the hidden AUDIO HOST + the tray-opened SETTINGS surface — the chat
 * panel's transcript/composer/agents accessors retired with it.
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
  // M17 addition: Codex sign-in state push.
  onCodexSignin(cb: (state: CodexSignInState) => void): Unsubscribe;

  getSettings(): Promise<Settings>;
  // M11 addition: runtime flags bootstrap.
  getRuntime(): Promise<RuntimeFlags>;
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
}

/** M20: exposed to the whisper renderer as `window.clicky`. */
export interface WhisperApi {
  onTranscript(cb: (entry: TranscriptEntry) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onSettings(cb: (settings: Settings) => void): Unsubscribe;
  /** The window was just shown — focus the composer input. */
  onShown(cb: () => void): Unsubscribe;

  /** Bootstrap snapshots (push updates ride on the whisper:* channels). */
  getSettings(): Promise<Settings>;
  getAssistantState(): Promise<AssistantState>;

  /** Same pipeline as the panel composer ('panel:ask-text'). */
  askText(text: string): Promise<void>;
  /** Toggle quiet mode etc. — only voiceMuted is expected from here. */
  setSettings(patch: SettingsPatch): Promise<Settings>;
  /** Tuck the whisper away (esc / close affordance). */
  hide(): void;
}
