/**
 * M19 helper-buddy unit tests: the pure view-model in
 * src/renderer/overlay/helper-buddies-ui.ts (visible-helper selection, arc layout,
 * tint stability, and the non-technical copy).
 */

import { describe, expect, it } from 'vitest';
import {
  HELPER_BUDDY_CARD_EXPANDED_W,
  HELPER_BUDDY_CARD_GAP,
  CARD_HIDE_DELAY_MS,
  CARD_SHOW_DELAY_MS,
  EXPANDED_STEPS_MAX,
  FINISHED_LINGER_MS,
  HELPER_ARC_RADIUS,
  HELPER_DEPART_MS,
  HELPER_HIT_RADIUS,
  HELPER_TINTS,
  MAX_HELPER_SPRITES,
  OVERFLOW_KEY,
  clip,
  desiredHelperHover,
  elapsedPhrase,
  expandedFindings,
  helperHoverStep,
  helperPhase,
  helperSlotViews,
  helperSlots,
  helperStatus,
  helperTint,
  nextHelperTransition,
  plainText,
  recentSteps,
  selectHelpers,
  sourceHosts,
  sourcesPhrase,
  timeAgoPhrase,
  truncate,
} from '../src/renderer/overlay/helper-buddies-ui';
import type { HelperSlot } from '../src/renderer/overlay/helper-buddies-ui';
import { AUX_PAD } from '../src/renderer/overlay/hover';
import type { HelperBuddySummary, Rect } from '../src/shared/types';

const NOW = 10_000_000;

function helperBuddy(over: Partial<HelperBuddySummary>): HelperBuddySummary {
  return {
    id: 'helper_buddy_1_1',
    task: 'find the best 27 inch monitor under $400',
    status: 'running',
    createdAt: NOW - 30_000,
    steps: [],
    spoken: false,
    unseen: false,
    ...over,
  };
}

