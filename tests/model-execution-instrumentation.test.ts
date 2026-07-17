import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAgentBackend } from '../src/main/agents/backend';
import type { AgentBackendRequest } from '../src/main/agents/types';
import type { AuthSource } from '../src/main/auth/auth-source';
import { CodexResponsesSession } from '../src/main/codex/responses-session';
import { RestGrounder } from '../src/main/grounding/rest-grounder';
import {
  installModelExecutionRecorder,
  ModelExecutionRecorder,
  resetModelExecutionRecorderForTests,
} from '../src/main/model-execution-recorder';
import { RealtimeSession } from '../src/main/realtime/session';
import type * as MockRealtime from '../tools/mock-realtime/server';

const require = createRequire(import.meta.url);
const mock = require('../tools/mock-realtime/server') as typeof MockRealtime;
const roots: string[] = [];

afterEach(() => {
  resetModelExecutionRecorderForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sse(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

describe('model transport instrumentation', () => {
  it('journals every production model transport and exact helper function calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buddy-model-instrumentation-'));
    roots.push(root);
    const recorder = new ModelExecutionRecorder({
      userDataPath: root,
      appVersion: 'test',
      id: 'instrumentation-recorder',
    });
    installModelExecutionRecorder(recorder);

    const codexAuth = {
      kind: 'chatgptCodex' as const,
      getBearer: async () => 'codex-secret-bearer',
      accountId: 'acct-1',
      planType: 'pro',
    };

    const codexSession = new CodexResponsesSession({
      auth: codexAuth,
      instructions: 'codex conversation instructions',
      env: {},
      fetchImpl: (async () =>
        new Response(
          sse([
            { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'codex answer' },
            { type: 'response.output_text.done', item_id: 'msg_1', text: 'codex answer' },
            {
              type: 'response.completed',
              response: {
                id: 'resp_codex',
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ]),
          { status: 200 },
        )) as typeof fetch,
    });
    await codexSession.submit({ text: 'codex user prompt' });

    const agentBackend = new CodexAgentBackend(
      {
        getCodexAuth: () => ({
          accessToken: 'stored-secret',
          accountId: 'acct-1',
          planType: 'pro',
          expiresAt: Date.now() + 60_000,
        }),
        getBearer: async () => 'agent-secret-bearer',
      },
      (async () =>
        new Response(
          sse([
            {
              type: 'response.output_item.added',
              item: {
                id: 'fc_1',
                type: 'function_call',
                call_id: 'call_1',
                name: 'run_staged_shell',
                arguments: '{"script":"python build_real_charts.py"}',
              },
            },
            {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_1',
              arguments: '{"script":"python build_real_charts.py"}',
            },
            {
              type: 'response.completed',
              response: { usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } },
            },
          ]),
          { status: 200 },
        )) as typeof fetch,
    );
    const agentRequest: AgentBackendRequest = {
      model: 'gpt-5.6-sol',
      instructions: 'helper buddy instructions',
      input: [],
      tools: [],
      effort: 'medium',
      signal: new AbortController().signal,
      runContext: { agentId: 'agent-observability-test', requestAttempt: 1 },
    };
    await agentBackend.request(agentRequest);

    const apiPayload = {
      id: 'resp_ground',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: '{"x":12,"y":34}' }],
        },
      ],
    };
    const apiGrounder = new RestGrounder({
      getApiKey: () => 'sk-api-secret',
      env: {},
      fetchImpl: (async () =>
        new Response(JSON.stringify(apiPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as typeof fetch,
    });
    const query = {
      jpegBase64: Buffer.from('fake-jpeg').toString('base64'),
      imageW: 100,
      imageH: 100,
      label: 'save button',
    };
    const apiAuth: AuthSource = { kind: 'apiKey', getApiKey: () => 'sk-api-secret' };
    await apiGrounder.ground(query, apiAuth);

    const codexGrounder = new RestGrounder({
      getApiKey: () => null,
      env: {},
      fetchImpl: (async () =>
        new Response(
          sse([
            { type: 'response.output_text.delta', delta: '{"x":56,"y":78}' },
            {
              type: 'response.completed',
              response: {
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'output_text', text: '{"x":56,"y":78}' }],
                  },
                ],
                usage: { input_tokens: 30, output_tokens: 3, total_tokens: 33 },
              },
            },
          ]),
          { status: 200 },
        )) as typeof fetch,
    });
    await codexGrounder.ground(query, codexAuth);

    const realtimeServer = await mock.createMockServer({
      port: 0,
      wordDelayMs: 1,
      audioChunkDelayMs: 1,
    });
    const realtime = new RealtimeSession({
      model: 'gpt-realtime-2.1-mini',
      voice: 'marin',
      instructions: 'realtime instructions',
      urlOverride: realtimeServer.url,
    });
    realtime.on('error', () => undefined);
    try {
      const done = new Promise<void>((resolve) => realtime.once('response-done', () => resolve()));
      await realtime.askText('realtime user prompt');
      await done;
    } finally {
      realtime.close();
      await realtimeServer.close();
    }

    recorder.close('test_complete');
    const journal = readFileSync(recorder.filePath, 'utf8');
    for (const transport of [
      'chatgpt-codex-responses',
      'chatgpt-codex-agent',
      'openai-responses-grounding',
      'chatgpt-codex-grounding',
      'openai-realtime-websocket',
    ]) {
      expect(journal).toContain(transport);
    }
    expect(journal).toContain('codex user prompt');
    expect(journal).toContain('python build_real_charts.py');
    expect(journal).toContain('agent-observability-test');
    expect(journal).toContain('requestAttempt');
    expect(journal).toContain('realtime user prompt');
    expect(journal).toContain('response.completed');
    expect(journal).toContain('response.done');
    expect(journal).not.toContain('codex-secret-bearer');
    expect(journal).not.toContain('agent-secret-bearer');
    expect(journal).not.toContain('sk-api-secret');
  });
});
