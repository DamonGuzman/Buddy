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
import type { AssistantState, PointerPoint } from '../../shared/types';
import './overlay.css';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Dwell at each point of a multi-point command. */
const DWELL_MS = 1200;
/** After the last point: wait this long (and for idle state) before arcing home. */
const HOME_AFTER_MS = 6000;
/** Caption bubble lingers this long after done:true, then fades. */
const CAPTION_LINGER_MS = 4000;
/** Caption fade-out transition time (matches overlay.css). */
const CAPTION_FADE_MS = 500;
/** Error flash duration (shake + red), then back to the idle look. */
const ERROR_FLASH_MS = 650;

/**
 * When settled at SETTLE_ROT (tip up-left, like a cursor) the triangle's tip
 * sits at center + (-8.4, -10.7); offset the flight target so the TIP kisses
 * the exact point while the body sits just below-right of it.
 */
const TIP_OFFSET: Vec = { x: 8.4, y: 10.7 };

/** Rest pose: near the bottom-right of the display, above the taskbar. */
function restPos(): Vec {
  return { x: window.innerWidth - 76, y: window.innerHeight - 120 };
}

/** Was this overlay created on the primary display? (set by main via query) */
function isPrimaryOverlay(): boolean {
  return new URLSearchParams(window.location.search).get('primary') !== '0';
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

type BuddyMode = 'rest' | 'flying' | 'pointing';

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
}

interface Placement {
  h: 'left' | 'right';
  v: 'above' | 'below';
}

// ---------------------------------------------------------------------------

function BuddySvg(): React.JSX.Element {
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
        <circle cx={15.5} cy={25.1} r={1.55} fill="#173a63" />
        <circle cx={25.9} cy={25.1} r={1.55} fill="#173a63" />
      </g>
    </svg>
  );
}

function App(): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const rotRef = useRef<HTMLDivElement>(null);

  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [capturing, setCapturing] = useState(false);
  const [buddyVisible, setBuddyVisible] = useState(isPrimaryOverlay());
  const [mode, setMode] = useState<BuddyMode>('rest');
  const [errorFlash, setErrorFlash] = useState(false);
  const [blink, setBlink] = useState(false);
  const [caption, setCaption] = useState<CaptionView | null>(null);
  const [pulses, setPulses] = useState<PulseView[]>([]);
  const [placement, setPlacement] = useState<Placement>({ h: 'right', v: 'above' });

  useEffect(() => {
    // ------------------------------------------------------------- engine --
    const flight = new FlightController((pose) => {
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
    /** When the go-home timer fired while not idle, go home once idle again. */
    let waitingIdleGen: number | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let captionTimer: ReturnType<typeof setTimeout> | null = null;

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
    };
    const applyMode = (m: BuddyMode): void => {
      currentMode = m;
      setMode(m);
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
          ...(p.label !== undefined ? { label: p.label } : {}),
        },
      ]);
    };

    const scheduleHome = (myGen: number): void => {
      after(HOME_AFTER_MS, () => {
        if (gen !== myGen) return;
        if (currentState === 'idle') void goHome(myGen);
        else waitingIdleGen = myGen;
      });
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
      waitingIdleGen = null;
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
      waitingIdleGen = null;
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
      scheduleHome(myGen);
    }

    const applyState = (s: AssistantState): void => {
      currentState = s;
      setAssistantState(s);
      if (s === 'error') {
        setErrorFlash(true);
        after(ERROR_FLASH_MS, () => setErrorFlash(false));
      }
      if (s === 'idle' && waitingIdleGen !== null && waitingIdleGen === gen) {
        void goHome(gen);
      }
    };

    // --------------------------------------------------------------- init --
    flight.jumpTo(restPos(), REST_ROT);
    updatePlacement(restPos());
    void clicky.getAssistantState().then((s) => {
      currentState = s;
      setAssistantState(s);
    });

    const offPointer = clicky.onPointer((cmd) => {
      if (cmd.type === 'animate') {
        if (cmd.points.length > 0) void runPoints(cmd.points);
      } else if (cmd.type === 'idle') {
        void goHome();
      } else {
        // hide: fade the buddy out entirely.
        gen += 1;
        clearTimers();
        flight.cancel();
        setPulses([]);
        setVisible(false);
        applyMode('rest');
      }
    });

    const offState = clicky.onAssistantState(applyState);

    const offCapture = clicky.onCaptureIndicator(({ active }) => setCapturing(active));

    const offCaption = clicky.onCaption((update) => {
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

    const onResize = (): void => {
      if (currentMode === 'rest') {
        flight.jumpTo(restPos(), REST_ROT);
        updatePlacement(restPos());
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      offPointer();
      offState();
      offCapture();
      offCaption();
      window.removeEventListener('resize', onResize);
      clearTimers();
      if (captionTimer !== null) clearTimeout(captionTimer);
      if (blinkTimer !== null) clearTimeout(blinkTimer);
      flight.cancel();
    };
  }, []);

  return (
    <>
      <div className="edge-pulse" data-active={capturing ? '' : undefined} />
      <div
        ref={rootRef}
        className="buddy-root"
        data-state={assistantState}
        data-mode={mode}
        data-visible={buddyVisible ? '' : undefined}
        data-flash={errorFlash ? '' : undefined}
        data-blink={blink ? '' : undefined}
        data-h={placement.h}
        data-v={placement.v}
      >
        <div className="listen-ring r1" />
        <div className="listen-ring r2" />
        <div ref={rotRef} className="buddy-rot">
          <div className="buddy-fx">
            <div className="buddy-bob">
              <BuddySvg />
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
      </div>
      {pulses.map((p) => (
        <div
          key={p.id}
          className="point-pulse"
          data-side={p.side}
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
