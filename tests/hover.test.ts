/**
 * M15 buddy-hover unit tests: the dwell/region state machine and the
 * rest-position persistence math (src/renderer/overlay/hover.ts is pure —
 * no DOM, time injected).
 *
 * The safety-critical property under test: once interactive, ANY step that
 * puts the cursor outside the padded buddy region (or disables the machine)
 * emits releaseInteractive on that very call.
 */

import { describe, expect, it } from 'vitest';
import {
  AUX_PAD,
  AWARE_RADIUS,
  DWELL_MS,
  HINT_DELAY_MS,
  HOVER_RADIUS,
  HoverMachine,
  REGION_CAP,
  REGION_PAD,
  REST_MARGIN_X,
  REST_MARGIN_Y_BOTTOM,
  REST_MARGIN_Y_TOP,
  defaultRest,
  eyeOffset,
  hoverInteractionEnabled,
  hintText,
  insideAux,
  insideRect,
  mergedRegion,
  paddedRegion,
  restFromFrac,
  restToFrac,
  snapRest,
  zoneFor,
} from '../src/renderer/overlay/hover';
import type { AuxHoverGeometry, Vec } from '../src/renderer/overlay/hover';

const BUDDY: Vec = { x: 500, y: 500 };
const FAR: Vec = { x: 900, y: 900 };
const AWARE: Vec = { x: 500 + AWARE_RADIUS - 10, y: 500 };
const ON_BUDDY: Vec = { x: 505, y: 503 };

describe('zoneFor / eyeOffset / paddedRegion', () => {
  it('classifies zones by distance', () => {
    expect(zoneFor(FAR, BUDDY)).toBe('far');
    expect(zoneFor(AWARE, BUDDY)).toBe('aware');
    expect(zoneFor(ON_BUDDY, BUDDY)).toBe('hover');
    // Boundary: exactly the hover radius counts as hover.
    expect(zoneFor({ x: 500 + HOVER_RADIUS, y: 500 }, BUDDY)).toBe('hover');
    expect(zoneFor({ x: 500 + AWARE_RADIUS + 1, y: 500 }, BUDDY)).toBe('far');
  });

  it('eyeOffset points toward the cursor, capped, zero when far/null', () => {
    expect(eyeOffset(null, BUDDY)).toEqual({ x: 0, y: 0 });
    expect(eyeOffset(FAR, BUDDY)).toEqual({ x: 0, y: 0 });
    const right = eyeOffset({ x: 600, y: 500 }, BUDDY);
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBe(0);
    expect(Math.hypot(right.x, right.y)).toBeLessThanOrEqual(1.51);
    const up = eyeOffset({ x: 500, y: 400 }, BUDDY);
    expect(up.y).toBeLessThan(0);
    // Quantized to 0.25px steps.
    expect((right.x * 4) % 1).toBe(0);
  });

  it('paddedRegion is a square around the buddy, footprint + pad', () => {
    const r = paddedRegion(BUDDY);
    const half = HOVER_RADIUS + REGION_PAD;
    expect(r).toEqual({ x: 500 - half, y: 500 - half, width: half * 2, height: half * 2 });
    expect(insideRect(BUDDY, r)).toBe(true);
    expect(insideRect({ x: 500 + half + 1, y: 500 }, r)).toBe(false);
  });
});

describe('hoverInteractionEnabled', () => {
  it('blocks a physical push-to-talk hold', () => {
    expect(
      hoverInteractionEnabled({
        visible: true,
        atRest: true,
        state: 'listening',
        fullRealtimeMode: false,
      }),
    ).toBe(false);
  });

  it('allows hover during the persistent full-realtime listening state', () => {
    expect(
      hoverInteractionEnabled({
        visible: true,
        atRest: true,
        state: 'listening',
        fullRealtimeMode: true,
      }),
    ).toBe(true);
  });

  it('still blocks hidden or non-resting Buddy', () => {
    expect(
      hoverInteractionEnabled({
        visible: false,
        atRest: true,
        state: 'idle',
        fullRealtimeMode: false,
      }),
    ).toBe(false);
    expect(
      hoverInteractionEnabled({
        visible: true,
        atRest: false,
        state: 'idle',
        fullRealtimeMode: false,
      }),
    ).toBe(false);
  });
});

