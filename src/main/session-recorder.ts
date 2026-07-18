/**
 * Durable, local Buddy session recorder.
 *
 * One app run owns one directory under <userData>/sessions. The append-only
 * journal remains useful after an abrupt process exit; session.json is an
 * atomic, human-readable index. Explicit-turn captures and PCM are stored as
 * sidecar artifacts so debugging does not require bloating the JSON journal.
 * Secrets are redacted defensively even though callers should only pass
 * renderer-safe settings and protocol metadata.
 *
 * `SessionEventMap` enumerates every journal event and its payload shape;
 * `record` is generic over it, so a call site cannot silently drift the
 * on-disk vocabulary.
 */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { arch, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import type { CaptureResult } from './capture';
import type { ActionGateJournalEntry, ComputerActionOutcomeEntry } from './agents/gate/action-gate';
import type { CodexFunctionCall } from './codex/responses-session';
import type { ErrorPresentation } from './errors';
import type { PhoneAudioBridgeStatus } from './phone-audio-bridge-supervisor';
import type { ResponseStatus, ResponseUsage } from './realtime/protocol';
import type { ToolCall } from './realtime/session';
import type {
  HelperBuddySummary,
  AssistantState,
  PlaybackStatsUpdate,
  PointerCommand,
  SessionStatus,
  Settings,
  TranscriptEntry,
  TurnTimings,
  PermissionHealth,
} from '../shared/types';

const FORMAT_VERSION = 1;
const SECRET_KEY =
  /^(?:api.?key(?:encrypted)?|authorization|cookie|password|secret|.*[_-]?token)$/i;
const SECRET_TEXT = /\b(?:bearer\s+\S+|sk-[a-z0-9_-]{8,})\b/gi;

export type AudioDirection = 'input' | 'output';

export interface SessionRecorderOptions {
  userDataPath: string;
  appVersion: string;
  settings: Settings;
  devFlags?: readonly string[];
  now?: () => Date;
  id?: string;
}

interface SessionRuntime {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  pid: number;
  devFlags: readonly string[];
}

interface SessionManifest {
  formatVersion: number;
  sessionId: string;
  status: 'active' | 'closed';
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  appVersion: string;
  runtime: SessionRuntime;
  settings: Settings;
  files: {
    events: 'events.jsonl';
    captures: 'captures/';
    audio: 'audio/';
  };
}

interface AudioStreamStats {
  direction: AudioDirection;
  turnId: string;
  streamId: string;
  relativePath: string;
  bytes: number;
  chunks: number;
  startedAt: string;
}

/** One saved screenshot sidecar, as journaled by `captures_saved`. */
interface CaptureArtifact {
  path: string;
  bytes: number;
  sha256: string;
  meta: CaptureResult['meta'];
}

/**
 * Every journal event and its payload shape — derived from the record() call
 * sites in conversation.ts, index.ts, and this module. Extend here when a new
 * event is journaled.
 */
export interface SessionEventMap {
  // Recorder-internal lifecycle events.
  session_started: { appVersion: string; settings: Settings; runtime: SessionRuntime };
  settings_changed: Settings;
  captures_saved: { turnId: string; artifacts: CaptureArtifact[] };
  audio_stream_started: AudioStreamStats & {
    format: { encoding: 'pcm_s16le'; sampleRate: number; channels: number };
  };
  audio_stream_finished: AudioStreamStats & { endedAt: string; durationMs: number };
  session_ended: { reason: string };
  // Conversation pipeline (conversation.ts).
  playback_stats: PlaybackStatsUpdate;
  turn_started: TurnTimings;
  turn_discarded: TurnTimings;
  turn_finished: TurnTimings;
  capture_failed: { turnId: string; error: unknown };
  tool_call:
    | { transport: 'realtime'; turnId: string | undefined; call: ToolCall }
    | { transport: 'codex'; turnId: string | undefined; call: CodexFunctionCall };
  conversation_closed: {
    state: AssistantState;
    activeTurn: TurnTimings | null;
    transcriptEntriesInMemory: number;
  };
  error_presented: ErrorPresentation;
  realtime_status: SessionStatus;
  response_requested: { turnId: string | undefined; pendingResponses: number };
  response_done: {
    turnId: string | undefined;
    status: ResponseStatus;
    usage: ResponseUsage | undefined;
    pendingResponses: number;
  };
  realtime_error: Error;
  pointer_dispatched: { turnId: string | undefined; command: PointerCommand };
  assistant_state_changed: { previous: AssistantState; next: AssistantState };
  /** The state machine's watchdog force-landed a leaked thinking/speaking. */
  assistant_state_watchdog: { stuck: AssistantState };
  transcript_upsert: { turnId: string | undefined; entry: TranscriptEntry };
  // App bootstrap / OS lifecycle (index.ts).
  phone_audio_bridge_status: PhoneAudioBridgeStatus;
  phone_audio_bridge_client: { state: 'connected' | 'disconnected' };
  helper_buddies_changed: HelperBuddySummary[];
  action_gate_assessment: ActionGateJournalEntry;
  computer_action_executed: ComputerActionOutcomeEntry;
  computer_action_failed: ComputerActionOutcomeEntry;
  hotkey_start_failed: { name: string; message: string; permissions: PermissionHealth };
  fatal_error: { kind: string; error: unknown };
  system_lock: null;
  system_suspend: null;
  system_resume: null;
}

export type SessionEventType = keyof SessionEventMap;

/**
 * The journal file descriptor behind a null-safe seam: every operation is a
 * no-op once closed, so callers never juggle a nullable fd (or assert on it).
 */
class JournalFile {
  private fd: number | null;

  constructor(path: string) {
    this.fd = openSync(path, 'a', 0o600);
  }

  appendLine(line: string): void {
    if (this.fd === null) return;
    writeSync(this.fd, `${line}\n`, undefined, 'utf8');
  }

  sync(): void {
    if (this.fd === null) return;
    fsyncSync(this.fd);
  }

  /** Best-effort close; the journal is flushed by callers before this. */
  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      closeSync(fd);
    } catch {
      // Best-effort shutdown; the journal was already flushed above.
    }
  }
}

