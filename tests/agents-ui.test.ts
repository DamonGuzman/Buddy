/**
 * M19 agent-helper unit tests: the pure view-model in
 * src/renderer/overlay/agents-ui.ts (visible-helper selection, arc layout,
 * tint stability, and the non-technical copy).
 */

import { describe, expect, it } from 'vitest';
import {
  FINISHED_LINGER_MS,
  HELPER_ARC_RADIUS,
  HELPER_DEPART_MS,
  HELPER_TINTS,
  MAX_HELPER_SPRITES,
  elapsedPhrase,
  helperPhase,
  helperSlots,
  helperStatus,
  helperTint,
  nextHelperTransition,
  selectHelpers,
  sourcesPhrase,
  truncate,
} from '../src/renderer/overlay/agents-ui';
import type { AgentSummary } from '../src/shared/types';

const NOW = 10_000_000;

function agent(over: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'agent_1_1',
    task: 'find the best 27 inch monitor under $400',
    status: 'running',
    createdAt: NOW - 30_000,
    maxSteps: null,
    steps: [],
    spoken: false,
    unseen: false,
    ...over,
  };
}

describe('selectHelpers', () => {
  it('shows active agents oldest-first, then fresh finished newest-first', () => {
    const view = selectHelpers(
      [
        agent({ id: 'b', createdAt: NOW - 10_000 }),
        agent({ id: 'a', createdAt: NOW - 20_000 }),
        agent({
          id: 'done-fresh',
          status: 'done',
          unseen: true,
          createdAt: NOW - 90_000,
          finishedAt: NOW - 5_000,
        }),
      ],
      NOW,
    );
    expect(view.shown.map((a) => a.id)).toEqual(['a', 'b', 'done-fresh']);
    expect(view.overflow).toEqual([]);
  });

  it('hides cancelled, seen-finished, and linger-expired agents', () => {
    const view = selectHelpers(
      [
        agent({ id: 'x', status: 'cancelled', unseen: true, finishedAt: NOW - 1_000 }),
        agent({ id: 'y', status: 'done', unseen: false, finishedAt: NOW - 1_000 }),
        agent({
          id: 'z',
          status: 'done',
          unseen: true,
          finishedAt: NOW - FINISHED_LINGER_MS - 1,
        }),
      ],
      NOW,
    );
    expect(view.shown).toEqual([]);
    expect(view.overflow).toEqual([]);
  });

  it('a hovered helper (keepId) survives past its linger window', () => {
    const overdue = agent({
      id: 'held',
      status: 'done',
      unseen: true,
      finishedAt: NOW - FINISHED_LINGER_MS - 5_000,
    });
    expect(selectHelpers([overdue], NOW).shown).toEqual([]);
    expect(selectHelpers([overdue], NOW, 'held').shown.map((a) => a.id)).toEqual(['held']);
  });

  it('folds everything past MAX_HELPER_SPRITES into overflow', () => {
    const agents = [
      agent({ id: 'r1', createdAt: NOW - 40_000 }),
      agent({ id: 'r2', createdAt: NOW - 30_000 }),
      agent({ id: 'r3', createdAt: NOW - 20_000 }),
      agent({ id: 'f1', status: 'failed', unseen: true, finishedAt: NOW - 5_000 }),
      agent({ id: 'f2', status: 'done', unseen: true, finishedAt: NOW - 2_000 }),
    ];
    const view = selectHelpers(agents, NOW);
    expect(view.shown).toHaveLength(MAX_HELPER_SPRITES);
    expect(view.shown.map((a) => a.id)).toEqual(['r1', 'r2', 'r3']);
    // Finished sort is newest-first.
    expect(view.overflow.map((a) => a.id)).toEqual(['f2', 'f1']);
  });
});

describe('helperPhase / nextHelperTransition (celebrate, then leave)', () => {
  const FIN = NOW - 1_000;
  const done = agent({ id: 'd', status: 'done', unseen: true, finishedAt: FIN });

  it('walks settled -> departing -> gone on the linger clock', () => {
    expect(helperPhase(agent({}), NOW)).toBe('active');
    expect(helperPhase(done, NOW)).toBe('settled');
    const departAt = FIN + FINISHED_LINGER_MS - HELPER_DEPART_MS;
    expect(helperPhase(done, departAt - 1)).toBe('settled');
    expect(helperPhase(done, departAt)).toBe('departing');
    expect(helperPhase(done, FIN + FINISHED_LINGER_MS)).toBe('gone');
  });

  it('viewed-in-panel and cancelled helpers are gone immediately', () => {
    expect(helperPhase({ ...done, unseen: false }, NOW)).toBe('gone');
    expect(helperPhase(agent({ status: 'cancelled', unseen: true, finishedAt: FIN }), NOW)).toBe(
      'gone',
    );
  });

  it('keepId freezes the hovered helper at settled', () => {
    expect(helperPhase(done, FIN + FINISHED_LINGER_MS + 60_000, 'd')).toBe('settled');
  });

  it('nextHelperTransition returns the soonest future boundary', () => {
    expect(nextHelperTransition([done], NOW)).toBe(FIN + FINISHED_LINGER_MS - HELPER_DEPART_MS);
    // Mid-departure: the removal boundary is next.
    const midDepart = FIN + FINISHED_LINGER_MS - HELPER_DEPART_MS + 10;
    expect(nextHelperTransition([done], midDepart)).toBe(FIN + FINISHED_LINGER_MS);
    // Hovered helpers are exempt; active agents have no boundaries.
    expect(nextHelperTransition([done], NOW, 'd')).toBeNull();
    expect(nextHelperTransition([agent({})], NOW)).toBeNull();
    expect(nextHelperTransition([done], FIN + FINISHED_LINGER_MS + 1)).toBeNull();
  });
});