describe('rest position: snap + fraction persistence', () => {
  const VW = 1920;
  const VH = 1080;

  it('defaultRest matches the pre-M15 corner', () => {
    expect(defaultRest(VW, VH)).toEqual({ x: VW - 76, y: VH - 120 });
  });

  it('snaps to the nearest edge margin, other axis clamped', () => {
    // Near the left edge, mid-height: pin x to the left margin.
    expect(snapRest({ x: 100, y: 540 }, VW, VH)).toEqual({ x: REST_MARGIN_X, y: 540 });
    // Near the top: pin y to the top margin.
    expect(snapRest({ x: 960, y: 120 }, VW, VH)).toEqual({ x: 960, y: REST_MARGIN_Y_TOP });
    // Near the bottom: pin y to the bottom margin.
    expect(snapRest({ x: 960, y: VH - 130 }, VW, VH)).toEqual({
      x: 960,
      y: VH - REST_MARGIN_Y_BOTTOM,
    });
    // Middle of the screen still lands on SOME edge (never floats).
    const mid = snapRest({ x: 960, y: 500 }, VW, VH);
    const onEdge =
      mid.x === REST_MARGIN_X ||
      mid.x === VW - REST_MARGIN_X ||
      mid.y === REST_MARGIN_Y_TOP ||
      mid.y === VH - REST_MARGIN_Y_BOTTOM;
    expect(onEdge).toBe(true);
  });

  it('a corner drop yields the corner', () => {
    expect(snapRest({ x: 30, y: 40 }, VW, VH)).toEqual({
      x: REST_MARGIN_X,
      y: REST_MARGIN_Y_TOP,
    });
    expect(snapRest({ x: VW - 10, y: VH - 10 }, VW, VH)).toEqual({
      x: VW - REST_MARGIN_X,
      y: VH - REST_MARGIN_Y_BOTTOM,
    });
  });

  it('snapRest is idempotent (config echo after a drag must not move the buddy)', () => {
    for (const p of [
      { x: 100, y: 540 },
      { x: 960, y: 120 },
      { x: VW - 10, y: VH - 10 },
      { x: 960, y: 500 },
    ]) {
      const once = snapRest(p, VW, VH);
      expect(snapRest(once, VW, VH)).toEqual(once);
    }
  });

  it('degenerate viewports fall back to the default rest', () => {
    expect(snapRest({ x: 10, y: 10 }, 100, 100)).toEqual(defaultRest(100, 100));
  });

  it('fraction round-trip restores the same snapped position', () => {
    const snapped = snapRest({ x: 100, y: 540 }, VW, VH);
    const frac = restToFrac(snapped, VW, VH);
    expect(restFromFrac(frac, VW, VH)).toEqual(snapped);
  });

  it('restFromFrac(null) is the default corner; fractions re-snap on resize', () => {
    expect(restFromFrac(null, VW, VH)).toEqual(defaultRest(VW, VH));
    const frac = restToFrac(snapRest({ x: 100, y: 540 }, VW, VH), VW, VH);
    const restored = restFromFrac(frac, 1280, 720);
    // Still pinned to the left margin on the smaller display.
    expect(restored.x).toBe(REST_MARGIN_X);
    expect(restored.y).toBeGreaterThanOrEqual(REST_MARGIN_Y_TOP);
    expect(restored.y).toBeLessThanOrEqual(720 - REST_MARGIN_Y_BOTTOM);
  });
});

