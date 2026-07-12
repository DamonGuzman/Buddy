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
  AssistantState,
  AudioOutputDelta,
  CaptionUpdate,
  CaptureCommand,
  MicDevice,
  PlaybackCommand,
  PointerCommand,
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
  /** Model audio output for the panel's playback queue. */
  'audio:output': AudioOutputDelta;
  /** Playback control: 'stop' halts immediately; 'flush' drops queued audio. */
  'audio:playback': { command: PlaybackCommand };
  // M5 addition (orchestrator-approved): main tells the panel renderer to
  // start/stop mic capture when the push-to-talk hotkey goes down/up.
  'audio:capture': { command: CaptureCommand };
}

// ===========================================================================
// 3. Renderer -> Main, fire-and-forget (ipcRenderer.send / ipcMain.on)
// ===========================================================================

export interface RendererSendEvents {
  /** Mic PCM16 (24kHz mono) chunk captured while the hotkey is held. */
  'audio:chunk': ArrayBuffer;
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
}

/** Exposed to the panel renderer as `window.clicky`. */
export interface PanelApi {
  onTranscript(cb: (entry: TranscriptEntry) => void): Unsubscribe;
  onSessionStatus(cb: (status: SessionStatus) => void): Unsubscribe;
  onAssistantState(cb: (state: AssistantState) => void): Unsubscribe;
  onSettings(cb: (settings: Settings) => void): Unsubscribe;
  onAudioOutput(cb: (delta: AudioOutputDelta) => void): Unsubscribe;
  onPlayback(cb: (payload: { command: PlaybackCommand }) => void): Unsubscribe;
  // M5 addition (orchestrator-approved): mic capture start/stop from main.
  onCaptureCommand(cb: (payload: { command: CaptureCommand }) => void): Unsubscribe;

  getSettings(): Promise<Settings>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  askText(text: string): Promise<void>;
  listMics(): Promise<MicDevice[]>;
  selectMic(deviceId: string): Promise<void>;

  /** Stream a mic PCM16 chunk to main (fire-and-forget). */
  sendAudioChunk(chunk: ArrayBuffer): void;
}