export class SessionRecorder {
  readonly sessionId: string;
  readonly directoryPath: string;

  private readonly now: () => Date;
  private readonly manifestPath: string;
  private readonly manifest: SessionManifest;
  private readonly audioStreams = new Map<string, AudioStreamStats>();
  private readonly journal: JournalFile;
  private seq = 0;
  private closed = false;
  private failed = false;
  private warned = false;

  constructor(options: SessionRecorderOptions) {
    this.now = options.now ?? (() => new Date());
    this.sessionId = options.id ?? randomUUID();
    const started = this.now();
    const day = started.toISOString().slice(0, 10);
    const folder = `${fileTimestamp(started)}_${this.sessionId}`;
    this.directoryPath = join(options.userDataPath, 'sessions', day, folder);
    this.manifestPath = join(this.directoryPath, 'session.json');

    mkdirSync(join(this.directoryPath, 'captures'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.directoryPath, 'audio'), { recursive: true, mode: 0o700 });
    this.journal = new JournalFile(join(this.directoryPath, 'events.jsonl'));
    this.manifest = {
      formatVersion: FORMAT_VERSION,
      sessionId: this.sessionId,
      status: 'active',
      startedAt: started.toISOString(),
      endedAt: null,
      endReason: null,
      appVersion: options.appVersion,
      runtime: {
        platform: platform(),
        release: release(),
        arch: arch(),
        pid: process.pid,
        devFlags: [...(options.devFlags ?? [])],
      },
      settings: redactSettings(options.settings),
      files: { events: 'events.jsonl', captures: 'captures/', audio: 'audio/' },
    };
    this.writeManifest();
    this.record('session_started', {
      appVersion: options.appVersion,
      settings: options.settings,
      runtime: this.manifest.runtime,
    });
    this.flush();
  }

  record<K extends SessionEventType>(type: K, payload: SessionEventMap[K]): void {
    if (this.closed || this.failed) return;
    this.safely(() => {
      const event = {
        formatVersion: FORMAT_VERSION,
        seq: (this.seq += 1),
        recordedAt: this.now().toISOString(),
        type,
        payload: redact(payload),
      };
      this.journal.appendLine(JSON.stringify(event));
    });
  }

