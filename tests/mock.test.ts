/**
 * Mock Realtime server tests: raw-WebSocket protocol conformance, tone audio
 * synthesis, and the `npm run mock` CLI entry point.
 */

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const mock =
  require('../tools/mock-realtime/server') as typeof import('../tools/mock-realtime/server');
type MockServer = Awaited<ReturnType<typeof mock.createMockServer>>;

interface AnyEvent {
  type: string;
  [k: string]: unknown;
}

/** Raw test client: collects every server event, with awaitable predicates. */
class RawClient {
  events: AnyEvent[] = [];
  private ws: WebSocket;
  private waiters: Array<{ predicate: (e: AnyEvent) => boolean; resolve: (e: AnyEvent) => void }> =
    [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const evt = JSON.parse(String(data)) as AnyEvent;
      this.events.push(evt);
      this.waiters = this.waiters.filter((w) => {
        if (!w.predicate(evt)) return true;
        w.resolve(evt);
        return false;
      });
    });
  }

  send(evt: object): void {
    this.ws.send(JSON.stringify(evt));
  }

  waitFor(predicate: (e: AnyEvent) => boolean, timeoutMs = 5000): Promise<AnyEvent> {
    const already = this.events.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting for event')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (e) => {
          clearTimeout(timer);
          res(e);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

describe('tone synthesis', () => {
  it('produces ~1.5s of non-silent pcm16@24kHz', () => {
    const tone = mock.synthesizeMelodyPcm16();
    expect(tone.length % 2).toBe(0);
    const seconds = tone.length / 2 / 24000;
    expect(seconds).toBeGreaterThan(1.2);
    expect(seconds).toBeLessThan(1.8);
    let maxAbs = 0;
    for (let i = 0; i < tone.length; i += 2)
      maxAbs = Math.max(maxAbs, Math.abs(tone.readInt16LE(i)));
    expect(maxAbs).toBeGreaterThan(3000); // audible
    expect(maxAbs).toBeLessThan(16000); // moderate volume
  });
});

describe('mock realtime server', () => {
  let server: MockServer;

  beforeAll(async () => {
    server = await mock.createMockServer({ port: 0, wordDelayMs: 1, audioChunkDelayMs: 1 });
  });
  afterAll(async () => {
    await server.close();
  });

  async function connect(): Promise<RawClient> {
    const client = new RawClient(server.url);
    await client.waitFor((e) => e.type === 'session.created');
    return client;
  }

  it('greets with session.created and answers session.update', async () => {
    const client = await connect();
    client.send({ type: 'session.update', session: { type: 'realtime', instructions: 'hi' } });
    const updated = await client.waitFor((e) => e.type === 'session.updated');
    expect((updated['session'] as { instructions?: string }).instructions).toBe('hi');
    expect(server.sessionUpdates.length).toBeGreaterThan(0);
    client.close();
  });

  it('"point" turn streams transcript + real audio + one point_at call', async () => {
    const client = await connect();
    client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'context: 1 screenshot(s) attached. screen0 is 1000x600 pixels.',
          },
          { type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' },
          { type: 'input_text', text: 'where is the button?' },
        ],
      },
    });
    client.send({ type: 'response.create' });
    const done = await client.waitFor((e) => e.type === 'response.done');

    const transcriptDeltas = client.events.filter(
      (e) => e.type === 'response.output_audio_transcript.delta',
    );
    expect(transcriptDeltas.length).toBeGreaterThan(3);
    const transcriptDone = client.events.find(
      (e) => e.type === 'response.output_audio_transcript.done',
    ) as AnyEvent;
    expect(transcriptDone['transcript']).toBe(transcriptDeltas.map((d) => d['delta']).join(''));

    const audioBytes = client.events
      .filter((e) => e.type === 'response.output_audio.delta')
      .reduce((sum, e) => sum + Buffer.from(String(e['delta']), 'base64').length, 0);
    expect(audioBytes).toBe(mock.synthesizeMelodyPcm16().length);
    expect(client.events.some((e) => e.type === 'response.output_audio.done')).toBe(true);

    const call = client.events.find(
      (e) => e.type === 'response.function_call_arguments.done',
    ) as AnyEvent;
    expect(call['name']).toBe('point_at');
    const args = JSON.parse(String(call['arguments'])) as { x: number; y: number; screen: number };
    expect(args).toMatchObject({ x: 500, y: 300, screen: 0 }); // center of 1000x600

    const response = done['response'] as { status: string; usage: { total_tokens: number } };
    expect(response.status).toBe('completed');
    expect(response.usage.total_tokens).toBeGreaterThan(0);
    client.close();
  });

  it('function_call_output + response.create yields a follow-up response', async () => {
    const client = await connect();
    client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'point at it' }],
      },
    });
    client.send({ type: 'response.create' });
    const call = await client.waitFor((e) => e.type === 'response.function_call_arguments.done');
    await client.waitFor((e) => e.type === 'response.done');

    client.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: String(call['call_id']),
        output: '{"ok":true}',
      },
    });
    client.send({ type: 'response.create' });
    await client.waitFor(
      (e) =>
        e.type === 'response.output_audio_transcript.done' &&
        String(e['transcript']).includes('there it is'),
    );
    client.close();
  });

  it('"two" turn emits two sequential point_at calls', async () => {
    const client = await connect();
    client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'show me two things' }],
      },
    });
    client.send({ type: 'response.create' });
    await client.waitFor((e) => e.type === 'response.done');
    const calls = client.events.filter((e) => e.type === 'response.function_call_arguments.done');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c['call_id'])).size).toBe(2);
    client.close();
  });

  it('rejects response.create while a response is active (F1 M4 hardening)', async () => {
    const client = await connect();
    client.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    });
    client.send({ type: 'response.create' });
    client.send({ type: 'response.create' }); // concurrent: the real API rejects this
    const err = await client.waitFor(
      (e) =>
        e.type === 'error' &&
        (e['error'] as { code?: string }).code === 'conversation_already_has_active_response',
    );
    expect((err['error'] as { message: string }).message).toContain('active response');
    // Only ONE response ran, and it still completes normally.
    const done = await client.waitFor((e) => e.type === 'response.done');
    expect((done['response'] as { status: string }).status).toBe('completed');
    expect(client.events.filter((e) => e.type === 'response.created')).toHaveLength(1);
    // After response.done, response.create is accepted again.
    client.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] },
    });
    client.send({ type: 'response.create' });
    await client.waitFor((e) => e.type === 'response.done' && e !== done);
    expect(client.events.filter((e) => e.type === 'response.created')).toHaveLength(2);
    client.close();
  });

  it('accepts response.create after cancelling the active response', async () => {
    const client = await connect();
    client.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    });
    client.send({ type: 'response.create' });
    await client.waitFor((e) => e.type === 'response.created');
    client.send({ type: 'response.cancel' });
    client.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    });
    client.send({ type: 'response.create' }); // barge-in path: must be accepted
    expect(
      client.events.some(
        (e) =>
          e.type === 'error' &&
          (e['error'] as { code?: string }).code === 'conversation_already_has_active_response',
      ),
    ).toBe(false);
    await client.waitFor(
      (e) =>
        e.type === 'response.done' && (e['response'] as { status: string }).status === 'completed',
    );
    client.close();
  });

  it('"error" turn emits an error event', async () => {
    const client = await connect();
    client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'error please' }],
      },
    });
    client.send({ type: 'response.create' });
    const err = await client.waitFor((e) => e.type === 'error');
    expect((err['error'] as { message: string }).message).toContain('mock');
    const done = await client.waitFor((e) => e.type === 'response.done');
    expect((done['response'] as { status: string }).status).toBe('failed');
    client.close();
  });

  it('committed audio with no text gets the canned nudge', async () => {
    const client = await connect();
    client.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.alloc(4800).toString('base64'),
    });
    client.send({ type: 'input_audio_buffer.commit' });
    const transcription = await client.waitFor(
      (e) => e.type === 'conversation.item.input_audio_transcription.completed',
    );
    expect(String(transcription['transcript'])).toContain('mock transcript');
    client.send({ type: 'response.create' });
    const done = await client.waitFor((e) => e.type === 'response.output_audio_transcript.done');
    expect(String(done['transcript'])).toContain('point at something');
    client.close();
  });
});

describe('npm run mock CLI', () => {
  it('starts, prints its URL, and serves session.created', async () => {
    const root = resolve(__dirname, '..');
    const child = spawn(process.execPath, ['tools/mock-realtime/index.js', '0'], { cwd: root });
    try {
      const url = await new Promise<string>((res, rej) => {
        const timer = setTimeout(() => rej(new Error('CLI did not print ready line')), 10_000);
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
          const m = /ready on (ws:\/\/[^\s]+)/.exec(out);
          if (m) {
            clearTimeout(timer);
            res(m[1] as string);
          }
        });
        child.on('exit', () => rej(new Error(`CLI exited early:\n${out}`)));
      });
      const client = new RawClient(url);
      const created = await client.waitFor((e) => e.type === 'session.created');
      expect((created['session'] as { id: string }).id).toBeTruthy();
      client.close();
    } finally {
      child.kill();
    }
  });
});
