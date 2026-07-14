import type { AgentBackend, AgentBackendRequest, AgentBackendResult } from './types';

/** Deterministic no-network backend for debug/E2E Agent Mode checks. */
export class MockAgentBackend implements AgentBackend {
  async request(req: AgentBackendRequest): Promise<AgentBackendResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (req.signal.aborted)
      return { ok: false, errorKind: 'agent_backend_down', detail: 'aborted', retryable: false };
    const hasToolOutput = req.input.some((item) => item['type'] === 'function_call_output');
    if (!hasToolOutput) {
      return {
        ok: true,
        outputItems: [
          {
            type: 'function_call',
            call_id: 'mock_note_1',
            name: 'scratchpad_write',
            arguments: JSON.stringify({
              text: 'mock research checked the requested topic and found a clear recommendation.',
            }),
          },
        ],
        text: '',
        functionCalls: [
          {
            callId: 'mock_note_1',
            name: 'scratchpad_write',
            argsJson: JSON.stringify({
              text: 'mock research checked the requested topic and found a clear recommendation.',
            }),
          },
        ],
        searchQueries: ['mock research query'],
        citations: ['https://example.com/mock-source'],
        usedPercent: { primary: 1, secondary: null },
      };
    }
    const text =
      'the mock research run completed successfully. the strongest option is the one that best matches the constraints in the task.';
    return {
      ok: true,
      outputItems: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
      text,
      functionCalls: [],
      searchQueries: [],
      citations: [],
      usedPercent: { primary: 1, secondary: null },
    };
  }
}
