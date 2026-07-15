/**
 * Overlay renderer: the buddy (friendly blue triangle with eyes), quadratic-
 * bezier pointer flights, arrival pulse + label chips, streamed caption
 * bubble, capture privacy signposts, and assistant-state visuals.
 *
 * Architecture: React renders the (mostly static) DOM tree and state-driven
 * classes; the 60fps flight animation writes transforms imperatively through
 * FlightController so nothing re-renders per frame. rAF runs ONLY during a
 * flight — at rest all motion is cheap compositor-only CSS.
 */

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clicky } from './clicky';
import { FlightController, REST_ROT, SETTLE_ROT } from './flight';
import type { Vec } from './flight';
import { PointerReturnLifecycle } from './pointer-lifecycle';
import type { BuddyMode } from './pointer-lifecycle';
import {
  AUX_PAD,
  AWARE_RADIUS,
  DRAG_THRESHOLD,
  HOVER_RADIUS,
  HoverMachine,
  REGION_PAD,
  dist,
  eyeOffset,
  hoverInteractionEnabled,
  hintText,
  insideRect,
  restFromFrac,
  restToFrac,
  snapRest,
} from './hover';
import type { HoverEffects, HoverZone } from './hover';
import { AgentCluster } from './AgentHelpers';
import { BuddyIsland } from './BuddyIsland';
import {
  CARD_HIDE_DELAY_MS,
  CARD_SHOW_DELAY_MS,
  HELPER_HIT_RADIUS,
  OVERFLOW_KEY,
  helperSlots,
  nextHelperTransition,
  selectHelpers,
} from './agents-ui';
import type { HelperView } from './agents-ui';
import type {
  AgentSummary,
  AssistantState,
  OverlayHoverConfig,
  OverlayDisplaySurface,
  PointerPoint,
  Rect,
} from '../../shared/types';
import './overlay.css';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Dwell at each point of a multi-point command. */
const DWELL_MS = 1200;
/** Keep the final point visible this long after the current turn settles. */
const HOME_AFTER_MS = 6000;
/** Caption bubble lingers this long after done:true, then fades. */
const CAPTION_LINGER_MS = 4000;
/** Caption fade-out transition time (matches overlay.css). */
const CAPTION_FADE_MS = 500;
/** Error flash duration (shake + red), then back to the idle look. */
const ERROR_FLASH_MS = 650;
/**
 * Battery saver: after this long fully idle (state 'idle' and no pointer/
 * caption/state activity) the rest bob animation pauses — the buddy stays
 * visible, it just holds still. Any activity resumes it. The main process can
 * shrink this via the CLICKY_BOB_IDLE_MS env (test hook; forwarded as the
 * ?bobIdleMs query param).
 */
const BOB_IDLE_PAUSE_MS = (() => {
  const q = Number(new URLSearchParams(window.location.search).get('bobIdleMs'));
  return Number.isFinite(q) && q > 0 ? q : 5 * 60_000;
})();

/**
 * When settled at SETTLE_ROT (tip up-left, like a cursor) the triangle's tip
 * sits at center + (-8.4, -10.7); offset the flight target so the TIP kisses
 * the exact point while the body sits just below-right of it.
 */
const TIP_OFFSET: Vec = { x: 8.4, y: 10.7 };

/** M15: hint bubble fade-out duration (matches overlay.css .hint-bubble). */
const HINT_FADE_MS = 300;
/** M15: min interval between drag-time region refresh IPC sends. */
const DRAG_REGION_SEND_MS = 50;

