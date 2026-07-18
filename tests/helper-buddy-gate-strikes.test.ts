import { describe, expect, it } from 'vitest';
import { DENIAL_HALT_COPY, DenialStrikeCounter } from '../src/main/agents/gate/strikes';

describe('DenialStrikeCounter', () => {
  it('escalates on three denials of one target and halts on five total denials', () => {
    const counter = new DenialStrikeCounter();
    expect(counter.recordDenial('helper-buddy-a', 'target-a')).toEqual({
      decision: 'deny',
      targetCount: 1,
      totalCount: 1,
    });
    expect(counter.recordDenial('helper-buddy-a', 'target-a').decision).toBe('deny');
    expect(counter.recordDenial('helper-buddy-a', 'target-a')).toEqual({
      decision: 'escalate',
      targetCount: 3,
      totalCount: 3,
    });
    expect(counter.recordDenial('helper-buddy-a', 'target-b').decision).toBe('deny');
    expect(counter.recordDenial('helper-buddy-a', 'target-c')).toEqual({
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
    counter.recordDenial('helper-buddy-a', signature);
    expect(
      counter.recordDenial('helper-buddy-a', {
        domain: 'linear.app',
        actionKind: 'button',
        target: 'delete issue (9)',
      }).targetCount,
    ).toBe(2);
    expect(counter.recordDenial('helper-buddy-b', signature).targetCount).toBe(1);
    expect(counter.snapshot('helper-buddy-a').totalCount).toBe(2);
    expect(Object.values(counter.snapshot('helper-buddy-a').targets)).toEqual([2]);
  });

  it('can reset one run without changing another', () => {
    const counter = new DenialStrikeCounter();
    counter.recordDenial('helper-buddy-a', 'x');
    counter.recordDenial('helper-buddy-b', 'x');
    counter.resetHelperBuddy('helper-buddy-a');
    expect(counter.snapshot('helper-buddy-a').totalCount).toBe(0);
    expect(counter.snapshot('helper-buddy-b').totalCount).toBe(1);
    counter.clear();
    expect(counter.snapshot('helper-buddy-b').totalCount).toBe(0);
  });

  it('fails fast on invalid thresholds and empty identifiers', () => {
    expect(() => new DenialStrikeCounter({ totalHalt: 0 })).toThrow('positive integer');
    const counter = new DenialStrikeCounter();
    expect(() => counter.recordDenial('', 'x')).toThrow('helper buddy id is required');
    expect(() => counter.recordDenial('a', '')).toThrow('signature is required');
  });
});