describe('selectHelpers', () => {
  it('shows active helper buddies oldest-first, then fresh finished newest-first', () => {
    const view = selectHelpers(
      [
        helperBuddy({ id: 'b', createdAt: NOW - 10_000 }),
        helperBuddy({ id: 'a', createdAt: NOW - 20_000 }),
        helperBuddy({
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

  it('hides cancelled, seen-finished, and linger-expired helper buddies', () => {
    const view = selectHelpers(
      [
        helperBuddy({ id: 'x', status: 'cancelled', unseen: true, finishedAt: NOW - 1_000 }),
        helperBuddy({ id: 'y', status: 'done', unseen: false, finishedAt: NOW - 1_000 }),
        helperBuddy({
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
    const overdue = helperBuddy({
      id: 'held',
      status: 'done',
      unseen: true,
      finishedAt: NOW - FINISHED_LINGER_MS - 5_000,
    });
    expect(selectHelpers([overdue], NOW).shown).toEqual([]);
    expect(selectHelpers([overdue], NOW, 'held').shown.map((a) => a.id)).toEqual(['held']);
  });

  it('keeps a waiting-approval helper active indefinitely', () => {
    const waiting = helperBuddy({
      id: 'needs-ok',
      status: 'waiting_approval',
      createdAt: NOW - FINISHED_LINGER_MS * 10,
      unseen: false,
    });
    expect(selectHelpers([waiting], NOW).shown.map((item) => item.id)).toEqual(['needs-ok']);
    expect(helperPhase(waiting, NOW)).toBe('active');
    expect(nextHelperTransition([waiting], NOW)).toBeNull();
  });

  it('keeps waiting approvals visible ahead of the overflow fold', () => {
    const view = selectHelpers(
      [
        helperBuddy({ id: 'old-1', createdAt: NOW - 40_000 }),
        helperBuddy({ id: 'old-2', createdAt: NOW - 30_000 }),
        helperBuddy({ id: 'old-3', createdAt: NOW - 20_000 }),
        helperBuddy({ id: 'needs-ok', status: 'waiting_approval', createdAt: NOW - 10_000 }),
      ],
      NOW,
    );
    expect(view.shown.map((item) => item.id)).toContain('needs-ok');
    expect(view.overflow.map((item) => item.id)).not.toContain('needs-ok');
  });

  it('folds everything past MAX_HELPER_SPRITES into overflow', () => {
    const helperBuddies = [
      helperBuddy({ id: 'r1', createdAt: NOW - 40_000 }),
      helperBuddy({ id: 'r2', createdAt: NOW - 30_000 }),
      helperBuddy({ id: 'r3', createdAt: NOW - 20_000 }),
      helperBuddy({ id: 'f1', status: 'failed', unseen: true, finishedAt: NOW - 5_000 }),
      helperBuddy({ id: 'f2', status: 'done', unseen: true, finishedAt: NOW - 2_000 }),
    ];
    const view = selectHelpers(helperBuddies, NOW);
    expect(view.shown).toHaveLength(MAX_HELPER_SPRITES);
    expect(view.shown.map((a) => a.id)).toEqual(['r1', 'r2', 'r3']);
    // Finished sort is newest-first.
    expect(view.overflow.map((a) => a.id)).toEqual(['f2', 'f1']);
  });
});

describe('helperPhase / nextHelperTransition (celebrate, then leave)', () => {
  const FIN = NOW - 1_000;
  const done = helperBuddy({ id: 'd', status: 'done', unseen: true, finishedAt: FIN });

  it('walks settled -> departing -> gone on the linger clock', () => {
    expect(helperPhase(helperBuddy({}), NOW)).toBe('active');
    expect(helperPhase(done, NOW)).toBe('settled');
    const departAt = FIN + FINISHED_LINGER_MS - HELPER_DEPART_MS;
    expect(helperPhase(done, departAt - 1)).toBe('settled');
    expect(helperPhase(done, departAt)).toBe('departing');
    expect(helperPhase(done, FIN + FINISHED_LINGER_MS)).toBe('gone');
  });

  it('viewed-in-panel and cancelled helpers are gone immediately', () => {
    expect(helperPhase({ ...done, unseen: false }, NOW)).toBe('gone');
    expect(
      helperPhase(helperBuddy({ status: 'cancelled', unseen: true, finishedAt: FIN }), NOW),
    ).toBe('gone');
  });

  it('keepId freezes the hovered helper at settled', () => {
    expect(helperPhase(done, FIN + FINISHED_LINGER_MS + 60_000, 'd')).toBe('settled');
  });

  it('nextHelperTransition returns the soonest future boundary', () => {
    expect(nextHelperTransition([done], NOW)).toBe(FIN + FINISHED_LINGER_MS - HELPER_DEPART_MS);
    // Mid-departure: the removal boundary is next.
    const midDepart = FIN + FINISHED_LINGER_MS - HELPER_DEPART_MS + 10;
    expect(nextHelperTransition([done], midDepart)).toBe(FIN + FINISHED_LINGER_MS);
    // Hovered helpers are exempt; active helper buddies have no boundaries.
    expect(nextHelperTransition([done], NOW, 'd')).toBeNull();
    expect(nextHelperTransition([helperBuddy({})], NOW)).toBeNull();
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

describe('helperSlotViews', () => {
  it('fuses shown helper buddies + the overflow pebble into keyed absolute slots', () => {
    const view = selectHelpers(
      [
        helperBuddy({ id: 'r1', createdAt: NOW - 40_000 }),
        helperBuddy({ id: 'r2', createdAt: NOW - 30_000 }),
        helperBuddy({ id: 'r3', createdAt: NOW - 20_000 }),
        helperBuddy({ id: 'f1', status: 'done', unseen: true, finishedAt: NOW - 2_000 }),
      ],
      NOW,
    );
    const anchor = { x: 900, y: 500 };
    const slots = helperSlotViews(view, anchor, -1, -1);
    expect(slots.map((s) => s.key)).toEqual(['r1', 'r2', 'r3', OVERFLOW_KEY]);
    const offsets = helperSlots(4, -1, -1);
    slots.forEach((s, i) => {
      expect(s.pos).toEqual({
        x: anchor.x + (offsets[i]?.x ?? NaN),
        y: anchor.y + (offsets[i]?.y ?? NaN),
      });
    });
  });

  it('no overflow -> exactly one slot per shown helper buddy', () => {
    const view = selectHelpers([helperBuddy({ id: 'only' })], NOW);
    expect(helperSlotViews(view, { x: 0, y: 0 }, 1, 1).map((s) => s.key)).toEqual(['only']);
  });
});

describe('desiredHelperHover', () => {
  const SLOTS: HelperSlot[] = [
    { key: 'a', pos: { x: 900, y: 452 } },
    { key: 'b', pos: { x: 870, y: 462 } },
  ];
  const base = { slots: SLOTS, hovered: null, cardRect: null, enabled: true };

  it('picks the NEAREST sprite within the hit radius', () => {
    expect(desiredHelperHover({ ...base, cursor: { x: 900, y: 452 } })).toBe('a');
    // Between the two but closer to b.
    expect(desiredHelperHover({ ...base, cursor: { x: 878, y: 460 } })).toBe('b');
    // On the hit-radius boundary still counts.
    expect(desiredHelperHover({ ...base, cursor: { x: 900, y: 452 - HELPER_HIT_RADIUS } })).toBe(
      'a',
    );
    expect(
      desiredHelperHover({ ...base, cursor: { x: 900, y: 452 - HELPER_HIT_RADIUS - 1 } }),
    ).toBeNull();
  });

  it('a cursor inside the padded open card keeps the hovered helper', () => {
    const card: Rect = { x: 582, y: 380, width: 248, height: 120 };
    const onCard = { x: 600, y: 400 };
    expect(desiredHelperHover({ ...base, cursor: onCard, hovered: 'a', cardRect: card })).toBe('a');
    // The AUX_PAD ring around the card counts too (matches the aux hit test).
    expect(
      desiredHelperHover({
        ...base,
        cursor: { x: 582 - AUX_PAD + 1, y: 400 },
        hovered: 'a',
        cardRect: card,
      }),
    ).toBe('a');
    expect(
      desiredHelperHover({
        ...base,
        cursor: { x: 582 - AUX_PAD - 2, y: 400 },
        hovered: 'a',
        cardRect: card,
      }),
    ).toBeNull();
    // The card only holds an EXISTING hover — it never starts one.
    expect(desiredHelperHover({ ...base, cursor: onCard, cardRect: card })).toBeNull();
  });

  it('nothing when the cursor is gone, no slots exist, or hovering is ineligible', () => {
    expect(desiredHelperHover({ ...base, cursor: null })).toBeNull();
    expect(desiredHelperHover({ ...base, cursor: { x: 900, y: 452 }, slots: [] })).toBeNull();
    expect(desiredHelperHover({ ...base, cursor: { x: 900, y: 452 }, enabled: false })).toBeNull();
  });
});

describe('helperHoverStep (anti-flicker rules)', () => {
  it('holds when nothing changes (cancels any pending switch)', () => {
    expect(helperHoverStep(null, null)).toEqual({ kind: 'hold' });
    expect(helperHoverStep('a', 'a')).toEqual({ kind: 'hold' });
  });

  it('switches directly between helpers with no delay', () => {
    expect(helperHoverStep('b', 'a')).toEqual({ kind: 'commit' });
  });

  it('defers show/hide by their grace delays', () => {
    expect(helperHoverStep('a', null)).toEqual({ kind: 'defer', delayMs: CARD_SHOW_DELAY_MS });
    expect(helperHoverStep(null, 'a')).toEqual({ kind: 'defer', delayMs: CARD_HIDE_DELAY_MS });
  });
});

describe('helperTint', () => {
  it('is stable per id and always from the palette', () => {
    const t1 = helperTint('helper_buddy_12_345');
    expect(helperTint('helper_buddy_12_345')).toBe(t1);
    expect(HELPER_TINTS).toContain(t1);
  });

  it('spreads across the palette', () => {
    const names = new Set(
      ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'helper_buddy_1', 'helper_buddy_2'].map(
        (id) => helperTint(id).name,
      ),
    );
    expect(names.size).toBeGreaterThan(2);
  });
});

describe('helperStatus (non-technical copy)', () => {
  it('running: derives the activity line from the last step', () => {
    const search = helperStatus(
      helperBuddy({ steps: [{ kind: 'search', label: 'checking affordable monitors', at: NOW }] }),
    );
    expect(search.kind).toBe('working');
    expect(search.line).toBe('checking affordable monitors');
    const fetch = helperStatus(
      helperBuddy({ steps: [{ kind: 'fetch', label: 'reading the product reviews', at: NOW }] }),
    );
    expect(fetch.line).toBe('reading the product reviews');
    const think = helperStatus(
      helperBuddy({
        steps: [{ kind: 'think', label: 'comparing the strongest options', at: NOW }],
      }),
    );
    expect(think.line).toBe('comparing the strongest options');
    expect(helperStatus(helperBuddy({})).line).toBe('figuring out where to start');
  });

  it('done: shows the summary (truncated), with a see-it cta', () => {
    const s = helperStatus(helperBuddy({ status: 'done', summary: 'x'.repeat(400) }));
    expect(s.kind).toBe('done');
    expect(s.pill).toBe('all done');
    expect(s.line.length).toBeLessThanOrEqual(150);
    expect(s.line.endsWith('…')).toBe(true);
    expect(s.cta).toContain('click');
  });

  it('failed reads as friendly trouble and queued as waiting', () => {
    expect(
      helperStatus(helperBuddy({ status: 'failed', error: 'the web search service said no' })),
    ).toMatchObject({
      kind: 'trouble',
      line: 'the web search service said no',
    });
    expect(helperStatus(helperBuddy({ status: 'failed' })).line).toBe(
      'something went wrong along the way',
    );
    expect(helperStatus(helperBuddy({ status: 'queued' })).kind).toBe('waiting');
  });

  it('waiting approval stays amber and asks for a choice', () => {
    expect(helperStatus(helperBuddy({ status: 'waiting_approval' }))).toEqual({
      pill: 'needs your ok',
      kind: 'approval',
      line: 'i paused before doing something that needs your choice',
      cta: 'click to review this action',
    });
    expect(elapsedPhrase(helperBuddy({ status: 'waiting_approval' }), NOW)).toBe(
      'waiting for your choice',
    );
  });
});

describe('elapsedPhrase / sourcesPhrase / truncate', () => {
  it('speaks elapsed time in plain words', () => {
    expect(elapsedPhrase(helperBuddy({ createdAt: NOW - 10_000 }), NOW)).toBe('just started');
    expect(elapsedPhrase(helperBuddy({ createdAt: NOW - 100_000 }), NOW)).toBe(
      'working for about a minute',
    );
    expect(elapsedPhrase(helperBuddy({ createdAt: NOW - 3 * 60_000 }), NOW)).toBe(
      'working for 3 minutes',
    );
    expect(
      elapsedPhrase(
        helperBuddy({ status: 'done', createdAt: NOW - 50_000, finishedAt: NOW - 10_000 }),
        NOW,
      ),
    ).toBe('took under a minute');
    expect(
      elapsedPhrase(
        helperBuddy({ status: 'done', createdAt: NOW - 200_000, finishedAt: NOW - 10_000 }),
        NOW,
      ),
    ).toBe('took 3 minutes');
  });

  it('counts places, not "sources"', () => {
    expect(sourcesPhrase(helperBuddy({}))).toBeNull();
    expect(sourcesPhrase(helperBuddy({ sources: ['a'] }))).toBe('checked 1 place on the web');
    expect(sourcesPhrase(helperBuddy({ sources: ['a', 'b', 'c'] }))).toBe(
      'checked 3 places on the web',
    );
  });

  it('truncate collapses whitespace and appends an ellipsis', () => {
    expect(truncate('  hello   world  ', 20)).toBe('hello world');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('expanded card view-model (M22 click -> full status)', () => {
  it('recentSteps keeps the last N, oldest first', () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({
      kind: 'note' as const,
      label: `step ${i}`,
      at: NOW - (9 - i) * 1000,
    }));
    const out = recentSteps(helperBuddy({ steps }));
    expect(out).toHaveLength(EXPANDED_STEPS_MAX);
    expect(out[0]?.label).toBe('step 3');
    expect(out[out.length - 1]?.label).toBe('step 8');
  });

  it('timeAgoPhrase speaks in plain words', () => {
    expect(timeAgoPhrase(NOW - 10_000, NOW)).toBe('just now');
    expect(timeAgoPhrase(NOW - 60_000, NOW)).toBe('a minute ago');
    expect(timeAgoPhrase(NOW - 4 * 60_000, NOW)).toBe('4 minutes ago');
    expect(timeAgoPhrase(NOW - 2 * 60 * 60_000, NOW)).toBe('a while ago');
    expect(timeAgoPhrase(NOW + 5_000, NOW)).toBe('just now'); // clock skew
  });

  it('sourceHosts dedupes hostnames, strips www, and caps the list', () => {
    const { hosts, more } = sourceHosts(
      helperBuddy({
        sources: [
          'https://www.rtings.com/monitor/reviews/best',
          'https://rtings.com/other-page',
          'https://displayninja.com/x',
          'not a url',
        ],
      }),
    );
    expect(hosts).toEqual(['rtings.com', 'displayninja.com', 'not a url']);
    expect(more).toBe(0);
  });

  it('sourceHosts reports the overflow count past the cap', () => {
    const sources = Array.from({ length: 8 }, (_, i) => `https://site${i}.com/a`);
    const { hosts, more } = sourceHosts(helperBuddy({ sources }));
    expect(hosts).toHaveLength(5);
    expect(more).toBe(3);
  });

  it('clip preserves line breaks (unlike truncate)', () => {
    expect(clip('one\ntwo\nthree', 100)).toBe('one\ntwo\nthree');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
  });

  it('plainText strips light markdown down to readable text', () => {
    expect(plainText('# heading\n**bold** and *soft*\n- item\n[link](https://x.com)')).toBe(
      'heading\nbold and soft\n• item\nlink',
    );
  });

  it('expandedFindings: finished runs only, full output over spoken summary', () => {
    expect(expandedFindings(helperBuddy({ output: 'notes' }))).toBeNull(); // running
    expect(expandedFindings(helperBuddy({ status: 'queued', output: 'notes' }))).toBeNull();
    expect(
      expandedFindings(helperBuddy({ status: 'waiting_approval', output: 'notes' })),
    ).toBeNull();
    expect(
      expandedFindings(helperBuddy({ status: 'done', summary: 'short', output: 'the full story' })),
    ).toBe('the full story');
    expect(expandedFindings(helperBuddy({ status: 'done', summary: 'short' }))).toBe('short');
    expect(expandedFindings(helperBuddy({ status: 'failed' }))).toBeNull();
  });

  it('the expanded card geometry stays under the merged-region cap', () => {
    // buddy half-footprint + gap + card + pad must fit REGION_CAP (398).
    expect(36 + HELPER_BUDDY_CARD_GAP + HELPER_BUDDY_CARD_EXPANDED_W + AUX_PAD).toBeLessThanOrEqual(
      398,
    );
  });
});