describe('hintText', () => {
  const base = {
    state: 'idle' as const,
    hotkeyLabel: 'Ctrl+Alt (left alt)',
    lastSpokeAt: null,
    now: 1_000_000,
    captionShowing: false,
    interactive: false,
  };

  it('idle default copy uses the lowercased hotkey label', () => {
    expect(hintText(base)).toEqual({ text: 'hold ctrl+alt (left alt) and talk to me' });
  });

  it('uses toggle copy in full realtime mode', () => {
    expect(hintText({ ...base, fullRealtimeMode: true })).toEqual({
      text: 'press ctrl+alt (left alt) to start realtime mode',
    });
  });

  it('recent-response variant inside 2 minutes, default after', () => {
    expect(hintText({ ...base, lastSpokeAt: base.now - 60_000 })?.text).toMatch(/^want more\?/);
    expect(hintText({ ...base, lastSpokeAt: base.now - 121_000 })?.text).toMatch(/^hold /);
  });

  it('suppressed while listening/thinking/speaking/error and under captions', () => {
    for (const state of ['listening', 'thinking', 'speaking', 'error'] as const) {
      expect(hintText({ ...base, state })).toBeNull();
    }
    expect(hintText({ ...base, captionShowing: true })).toBeNull();
  });

  it('appends the muted panel line once the dwell flip is armed', () => {
    expect(hintText({ ...base, interactive: true })?.sub).toBe('click me to open the panel');
  });
});

describe('HoverMachine: hint + dwell timing', () => {
  it('shows the hint after HINT_DELAY_MS and dwell-arms after DWELL_MS', () => {
    const m = new HoverMachine();
    let t = 1000;
    let fx = m.update(ON_BUDDY, BUDDY, t);
    expect(fx.zone).toBe('hover');
    expect(fx.hintVisible).toBe(false);
    expect(fx.requestInteractive).toBe(false);
    expect(fx.nextDeadline).toBe(t + HINT_DELAY_MS);

    t += HINT_DELAY_MS;
    fx = m.tick(BUDDY, t);
    expect(fx.hintVisible).toBe(true);
    expect(fx.requestInteractive).toBe(false);
    expect(fx.nextDeadline).toBe(1000 + DWELL_MS);

    t = 1000 + DWELL_MS;
    fx = m.tick(BUDDY, t);
    expect(fx.requestInteractive).toBe(true);
    expect(m.isInteractive).toBe(true);
    expect(fx.nextDeadline).toBeNull();
  });

  it('leaving the footprint before the deadlines resets the countdown', () => {
    const m = new HoverMachine();
    m.update(ON_BUDDY, BUDDY, 1000);
    let fx = m.update(AWARE, BUDDY, 1100); // left before hint
    expect(fx.zone).toBe('aware');
    expect(fx.hintVisible).toBe(false);
    // Re-enter: the clock restarts.
    fx = m.update(ON_BUDDY, BUDDY, 1200);
    expect(fx.nextDeadline).toBe(1200 + HINT_DELAY_MS);
    fx = m.tick(BUDDY, 1200 + DWELL_MS - 1);
    expect(fx.requestInteractive).toBe(false);
  });

  it('no flicker: a quick pass through the footprint never shows the hint', () => {
    const m = new HoverMachine();
    m.update(ON_BUDDY, BUDDY, 1000);
    const fx = m.update(FAR, BUDDY, 1100);
    expect(fx.hintVisible).toBe(false);
    expect(fx.requestInteractive).toBe(false);
    expect(m.isInteractive).toBe(false);
  });
});

describe('HoverMachine: interactive release (SAFETY-CRITICAL)', () => {
  function arm(m: HoverMachine, t = 1000): number {
    m.update(ON_BUDDY, BUDDY, t);
    const fx = m.tick(BUDDY, t + DWELL_MS);
    expect(fx.requestInteractive).toBe(true);
    return t + DWELL_MS;
  }

  it('releases on the very step the cursor leaves the padded region', () => {
    const m = new HoverMachine();
    const t = arm(m);
    const half = HOVER_RADIUS + REGION_PAD;
    // Just inside the pad: stays interactive.
    let fx = m.update({ x: 500 + half - 1, y: 500 }, BUDDY, t + 50);
    expect(fx.releaseInteractive).toBe(false);
    expect(m.isInteractive).toBe(true);
    // One pixel outside: releases immediately.
    fx = m.update({ x: 500 + half + 1, y: 500 }, BUDDY, t + 66);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
    expect(fx.hintVisible).toBe(false);
  });

  it('releases when the cursor leaves the window (null)', () => {
    const m = new HoverMachine();
    const t = arm(m);
    const fx = m.update(null, BUDDY, t + 50);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
  });

  it('releases when disabled (flight starts / push-to-talk held)', () => {
    const m = new HoverMachine();
    const t = arm(m);
    const fx = m.setEnabled(false, t + 50);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
    // Disabled: hovering does nothing at all.
    const fx2 = m.update(ON_BUDDY, BUDDY, t + 100);
    expect(fx2.zone).toBe('far');
    expect(fx2.requestInteractive).toBe(false);
    expect(fx2.nextDeadline).toBeNull();
  });

  it('re-arms only after a fresh dwell', () => {
    const m = new HoverMachine();
    const t = arm(m);
    m.update(FAR, BUDDY, t + 50); // release
    let fx = m.update(ON_BUDDY, BUDDY, t + 100);
    expect(fx.requestInteractive).toBe(false);
    fx = m.tick(BUDDY, t + 100 + DWELL_MS);
    expect(fx.requestInteractive).toBe(true);
  });
});

