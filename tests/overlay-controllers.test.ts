/**
 * Overlay controller unit tests: TimerBag, the query-param protocol parser,
 * CaptionController, PointerChoreographer, HelperHoverController and the
 * HoverDragController wiring — all pure logic over injected clocks/timers
 * (fake time below), no DOM.
 *
 * The choreography/caption scenarios pin the user-visible TIMING contracts:
 * per-point dwell, the six-second return-home dwell after turn settle, the
 * caption linger->fade sequence, helper-card show/hide grace, and the ORDER
 * of overlay:hover dwell/exit/status emissions.
 */

import { describe, expect, it } from 'vitest';
import { TimerBag } from '../src/renderer/overlay/timer-bag';
import type { Clock, TimerHost } from '../src/renderer/overlay/timer-bag';
import { parseOverlayParams } from '../src/renderer/overlay/query-params';
import {
  CAPTION_FADE_MS,
  CAPTION_LINGER_MS,
  CaptionController,
} from '../src/renderer/overlay/caption-controller';
import type { CaptionView } from '../src/renderer/overlay/caption-controller';
import {
  HOME_AFTER_MS,
  POINT_DWELL_MS,
  PointerChoreographer,
  TIP_OFFSET,
} from '../src/renderer/overlay/pointer-choreographer';
import type { FlightDriver, PulseView } from '../src/renderer/overlay/pointer-choreographer';
import { HelperHoverController } from '../src/renderer/overlay/helper-hover-controller';
import type { ClusterGeom } from '../src/renderer/overlay/helper-hover-controller';
import { HoverDragController } from '../src/renderer/overlay/hover-controller';
import type { HoverDragPorts } from '../src/renderer/overlay/hover-controller';
import {
  CARD_HIDE_DELAY_MS,
  CARD_SHOW_DELAY_MS,
  FINISHED_LINGER_MS,
  HELPER_ARC_RADIUS,
} from '../src/renderer/overlay/agents-ui';
import type { HelperView } from '../src/renderer/overlay/agents-ui';
import { DWELL_MS as HOVER_DWELL_MS, HINT_DELAY_MS } from '../src/renderer/overlay/hover';
import type { AuxHoverGeometry, HoverGateInput, Vec } from '../src/renderer/overlay/hover';
import type { AgentSummary, AssistantState, OverlayHoverEvent, Rect } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Fake time: a TimerHost + Clock that fires due timers in order on advance().
// ---------------------------------------------------------------------------

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

class FakeTime implements TimerHost {
  now = 0;
  private seq = 0;
  private readonly due = new Map<number, { at: number; fn: () => void }>();

  readonly clock: Clock = () => this.now;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.due.delete(handle as number);
  }

  get pendingCount(): number {
    return this.due.size;
  }

  /** Advance fake time, firing due timers in order (async continuations flushed). */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, t] of this.due) {
        if (t.at <= end && (t.at < nextAt || (t.at === nextAt && id < (nextId ?? Infinity)))) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.due.get(nextId);
      this.due.delete(nextId);
      this.now = Math.max(this.now, nextAt);
      timer?.fn();
      await flushMicrotasks();
    }
    this.now = end;
  }
}

// ---------------------------------------------------------------------------

describe('TimerBag', () => {
  it('fires a named one-shot once and self-clears', async () => {
    const time = new FakeTime();
    const bag = new TimerBag(time);
    let fired = 0;
    bag.set('a', 100, () => (fired += 1));
    expect(bag.has('a')).toBe(true);
    await time.advance(99);
    expect(fired).toBe(0);
    await time.advance(1);
    expect(fired).toBe(1);
    expect(bag.has('a')).toBe(false);
    await time.advance(1000);
    expect(fired).toBe(1);
  });

  it('re-arming a name replaces the pending timer', async () => {
    const time = new FakeTime();
    const bag = new TimerBag(time);
    const log: string[] = [];
    bag.set('a', 100, () => log.push('first'));
    await time.advance(50);
    bag.set('a', 100, () => log.push('second'));
    await time.advance(200);
    expect(log).toEqual(['second']);
  });

  it('clear cancels one name; clearAll cancels everything; names are independent', async () => {
    const time = new FakeTime();
    const bag = new TimerBag(time);
    const log: string[] = [];
    bag.set('a', 10, () => log.push('a'));
    bag.set('b', 20, () => log.push('b'));
    bag.clear('a');
    expect(bag.has('a')).toBe(false);
    expect(bag.has('b')).toBe(true);
    await time.advance(30);
    expect(log).toEqual(['b']);
    bag.set('c', 10, () => log.push('c'));
    bag.set('d', 10, () => log.push('d'));
    bag.clearAll();
    await time.advance(30);
    expect(log).toEqual(['b']);
    expect(time.pendingCount).toBe(0);
  });
});

