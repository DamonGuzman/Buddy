import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunBudget } from '../src/main/agents/run-budget';

afterEach(() => vi.useRealTimers());

describe('AgentRunBudget', () => {
  it('uses monotonic elapsed time and ignores wall-clock jumps', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const expired = vi.fn();
    const budget = new AgentRunBudget(1_000, expired);
    budget.start();

    vi.setSystemTime(new Date('1990-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(999);
    expect(expired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledOnce();
  });

  it('does not charge elapsed time while paused', () => {
    let now = 0;
    const expired = vi.fn();
    const budget = new AgentRunBudget(1_000, expired, () => now);
    budget.start();
    now = 400;
    budget.pause();
    now = 10_000;
    expect(budget.remaining()).toBe(600);
    budget.dispose();
  });
});
