import { describe, expect, it } from 'vitest';
import { compactHelperBuddyHistory } from '../src/main/agents/helper-buddy-history';
import type { ResponseItem } from '../src/main/agents/types';

describe('helper-buddy store:false history compaction', () => {
  it('keeps tool pairs intact while retaining only two of forty image observations', () => {
    const history: ResponseItem[] = [];
    const image = 'x'.repeat(100_000);
    for (let round = 1; round <= 40; round += 1) {
      history.push(
        {
          type: 'function_call',
          call_id: `call_${round}`,
          name: 'browser_scroll',
          arguments: JSON.stringify({ x: 10, y: 10, dy: 200, justification: 'continue reading' }),
        },
        {
          type: 'function_call_output',
          call_id: `call_${round}`,
          output: JSON.stringify({ ok: true, scrolled: 200 }),
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: `fresh observation ${round}` },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${image}` },
          ],
        },
      );
    }

    const compacted = compactHelperBuddyHistory(history);
    const serialized = JSON.stringify(compacted);
    expect((serialized.match(/data:image\/jpeg;base64/g) ?? []).length).toBe(2);
    expect(serialized.length).toBeLessThan(250_000);

    const calls = compacted.filter((item) => item['type'] === 'function_call');
    const outputs = compacted.filter((item) => item['type'] === 'function_call_output');
    expect(calls).toHaveLength(40);
    expect(outputs).toHaveLength(40);
    expect(calls.map((item) => item['call_id'])).toEqual(outputs.map((item) => item['call_id']));
  });
});
