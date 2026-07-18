/**
 * Structural ports: the exact slices of the app's concrete services the
 * conversation package touches. The real SettingsStore / OverlayManager /
 * PanelManager / SessionRecorder / HelperBuddyManager satisfy these unchanged;
 * tests construct small honest fakes instead of `as never` casts.
 */

import type { MainToOverlayEvents, MainToPanelEvents } from '../../shared/ipc';
import type { HelperBuddySummary, PointerCommand, Settings } from '../../shared/types';
import type { HelperBuddyBrief, HelperBuddySpawnResult } from '../agents/types';
import type { CaptureResult } from '../capture';
import type { SessionEventMap, SessionEventType } from '../session-recorder';

/** The renderer-safe settings fields the conversation actually reads. */
export type ConversationSettings = Pick<
  Settings,
  | 'model'
  | 'voice'
  | 'captionsEnabled'
  | 'voiceMuted'
  | 'fullRealtimeMode'
  | 'computerUseEnabled'
  | 'preferApiKeyGrounding'
  | 'apiKeyUnreadable'
>;

/** Settings access (SettingsStore satisfies this). */
export interface SettingsPort {
  get(): ConversationSettings;
  /** Decrypted API key — never logged, never sent to a renderer. */
  getApiKey(): string | null;
  /** M11: the store fell back to defaults because the file was corrupt. */
  settingsWereReset(): boolean;
}

/** Overlay channels the conversation broadcasts on. */
export type ConversationOverlayChannel =
  'overlay:caption' | 'overlay:assistant-state' | 'overlay:capture-indicator';

/** Overlay fan-out (OverlayManager satisfies this). */
export interface OverlayPort {
  broadcast<C extends ConversationOverlayChannel>(
    channel: C,
    payload: MainToOverlayEvents[C],
  ): void;
  /** Route a pointer command to the buddy-hosting overlay. */
  routePointer(cmd: PointerCommand): void;
}

/** Panel channels the conversation sends on. */
export type ConversationPanelChannel =
  | 'panel:transcript'
  | 'panel:session-status'
  | 'panel:assistant-state'
  | 'audio:output'
  | 'audio:playback'
  | 'audio:capture';

/** Panel window messaging (PanelManager satisfies this). */
export interface PanelPort {
  send<C extends ConversationPanelChannel>(channel: C, payload: MainToPanelEvents[C]): void;
}

/** Durable local journal + turn artifacts (SessionRecorder satisfies this). */
export interface RecorderPort {
  record<K extends SessionEventType>(type: K, payload: SessionEventMap[K]): void;
  recordSettings(settings: Settings): void;
  recordCaptures(turnId: string, captures: readonly CaptureResult[]): void;
  appendAudio(
    direction: 'input' | 'output',
    turnId: string,
    chunk: ArrayBuffer,
    streamId?: string,
  ): void;
  flush(): void;
}

/** Helper-buddy runtime (HelperBuddyManager satisfies this). */
export interface HelperBuddiesPort {
  isReady(): boolean;
  list(): HelperBuddySummary[];
  spawn(brief: HelperBuddyBrief): HelperBuddySpawnResult;
  markSpoken(id: string): void;
}
