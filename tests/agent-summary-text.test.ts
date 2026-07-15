/**
 * Direct unit tests for the pure agent-loop helpers in
 * src/main/agents/summary-text.ts — especially concise()'s sentence-cut
 * edges (500-char budget, >180 sentence-break rule, 497 hard cut).
 */

import { describe, expect, it } from 'vitest';
import {
  buildInitialMessage,
  cloneAgentSummary,
  concise,
  delay,
  isTerminal,
  stripLinks,
} from '../src/main/agents/summary-text';
import type { AgentBrief } from '../src/main/agents/types';
import type { AgentSummary, CaptureMeta } from '../src/shared/types';

describe('concise', () => {
  it('passes text at or under 500 chars through (trimmed)', () => {
    expect(concise('  short recap  ')).toBe('short recap');
    const exactly500 = 'a'.repeat(500);
    expect(concise(exactly500)).toBe(exactly500);
  });

  it('cuts at the last sentence break past index 180', () => {
    const text = `${'a'.repeat(300)}. ${'b'.repeat(199)}`; // 501 chars
    expect(concise(text)).toBe(`${'a'.repeat(300)}.…`);
  });

  it('accepts ! and ? as sentence breaks', () => {
    expect(concise(`${'a'.repeat(300)}! ${'b'.repeat(199)}`)).toBe(`${'a'.repeat(300)}!…`);
    expect(concise(`${'a'.repeat(300)}? ${'b'.repeat(199)}`)).toBe(`${'a'.repeat(300)}?…`);
  });

  it('a break at exactly index 180 is too early — falls back to the 497 hard cut', () => {
    const text = `${'a'.repeat(180)}. ${'b'.repeat(400)}`;
    expect(concise(text)).toBe(`${text.slice(0, 497)}…`);
  });

  it('a break at index 181 is late enough to use', () => {
    const text = `${'a'.repeat(181)}. ${'b'.repeat(400)}`;
    expect(concise(text)).toBe(`${'a'.repeat(181)}.…`);
  });

  it('hard-cuts at 497 chars when there is no sentence break at all', () => {
    const result = concise('x'.repeat(600));
    expect(result).toBe(`${'x'.repeat(497)}…`);
    expect(result.length).toBe(498);
  });

  it('trims whitespace left dangling by the cut', () => {
    const text = `${'a'.repeat(496)} ${'b'.repeat(100)}`; // char 496 is a space
    expect(concise(text)).toBe(`${'a'.repeat(496)}…`);
  });
});

describe('stripLinks', () => {
  it('keeps markdown link text and drops raw urls', () => {
    expect(stripLinks('see [the review](https://example.com/x) at https://example.com/y now')).toBe(
      'see the review at now',
    );
  });

  it('collapses doubled spaces and trailing line whitespace', () => {
    expect(stripLinks('a  b   c \nnext')).toBe('a b c\nnext');
  });
});

describe('buildInitialMessage', () => {
  const base: AgentBrief = {
    id: 'agent_1',
    userRequest: 'find the best monitor',
    task: 'find the best monitor',
    recentTranscript: '',
    createdAt: 1,
    browserEnabled: false,
  };

  it('includes only the task when why/transcript/screenshot are absent', () => {
    expect(buildInitialMessage(base)).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'task: find the best monitor' }],
    });
  });

  it('joins task, why, and transcript with blank lines and attaches the screenshot', () => {
    const message = buildInitialMessage({
      ...base,
      why: 'user asked',
      recentTranscript: 'user: hi',
      screenshot: {
        jpegBase64: 'QUJD',
        meta: {
          screenIndex: 0,
          displayId: 1,
          imageW: 1920,
          imageH: 1080,
          displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          scaleFactor: 1,
          isActive: true,
        } as CaptureMeta,
      },
    });
    expect(message['content']).toEqual([
      {
        type: 'input_text',
        text: 'task: find the best monitor\n\nwhy/context: user asked\n\nrecent conversation:\nuser: hi',
      },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
    ]);
  });
});

describe('isTerminal', () => {
  it('is true only for final statuses', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('timed_out')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});

describe('cloneAgentSummary', () => {
  it('copies steps/sources into fresh arrays and defaults sources to []', () => {
    const summary: AgentSummary = {
      id: 'a',
      task: 't',
      status: 'done',
      createdAt: 1,
      maxSteps: null,
      steps: [{ kind: 'note', label: 'l', at: 2 }],
      spoken: false,
      unseen: true,
    };
    const clone = cloneAgentSummary(summary);
    expect(clone).not.toBe(summary);
    expect(clone.steps).not.toBe(summary.steps);
    expect(clone.steps).toEqual(summary.steps);
    expect(clone.sources).toEqual([]);
  });
});

describe('delay', () => {
  it('resolves after the timeout', async () => {
    await expect(delay(1, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('resolves early (never rejects) when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = delay(60_000, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
  });
});