describe('M19 aux geometry: insideAux / mergedRegion', () => {
  // A realistic helper layout around a buddy at (500, 500): arc up-left +
  // a card extending left.
  const AUX: AuxHoverGeometry = {
    targets: [
      { x: 500, y: 452 },
      { x: 470, y: 462 },
      { x: 456, y: 488 },
    ],
    targetRadius: 18,
    rect: { x: 500 - 70 - 248, y: 330, width: 248, height: 156 },
  };

  it('hits sprites within targetRadius and the padded card rect', () => {
    expect(insideAux({ x: 500, y: 452 }, AUX)).toBe(true);
    expect(insideAux({ x: 500, y: 452 - 18 }, AUX)).toBe(true);
    expect(insideAux({ x: 500, y: 452 - 40 }, AUX)).toBe(false);
    // Inside the card, and within its AUX_PAD ring.
    expect(insideAux({ x: 300, y: 400 }, AUX)).toBe(true);
    expect(insideAux({ x: 182 - AUX_PAD + 1, y: 400 }, AUX)).toBe(true);
    expect(insideAux({ x: 182 - AUX_PAD - 2, y: 400 }, AUX)).toBe(false);
    expect(insideAux({ x: 300, y: 400 }, null)).toBe(false);
  });

  it('mergedRegion covers the buddy footprint, sprites and card — under the cap', () => {
    const r = mergedRegion(BUDDY, AUX);
    expect(insideRect(BUDDY, r)).toBe(true);
    for (const t of AUX.targets) expect(insideRect(t, r)).toBe(true);
    expect(insideRect({ x: 182, y: 330 }, r)).toBe(true); // card top-left
    // Must satisfy main's isFiniteRect cap (windows/overlay.ts): <= 400.
    expect(r.width).toBeLessThanOrEqual(REGION_CAP);
    expect(r.height).toBeLessThanOrEqual(REGION_CAP);
    // No aux -> plain padded region.
    expect(mergedRegion(BUDDY, null)).toEqual(paddedRegion(BUDDY));
  });

  it('an oversized union is clamped by trimming the side away from the buddy', () => {
    const wide = mergedRegion(BUDDY, {
      targets: [],
      targetRadius: 18,
      rect: { x: 0, y: 480, width: 460, height: 40 },
    });
    expect(wide.width).toBeLessThanOrEqual(REGION_CAP);
    const base = paddedRegion(BUDDY);
    expect(insideRect({ x: base.x, y: 500 }, wide)).toBe(true);
    expect(insideRect({ x: base.x + base.width, y: 500 }, wide)).toBe(true);
  });
});

