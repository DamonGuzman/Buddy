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
  CaptionUpdate,
  CaptureCommand,
  CodexSignInState,
  MicDevice,
  OverlayHoverConfig,
  OverlayHoverEvent,
  PlaybackCommand,
  PlaybackStatsUpdate,
  PointerCommand,
  RuntimeFlags,
  SessionStatus,
  Settings,
  SettingsPatch,
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
  'overlay:capture-indicator': { active: boolean };
  // M15 additions (orchestrator-approved): buddy hover.
  /** Hover config (hotkey label + rest position) on load and settings change. */
  'overlay:hover-config': OverlayHoverConfig;
  /** This overlay window's click-through state flipped (dwell-to-interact). */
  'overlay:interactive': { interactive: boolean };
  // M19 addition (integration-approved): agent helpers on the overlay — the
  // same renderer-safe list the panel gets (full-list upsert, broadcast on
  // every agent state change; NEVER carries screenshot bytes). Every overlay
  // receives it; only the buddy-hosting overlay renders the helper sprites.
  'overlay:agents': AgentSummary[];
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
  // M17 addition (integration-approved): the ChatGPT-subscription (Codex CLI)
  // sign-in snapshot, pushed on ready and whenever it changes (the CLI's
  // auth.json can rotate under us). NEVER carries a token. The codex* fields
  // also ride on 'panel:settings'; this is the lower-latency dedicated push.
  'panel:codex-signin': CodexSignInState;
  /** Model audio output for the panel's playback queue. */
  'audio:output': AudioOutputDelta;
  /**
   * Playback control: 'stop' halts immediately; 'flush' drops queued audio.
   * F1 fix (orchestrator-approved), M2: `epoch` is the new playback-epoch
   * floor — subsequent audio:output deltas tagged with an older epoch are
   * stale (they belong to a cancelled/superseded response) and are dropped.
   */
  'audio:playback': { command: PlaybackCommand; epoch?: number };
  // M5 addition (orchestrator-approved): main tells the panel renderer to
  // start/stop mic capture when the push-to-talk hotkey goes down/up.
  'audio:capture': { command: CaptureCommand };
  // M11 addition (orchestrator-approved): runtime flags for the panel —
  // hookAlive (hero hint adapts) + CLICKY_* dev flags (header dev chip).
  'panel:runtime': RuntimeFlags;
  // M18 addition (integration-approved): agent-mode mirror — the FULL
  // renderer-safe agent list, pushed on every state change (full-list upsert;
  // the panel replaces its list wholesale). Never carries screenshot bytes.
  'panel:agents': AgentSummary[];
  // M19 addition (integration-approved): switch the panel to the agents view
  // (an overlay helper sprite / agent card was clicked; main shows the panel
  // and sends this so the click lands on the right view).
  'panel:show-agents': null;
}

// ===========================================================================
// 3. Renderer -> Main, fire-and-forget (ipcRenderer.send / ipcMain.on)
// ===========================================================================

export interface RendererSendEvents {
  /** Mic PCM16 (24kHz mono) chunk captured while the hotkey is held. */
  'audio:chunk': ArrayBuffer;
  // M8.5 addition (orchestrator-approved): playback tap — the panel reports
  // per-item played-audio stats (on first play, ~1s cadence, and on done).
  'audio:playback-stats': PlaybackStatsUpdate;
  // M8.5 addition (orchestrator-approved): ring buffer of the last ~15s of
  // PLAYED audio as Int16 PCM (24kHz mono), sent when an item finishes.
  'audio:playback-ring': ArrayBuffer;
  // M11 addition (orchestrator-approved): the panel renderer reports audio
  // device failures (mic capture start / playback init) so main can surface
  // mic_unavailable / audio_output_failed from the error catalog.
  'audio:capture-error': AudioDeviceError;
  // M15 additions (orchestrator-approved): buddy hover.
  /** Hover state machine events: dwell (make interactive) / exit / status. */
  'overlay:hover': OverlayHoverEvent;
  /** The buddy was clicked while interactive -> main toggles the panel. */
  'overlay:buddy-click': null;
  /** Drag-reposition finished: persist this rest fraction for this overlay. */
  'overlay:buddy-move': { xFrac: number; yFrac: number };
  // M19 additions (integration-approved): agent helpers on the overlay.
  /** A helper sprite / agent card was clicked -> open the panel agents view. */
  'overlay:agent-click': { id: string };
  /** The agent card's stop affordance was clicked -> cancel that agent. */
  'overlay:agent-cancel': { id: string };
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
  // M11 addition (orchestrator-approved): panel bootstrap for runtime flags
  // (push updates ride on 'panel:runtime').
  'panel:get-runtime': { args: []; result: RuntimeFlags };
  // M17 addition (integration-approved): panel bootstrap for the Codex
  // sign-in snapshot (push updates ride on 'panel:codex-signin').
  'codex:signin-state': { args: []; result: CodexSignInState };
  /** Start system-browser ChatGPT sign-in through the local PKCE callback. */
  'codex:sign-in': { args: []; result: { ok: true } | { ok: false; error: string } };
  // M15 addition (orchestrator-approved): overlay bootstrap for hover config
  // (belt-and-braces vs the did-finish-load push; handled in windows/overlay.ts).
  'overlay:get-hover-config': { args: []; result: OverlayHoverConfig };
  // M18 additions (integration-approved): agent mode (docs/AGENT-MODE.md §6.2).
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
  onCaptureIndicator(cb: (payload: { active: boolean }) => void): Unsubscribe;
  getAssistantState(): Promise<AssistantState>;

