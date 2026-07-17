import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelExecutionRecorder,
  sanitizeModelLogValue,
} from '../src/main/model-execution-recorder';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRecorder(): ModelExecutionRecorder {
  const root = mkdtempSync(join(tmpdir(), 'buddy-model-executions-'));
  roots.push(root);
  return new ModelExecutionRecorder({
    userDataPath: root,
    appVersion: '9.8.7-test',
    appSessionId: 'app-session-id',
    id: 'model-recorder-id',
    now: () => new Date('2026-07-16T20:00:00.000Z'),
  });
}

describe('ModelExecutionRecorder', () => {
  it('persists complete request, stream, tool, and terminal records in one JSONL file', () => {
    const recorder = makeRecorder();
    const trace = recorder.begin({
      transport: 'chatgpt-codex-agent',
      model: 'gpt-5.6-sol',
      operation: 'agent.responses.create',
      endpoint: 'https://example.test/responses',
    });
    trace.request({
      instructions: 'build the requested deck',
      input: [{ type: 'message', text: 'include real charts' }],
    });
    trace.event('server', {
      type: 'response.function_call_arguments.done',
      name: 'run_staged_shell',
      arguments: '{"script":"python build_deck.py"}',
    });
    recorder.recordToolExecution({
      agentId: 'agent_5',
      tool: 'run_staged_shell',
      parsedArguments: { script: 'python build_deck.py' },
      result: { output: 'created 23 slides and 8 charts' },
    });
    trace.complete({ usage: { inputTokens: 100, outputTokens: 20 } });
    recorder.close('test_complete');

    const events = readFileSync(recorder.filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => event['type'])).toEqual([
      'recorder_started',
      'execution_started',
      'request',
      'server_event',
      'tool_execution',
      'execution_completed',
      'recorder_closed',
    ]);
    expect(events.map((event) => event['seq'])).toEqual(events.map((_, index) => index + 1));
    const journal = JSON.stringify(events);
    expect(journal).toContain('build the requested deck');
    expect(journal).toContain('python build_deck.py');
    expect(journal).toContain('created 23 slides and 8 charts');
    expect(journal).toContain('inputTokens');
  });

  it('redacts credentials and replaces large binary payloads with stable digests', () => {
    const jpeg = Buffer.alloc(2_048, 7);
    const sanitized = sanitizeModelLogValue({
      authorization: 'Bearer top-secret',
      output: '{"password":"hunter2","ok":true}',
      image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      audio: jpeg.toString('base64'),
    });
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain('top-secret');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain(jpeg.toString('base64'));
    expect(text).toContain('[redacted]');
    expect(text).toContain('binary-redacted-to-digest');
    expect(text).toContain('sha256');
    expect(text).toContain('2048');
  });

  it('fails closed after the recorder is closed', () => {
    const recorder = makeRecorder();
    recorder.close();
    expect(() =>
      recorder.begin({
        transport: 'openai-responses-grounding',
        model: 'gpt-5.4-mini',
        operation: 'grounding.responses.create',
        endpoint: 'https://example.test/responses',
      }),
    ).toThrow('model execution recorder is closed');
  });
});