describe('M19 HoverMachine: aux hover (helper sprites + card)', () => {
  const SPRITE: Vec = { x: 500, y: 452 }; // outside the buddy footprint
  const AUX: AuxHoverGeometry = { targets: [SPRITE], targetRadius: 18, rect: null };

  it('a sprite counts as the hover zone and dwell-arms with the merged region', () => {
    const m = new HoverMachine();
    m.setAux(AUX, 900);
    let fx = m.update(SPRITE, BUDDY, 1000);
    expect(fx.zone).toBe('hover'); // zoneFor alone would say 'aware'
    fx = m.tick(BUDDY, 1000 + DWELL_MS);
    expect(fx.requestInteractive).toBe(true);
    expect(insideRect(SPRITE, fx.region)).toBe(true);
    expect(insideRect(BUDDY, fx.region)).toBe(true);
  });

  it('releases the instant the cursor leaves the merged region (safety)', () => {
    const m = new HoverMachine();
    m.setAux(AUX, 900);
    m.update(SPRITE, BUDDY, 1000);
    m.tick(BUDDY, 1000 + DWELL_MS);
    expect(m.isInteractive).toBe(true);
    const fx = m.update({ x: 500, y: 452 - 60 }, BUDDY, 1000 + DWELL_MS + 16);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
  });

  it('an aux change while interactive emits ONE region refresh', () => {
    const m = new HoverMachine();
    m.setAux(AUX, 900);
    m.update(SPRITE, BUDDY, 1000);
    m.tick(BUDDY, 1000 + DWELL_MS);
    // Card opened: region must refresh so main's exit poll covers it.
    const card = { x: 200, y: 330, width: 248, height: 150 };
    let fx = m.setAux({ ...AUX, rect: card }, 1000 + DWELL_MS + 20);
    expect(fx.requestInteractive).toBe(true);
    expect(insideRect({ x: 210, y: 340 }, fx.region)).toBe(true);
    // Next plain step: no further refresh spam.
    fx = m.update(SPRITE, BUDDY, 1000 + DWELL_MS + 40);
    expect(fx.requestInteractive).toBe(false);
    expect(fx.releaseInteractive).toBe(false);
  });

  it('shrinking aux away from under the cursor releases on that call', () => {
    const m = new HoverMachine();
    m.setAux(AUX, 900);
    m.update(SPRITE, BUDDY, 1000);
    m.tick(BUDDY, 1000 + DWELL_MS);
    expect(m.isInteractive).toBe(true);
    // All helpers vanished (results seen) while the cursor sat on a sprite.
    const fx = m.setAux(null, 1000 + DWELL_MS + 20);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
  });

  it('suppresses the hint while hovering an agent helper', () => {
    expect(
      hintText({
        state: 'idle',
        hotkeyLabel: 'Ctrl+Alt (left alt)',
        lastSpokeAt: null,
        now: 1_000_000,
        captionShowing: false,
        interactive: false,
        agentHover: true,
      }),
    ).toBeNull();
  });
});

describe('HoverMachine: dragging', () => {
  function armAndDrag(m: HoverMachine): number {
    m.update(ON_BUDDY, BUDDY, 1000);
    m.tick(BUDDY, 1000 + DWELL_MS);
    m.setDragging(true, 1000 + DWELL_MS + 10);
    return 1000 + DWELL_MS + 10;
  }

  it('suppresses region-exit while dragging and refreshes the region', () => {
    const m = new HoverMachine();
    const t = armAndDrag(m);
    // Cursor (and buddy) far from the original region: NO release mid-drag,
    // and the refreshed region follows the buddy.
    const newBuddy = { x: 900, y: 300 };
    const fx = m.update({ x: 901, y: 301 }, newBuddy, t + 100);
    expect(fx.releaseInteractive).toBe(false);
    expect(m.isInteractive).toBe(true);
    expect(fx.requestInteractive).toBe(true); // keepalive region refresh
    expect(insideRect(newBuddy, fx.region)).toBe(true);
  });

  it('drag end restores normal exit behavior', () => {
    const m = new HoverMachine();
    const t = armAndDrag(m);
    m.update({ x: 900, y: 300 }, { x: 900, y: 300 }, t + 100);
    m.setDragging(false, t + 200);
    // Buddy snapped elsewhere, cursor stayed: next step releases.
    const fx = m.tick({ x: 76, y: 300 }, t + 300);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
  });

  it('disabling mid-drag force-releases (safety beats drag continuity)', () => {
    const m = new HoverMachine();
    const t = armAndDrag(m);
    const fx = m.setEnabled(false, t + 100);
    expect(fx.releaseInteractive).toBe(true);
    expect(m.isInteractive).toBe(false);
    expect(m.isDragging).toBe(false);
  });
});
