import type { FunctionCallItem } from '../codex/wire-types';
import type { AgentBackend, AgentBackendRequest, AgentBackendResult } from './types';

/** Deterministic no-network backend for debug/E2E Agent Mode checks. */
export class MockAgentBackend implements AgentBackend {
  isReady(): boolean {
    return true;
  }

  async request(req: AgentBackendRequest): Promise<AgentBackendResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (req.signal.aborted)
      return { ok: false, errorKind: 'agent_backend_down', detail: 'aborted', retryable: false };
    const hasToolOutput = req.input.some((item) => item['type'] === 'function_call_output');
    if (!hasToolOutput) {
      // Single payload source: the function_call output item IS the call the
      // runner executes — functionCalls is derived from it, never restated.
      const noteCall: FunctionCallItem = {
        type: 'function_call',
        call_id: 'mock_note_1',
        name: 'scratchpad_write',
        arguments: JSON.stringify({
          text: 'mock research checked the requested topic and found a clear recommendation.',
        }),
      };
      return {
        ok: true,
        outputItems: [noteCall],
        text: '',
        functionCalls: [
          { callId: noteCall.call_id, name: noteCall.name, argsJson: noteCall.arguments },
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