describe('parseOverlayParams', () => {
  it('parses the full protocol', () => {
    expect(parseOverlayParams('?screenIndex=2&primary=0&bobIdleMs=1500')).toEqual({
      screenIndex: 2,
      primary: false,
      bobIdleMs: 1500,
    });
  });

  it('defaults: screen 0, primary true, no bob override', () => {
    expect(parseOverlayParams('')).toEqual({ screenIndex: 0, primary: true, bobIdleMs: null });
    expect(parseOverlayParams('?primary=1')).toEqual({
      screenIndex: 0,
      primary: true,
      bobIdleMs: null,
    });
  });

  it('rejects malformed values without throwing', () => {
    expect(parseOverlayParams('?screenIndex=abc').screenIndex).toBe(0);
    expect(parseOverlayParams('?bobIdleMs=abc').bobIdleMs).toBeNull();
    expect(parseOverlayParams('?bobIdleMs=0').bobIdleMs).toBeNull();
    expect(parseOverlayParams('?bobIdleMs=-5').bobIdleMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function captionHarness(): {
  time: FakeTime;
  ctrl: CaptionController;
  state: () => CaptionView | null;
} {
  const time = new FakeTime();
  let state: CaptionView | null = null;
  const ctrl = new CaptionController((update) => {
    state = typeof update === 'function' ? update(state) : update;
  }, new TimerBag(time));
  return { time, ctrl, state: () => state };
}

describe('CaptionController', () => {
  it('streams upserts and clears on an empty non-done update', () => {
    const h = captionHarness();
    h.ctrl.handleUpdate({ itemId: 'i1', text: 'hel', done: false });
    expect(h.state()).toEqual({ itemId: 'i1', text: 'hel', fading: false });
    h.ctrl.handleUpdate({ itemId: 'i1', text: 'hello', done: false });
    expect(h.state()?.text).toBe('hello');
    h.ctrl.handleUpdate({ itemId: 'i1', text: '', done: false });
    expect(h.state()).toBeNull();
  });

  it('done: lingers CAPTION_LINGER_MS, fades for CAPTION_FADE_MS, then drops', async () => {
    const h = captionHarness();
    h.ctrl.handleUpdate({ itemId: 'i1', text: 'all set', done: true });
    await h.time.advance(CAPTION_LINGER_MS - 1);
    expect(h.state()?.fading).toBe(false);
    await h.time.advance(1);
    expect(h.state()?.fading).toBe(true);
    await h.time.advance(CAPTION_FADE_MS - 1);
    expect(h.state()).not.toBeNull();
    await h.time.advance(1);
    expect(h.state()).toBeNull();
  });

  it('a new caption cancels the pending linger/fade of the previous one', async () => {
    const h = captionHarness();
    h.ctrl.handleUpdate({ itemId: 'i1', text: 'first', done: true });
    await h.time.advance(CAPTION_LINGER_MS - 100);
    h.ctrl.handleUpdate({ itemId: 'i2', text: 'second', done: false });
    await h.time.advance(CAPTION_LINGER_MS + CAPTION_FADE_MS);
    // Still showing: the new item never got a done, the old timers are dead.
    expect(h.state()).toEqual({ itemId: 'i2', text: 'second', fading: false });
  });

  it('flushForError fades whatever is showing, then drops it', async () => {
    const h = captionHarness();
    h.ctrl.handleUpdate({ itemId: 'i1', text: 'oops turn', done: true });
    h.ctrl.flushForError();
    expect(h.state()?.fading).toBe(true);
    await h.time.advance(CAPTION_FADE_MS);
    expect(h.state()).toBeNull();
    // No caption showing: stays null, no crash.
    h.ctrl.flushForError();
    expect(h.state()).toBeNull();
  });
});

// ---------------------------------------------------------------------------

class FakeFlight implements FlightDriver {
  readonly calls: string[] = [];
  private readonly landings: Array<(done: boolean) => void> = [];

  jumpTo(pos: Vec): void {
    this.calls.push(`jump:${Math.round(pos.x)},${Math.round(pos.y)}`);
  }

  cancel(): void {
    this.calls.push('cancel');
  }

  flyTo(target: Vec): Promise<boolean> {
    this.calls.push(`fly:${Math.round(target.x)},${Math.round(target.y)}`);
    return new Promise((resolve) => this.landings.push(resolve));
  }

  /** Land the oldest in-progress flight and let continuations run. */
  async land(done = true): Promise<void> {
    this.landings.shift()?.(done);
    await flushMicrotasks();
  }
}

const REST: Vec = { x: 900, y: 500 };

function choreoHarness(initialVisible = true): {
  time: FakeTime;
  flight: FakeFlight;
  ctrl: PointerChoreographer;
  events: string[];
  pulses: () => PulseView[];
  applyState: (s: AssistantState) => void;
} {
  const time = new FakeTime();
  const flight = new FakeFlight();
  const events: string[] = [];
  let pulses: PulseView[] = [];
  const ctrl = new PointerChoreographer(
    {
      flight,
      timers: new TimerBag(time),
      restPos: () => ({ ...REST }),
      viewport: () => ({ width: 1000, height: 600 }),
      onVisible: (v) => events.push(`visible:${v}`),
      onMode: (m) => events.push(`mode:${m}`),
      setPulses: (p) => {
        pulses = p;
        events.push(`pulses:${p.length}`);
      },
      updatePlacement: (pos) => events.push(`place:${Math.round(pos.x)},${Math.round(pos.y)}`),
    },
    initialVisible,
  );
  // Mirrors main.tsx's applyState pointer path (decide, then dispatch).
  const applyState = (s: AssistantState): void =>
    ctrl.applyReturnAction(ctrl.assistantStateChanged(s, false));
  return { time, flight, ctrl, events, pulses: () => pulses, applyState };
}

describe('PointerChoreographer', () => {
  it('flies to the tip-offset target, pulses on arrival, and dwells home 6s later', async () => {
    const h = choreoHarness();
    h.ctrl.runPoints([{ x: 100, y: 200, label: 'save button' }]);
    expect(h.events).toContain('mode:flying');
    expect(h.flight.calls).toEqual([
      `fly:${Math.round(100 + TIP_OFFSET.x)},${Math.round(200 + TIP_OFFSET.y)}`,
    ]);
    await h.flight.land();
    expect(h.ctrl.mode).toBe('pointing');
    expect(h.pulses()).toEqual([
      { id: 1, x: 100, y: 200, side: 'right', vside: 'below', label: 'save button' },
    ]);
    // Turn already settled (boot state idle): the home dwell is armed.
    await h.time.advance(HOME_AFTER_MS - 1);
    expect(h.flight.calls).toHaveLength(1);
    await h.time.advance(1);
    expect(h.flight.calls[1]).toBe(`fly:${REST.x},${REST.y}`);
    expect(h.pulses()).toEqual([]);
    await h.flight.land();
    expect(h.ctrl.mode).toBe('rest');
  });

  it('chips flip near the right/bottom edges', async () => {
    const h = choreoHarness();
    h.ctrl.runPoints([{ x: 800, y: 560 }]); // 1000-260 < 800, 600-60 < 560
    await h.flight.land();
    expect(h.pulses()[0]).toMatchObject({ side: 'left', vside: 'above' });
  });

  it('dwells POINT_DWELL_MS between points of a multi-point command', async () => {
    const h = choreoHarness();
    h.ctrl.runPoints([
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ]);
    await h.flight.land();
    expect(h.flight.calls).toHaveLength(1);
    await h.time.advance(POINT_DWELL_MS - 1);
    expect(h.flight.calls).toHaveLength(1);
    await h.time.advance(1);
    expect(h.flight.calls).toHaveLength(2);
  });

  it('a superseding command silently cancels the point sequence in flight', async () => {
    const h = choreoHarness();
    h.ctrl.runPoints([
      { x: 100, y: 200 },
      { x: 300, y: 400 },
    ]);
    await h.flight.land();
    h.ctrl.runPoints([{ x: 50, y: 60 }]); // mid-dwell supersede
    await h.flight.land();
    await h.time.advance(POINT_DWELL_MS + HOME_AFTER_MS + 1000);
    const flights = h.flight.calls.filter((c) => c.startsWith('fly:'));
    // p2 of the first command never flew; the second command went home once.
    expect(flights).toEqual([
      `fly:${Math.round(100 + TIP_OFFSET.x)},${Math.round(200 + TIP_OFFSET.y)}`,
      `fly:${Math.round(50 + TIP_OFFSET.x)},${Math.round(60 + TIP_OFFSET.y)}`,
      `fly:${REST.x},${REST.y}`,
    ]);
  });

  it('hide fades out, cancels flights, and resets mode', () => {
    const h = choreoHarness();
    h.ctrl.runPoints([{ x: 100, y: 200 }]);
    h.ctrl.hide();
    expect(h.ctrl.isVisible).toBe(false);
    expect(h.ctrl.mode).toBe('rest');
    expect(h.flight.calls).toContain('cancel');
    expect(h.pulses()).toEqual([]);
    expect(h.events).toContain('visible:false');
  });

  it('a hidden overlay rises from the rest corner when first addressed', () => {
    const h = choreoHarness(false);
    h.ctrl.runPoints([{ x: 100, y: 200 }]);
    expect(h.flight.calls[0]).toBe(`jump:${REST.x},${REST.y}`);
    expect(h.events).toContain('visible:true');
  });

  it('waits for BOTH the final landing and turn settle before the home dwell', async () => {
    const h = choreoHarness();
    h.applyState('speaking'); // turn active
    h.ctrl.runPoints([{ x: 100, y: 200 }]);
    await h.flight.land();
    // Landed, but the turn has not settled: the 6s timer must not go home.
    await h.time.advance(HOME_AFTER_MS + 1000);
    expect(h.flight.calls).toHaveLength(1);
    // idle arrives -> a FRESH six-second dwell starts now.
    h.applyState('idle');
    await h.time.advance(HOME_AFTER_MS - 1);
    expect(h.flight.calls).toHaveLength(1);
    await h.time.advance(1);
    expect(h.flight.calls[1]).toBe(`fly:${REST.x},${REST.y}`);
  });
});

// ---------------------------------------------------------------------------

const NOW0 = 10_000_000;

function agent(over: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'agent_1_1',
    task: 'find the best 27 inch monitor under $400',
    status: 'running',
    createdAt: NOW0 - 30_000,
    steps: [],
    spoken: false,
    unseen: false,
    ...over,
  };
}

function helperHarness(anchor: Vec = { x: 900, y: 500 }): {
  time: FakeTime;
  ctrl: HelperHoverController;
  out: {
    view: HelperView;
    cluster: ClusterGeom | null;
    hover: string | null;
    aux: AuxHoverGeometry | null;
  };
  setCursor: (c: Vec | null) => void;
  setEligible: (e: boolean) => void;
  setCardRect: (r: Rect | null) => void;
} {
  const time = new FakeTime();
  time.now = NOW0;
  const out: {
    view: HelperView;
    cluster: ClusterGeom | null;
    hover: string | null;
    aux: AuxHoverGeometry | null;
  } = { view: { shown: [], overflow: [] }, cluster: null, hover: null, aux: null };
  let cursor: Vec | null = null;
  let eligible = true;
  let cardRect: Rect | null = null;
  const ctrl = new HelperHoverController({
    clock: time.clock,
    timers: new TimerBag(time),
    anchor: () => anchor,
    cursor: () => cursor,
    hoverEligible: () => eligible,
    cardRect: () => cardRect,
    applyAux: (aux) => (out.aux = aux),
    onView: (v) => (out.view = v),
    onCluster: (c) => (out.cluster = c),
    onHover: (k) => (out.hover = k),
    onNow: () => {},
  });
  return {
    time,
    ctrl,
    out,
    setCursor: (c) => (cursor = c),
    setEligible: (e) => (eligible = e),
    setCardRect: (r) => (cardRect = r),
  };
}

describe('HelperHoverController', () => {
  // Bottom-right anchor: arc sweeps up-left, first slot straight up.
  const SPRITE: Vec = { x: 900, y: 500 - HELPER_ARC_RADIUS };

  it('derives the cluster + aux geometry from the agent list', () => {
    const h = helperHarness();
    h.ctrl.setAgents([agent({ id: 'a' })]);
    expect(h.out.cluster).toEqual({ anchor: { x: 900, y: 500 }, dir: -1, vdir: -1 });
    expect(h.out.view.shown.map((a) => a.id)).toEqual(['a']);
    expect(h.out.aux).toEqual({ targets: [SPRITE], targetRadius: 18, rect: null });
  });

  it('shows the card after the show-grace and hides after the hide-grace', async () => {
    const h = helperHarness();
    h.ctrl.setAgents([agent({ id: 'a' })]);
    h.setCursor(SPRITE);
    h.ctrl.updateFromCursor();
    expect(h.out.hover).toBeNull(); // anti-flicker: not yet
    await h.time.advance(CARD_SHOW_DELAY_MS - 1);
    expect(h.out.hover).toBeNull();
    await h.time.advance(1);
    expect(h.out.hover).toBe('a');
    // Cursor leaves: grace period to travel into the card, then hide.
    h.setCursor({ x: 700, y: 100 });
    h.ctrl.updateFromCursor();
    expect(h.out.hover).toBe('a');
    await h.time.advance(CARD_HIDE_DELAY_MS - 1);
    expect(h.out.hover).toBe('a');
    await h.time.advance(1);
    expect(h.out.hover).toBeNull();
  });

  it('a quick pass over a sprite never opens the card', async () => {
    const h = helperHarness();
    h.ctrl.setAgents([agent({ id: 'a' })]);
    h.setCursor(SPRITE);
    h.ctrl.updateFromCursor();
    h.setCursor({ x: 700, y: 100 });
    h.ctrl.updateFromCursor(); // left before the show-grace elapsed
    await h.time.advance(CARD_SHOW_DELAY_MS + CARD_HIDE_DELAY_MS + 50);
    expect(h.out.hover).toBeNull();
  });

  it('keeps the card open while the cursor sits inside it, and syncs its rect', async () => {
    const h = helperHarness();
    h.ctrl.setAgents([agent({ id: 'a' })]);
    h.setCursor(SPRITE);
    h.ctrl.updateFromCursor();
    await h.time.advance(CARD_SHOW_DELAY_MS);
    // main.tsx measures the card after render and re-syncs the aux geometry.
    const card: Rect = { x: 582, y: 380, width: 248, height: 120 };
    h.setCardRect(card);
    h.ctrl.syncAux();
    expect(h.out.aux?.rect).toEqual(card);
    // On the card (not the sprite): hover holds with no pending timers.
    h.setCursor({ x: 600, y: 400 });
    h.ctrl.updateFromCursor();
    await h.time.advance(CARD_HIDE_DELAY_MS + 1000);
    expect(h.out.hover).toBe('a');
  });

  it('switches directly between helper sprites with no grace delay', async () => {
    const h = helperHarness();
    h.ctrl.setAgents([agent({ id: 'a' }), agent({ id: 'b', createdAt: NOW0 - 10_000 })]);
    const targets = h.out.aux?.targets ?? [];
    expect(targets).toHaveLength(2);
    h.setCursor(targets[0] ?? null);
    h.ctrl.updateFromCursor();
    await h.time.advance(CARD_SHOW_DELAY_MS);
    expect(h.out.hover).toBe('a');
    h.setCursor(targets[1] ?? null);
    h.ctrl.updateFromCursor();
    expect(h.out.hover).toBe('b'); // instant
  });

  it('ineligible hovering (machine disabled, not interactive) selects nothing', async () => {
    const h = helperHarness();
    h.ctrl.setAgents([agent({ id: 'a' })]);
    h.setEligible(false);
    h.setCursor(SPRITE);
    h.ctrl.updateFromCursor();
    await h.time.advance(CARD_SHOW_DELAY_MS + 50);
    expect(h.out.hover).toBeNull();
  });

  it('release() drops an overdue hovered helper and sweeps it away shortly after', async () => {
    const h = helperHarness();
    const done = agent({ id: 'd', status: 'done', unseen: true, finishedAt: NOW0 - 1_000 });
    h.ctrl.setAgents([done]);
    h.setCursor(SPRITE);
    h.ctrl.updateFromCursor();
    await h.time.advance(CARD_SHOW_DELAY_MS);
    expect(h.out.hover).toBe('d');
    // Hovered helpers are exempt from the linger clock: it stays past expiry.
    await h.time.advance(FINISHED_LINGER_MS * 2);
    expect(h.out.view.shown.map((a) => a.id)).toEqual(['d']);
    // Hover interaction disabled -> the card must not linger; the re-sweep
    // retires the (now overdue) helper.
    h.setCursor(null);
    h.ctrl.release();
    expect(h.out.hover).toBeNull();
    await h.time.advance(500);
    expect(h.out.view.shown).toEqual([]);
    expect(h.out.cluster).toBeNull();
    expect(h.out.aux).toBeNull();
  });

  it('a pinned (expanded) helper is exempt from the linger clock until unpinned', async () => {
    const h = helperHarness();
    const done = agent({ id: 'd', status: 'done', unseen: true, finishedAt: NOW0 - 1_000 });
    h.ctrl.setAgents([done]);
    // Pinned via the expanded card (hover may sit on the overflow pebble or
    // elsewhere) — the helper must survive well past its linger window.
    h.ctrl.setPinned('d');
    await h.time.advance(FINISHED_LINGER_MS * 2);
    expect(h.out.view.shown.map((a) => a.id)).toEqual(['d']);
    // Unpinning retires the (long overdue) helper on the next recompute.
    h.ctrl.setPinned(null);
    expect(h.out.view.shown).toEqual([]);
    expect(h.out.cluster).toBeNull();
  });
});

// ---------------------------------------------------------------------------

function hoverHarness(): {
  time: FakeTime;
  ctrl: HoverDragController;
  sent: OverlayHoverEvent[];
  gate: HoverGateInput;
  runFrames: () => void;
  moves: Array<{ xFrac: number; yFrac: number }>;
  clicks: () => number;
  settingsClicks: () => number;
  buddy: () => Vec;
} {
  const time = new FakeTime();
  const sent: OverlayHoverEvent[] = [];
  const moves: Array<{ xFrac: number; yFrac: number }> = [];
  const gate: HoverGateInput = {
    visible: true,
    atRest: true,
    state: 'idle',
    fullRealtimeMode: false,
  };
  let buddy: Vec = { x: 500, y: 500 };
  let clicks = 0;
  let settingsClicks = 0;
  const frames: Array<() => void> = [];
  let frameSeq = 0;
  const ports: HoverDragPorts = {
    clock: time.clock,
    timers: new TimerBag(time),
    requestFrame: (cb) => {
      frames.push(cb);
      return ++frameSeq;
    },
    cancelFrame: () => {},
    flight: {
      jumpTo: (pos) => (buddy = pos),
      flyTo: (pos) => {
        buddy = pos;
        return Promise.resolve(true);
      },
    },
    buddyPos: () => buddy,
    viewport: () => ({ width: 1920, height: 1080 }),
    gateInput: () => gate,
    sendHover: (evt) => sent.push(evt),
    sendBuddyClick: () => (clicks += 1),
    sendBuddySettings: () => (settingsClicks += 1),
    sendBuddyMove: (rest) => moves.push(rest),
    bumpActivity: () => {},
    updatePlacement: () => {},
    setZone: () => {},
    setHintState: () => {},
    setDraggingState: () => {},
    setInteractiveState: () => {},
    setPupilTransform: () => {},
    helperHover: { updateFromCursor: () => {}, release: () => {} },
  };
  const ctrl = new HoverDragController(ports);
  return {
    time,
    ctrl,
    sent,
    gate,
    runFrames: () => {
      for (const cb of frames.splice(0)) cb();
    },
    moves,
    clicks: () => clicks,
    settingsClicks: () => settingsClicks,
    buddy: () => buddy,
  };
}

describe('HoverDragController (overlay:hover emission order)', () => {
  it('hover -> dwell -> hint -> synchronous exit, statuses on each transition', async () => {
    const h = hoverHarness();
    h.ctrl.onMouseMove(505, 503); // on the buddy: rAF-throttled observation
    h.runFrames();
    expect(h.sent.map((e) => e.kind)).toEqual(['status']);
    expect(h.sent[0]?.status?.zone).toBe('hover');
    // M20: the dwell deadline (150ms) now precedes the hint (250ms) — the
    // buddy must be clickable before a human can physically click.
    await h.time.advance(HOVER_DWELL_MS); // dwell deadline
    expect(h.sent.map((e) => e.kind)).toEqual(['status', 'dwell']);
    const region = h.sent[1]?.region;
    expect(region).toBeDefined();
    await h.time.advance(HINT_DELAY_MS - HOVER_DWELL_MS); // hint deadline
    expect(h.sent.map((e) => e.kind)).toEqual(['status', 'dwell', 'status']);
    expect(h.sent[2]?.status?.hint).toBe(true);
    // The very next move outside the region releases SYNCHRONOUSLY (no rAF),
    // then reports the zone and hint-off transitions.
    h.ctrl.onMouseMove(700, 500);
    expect(h.sent.map((e) => e.kind)).toEqual([
      'status',
      'dwell',
      'status',
      'exit',
      'status',
      'status',
    ]);
    expect(h.sent[4]?.status?.zone).toBe('aware');
    expect(h.sent[5]?.status?.hint).toBe(false);
  });

  it('far-away mousemoves are ignored entirely (budget gate)', () => {
    const h = hoverHarness();
    h.ctrl.onMouseMove(1500, 900);
    h.runFrames();
    expect(h.sent).toEqual([]);
  });

  it('a click without movement reports the buddy click; a drag persists the spot', async () => {
    const h = hoverHarness();
    h.ctrl.setInteractiveFromMain(true);
    // Click: down + up without crossing the drag threshold.
    expect(h.ctrl.onMouseDown(505, 503, 0)).toBe(true);
    h.ctrl.onMouseUp(0);
    expect(h.clicks()).toBe(1);
    expect(h.moves).toEqual([]);
    // Drag: down, move beyond the threshold, up -> snapped rest persisted.
    h.ctrl.setInteractiveFromMain(true);
    expect(h.ctrl.onMouseDown(505, 503, 0)).toBe(true);
    h.ctrl.onMouseMove(700, 900);
    expect(h.buddy()).toEqual({ x: 695, y: 897 }); // grab offset preserved
    h.ctrl.onMouseUp(0);
    expect(h.moves).toHaveLength(1);
    await flushMicrotasks();
    // Glided to the snapped spot (bottom edge is nearest from y=897 @1080).
    expect(h.buddy().y).toBe(1080 - 120);
  });

  it('mousedown outside the buddy footprint is not consumed', () => {
    const h = hoverHarness();
    h.ctrl.setInteractiveFromMain(true);
    expect(h.ctrl.onMouseDown(700, 700, 0)).toBe(false);
    expect(h.ctrl.onMouseDown(505, 503, 1)).toBe(false);
  });

  it('handles Buddy context menus only while its narrow region is interactive', () => {
    const h = hoverHarness();
    expect(h.ctrl.onContextMenu(505, 503)).toBe(false);
    h.ctrl.setInteractiveFromMain(true);
    expect(h.ctrl.onContextMenu(700, 700)).toBe(false);
    expect(h.ctrl.onContextMenu(505, 503)).toBe(true);
    // The full padded interactive region is actionable, not a swallowed ring.
    expect(h.ctrl.onContextMenu(530, 500)).toBe(true);
    expect(h.settingsClicks()).toBe(2);
  });

  it('does not arm a primary click for a macOS Control-click', () => {
    const h = hoverHarness();
    h.ctrl.setInteractiveFromMain(true);
    expect(h.ctrl.onMouseDown(505, 503, 0, true)).toBe(true);
    h.ctrl.onMouseUp(0);
    expect(h.clicks()).toBe(0);
    expect(h.ctrl.onContextMenu(505, 503)).toBe(true);
    expect(h.settingsClicks()).toBe(1);
  });

  it('disabling the gate releases interactive and drops helper hover', async () => {
    const h = hoverHarness();
    h.ctrl.onMouseMove(505, 503);
    h.runFrames();
    await h.time.advance(HOVER_DWELL_MS);
    expect(h.sent.map((e) => e.kind)).toContain('dwell');
    h.gate.state = 'listening'; // physical PTT hold
    const before = h.sent.length;
    h.ctrl.syncEnabled();
    // exit first (SAFETY-CRITICAL), then the zone status. (M20: the dwell
    // now precedes the hint, so at this point the hint never showed and
    // there is no hint-off status to report.)
    expect(h.sent.slice(before).map((e) => e.kind)).toEqual(['exit', 'status']);
  });
});