describe('helperSlots', () => {
  it('starts straight up and sweeps toward the dir side', () => {
    const slots = helperSlots(3, -1, -1);
    expect(slots[0]).toEqual({ x: 0, y: -HELPER_ARC_RADIUS });
    // All remaining slots are on the dir side (left) and none below center+arc.
    for (const s of slots.slice(1)) expect(s.x).toBeLessThan(0);
    for (const s of slots) expect(Math.hypot(s.x, s.y)).toBeCloseTo(HELPER_ARC_RADIUS, -1);
  });

  it('mirrors horizontally with dir and vertically with vdir', () => {
    const base = helperSlots(4, -1, -1);
    const mirroredX = helperSlots(4, 1, -1);
    const mirroredY = helperSlots(4, -1, 1);
    base.forEach((s, i) => {
      // `+ 0` normalizes the -0 that negating a zero coordinate produces.
      expect(mirroredX[i]).toEqual({ x: -s.x + 0, y: s.y });
      expect(mirroredY[i]).toEqual({ x: s.x, y: -s.y + 0 });
    });
  });
});

describe('helperTint', () => {
  it('is stable per id and always from the palette', () => {
    const t1 = helperTint('agent_12_345');
    expect(helperTint('agent_12_345')).toBe(t1);
    expect(HELPER_TINTS).toContain(t1);
  });

  it('spreads across the palette', () => {
    const names = new Set(
      ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'agent_1', 'agent_2'].map(
        (id) => helperTint(id).name,
      ),
    );
    expect(names.size).toBeGreaterThan(2);
  });
});

describe('helperStatus (non-technical copy)', () => {
  it('running: derives the activity line from the last step', () => {
    const search = helperStatus(
      agent({ steps: [{ kind: 'search', label: 'searched "best 27 inch monitor"', at: NOW }] }),
    );
    expect(search.kind).toBe('working');
    expect(search.line).toBe('searching for "best 27 inch monitor"');
    const fetch = helperStatus(
      agent({ steps: [{ kind: 'fetch', label: 'read rtings.com/reviews', at: NOW }] }),
    );
    expect(fetch.line).toBe('reading rtings.com/reviews');
    const think = helperStatus(agent({ steps: [{ kind: 'think', label: 'thinking', at: NOW }] }));
    expect(think.line).toBe('thinking it over');
    expect(helperStatus(agent({})).line).toBe('figuring out where to start');
  });

  it('done: shows the summary (truncated), with a see-it cta', () => {
    const s = helperStatus(agent({ status: 'done', summary: 'x'.repeat(400) }));
    expect(s.kind).toBe('done');
    expect(s.pill).toBe('all done');
    expect(s.line.length).toBeLessThanOrEqual(150);
    expect(s.line.endsWith('…')).toBe(true);
    expect(s.cta).toContain('click');
  });

  it('failed/timed_out read as friendly trouble, queued as waiting', () => {
    expect(
      helperStatus(agent({ status: 'failed', error: 'the web search service said no' })),
    ).toMatchObject({
      kind: 'trouble',
      line: 'the web search service said no',
    });
    expect(helperStatus(agent({ status: 'failed' })).line).toBe(
      'something went wrong along the way',
    );
    expect(helperStatus(agent({ status: 'timed_out' })).pill).toBe('ran long');
    expect(helperStatus(agent({ status: 'queued' })).kind).toBe('waiting');
  });
});

describe('elapsedPhrase / sourcesPhrase / truncate', () => {
  it('speaks elapsed time in plain words', () => {
    expect(elapsedPhrase(agent({ createdAt: NOW - 10_000 }), NOW)).toBe('just started');
    expect(elapsedPhrase(agent({ createdAt: NOW - 100_000 }), NOW)).toBe(
      'working for about a minute',
    );
    expect(elapsedPhrase(agent({ createdAt: NOW - 3 * 60_000 }), NOW)).toBe(
      'working for 3 minutes',
    );
    expect(
      elapsedPhrase(
        agent({ status: 'done', createdAt: NOW - 50_000, finishedAt: NOW - 10_000 }),
        NOW,
      ),
    ).toBe('took under a minute');
    expect(
      elapsedPhrase(
        agent({ status: 'done', createdAt: NOW - 200_000, finishedAt: NOW - 10_000 }),
        NOW,
      ),
    ).toBe('took 3 minutes');
  });

  it('counts places, not "sources"', () => {
    expect(sourcesPhrase(agent({}))).toBeNull();
    expect(sourcesPhrase(agent({ sources: ['a'] }))).toBe('checked 1 place on the web');
    expect(sourcesPhrase(agent({ sources: ['a', 'b', 'c'] }))).toBe('checked 3 places on the web');
  });

  it('truncate collapses whitespace and appends an ellipsis', () => {
    expect(truncate('  hello   world  ', 20)).toBe('hello world');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
