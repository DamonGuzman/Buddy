/**
 * Durable, process-wide observability for every model execution.
 *
 * Model transports write the exact text/tool payloads they send and every
 * parsed streaming event they receive to one append-only JSONL journal per
 * app session. Credentials are always redacted. Large base64 audio/image
 * fields are represented by byte length + SHA-256. Foreground conversation
 * screenshots and audio are also retained by the existing session recorder.
 *
 * The installed recorder is intentionally fail-closed: a write failure throws
 * at the model boundary so Buddy never silently continues with an unlogged
 * model call. Unit tests and isolated transport consumers may omit installing
 * the process recorder; production installs it before constructing transports.
 */

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FORMAT_VERSION = 1;
const SECRET_KEY =
  /^(?:api.?key(?:encrypted)?|authorization|cookie|password|secret|.*[_-]?token)$/i;
const SECRET_TEXT =
  /\b(?:bearer\s+\S+|sk-[a-z0-9_-]{8,}|eyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{8,}|(?:password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[^"'\s,}]+)\b/gi;
const DATA_URL = /^data:([^;,]+)?;base64,([a-z0-9+/=\r\n]+)$/i;
const BASE64 = /^[a-z0-9+/=\r\n]+$/i;
const BINARY_STRING_MIN_CHARS = 1_024;

export type ModelTransport =
  | 'openai-realtime-websocket'
  | 'chatgpt-codex-responses'
  | 'chatgpt-codex-helper-buddy'
  | 'chatgpt-codex-grounding'
  | 'openai-responses-grounding';

export interface ModelExecutionStart {
  transport: ModelTransport;
  model: string;
  operation: string;
  endpoint: string;
  context?: unknown;
}

export interface ModelExecutionRecorderOptions {
  userDataPath: string;
  appVersion: string;
  appSessionId?: string | null;
  now?: () => Date;
  id?: string;
}

interface ModelJournalEvent {
  formatVersion: number;
  seq: number;
  recordedAt: string;
  recorderId: string;
  appSessionId: string | null;
  executionId: string | null;
  type: string;
  payload: unknown;
}

export class ModelExecutionRecorder {
  readonly recorderId: string;
  readonly directoryPath: string;
  readonly filePath: string;

  private readonly now: () => Date;
  private readonly appSessionId: string | null;
  private readonly fd: number;
  private seq = 0;
  private closed = false;

  constructor(options: ModelExecutionRecorderOptions) {
    this.now = options.now ?? (() => new Date());
    this.recorderId = options.id ?? randomUUID();
    this.appSessionId = options.appSessionId ?? null;
    const started = this.now();
    const day = started.toISOString().slice(0, 10);
    const sessionFolder = `${fileTimestamp(started)}_${this.recorderId}`;
    this.directoryPath = join(options.userDataPath, 'model-executions', day, sessionFolder);
    this.filePath = join(this.directoryPath, 'model-executions.jsonl');
    mkdirSync(this.directoryPath, { recursive: true, mode: 0o700 });
    this.fd = openSync(this.filePath, 'a', 0o600);
    this.append(null, 'recorder_started', {
      appVersion: options.appVersion,
      appSessionId: this.appSessionId,
      pid: process.pid,
    });
    this.flush();
  }

  begin(start: ModelExecutionStart): ModelExecutionTrace {
    this.assertOpen();
    const executionId = randomUUID();
    this.append(executionId, 'execution_started', start);
    return new ModelExecutionTrace(this, executionId);
  }

  recordToolExecution(payload: unknown): void {
    this.append(null, 'tool_execution', payload);
    this.flush();
  }

  close(reason = 'app_quit'): void {
    if (this.closed) return;
    this.append(null, 'recorder_closed', { reason });
    this.flush();
    this.closed = true;
    closeSync(this.fd);
  }

  write(executionId: string, type: string, payload: unknown, flush = false): void {
    this.append(executionId, type, payload);
    if (flush) this.flush();
  }

  private append(executionId: string | null, type: string, payload: unknown): void {
    this.assertOpen();
    const event: ModelJournalEvent = {
      formatVersion: FORMAT_VERSION,
      seq: (this.seq += 1),
      recordedAt: this.now().toISOString(),
      recorderId: this.recorderId,
      appSessionId: this.appSessionId,
      executionId,
      type,
      payload: sanitizeModelLogValue(payload),
    };
    writeSync(this.fd, `${JSON.stringify(event)}\n`, undefined, 'utf8');
  }

  private flush(): void {
    this.assertOpen();
    fsyncSync(this.fd);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('model execution recorder is closed');
  }
}

export class ModelExecutionTrace {
  private terminal = false;

  constructor(
    private readonly recorder: ModelExecutionRecorder,
    readonly executionId: string,
  ) {}

  request(payload: unknown): void {
    this.write('request', payload);
  }

  response(payload: unknown): void {
    this.write('response', payload);
  }

  event(direction: 'client' | 'server', payload: unknown): void {
    this.write(direction === 'client' ? 'client_event' : 'server_event', payload);
  }

  complete(payload: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.recorder.write(this.executionId, 'execution_completed', payload, true);
  }

  fail(error: unknown, context?: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.recorder.write(this.executionId, 'execution_failed', { error, context }, true);
  }

  cancel(reason: string, context?: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    this.recorder.write(this.executionId, 'execution_cancelled', { reason, context }, true);
  }

  private write(type: string, payload: unknown): void {
    if (this.terminal) throw new Error(`cannot record ${type} after model execution terminated`);
    this.recorder.write(this.executionId, type, payload);
  }
}

let installedRecorder: ModelExecutionRecorder | null = null;

/** Install exactly one recorder for the Electron main-process lifetime. */
export function installModelExecutionRecorder(recorder: ModelExecutionRecorder): void {
  if (installedRecorder !== null) throw new Error('model execution recorder is already installed');
  installedRecorder = recorder;
}

export function beginModelExecution(start: ModelExecutionStart): ModelExecutionTrace | null {
  return installedRecorder?.begin(start) ?? null;
}

export function recordModelToolExecution(payload: unknown): void {
  installedRecorder?.recordToolExecution(payload);
}

/** Test-only seam for pure recorder assertions; production never uninstalls. */
export function resetModelExecutionRecorderForTests(): void {
  installedRecorder = null;
}

export function sanitizeModelLogValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: sanitizeString(value.stack ?? ''),
    };
  }
  if (value instanceof ArrayBuffer) return binaryDescriptor(Buffer.from(value));
  if (ArrayBuffer.isView(value)) {
    return binaryDescriptor(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeModelLogValue(item));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeModelLogValue(childValue, childKey);
    }
    return output;
  }
  return value;
}

function sanitizeString(value: string): unknown {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.stringify(sanitizeModelLogValue(JSON.parse(trimmed)));
    } catch {
      // Ordinary model text can resemble JSON without being valid JSON.
    }
  }
  const dataUrl = DATA_URL.exec(value);
  if (dataUrl !== null) {
    const bytes = Buffer.from((dataUrl[2] ?? '').replaceAll(/\s/g, ''), 'base64');
    return { ...binaryDescriptor(bytes), mimeType: dataUrl[1] ?? 'application/octet-stream' };
  }
  if (value.length >= BINARY_STRING_MIN_CHARS && value.length % 4 === 0 && BASE64.test(value)) {
    return binaryDescriptor(Buffer.from(value.replaceAll(/\s/g, ''), 'base64'));
  }
  return value.replace(SECRET_TEXT, '[redacted]');
}

function binaryDescriptor(bytes: Buffer): Record<string, unknown> {
  return {
    encoding: 'binary-redacted-to-digest',
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function fileTimestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
}