  // M15 additions (orchestrator-approved): buddy hover.
  onHoverConfig(cb: (cfg: OverlayHoverConfig) => void): Unsubscribe;
  onInteractive(cb: (payload: { interactive: boolean }) => void): Unsubscribe;
  getHoverConfig(): Promise<OverlayHoverConfig>;
  /** Fire-and-forget hover events (dwell/exit/status). */
  sendHover(evt: OverlayHoverEvent): void;
  /** The buddy was clicked while interactive (main toggles the panel). */
  sendBuddyClick(): void;
  /** Drag finished: persist the new rest fraction for this overlay. */
  sendBuddyMove(rest: { xFrac: number; yFrac: number }): void;

  // M19 additions (integration-approved): agent helpers on the overlay.
  onAgents(cb: (agents: AgentSummary[]) => void): Unsubscribe;
  /** Agent list bootstrap (push updates ride on 'overlay:agents'). */
  getAgents(): Promise<AgentSummary[]>;
  /** A helper sprite / agent card was clicked (main opens the agents view). */
  sendAgentClick(id: string): void;
  /** The agent card's stop affordance was clicked. */
  sendAgentCancel(id: string): void;
}

/** Exposed to the panel renderer as `window.clicky`. */
export interface PanelApi {
  onTranscript(cb: (entry: TranscriptEntry) => void): Unsubscribe;
  onSessionStatus(cb: (status: SessionStatus) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onSettings(cb: (settings: Settings) => void): Unsubscribe;
  onAudioOutput(cb: (delta: AudioOutputDelta) => void): Unsubscribe;
  // F1 fix (orchestrator-approved), M2: payload gained the optional epoch.
  onPlayback(cb: (payload: { command: PlaybackCommand; epoch?: number }) => void): Unsubscribe;
  // M5 addition (orchestrator-approved): mic capture start/stop from main.
  onCaptureCommand(cb: (payload: { command: CaptureCommand }) => void): Unsubscribe;
  // M11 addition (orchestrator-approved): runtime flags (hookAlive + dev flags).
  onRuntime(cb: (flags: RuntimeFlags) => void): Unsubscribe;
  // M17 addition (integration-approved): Codex sign-in state push.
  onCodexSignin(cb: (state: CodexSignInState) => void): Unsubscribe;
  // M18 addition (integration-approved): agent list push (full-list upsert).
  onAgents(cb: (agents: AgentSummary[]) => void): Unsubscribe;
  // M19 addition (integration-approved): switch to the agents view (an
  // overlay helper sprite / agent card was clicked).
  onShowAgents(cb: () => void): Unsubscribe;

  getSettings(): Promise<Settings>;
  // M11 addition (orchestrator-approved): runtime flags bootstrap.
  getRuntime(): Promise<RuntimeFlags>;
  // M17 addition (integration-approved): Codex sign-in state bootstrap.
  getCodexSigninState(): Promise<CodexSignInState>;
  signInToCodex(): Promise<{ ok: true } | { ok: false; error: string }>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  askText(text: string): Promise<void>;
  listMics(): Promise<MicDevice[]>;
  selectMic(deviceId: string): Promise<void>;

  // M18 additions (integration-approved): agent mode (docs/AGENT-MODE.md §6.2).
  /** Agent list bootstrap (push updates ride on 'panel:agents'). */
  listAgents(): Promise<AgentSummary[]>;
  cancelAgent(id: string): Promise<void>;
  cancelAllAgents(): Promise<void>;
  markAgentSeen(id: string): Promise<void>;

  /** Stream a mic PCM16 chunk to main (fire-and-forget). */
  sendAudioChunk(chunk: ArrayBuffer): void;

  // M8.5 additions (orchestrator-approved): playback tap reporting.
  /** Report played-audio stats for a response item (fire-and-forget). */
  sendPlaybackStats(stats: PlaybackStatsUpdate): void;
  /** Ship the last ~15s of played audio (Int16 PCM 24kHz mono). */
  sendPlaybackRing(ring: ArrayBuffer): void;

  // M11 addition (orchestrator-approved): audio device failure report
  // (mic capture start failed / playback init failed) — fire-and-forget.
  reportAudioError(payload: AudioDeviceError): void;
}
