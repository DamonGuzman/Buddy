import { describe, expect, it } from 'vitest';
import { DENIAL_HALT_COPY, DenialStrikeCounter } from '../src/main/agents/gate/strikes';

describe('DenialStrikeCounter', () => {
  it('escalates on three denials of one target and halts on five total denials', () => {
    const counter = new DenialStrikeCounter();
    expect(counter.recordDenial('agent-a', 'target-a')).toEqual({
      decision: 'deny',
      targetCount: 1,
      totalCount: 1,
    });
    expect(counter.recordDenial('agent-a', 'target-a').decision).toBe('deny');
    expect(counter.recordDenial('agent-a', 'target-a')).toEqual({
      decision: 'escalate',
      targetCount: 3,
      totalCount: 3,
    });
    expect(counter.recordDenial('agent-a', 'target-b').decision).toBe('deny');
    expect(counter.recordDenial('agent-a', 'target-c')).toEqual({
      decision: 'halt',
      targetCount: 1,
      totalCount: 5,
    });
    expect(DENIAL_HALT_COPY).toContain('i kept proposing actions');
  });

  it('isolates buddies and uses normalized action signatures as keys', () => {
    const counter = new DenialStrikeCounter();
    const signature = {
      domain: 'https://app.linear.app',
      actionKind: 'button' as const,
      target: 'Delete issue (3)',
    };
    counter.recordDenial('agent-a', signature);
    expect(
      counter.recordDenial('agent-a', {
        domain: 'linear.app',
        actionKind: 'button',
        target: 'delete issue (9)',
      }).targetCount,
    ).toBe(2);
    expect(counter.recordDenial('agent-b', signature).targetCount).toBe(1);
    expect(counter.snapshot('agent-a').totalCount).toBe(2);
    expect(Object.values(counter.snapshot('agent-a').targets)).toEqual([2]);
  });

  it('can reset one run without changing another', () => {
    const counter = new DenialStrikeCounter();
    counter.recordDenial('agent-a', 'x');
    counter.recordDenial('agent-b', 'x');
    counter.resetAgent('agent-a');
    expect(counter.snapshot('agent-a').totalCount).toBe(0);
    expect(counter.snapshot('agent-b').totalCount).toBe(1);
    counter.clear();
    expect(counter.snapshot('agent-b').totalCount).toBe(0);
  });

  it('fails fast on invalid thresholds and empty identifiers', () => {
    expect(() => new DenialStrikeCounter({ totalHalt: 0 })).toThrow('positive integer');
    const counter = new DenialStrikeCounter();
    expect(() => counter.recordDenial('', 'x')).toThrow('agent id is required');
    expect(() => counter.recordDenial('a', '')).toThrow('signature is required');
  });
});