/** Was this overlay created on the primary display? (set by main via query) */
function isPrimaryOverlay(): boolean {
  return new URLSearchParams(window.location.search).get('primary') !== '0';
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

interface CaptionView {
  itemId: string;
  text: string;
  fading: boolean;
}

interface PulseView {
  id: number;
  x: number;
  y: number;
  label?: string;
  side: 'left' | 'right';
  /** Chip flips above the point near the bottom screen edge (mirror of side). */
  vside: 'above' | 'below';
}

interface Placement {
  h: 'left' | 'right';
  v: 'above' | 'below';
}

// ---------------------------------------------------------------------------

function BuddySvg({
  pupilsRef,
}: {
  /** M15: imperative handle for cursor-tracking pupil offsets (transform-only). */
  pupilsRef: React.RefObject<SVGGElement | null>;
}): React.JSX.Element {
  return (
    <svg className="buddy-svg" width={34} height={34} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="buddy-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7cc4ff" />
          <stop offset="1" stopColor="#2b6ef2" />
        </linearGradient>
      </defs>
      {/* fat round-joined stroke = rounded corners on the triangle */}
      <path
        className="buddy-body"
        d="M20 7 L34 32.5 L6 32.5 Z"
        fill="url(#buddy-grad)"
        stroke="url(#buddy-grad)"
        strokeWidth={7}
        strokeLinejoin="round"
      />
      <g className="buddy-eyes">
        <circle cx={14.8} cy={24.5} r={3.1} fill="#ffffff" />
        <circle cx={25.2} cy={24.5} r={3.1} fill="#ffffff" />
        <g className="buddy-pupils" ref={pupilsRef}>
          <circle cx={15.5} cy={25.1} r={1.55} fill="#173a63" />
          <circle cx={25.9} cy={25.1} r={1.55} fill="#173a63" />
        </g>
      </g>
      <g className="buddy-mouth" aria-hidden="true">
        <rect x={16.2} y={28.5} width={1.7} height={3.2} rx={0.85} />
        <rect x={19.15} y={27.8} width={1.7} height={4.6} rx={0.85} />
        <rect x={22.1} y={28.5} width={1.7} height={3.2} rx={0.85} />
      </g>
    </svg>
  );
}

function App(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const rotRef = useRef<HTMLDivElement>(null);
  // M15 hover refs/state.
  const pupilsRef = useRef<SVGGElement>(null);
  const cfgRef = useRef<OverlayHoverConfig | null>(null);
  const lastSpokeAtRef = useRef<number | null>(null);

  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [capturing, setCapturing] = useState(false);
  const [buddyVisible, setBuddyVisible] = useState(isPrimaryOverlay());
  const [mode, setMode] = useState<BuddyMode>('rest');
  const [errorFlash, setErrorFlash] = useState(false);
  const [blink, setBlink] = useState(false);
  const [caption, setCaption] = useState<CaptionView | null>(null);
  const [pulses, setPulses] = useState<PulseView[]>([]);
  const [placement, setPlacement] = useState<Placement>({ h: 'right', v: 'above' });
  const [bobPaused, setBobPaused] = useState(false);
  // M15 hover state.
  const [hoverZone, setHoverZone] = useState<HoverZone>('far');
  const [hintState, setHintState] = useState<'hidden' | 'shown' | 'fading'>('hidden');
  const [interactive, setInteractive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverCfg, setHoverCfg] = useState<OverlayHoverConfig | null>(null);
  // M19 agent-helper state.
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [displaySurface, setDisplaySurface] = useState<OverlayDisplaySurface>({
    kind: 'off',
    notchWidth: 0,
    notchHeight: 0,
    menuBarHeight: 0,
  });
  const [helperHover, setHelperHover] = useState<string | null>(null);
  const [cluster, setCluster] = useState<{ anchor: Vec; dir: 1 | -1; vdir: 1 | -1 } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Measured card bounds, window-local DIP (grows the interactive region). */
  const cardRectRef = useRef<Rect | null>(null);
  /** Bridge: lets the card-measure effect resync the hover machine's aux. */
  const auxResyncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    /**
     * M15: rest pose — the user-defined drag spot (from the hover config)
     * when this overlay hosts the buddy at rest, else the default corner
     * near the bottom-right, above the taskbar.
     */
    function restPos(): Vec {
      return restFromFrac(cfgRef.current?.rest ?? null, window.innerWidth, window.innerHeight);
    }

    // M15: live buddy center (window-local DIP), fed by the flight engine's
    // apply callback so the hover machine always has the current position.
    let buddyPos: Vec = { x: 0, y: 0 };

    // ------------------------------------------------------------- engine --
    const flight = new FlightController((pose) => {
      buddyPos = pose.pos;
      const root = rootRef.current;
      const rot = rotRef.current;
      if (root) root.style.transform = `translate3d(${pose.pos.x}px, ${pose.pos.y}px, 0)`;
      if (rot) rot.style.transform = `rotate(${pose.rot}deg)`;
    });

    let gen = 0;
    let pulseSeq = 0;
    let visible = isPrimaryOverlay();
    let currentState: AssistantState = 'idle';
    let currentMode: BuddyMode = 'rest';
    const pointerReturn = new PointerReturnLifecycle();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let homeTimer: ReturnType<typeof setTimeout> | null = null;
    let captionTimer: ReturnType<typeof setTimeout> | null = null;
    let bobTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Battery saver: (re)arm the idle bob-pause timer. Called on every
     * pointer/caption/capture/state event; pauses the bob only if still fully
     * idle when the timer fires (state changes re-arm it, so a later return
     * to idle restarts the countdown).
     */
    const bumpActivity = (): void => {
      setBobPaused(false);
      if (bobTimer !== null) clearTimeout(bobTimer);
      bobTimer = setTimeout(() => {
        if (currentState === 'idle') setBobPaused(true);
      }, BOB_IDLE_PAUSE_MS);
    };

    const after = (ms: number, fn: () => void): void => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };
    const clearTimers = (): void => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    };
    const wait = (ms: number, myGen: number): Promise<boolean> =>
      new Promise((resolve) => after(ms, () => resolve(gen === myGen)));

    const setVisible = (v: boolean): void => {
      visible = v;
      setBuddyVisible(v);
      syncHoverEnabled(); // M15
    };
    const applyMode = (m: BuddyMode): void => {
      currentMode = m;
      pointerReturn.setMode(m);
      setMode(m);
      syncHoverEnabled(); // M15: hover must never fight the flight engine
    };
    const updatePlacement = (pos: Vec): void => {
      setPlacement({
        h: pos.x < 420 ? 'left' : 'right',
        v: pos.y < 180 ? 'below' : 'above',
      });
    };

    const spawnPulse = (p: PointerPoint): void => {
      pulseSeq += 1;
      setPulses([
        {
          id: pulseSeq,
          x: p.x,
          y: p.y,
          side: p.x > window.innerWidth - 260 ? 'left' : 'right',
          // Mirror of the horizontal flip: chips for points near the bottom
          // edge would clip off-screen, so flip them above the point.
          vside: p.y > window.innerHeight - 60 ? 'above' : 'below',
          ...(p.label !== undefined ? { label: p.label } : {}),
        },
      ]);
    };

    const scheduleHome = (myGen: number): void => {
      if (homeTimer !== null) clearTimeout(homeTimer);
      homeTimer = setTimeout(() => {
        homeTimer = null;
        if (gen !== myGen) return;
        if (pointerReturn.homeTimerFired(myGen) === 'home') void goHome(myGen);
      }, HOME_AFTER_MS);
    };

    async function goHome(expectedGen?: number): Promise<void> {
      let myGen: number;
      if (expectedGen === undefined) {
        gen += 1;
        myGen = gen;
        clearTimers();
      } else {
        myGen = expectedGen;
      }
      if (homeTimer !== null) {
        clearTimeout(homeTimer);
        homeTimer = null;
      }
      pointerReturn.homeStarted();
      setPulses([]);
      setVisible(true);
      applyMode('flying');
      const done = await flight.flyTo(restPos(), { settleRot: REST_ROT, duration: 650 });
      if (!done || gen !== myGen) return;
      applyMode('rest');
      updatePlacement(restPos());
    }

    async function runPoints(points: PointerPoint[]): Promise<void> {
      gen += 1;
      const myGen = gen;
      clearTimers();
      if (homeTimer !== null) {
        clearTimeout(homeTimer);
        homeTimer = null;
      }
      pointerReturn.beginPoints(myGen);
      if (!visible) {
        // Appearing on this display for the first time: rise from the rest corner.
        flight.jumpTo(restPos(), REST_ROT);
        setVisible(true);
      }
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        setPulses([]);
        applyMode('flying');
        const target = { x: p.x + TIP_OFFSET.x, y: p.y + TIP_OFFSET.y };
        const done = await flight.flyTo(target, { settleRot: SETTLE_ROT });
        if (!done || gen !== myGen) return;
        applyMode('pointing');
        updatePlacement(target);
        spawnPulse(p);
        if (i < points.length - 1) {
          const still = await wait(DWELL_MS, myGen);
          if (!still) return;
        }
      }
      // response.done can settle the turn while the final pointer flight is
      // still in progress. Start the dwell only once both signals have
      // arrived, so it is always six seconds rather than the response length.
      if (pointerReturn.pointsFinished(myGen) === 'schedule') scheduleHome(myGen);
    }

    const applyState = (s: AssistantState): void => {
      // M15: "recent response" hint variant — remember when speaking ended.
      if (currentState === 'speaking' && s !== 'speaking') {
        lastSpokeAtRef.current = Date.now();
      }
      currentState = s;
      const pointerAction = pointerReturn.assistantStateChanged(
        s,
        gen,
        cfgRef.current?.fullRealtimeMode ?? false,
      );
      setAssistantState(s);
      bumpActivity();
      syncHoverEnabled(); // M15: a physical PTT hold suppresses interaction
      if (s === 'error') {
        setErrorFlash(true);
        after(ERROR_FLASH_MS, () => setErrorFlash(false));
        // A failed/cancelled turn must not leave a stale caption on screen:
        // fade whatever is showing and drop it.
        if (captionTimer !== null) {
          clearTimeout(captionTimer);
          captionTimer = null;
        }
        setCaption((c) => (c && !c.fading ? { ...c, fading: true } : c));
        after(CAPTION_FADE_MS, () => setCaption(null));
      }
      if (pointerAction === 'home') void goHome(gen);
      else if (pointerAction === 'schedule') scheduleHome(gen);
    };

    // --------------------------------------------------------------- init --
    flight.jumpTo(restPos(), REST_ROT);
    updatePlacement(restPos());
    bumpActivity();
    void clicky.getAssistantState().then((s) => {
      currentState = s;
      pointerReturn.assistantStateChanged(s, gen, cfgRef.current?.fullRealtimeMode ?? false);
      setAssistantState(s);
    });

    const offPointer = clicky.onPointer((cmd) => {
      bumpActivity();
      if (cmd.type === 'animate') {
        if (cmd.points.length > 0) void runPoints(cmd.points);
      } else if (cmd.type === 'idle') {
        void goHome();
      } else {
        // hide: fade the buddy out entirely.
        gen += 1;
        clearTimers();
        if (homeTimer !== null) {
          clearTimeout(homeTimer);
          homeTimer = null;
        }
        flight.cancel();
        setPulses([]);
        setVisible(false);
        applyMode('rest');
      }
    });

    const offState = clicky.onAssistantState(applyState);

    const offCapture = clicky.onCaptureIndicator(({ active }) => {
      bumpActivity();
      setCapturing(active);
    });

    const offCaption = clicky.onCaption((update) => {
      bumpActivity();
      if (captionTimer !== null) {
        clearTimeout(captionTimer);
        captionTimer = null;
      }
      if (update.text.length === 0 && !update.done) {
        setCaption(null);
        return;
      }
      setCaption({ itemId: update.itemId, text: update.text, fading: false });
      if (update.done) {
        captionTimer = setTimeout(() => {
          setCaption((c) => (c && c.itemId === update.itemId ? { ...c, fading: true } : c));
          captionTimer = setTimeout(() => {
            setCaption((c) => (c && c.itemId === update.itemId ? null : c));
          }, CAPTION_FADE_MS);
        }, CAPTION_LINGER_MS);
      }
    });

    // Blink: instant class flip (~130ms closed) at a random 3.5–6.5s cadence.
    // JS-driven on purpose — see the .buddy-eyes comment in overlay.css.
    let blinkTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleBlink = (): void => {
      blinkTimer = setTimeout(() => {
        if (visible) {
          setBlink(true);
          setTimeout(() => setBlink(false), 130);
        }
        scheduleBlink();
      }, 3500 + Math.random() * 3000);
    };
    scheduleBlink();

    // =========================================================== M15 hover --
    // Mouse observation arrives only while main forwards mousemove to this
    // window (i.e. only while it hosts the buddy) or while it is interactive.
    // Budget: when the cursor is far from the buddy the per-event cost is one
    // squared-distance compare; processing is rAF-throttled otherwise.
    const hover = new HoverMachine();
    let hoverEnabled = true;
    let lastCursor: Vec | null = null;
    let hoverRaf = 0;
    let hoverDeadline: ReturnType<typeof setTimeout> | null = null;
    let hintFadeTimer: ReturnType<typeof setTimeout> | null = null;
    let interactiveNow = false; // as confirmed by main via overlay:interactive
    let drag: { grabDx: number; grabDy: number; sx: number; sy: number; moved: boolean } | null =
      null;
    let lastRegionSentAt = 0;
    let lastZone: HoverZone = 'far';
    let lastHintVisible = false;
    let lastEyeCss = '';
    const FAR_GATE_SQ = (AWARE_RADIUS + 40) ** 2;

    // ---------------------------------------------------- M19 agent helpers --
    let agentsNow: AgentSummary[] = [];
    let helperView: HelperView = { shown: [], overflow: [] };
    /** Absolute sprite/pebble centers (window-local DIP), parallel to keys. */
    let helperTargets: Vec[] = [];
    /** Agent id (or OVERFLOW_KEY) per slot. */
    let helperKeys: string[] = [];
    let hoveredHelper: string | null = null;
    let helperTimer: ReturnType<typeof setTimeout> | null = null;
    let helperPending: string | null = null;
    /** One-shot timer for the next celebrate->depart->gone phase boundary. */
    let helperSweepTimer: ReturnType<typeof setTimeout> | null = null;

    /** (Re)arm a recompute at the next finished-helper phase boundary. */
    function scheduleHelperSweep(delayOverrideMs?: number): void {
      if (helperSweepTimer !== null) {
        clearTimeout(helperSweepTimer);
        helperSweepTimer = null;
      }
      const now = Date.now();
      const next =
        delayOverrideMs !== undefined
          ? now + delayOverrideMs
          : nextHelperTransition(agentsNow, now, hoveredHelper ?? undefined);
      if (next === null) return;
      helperSweepTimer = setTimeout(
        () => {
          helperSweepTimer = null;
          recomputeHelpers();
        },
        Math.max(60, next - now + 30),
      );
    }

    /** Cluster anchor = the buddy REST spot; content extends toward the roomy
     *  side of the screen (same edge thresholds as updatePlacement). */
    function clusterGeom(): { anchor: Vec; dir: 1 | -1; vdir: 1 | -1 } {
      const anchor = restPos();
      return {
        anchor,
        dir: anchor.x < 420 ? 1 : -1,
        vdir: anchor.y < 180 ? 1 : -1,
      };
    }

    /** Push the current sprite/card geometry into the hover machine. */
    function syncAux(): void {
      const aux =
        helperTargets.length > 0
          ? {
              targets: helperTargets,
              targetRadius: HELPER_HIT_RADIUS,
              rect: hoveredHelper !== null ? cardRectRef.current : null,
            }
          : null;
      applyHoverEffects(hover.setAux(aux, Date.now()));
    }

    function commitHelperHover(key: string | null): void {
      if (helperTimer !== null) {
        clearTimeout(helperTimer);
        helperTimer = null;
      }
      helperPending = null;
      if (key === hoveredHelper) return;
      hoveredHelper = key;
      setHelperHover(key);
      syncAux();
      // A hover release may unfreeze an overdue departure (the hovered helper
      // is exempt from the linger clock) — sweep again shortly.
      if (key === null) scheduleHelperSweep(250);
      else scheduleHelperSweep();
    }

    /** Re-derive visible helpers + slot geometry (agents / anchor changed). */
    function recomputeHelpers(): void {
      const now = Date.now();
      setNowTick(now);
      helperView = selectHelpers(agentsNow, now, hoveredHelper ?? undefined);
      const count = helperView.shown.length + (helperView.overflow.length > 0 ? 1 : 0);
      if (count === 0) {
        helperTargets = [];
        helperKeys = [];
        setCluster(null);
        commitHelperHover(null);
        syncAux();
        scheduleHelperSweep();
        return;
      }
      const geom = clusterGeom();
      const slots = helperSlots(count, geom.dir, geom.vdir);
      helperKeys = [
        ...helperView.shown.map((a) => a.id),
        ...(helperView.overflow.length > 0 ? [OVERFLOW_KEY] : []),
      ];
      helperTargets = slots.map((s) => ({ x: geom.anchor.x + s.x, y: geom.anchor.y + s.y }));
      setCluster(geom);
      // A hovered helper that vanished entirely (seen / expired) drops its card.
      if (hoveredHelper !== null && !helperKeys.includes(hoveredHelper)) {
        const stillListed =
          hoveredHelper !== OVERFLOW_KEY &&
          [...helperView.shown, ...helperView.overflow].some((a) => a.id === hoveredHelper);
        if (!stillListed) commitHelperHover(null);
      }
      syncAux();
      updateHelperHover();
      scheduleHelperSweep();
    }

    /** Cursor -> hovered helper, with show/hide grace timers (anti-flicker +
     *  time to travel from a sprite into its card). */
    function updateHelperHover(): void {
      let want: string | null = null;
      if (lastCursor !== null && helperTargets.length > 0 && (hoverEnabled || interactiveNow)) {
        let bestD = Infinity;
        for (let i = 0; i < helperTargets.length; i++) {
          const t = helperTargets[i];
          if (!t) continue;
          const d = dist(lastCursor, t);
          if (d <= HELPER_HIT_RADIUS && d < bestD) {
            bestD = d;
            want = helperKeys[i] ?? null;
          }
        }
        // Not on a sprite, but still inside the open card: keep it open.
        if (want === null && hoveredHelper !== null && cardRectRef.current !== null) {
          const r = cardRectRef.current;
          const padded = {
            x: r.x - AUX_PAD,
            y: r.y - AUX_PAD,
            width: r.width + AUX_PAD * 2,
            height: r.height + AUX_PAD * 2,
          };
          if (insideRect(lastCursor, padded)) want = hoveredHelper;
        }
      }
      if (want === hoveredHelper) {
        if (helperTimer !== null) {
          clearTimeout(helperTimer);
          helperTimer = null;
          helperPending = null;
        }
        return;
      }
      // Switching directly between helpers: no delay.
      if (want !== null && hoveredHelper !== null) {
        commitHelperHover(want);
        return;
      }
      if (helperPending === want && helperTimer !== null) return;
      if (helperTimer !== null) clearTimeout(helperTimer);
      helperPending = want;
      helperTimer = setTimeout(
        () => {
          helperTimer = null;
          const key = helperPending;
          helperPending = null;
          commitHelperHover(key);
        },
        want === null ? CARD_HIDE_DELAY_MS : CARD_SHOW_DELAY_MS,
      );
    }
    // ------------------------------------------------ end M19 agent helpers --

    function sendStatus(): void {
      clicky.sendHover({
        kind: 'status',
        status: {
          zone: hover.currentZone,
          hint: hover.hintIsVisible,
          dragging: hover.isDragging,
          buddy: { x: buddyPos.x, y: buddyPos.y },
        },
      });
    }

    function applyHoverEffects(fx: HoverEffects): void {
      // Interactive flip requests (dwell) / SAFETY-CRITICAL releases (exit).
      if (fx.requestInteractive) {
        const now = Date.now();
        // During a drag these are throttled region-refresh keepalives.
        if (!hover.isDragging || now - lastRegionSentAt >= DRAG_REGION_SEND_MS) {
          lastRegionSentAt = now;
          clicky.sendHover({ kind: 'dwell', region: fx.region });
        }
      }
      if (fx.releaseInteractive) {
        clicky.sendHover({ kind: 'exit' });
      }

      // Zone visuals (perk-up / awareness) — only on transitions.
      if (fx.zone !== lastZone) {
        lastZone = fx.zone;
        setHoverZone(fx.zone);
        bumpActivity(); // hovering resumes the idle-bob battery saver
        sendStatus();
      }

      // Hint bubble show/fade edges.
      if (fx.hintVisible !== lastHintVisible) {
        lastHintVisible = fx.hintVisible;
        if (hintFadeTimer !== null) {
          clearTimeout(hintFadeTimer);
          hintFadeTimer = null;
        }
        if (fx.hintVisible) {
          setHintState('shown');
        } else {
          setHintState((s) => (s === 'shown' ? 'fading' : s));
          hintFadeTimer = setTimeout(() => setHintState('hidden'), HINT_FADE_MS);
        }
        sendStatus();
      }

      // Eye tracking: transform-only pupil offset, quantized in eyeOffset so
      // repeated mousemoves that don't visibly change the gaze are free.
      const offset = eyeOffset(fx.zone === 'far' ? null : lastCursor, buddyPos);
      const css = offset.x === 0 && offset.y === 0 ? '' : `translate(${offset.x}px, ${offset.y}px)`;
      if (css !== lastEyeCss) {
        lastEyeCss = css;
        const pupils = pupilsRef.current;
        if (pupils) pupils.style.transform = css;
      }

      // Pending hint/dwell deadlines -> timer tick (cursor may sit still).
      if (hoverDeadline !== null) {
        clearTimeout(hoverDeadline);
        hoverDeadline = null;
      }
      if (fx.nextDeadline !== null) {
        hoverDeadline = setTimeout(
          () => {
            hoverDeadline = null;
            applyHoverEffects(hover.tick(buddyPos, Date.now()));
          },
          Math.max(0, fx.nextDeadline - Date.now()),
        );
      }
    }

    function processHover(): void {
      applyHoverEffects(hover.update(lastCursor, buddyPos, Date.now()));
      updateHelperHover(); // M19: sprite/card hover rides the same cursor feed
    }

    function syncHoverEnabled(): void {
      const enabled = hoverInteractionEnabled({
        visible,
        atRest: currentMode === 'rest',
        state: currentState,
        fullRealtimeMode: cfgRef.current?.fullRealtimeMode ?? false,
      });
      if (enabled === hoverEnabled) return;
      hoverEnabled = enabled;
      if (!enabled && drag !== null) drag = null; // drop a drag mid-flight/PTT
      if (!enabled) commitHelperHover(null); // M19: card must not linger
      applyHoverEffects(hover.setEnabled(enabled, Date.now()));
    }

    function endDrag(): void {
      drag = null;
      setDragging(false);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const snapped = snapRest(buddyPos, vw, vh);
      // Persist FIRST (main updates settings + re-pushes hover config), then
      // glide to the snapped spot. setDragging(false) re-enables region-exit.
      clicky.sendBuddyMove(restToFrac(snapped, vw, vh));
      applyHoverEffects(hover.setDragging(false, Date.now()));
      void flight.flyTo(snapped, { settleRot: REST_ROT, duration: 260 }).then((done) => {
        if (!done) return;
        updatePlacement(snapped);
        // Re-evaluate now that the buddy settled: if the cursor stayed at the
        // release point (far from the snapped spot) this releases the
        // interactive flip immediately instead of leaving a stale region.
        applyHoverEffects(hover.tick(buddyPos, Date.now()));
      });
      sendStatus();
    }

    const onHoverMouseMove = (e: MouseEvent): void => {
      lastCursor = { x: e.clientX, y: e.clientY };
      if (!hoverEnabled && !interactiveNow) return;

      // Drag: move the buddy with the cursor (imperative, no re-render).
      if (drag !== null) {
        if (!drag.moved) {
          const moved =
            Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > DRAG_THRESHOLD;
          if (moved) {
            drag.moved = true;
            setDragging(true);
            applyHoverEffects(hover.setDragging(true, Date.now()));
            sendStatus();
          }
        }
        if (drag.moved) {
          flight.jumpTo(
            { x: e.clientX + drag.grabDx, y: e.clientY + drag.grabDy },
            REST_ROT,
          );
        }
        processHover();
        return;
      }

      // Interactive: run the exit check SYNCHRONOUSLY on every move — click-
      // through must be restored the instant the cursor leaves the region.
      if (interactiveNow || hover.isInteractive) {
        processHover();
        return;
      }

      // Passive observation: do nothing when far from the buddy (budget), and
      // rAF-throttle the rest.
      const dx = e.clientX - buddyPos.x;
      const dy = e.clientY - buddyPos.y;
      if (hover.currentZone === 'far' && dx * dx + dy * dy > FAR_GATE_SQ) return;
      if (hoverRaf === 0) {
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          processHover();
        });
      }
    };

    const onHoverMouseOut = (e: MouseEvent): void => {
      // relatedTarget null = the cursor left the window (display edge).
      if (e.relatedTarget === null) {
        lastCursor = null;
        processHover();
      }
    };

    const onHoverMouseDown = (e: MouseEvent): void => {
      if (!interactiveNow || e.button !== 0) return;
      const half = HOVER_RADIUS + REGION_PAD;
      if (Math.abs(e.clientX - buddyPos.x) > half || Math.abs(e.clientY - buddyPos.y) > half) {
        return;
      }
      drag = {
        grabDx: buddyPos.x - e.clientX,
        grabDy: buddyPos.y - e.clientY,
        sx: e.clientX,
        sy: e.clientY,
        moved: false,
      };
      e.preventDefault();
    };

    const onHoverMouseUp = (e: MouseEvent): void => {
      if (drag === null || e.button !== 0) return;
      const wasDrag = drag.moved;
      if (wasDrag) {
        endDrag();
      } else {
        drag = null;
        // CLICK on the buddy -> main toggles the control panel.
        clicky.sendBuddyClick();
        bumpActivity();
      }
    };

    const offInteractive = clicky.onInteractive(({ interactive: on }) => {
      interactiveNow = on;
      setInteractive(on);
      if (!on) {
        // Main force-restored click-through (exit event, safety poll, PTT,
        // pointer routing). Reconcile: abort any drag (persisting the spot)
        // and resync the machine if it still thinks it is interactive.
        if (drag !== null && drag.moved) {
          endDrag();
        } else {
          drag = null;
        }
        if (hover.isInteractive) {
          hover.setDragging(false, Date.now());
          applyHoverEffects(hover.update(null, buddyPos, Date.now()));
          lastCursor = null;
        }
      }
    });

    const applyHoverConfig = (cfg: OverlayHoverConfig): void => {
      const first = cfgRef.current === null;
      cfgRef.current = cfg;
      setHoverCfg(cfg);
      // The config can arrive after the initial assistant-state read. Re-run
      // the pointer rendezvous so a realtime `listening` state is not left
      // classified with push-to-talk semantics because of that startup race.
      const pointerAction = pointerReturn.assistantStateChanged(
        currentState,
        gen,
        cfg.fullRealtimeMode,
      );
      if (pointerAction === 'home') void goHome(gen);
      else if (pointerAction === 'schedule') scheduleHome(gen);
      syncHoverEnabled();
      recomputeHelpers(); // M19: the cluster is anchored at the rest spot
      if (currentMode !== 'rest' || hover.isDragging) return;
      const target = restPos();
      const cur = flight.currentPose.pos;
      if (Math.hypot(target.x - cur.x, target.y - cur.y) <= 2) return;
      if (!visible || first) {
        // Hidden overlays and the boot-time config just re-anchor silently.
        flight.jumpTo(target, REST_ROT);
        updatePlacement(target);
      } else {
        void goHome();
      }
      sendStatus(); // keep the debug/QA buddy position truthful post-anchor
    };
    const offHoverConfig = clicky.onHoverConfig(applyHoverConfig);
    // Belt-and-braces vs the did-finish-load push (subscription race).
    void clicky
      .getHoverConfig()
      .then((cfg) => {
        if (cfgRef.current === null) applyHoverConfig(cfg);
      })
      .catch(() => {});

    window.addEventListener('mousemove', onHoverMouseMove, { passive: true });
    window.addEventListener('mouseout', onHoverMouseOut, { passive: true });
    window.addEventListener('mousedown', onHoverMouseDown);
    window.addEventListener('mouseup', onHoverMouseUp);
    sendStatus(); // initial snapshot (buddy rest position) for debug/QA
    // ------------------------------------------------------- end M15 hover --

    // ------------------------------------------- M19 agent helpers wiring --
    const offAgents = clicky.onAgents((list) => {
      agentsNow = list;
      setAgents(list);
      recomputeHelpers();
    });
    // Bootstrap for late-created overlays (display hotplug) — push wins races.
    void clicky
      .getAgents()
      .then((list) => {
        if (agentsNow.length === 0 && list.length > 0) {
          agentsNow = list;
          setAgents(list);
          recomputeHelpers();
        }
      })
      .catch(() => {});
    const offDisplaySurface = clicky.onDisplaySurface(setDisplaySurface);
    void clicky.getDisplaySurface().then(setDisplaySurface).catch(() => {});
    auxResyncRef.current = syncAux;
    // --------------------------------------- end M19 agent helpers wiring --

    const onResize = (): void => {
      if (currentMode === 'rest') {
        flight.jumpTo(restPos(), REST_ROT);
        updatePlacement(restPos());
      }
      recomputeHelpers(); // M19: re-anchor the cluster
    };
    window.addEventListener('resize', onResize);

    return () => {
      offPointer();
      offState();
      offCapture();
      offCaption();
      // M15 hover teardown.
      offInteractive();
      offHoverConfig();
      window.removeEventListener('mousemove', onHoverMouseMove);
      window.removeEventListener('mouseout', onHoverMouseOut);
      window.removeEventListener('mousedown', onHoverMouseDown);
      window.removeEventListener('mouseup', onHoverMouseUp);
      if (hoverRaf !== 0) cancelAnimationFrame(hoverRaf);
      if (hoverDeadline !== null) clearTimeout(hoverDeadline);
      if (hintFadeTimer !== null) clearTimeout(hintFadeTimer);
      // M19 agent-helper teardown.
      offAgents();
      offDisplaySurface();
      if (helperSweepTimer !== null) clearTimeout(helperSweepTimer);
      if (helperTimer !== null) clearTimeout(helperTimer);
      auxResyncRef.current = null;
      window.removeEventListener('resize', onResize);
      clearTimers();
      if (homeTimer !== null) clearTimeout(homeTimer);
      if (captionTimer !== null) clearTimeout(captionTimer);
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      if (bobTimer !== null) clearTimeout(bobTimer);
      flight.cancel();
    };
  }, []);

  // M19: measure the open agent card so the hover machine's merged region
  // (and main's exit poll) covers it exactly. Runs after every render that
  // could move/resize the card.
  useEffect(() => {
    const el = cardRef.current;
    if (el) {
      const b = el.getBoundingClientRect();
      cardRectRef.current = { x: b.left, y: b.top, width: b.width, height: b.height };
    } else {
      cardRectRef.current = null;
    }
    auxResyncRef.current?.();
  }, [helperHover, agents, cluster]);

  // M19: tick the card's elapsed phrase while one is open.
  useEffect(() => {
    if (helperHover === null) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [helperHover]);

  // M15: state-aware hover hint copy (null = suppressed: non-idle states,
  // captions in progress — an error caption is never replaced).
  const hint =
    hintState !== 'hidden' && mode === 'rest'
      ? hintText({
          state: assistantState,
          hotkeyLabel: hoverCfg?.hotkeyLabel ?? 'Ctrl+Alt (left alt)',
          fullRealtimeMode: hoverCfg?.fullRealtimeMode ?? false,
          lastSpokeAt: lastSpokeAtRef.current,
          now: Date.now(),
          captionShowing: caption !== null,
          interactive,
          agentHover: helperHover !== null, // M19: the card IS the hint
        })
      : null;

  return (
    <>
      <div className="edge-pulse" data-active={capturing ? '' : undefined} />
      <BuddyIsland
        surface={displaySurface}
        assistantState={assistantState}
        capturing={capturing}
        agents={agents}
        visible={buddyVisible}
      />
      <div
        ref={rootRef}
        className="buddy-root"
        data-state={assistantState}
        data-mode={mode}
        data-visible={buddyVisible ? '' : undefined}
        data-flash={errorFlash ? '' : undefined}
        data-blink={blink ? '' : undefined}
        data-bob-paused={bobPaused ? '' : undefined}
        data-h={placement.h}
        data-v={placement.v}
        data-aware={hoverZone !== 'far' ? '' : undefined}
        data-hover={hoverZone === 'hover' ? '' : undefined}
        data-interactive={interactive ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
      >
        <div className="listen-ring r1" />
        <div className="listen-ring r2" />
        <div className="speech-rays left" aria-hidden="true">
          <span className="near" />
          <span className="far" />
        </div>
        <div className="speech-rays right" aria-hidden="true">
          <span className="near" />
          <span className="far" />
        </div>
        <div ref={rotRef} className="buddy-rot">
          <div className="buddy-fx">
            <div className="buddy-bob">
              <BuddySvg pupilsRef={pupilsRef} />
            </div>
          </div>
        </div>
        <div className="think-dots">
          <span />
          <span />
          <span />
        </div>
        {capturing && <div className="capture-pill">👀 screen captured</div>}
        {caption && (
          <div
            key={caption.itemId}
            className="caption-bubble"
            data-fading={caption.fading ? '' : undefined}
          >
            {caption.text}
          </div>
        )}
        {hint && (
          <div className="hint-bubble" data-fading={hintState === 'fading' ? '' : undefined}>
            <div>{hint.text}</div>
            {hint.sub !== undefined && <div className="hint-sub">{hint.sub}</div>}
          </div>
        )}
      </div>
      {cluster !== null && (
        <AgentCluster
          view={selectHelpers(agents, nowTick, helperHover ?? undefined)}
          anchor={cluster.anchor}
          dir={cluster.dir}
          vdir={cluster.vdir}
          visible={buddyVisible && mode === 'rest' && !dragging}
          interactive={interactive}
          hoveredKey={helperHover}
          now={nowTick}
          cardRef={cardRef}
          onAgentClick={(id) => clicky.sendAgentClick(id)}
          onAgentCancel={(id) => clicky.sendAgentCancel(id)}
        />
      )}
      {pulses.map((p) => (
        <div
          key={p.id}
          className="point-pulse"
          data-side={p.side}
          data-vside={p.vside}
          style={{ left: p.x, top: p.y }}
        >
          <span className="pp-dot" />
          <span className="pp-ring" />
          <span className="pp-ring d2" />
          {p.label !== undefined && <span className="pp-chip">{p.label}</span>}
        </div>
      ))}
    </>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