  recordSettings(settings: Settings): void {
    this.manifest.settings = redactSettings(settings);
    this.safely(() => this.writeManifest());
    this.record('settings_changed', settings);
    this.flush();
  }

  recordCaptures(turnId: string, captures: readonly CaptureResult[]): void {
    if (this.closed || this.failed) return;
    this.safely(() => {
      const safeTurn = safeSegment(turnId);
      const turnDir = join(this.directoryPath, 'captures', safeTurn);
      mkdirSync(turnDir, { recursive: true, mode: 0o700 });
      const artifacts = captures.map((capture, index): CaptureArtifact => {
        const bytes = Buffer.from(capture.jpegBase64, 'base64');
        const name = `screen${capture.meta.screenIndex}-${index}.jpg`;
        const path = join(turnDir, name);
        writeFileSync(path, bytes, { mode: 0o600 });
        return {
          path: `captures/${safeTurn}/${name}`,
          bytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          meta: capture.meta,
        };
      });
      this.record('captures_saved', { turnId, artifacts });
      this.flush();
    });
  }

  appendAudio(
    direction: AudioDirection,
    turnId: string,
    chunk: ArrayBuffer,
    streamId: string = direction,
  ): void {
    if (this.closed || this.failed || chunk.byteLength === 0) return;
    this.safely(() => {
      const key = `${direction}:${turnId}:${streamId}`;
      let stream = this.audioStreams.get(key);
      if (!stream) {
        const name = `${safeSegment(turnId)}-${direction}-${safeSegment(streamId)}.pcm`;
        stream = {
          direction,
          turnId,
          streamId,
          relativePath: `audio/${name}`,
          bytes: 0,
          chunks: 0,
          startedAt: this.now().toISOString(),
        };
        this.audioStreams.set(key, stream);
        this.record('audio_stream_started', {
          ...stream,
          format: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1 },
        });
      }
      const bytes = Buffer.from(chunk);
      appendFileSync(join(this.directoryPath, stream.relativePath), bytes, { mode: 0o600 });
      stream.bytes += bytes.byteLength;
      stream.chunks += 1;
    });
  }

  flush(): void {
    if (this.closed || this.failed) return;
    this.safely(() => this.journal.sync());
  }

  close(reason = 'app_quit'): void {
    if (this.closed) return;
    if (!this.failed) {
      for (const stream of this.audioStreams.values()) {
        this.record('audio_stream_finished', {
          ...stream,
          endedAt: this.now().toISOString(),
          durationMs: Math.round((stream.bytes / (24_000 * 2)) * 1000),
        });
      }
      this.record('session_ended', { reason });
      this.flush();
      this.manifest.status = 'closed';
      this.manifest.endedAt = this.now().toISOString();
      this.manifest.endReason = reason;
      this.safely(() => this.writeManifest());
    }
    this.closed = true;
    this.journal.close();
  }

  private writeManifest(): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.manifestPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.manifestPath);
  }

  private safely(action: () => void): void {
    if (this.failed) return;
    try {
      action();
    } catch (err) {
      this.failed = true;
      if (!this.warned) {
        this.warned = true;
        console.error(
          '[session-recorder] persistence disabled after write failure:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

function fileTimestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100);
  return safe || 'unknown';
}

/**
 * Redaction is shape-preserving for the renderer-safe Settings view: no
 * Settings key matches SECRET_KEY (the raw key never enters a snapshot), so
 * the manifest can keep the honest type.
 */
function redactSettings(settings: Settings): Settings {
  return redact(settings) as Settings;
}

function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(SECRET_TEXT, '[redacted]');
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack ?? '') };
  }
  if (value instanceof ArrayBuffer) return { byteLength: value.byteLength };
  if (ArrayBuffer.isView(value)) return { byteLength: value.byteLength };
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = redact(childValue, childKey);
    }
    return output;
  }
  return value;
}

/** Test-only helper kept exported to lock the secret-scrubbing contract. */
export function redactSessionValue(value: unknown): unknown {
  return redact(value);
}
