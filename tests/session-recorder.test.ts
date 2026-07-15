import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { redactSessionValue, SessionRecorder } from '../src/main/session-recorder';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRecorder(): SessionRecorder {
  const root = mkdtempSync(join(tmpdir(), 'buddy-session-'));
  roots.push(root);
  return new SessionRecorder({
    userDataPath: root,
    appVersion: '9.8.7-test',
    settings: DEFAULT_SETTINGS,
    id: 'session-test-id',
    now: () => new Date('2026-07-13T12:34:56.000Z'),
    devFlags: ['CLICKY_MOCK_URL'],
  });
}

describe('SessionRecorder', () => {
  it('keeps a crash-readable journal and atomically closes the manifest', () => {
    const recorder = makeRecorder();
    // The journal accepts any event name at runtime (fail-soft, forward
    // compatible); widen past the compile-time SessionEventMap to exercise
    // sequencing + redaction with a synthetic event.
    const recordRaw = recorder.record.bind(recorder) as (type: string, payload: unknown) => void;
    recordRaw('custom', {
      inputTokens: 42,
      authorization: 'Bearer super-secret',
      nested: { password: 'hunter2', text: 'key sk-abcdefgh123456' },
    });
    recorder.close('test_complete');

    const manifest = JSON.parse(
      readFileSync(join(recorder.directoryPath, 'session.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      formatVersion: 1,
      sessionId: 'session-test-id',
      status: 'closed',
      endReason: 'test_complete',
      appVersion: '9.8.7-test',
    });
    expect(existsSync(join(recorder.directoryPath, 'session.json.tmp'))).toBe(false);

    const events = readFileSync(join(recorder.directoryPath, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number; type: string; payload: unknown });
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'custom',
      'session_ended',
    ]);
    expect(JSON.stringify(events)).not.toContain('super-secret');
    expect(JSON.stringify(events)).not.toContain('hunter2');
    expect(JSON.stringify(events)).not.toContain('sk-abcdefgh123456');
    expect(JSON.stringify(events)).toContain('inputTokens');
    expect(JSON.stringify(events)).toContain('42');
  });

  it('stores hashed captures and lossless PCM sidecars with journal metadata', () => {
    const recorder = makeRecorder();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    recorder.recordCaptures('turn_1', [
      {
        jpegBase64: jpeg.toString('base64'),
        meta: {
          screenIndex: 0,
          displayId: 123,
          imageW: 640,
          imageH: 360,
          displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1,
          isActive: true,
        },
      },
    ]);
    const first = Uint8Array.from([1, 2, 3, 4]).buffer;
    const second = Uint8Array.from([5, 6]).buffer;
    recorder.appendAudio('input', 'turn_1', first);
    recorder.appendAudio('input', 'turn_1', second);
    recorder.close();

    expect(
      readFileSync(join(recorder.directoryPath, 'captures', 'turn_1', 'screen0-0.jpg')),
    ).toEqual(jpeg);
    expect(readFileSync(join(recorder.directoryPath, 'audio', 'turn_1-input-input.pcm'))).toEqual(
      Buffer.from([1, 2, 3, 4, 5, 6]),
    );
    const journal = readFileSync(join(recorder.directoryPath, 'events.jsonl'), 'utf8');
    expect(journal).toContain('captures_saved');
    expect(journal).toContain('sha256');
    expect(journal).toContain('audio_stream_finished');
    expect(journal).toContain('pcm_s16le');
  });

  it('redacts credential-shaped values without erasing usage telemetry', () => {
    expect(
      redactSessionValue({
        apiKey: 'secret',
        access_token: 'also-secret',
        apiKeyPresent: true,
        inputTokens: 123,
      }),
    ).toEqual({
      apiKey: '[redacted]',
      access_token: '[redacted]',
      apiKeyPresent: true,
      inputTokens: 123,
    });
  });
});
