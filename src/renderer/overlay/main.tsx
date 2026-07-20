/**
 * Overlay renderer: the buddy (friendly blue triangle with eyes), quadratic-
 * bezier pointer flights, arrival pulse + label chips, streamed caption
 * bubble, capture privacy signposts, and assistant-state visuals.
 *
 * Architecture: React renders the (mostly static) DOM tree and state-driven
 * classes; the 60fps flight animation writes transforms imperatively through
 * FlightController so nothing re-renders per frame. rAF runs ONLY during a
 * flight — at rest all motion is cheap compositor-only CSS.
 *
 * This file is deliberately thin wiring: the behavior lives in focused
 * controllers (PointerChoreographer, CaptionController, HelperHoverController,
 * HoverDragController), each driven by an injected clock + TimerBag so it is
 * unit-testable with fake time. The single mount effect constructs them,
 * adapts DOM/IPC events onto them, and mirrors their view state into useState
 * for JSX.
 */

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clicky } from './clicky';
import { FlightController } from './flight';
import type { Vec } from './flight';
import type { BuddyMode } from './pointer-lifecycle';
import { hintText, placementFor, restFromFrac } from './hover';
import type { HoverZone, Placement } from './hover';
import { CaptionController } from './caption-controller';
import type { CaptionView } from './caption-controller';
import { PointerChoreographer } from './pointer-choreographer';
import type { PulseView } from './pointer-choreographer';
import { HelperHoverController } from './helper-hover-controller';
import type { ClusterGeom } from './helper-hover-controller';
import { HoverDragController } from './hover-controller';
import type { HintBubbleState } from './hover-controller';
import { TimerBag } from './timer-bag';
import { parseOverlayParams } from './query-params';
import { HelperBuddyCluster } from './HelperBuddies';
import { applyBrowserPreviewUpdate } from './helper-buddies-ui';
import type { HelperView } from './helper-buddies-ui';
import { TriangleSvg } from './TriangleSvg';
import { BuddyIsland } from './BuddyIsland';
import { observeLiquidGlassRegions } from './liquid-glass-regions';
import type {
  HelperBuddySummary,
  HelperBuddyBrowserPreview,
  AssistantState,
  OverlayDisplaySurface,
  OverlayHoverConfig,
  Rect,
} from '../../shared/types';
import './overlay.css';

// ---------------------------------------------------------------------------
// Page params + tuning constants
// ---------------------------------------------------------------------------

/** Overlay query-param protocol (?screenIndex / ?primary / ?bobIdleMs). */
const PAGE_PARAMS = parseOverlayParams(window.location.search);

/** Error flash duration (shake + red), then back to the idle look. */
const ERROR_FLASH_MS = 650;
/**
 * Battery saver: after this long fully idle (state 'idle' and no pointer/
 * caption/state activity) the rest bob animation pauses — the buddy stays
 * visible, it just holds still. Any activity resumes it. The main process can
 * shrink this via the CLICKY_BOB_IDLE_MS env (test hook; forwarded as the
 * ?bobIdleMs query param).
 */
const BOB_IDLE_PAUSE_MS = PAGE_PARAMS.bobIdleMs ?? 5 * 60_000;
/** Blink cadence: instant class flip (~130ms closed) at a random 3.5–6.5s gap. */
const BLINK_MIN_GAP_MS = 3500;
const BLINK_GAP_JITTER_MS = 3000;
const BLINK_CLOSED_MS = 130;
/** Config re-anchors within this distance of the current pose are ignored. */
const REST_REANCHOR_EPSILON_PX = 2;

// ---------------------------------------------------------------------------

function BuddySvg({
  pupilsRef,
}: {
  /** M15: imperative handle for cursor-tracking pupil offsets (transform-only). */
  pupilsRef: React.RefObject<SVGGElement | null>;
}): React.JSX.Element {
  return (
    <TriangleSvg
      svgClassName="buddy-svg"
      size={34}
      gradientId="buddy-grad"
      gradientTop="#7cc4ff"
      gradientBottom="#2b6ef2"
      bodyClassName="buddy-body"
      eyesClassName="buddy-eyes"
      pupilFill="#173a63"
      pupilsClassName="buddy-pupils"
      pupilsRef={pupilsRef}
    />
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
  const [buddyVisible, setBuddyVisible] = useState(PAGE_PARAMS.primary);
  const [mode, setMode] = useState<BuddyMode>('rest');
  const [errorFlash, setErrorFlash] = useState(false);
  const [blink, setBlink] = useState(false);
  const [caption, setCaption] = useState<CaptionView | null>(null);
  const [pulses, setPulses] = useState<PulseView[]>([]);
  const [placement, setPlacement] = useState<Placement>({ h: 'right', v: 'above' });
  const [bobPaused, setBobPaused] = useState(false);
  // M15 hover state.
  const [hoverZone, setHoverZone] = useState<HoverZone>('far');
  const [hintState, setHintState] = useState<HintBubbleState>('hidden');
  const [interactive, setInteractive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hoverCfg, setHoverCfg] = useState<OverlayHoverConfig | null>(null);
  // M19 helper-buddy state (mirrors of HelperHoverController — one clock).
  const [helperView, setHelperView] = useState<HelperView>({ shown: [], overflow: [] });
  const [helperHover, setHelperHover] = useState<string | null>(null);
  // M22: helper whose card is click-expanded to its full status (ref mirror
  // so the mount-effect controller callbacks see the current value).
  const [helperExpanded, setHelperExpanded] = useState<string | null>(null);
  const helperExpandedRef = useRef<string | null>(null);
  const [cluster, setCluster] = useState<ClusterGeom | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [helperBuddies, setHelperBuddies] = useState<HelperBuddySummary[]>([]);
  const [browserPreviews, setBrowserPreviews] = useState<HelperBuddyBrowserPreview[]>([]);
  const browserPreviewsRef = useRef<HelperBuddyBrowserPreview[]>([]);
  const browserPreviewRevisionRef = useRef(0);
  const [displaySurface, setDisplaySurface] = useState<OverlayDisplaySurface>({
    kind: 'off',
    notchWidth: 0,
    notchHeight: 0,
    menuBarHeight: 0,
  });
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Measured card bounds, window-local DIP (grows the interactive region). */
  const cardRectRef = useRef<Rect | null>(null);
  /** The mounted helper controller — the card-measure effect resyncs its aux. */
  const helpersRef = useRef<HelperHoverController | null>(null);

  useEffect(() => {
    const clock = (): number => Date.now();
    const viewport = (): { width: number; height: number } => ({
      width: window.innerWidth,
      height: window.innerHeight,
    });

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

    let currentState: AssistantState = 'idle';
    const uiTimers = new TimerBag(); // bob / errorFlash / blink one-shots

    /**
     * Battery saver: (re)arm the idle bob-pause timer. Called on every
     * pointer/caption/capture/state event; pauses the bob only if still fully
     * idle when the timer fires (state changes re-arm it, so a later return
     * to idle restarts the countdown).
     */
    const bumpActivity = (): void => {
      setBobPaused(false);
      uiTimers.set('bob', BOB_IDLE_PAUSE_MS, () => {
        if (currentState === 'idle') setBobPaused(true);
      });
    };

    const updatePlacement = (pos: Vec): void => setPlacement(placementFor(pos));

    // -------------------------------------------------------- controllers --
    const captions = new CaptionController(setCaption, new TimerBag());

    const choreographer = new PointerChoreographer(
      {
        flight,
        timers: new TimerBag(),
        restPos,
        viewport,
        onVisible: (v) => {
          setBuddyVisible(v);
          hoverCtrl.syncEnabled(); // M15
        },
        onMode: (m) => {
          setMode(m);
          hoverCtrl.syncEnabled(); // M15: hover must never fight the flight engine
        },
        setPulses,
        updatePlacement,
      },
      PAGE_PARAMS.primary,
    );

    const helpers = new HelperHoverController({
      clock,
      timers: new TimerBag(),
      anchor: restPos,
      cursor: () => hoverCtrl.cursor,
      hoverEligible: () => hoverCtrl.isEligible,
      cardRect: () => cardRectRef.current,
      applyAux: (aux) => hoverCtrl.setAux(aux),
      onView: (view) => {
        setHelperView(view);
        // M22: the expanded helper buddy vanished from the cluster (e.g. cancelled).
        const id = helperExpandedRef.current;
        if (id !== null && ![...view.shown, ...view.overflow].some((a) => a.id === id)) {
          clearHelperExpanded();
        }
      },
      onCluster: setCluster,
      onHover: (key) => {
        setHelperHover(key);
        // M22: the hover machine owns card lifetime — a full hover release
        // (cursor left the merged region / interaction disabled) closes the
        // expanded full-status card with it.
        if (key === null) clearHelperExpanded();
      },
      onNow: setNowTick,
    });

    function clearHelperExpanded(): void {
      if (helperExpandedRef.current === null) return;
      helperExpandedRef.current = null;
      setHelperExpanded(null);
      helpers.setPinned(null);
    }

    const hoverCtrl = new HoverDragController({
      clock,
      timers: new TimerBag(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
      flight,
      buddyPos: () => buddyPos,
      viewport,
      gateInput: () => ({
        visible: choreographer.isVisible,
        atRest: choreographer.mode === 'rest',
        state: currentState,
        fullRealtimeMode: cfgRef.current?.fullRealtimeMode ?? false,
      }),
      sendHover: (evt) => clicky.sendHover(evt),
      sendBuddyClick: () => clicky.sendBuddyClick(),
      sendBuddySettings: () => clicky.sendBuddySettings(),
      sendBuddyMove: (rest) => clicky.sendBuddyMove(rest),
      bumpActivity,
      updatePlacement,
      setZone: setHoverZone,
      setHintState,
      setDraggingState: setDragging,
      setInteractiveState: setInteractive,
      setPupilTransform: (css) => {
        const pupils = pupilsRef.current;
        if (pupils) pupils.style.transform = css;
      },
      helperHover: {
        updateFromCursor: () => helpers.updateFromCursor(),
        release: () => helpers.release(),
      },
    });

    const applyState = (s: AssistantState): void => {
      // M15: "recent response" hint variant — remember when speaking ended.
      if (currentState === 'speaking' && s !== 'speaking') {
        lastSpokeAtRef.current = clock();
      }
      currentState = s;
      const pointerAction = choreographer.assistantStateChanged(
        s,
        cfgRef.current?.fullRealtimeMode ?? false,
      );
      setAssistantState(s);
      bumpActivity();
      hoverCtrl.syncEnabled(); // M15: a physical PTT hold suppresses interaction
      if (s === 'error') {
        setErrorFlash(true);
        uiTimers.set('errorFlash', ERROR_FLASH_MS, () => setErrorFlash(false));
        captions.flushForError();
      }
      choreographer.applyReturnAction(pointerAction);
    };

    // --------------------------------------------------------------- init --
    // StrictMode mounts, tears down, and mounts this effect again in
    // development. Promise continuations from the first mount must never
    // mutate its disposed controllers or overwrite newer pushed state.
    let disposed = false;
    choreographer.jumpToRest();
    bumpActivity();

    let assistantStatePushed = false;
    const offState = clicky.onAssistantState((state) => {
      assistantStatePushed = true;
      applyState(state);
    });
    void clicky
      .getAssistantState()
      .then((state) => {
        if (disposed || assistantStatePushed) return;
        applyState(state);
      })
      .catch(() => undefined);

    const offPointer = clicky.onPointer((cmd) => {
      bumpActivity();
      if (cmd.type === 'animate') {
        if (cmd.points.length > 0) choreographer.runPoints(cmd.points);
      } else if (cmd.type === 'idle') {
        void choreographer.goHome();
      } else {
        // hide: fade the buddy out entirely.
        choreographer.hide();
      }
    });

    const offCapture = clicky.onCaptureIndicator(({ active }) => {
      bumpActivity();
      setCapturing(active);
    });

    const offCaption = clicky.onCaption((update) => {
      bumpActivity();
      captions.handleUpdate(update);
    });

    // Blink: instant class flip (~130ms closed) at a random 3.5–6.5s cadence.
    // JS-driven on purpose — see the .buddy-eyes comment in overlay.css.
    const scheduleBlink = (): void => {
      uiTimers.set('blink', BLINK_MIN_GAP_MS + Math.random() * BLINK_GAP_JITTER_MS, () => {
        if (choreographer.isVisible) {
          setBlink(true);
          uiTimers.set('blinkClose', BLINK_CLOSED_MS, () => setBlink(false));
        }
        scheduleBlink();
      });
    };
    scheduleBlink();

    // =========================================================== M15 hover --
    const offInteractive = clicky.onInteractive(({ interactive: on }) =>
      hoverCtrl.setInteractiveFromMain(on),
    );
    const offGlassRegionsReady = clicky.onGlassRegionsReady(({ enabled }) => {
      if (enabled) document.documentElement.dataset['nativeGlassRegions'] = 'true';
      else delete document.documentElement.dataset['nativeGlassRegions'];
    });
    const stopGlassRegions = observeLiquidGlassRegions(clicky.isMacOS, (regions) =>
      clicky.sendGlassRegions(regions),
    );

    const applyHoverConfig = (cfg: OverlayHoverConfig): void => {
      const first = cfgRef.current === null;
      cfgRef.current = cfg;
      setHoverCfg(cfg);
      // The config can arrive after the initial assistant-state read. Re-run
      // the pointer rendezvous so a realtime `listening` state is not left
      // classified with push-to-talk semantics because of that startup race.
      choreographer.applyReturnAction(
        choreographer.assistantStateChanged(currentState, cfg.fullRealtimeMode),
      );
      hoverCtrl.syncEnabled();
      helpers.recompute(); // M19: the cluster is anchored at the rest spot
      if (choreographer.mode !== 'rest' || hoverCtrl.isDragging) return;
      const target = restPos();
      const cur = flight.currentPose.pos;
      if (Math.hypot(target.x - cur.x, target.y - cur.y) <= REST_REANCHOR_EPSILON_PX) return;
      if (!choreographer.isVisible || first) {
        // Hidden overlays and the boot-time config just re-anchor silently.
        choreographer.jumpToRest();
      } else {
        void choreographer.goHome();
      }
      hoverCtrl.sendStatus(); // keep the debug/QA buddy position truthful post-anchor
    };
    const offHoverConfig = clicky.onHoverConfig(applyHoverConfig);
    // Belt-and-braces vs the did-finish-load push (subscription race).
    void clicky
      .getHoverConfig()
      .then((cfg) => {
        if (!disposed && cfgRef.current === null) applyHoverConfig(cfg);
      })
      .catch(() => {});

    const onMouseMove = (e: MouseEvent): void => hoverCtrl.onMouseMove(e.clientX, e.clientY);
    const onMouseOut = (e: MouseEvent): void => {
      // relatedTarget null = the cursor left the window (display edge).
      if (e.relatedTarget === null) hoverCtrl.onCursorLeftWindow();
    };
    const onMouseDown = (e: MouseEvent): void => {
      const contextClick = clicky.isMacOS && e.button === 0 && e.ctrlKey;
      if (hoverCtrl.onMouseDown(e.clientX, e.clientY, e.button, contextClick)) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent): void => hoverCtrl.onMouseUp(e.button);
    const onContextMenu = (e: MouseEvent): void => {
      if (hoverCtrl.onContextMenu(e.clientX, e.clientY)) e.preventDefault();
    };
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseout', onMouseOut, { passive: true });
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    // M20: main-side cursor feed — Windows' forward:true mousemove delivery
    // proved unreliable, so main streams cursor positions while this window
    // hosts the buddy at rest. Same HoverMachine entry points as real events;
    // the feed pauses while interactive (real DOM events take over).
    const offCursor = clicky.onCursor((pos) => {
      if (pos === null) hoverCtrl.onCursorLeftWindow();
      else hoverCtrl.onMouseMove(pos.x, pos.y);
    });
    hoverCtrl.sendStatus(); // initial snapshot (buddy rest position) for debug/QA
    // ------------------------------------------------------- end M15 hover --

    // -------------------------------------------- M19 helper-buddy helper wiring --
    const offHelperBuddies = clicky.onHelperBuddies((list) => {
      setHelperBuddies(list);
      helpers.setHelperBuddies(list);
    });
    let browserPreviewsBootstrapped = false;
    const pendingBrowserPreviewUpdates: Parameters<typeof applyBrowserPreviewUpdate>[1][] = [];
    // Advance the revision before scheduling React state. This cache lives outside
    // the updater itself because StrictMode may invoke updater functions twice.
    const applyBrowserPreview = (update: Parameters<typeof applyBrowserPreviewUpdate>[1]): void => {
      if (update.revision <= browserPreviewRevisionRef.current) return;
      browserPreviewRevisionRef.current = update.revision;
      const next = applyBrowserPreviewUpdate(browserPreviewsRef.current, update);
      browserPreviewsRef.current = next;
      setBrowserPreviews(next);
    };
    const offBrowserPreview = clicky.onHelperBuddyBrowserPreview((update) => {
      if (!browserPreviewsBootstrapped) {
        pendingBrowserPreviewUpdates.push(update);
        return;
      }
      applyBrowserPreview(update);
    });
    let displaySurfacePushed = false;
    const offDisplaySurface = clicky.onDisplaySurface((surface) => {
      displaySurfacePushed = true;
      setDisplaySurface(surface);
    });
    void clicky
      .getDisplaySurface()
      .then((surface) => {
        if (!disposed && !displaySurfacePushed) setDisplaySurface(surface);
      })
      .catch(() => undefined);
    // Bootstrap for late-created overlays (display hotplug) — push wins races.
    void clicky
      .getHelperBuddies()
      .then((list) => {
        if (!disposed && helpers.bootstrap(list)) setHelperBuddies(list);
      })
      .catch(() => {});
    void clicky
      .getHelperBuddyBrowserPreviews()
      .then((snapshot) => {
        if (disposed) return;
        const buffered = [...pendingBrowserPreviewUpdates].sort(
          (left, right) => left.revision - right.revision,
        );
        pendingBrowserPreviewUpdates.length = 0;
        browserPreviewsBootstrapped = true;
        if (snapshot.revision >= browserPreviewRevisionRef.current) {
          browserPreviewRevisionRef.current = snapshot.revision;
          browserPreviewsRef.current = snapshot.previews;
          setBrowserPreviews(snapshot.previews);
        }
        for (const update of buffered) applyBrowserPreview(update);
      })
      .catch(() => {
        if (disposed) return;
        const buffered = [...pendingBrowserPreviewUpdates].sort(
          (left, right) => left.revision - right.revision,
        );
        pendingBrowserPreviewUpdates.length = 0;
        browserPreviewsBootstrapped = true;
        for (const update of buffered) applyBrowserPreview(update);
      });
    helpersRef.current = helpers;
    // ---------------------------------------- end M19 helper-buddy helper wiring --

    const onResize = (): void => {
      if (choreographer.mode === 'rest') choreographer.jumpToRest();
      helpers.recompute(); // M19: re-anchor the cluster
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      offPointer();
      offState();
      offCapture();
      offCaption();
      // M15 hover teardown.
      offInteractive();
      offGlassRegionsReady();
      stopGlassRegions();
      delete document.documentElement.dataset['nativeGlassRegions'];
      offHoverConfig();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      offCursor(); // M20 cursor feed
      // M19 helper-buddy teardown.
      offHelperBuddies();
      offBrowserPreview();
      offDisplaySurface();
      helpersRef.current = null;
      window.removeEventListener('resize', onResize);
      hoverCtrl.dispose();
      helpers.dispose();
      captions.dispose();
      choreographer.dispose();
      uiTimers.clearAll();
      flight.cancel();
    };
  }, []);

  // M19: measure the open helper-buddy card so the hover machine's merged region
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
    helpersRef.current?.syncAux();
  }, [helperHover, helperExpanded, helperView, cluster, browserPreviews]);

  // M19: tick the card's elapsed/time-ago phrases while one is open.
  useEffect(() => {
    if (helperHover === null) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [helperHover]);

  // M22: a click toggles the helper's card between hover-summary and full
  // status. Handled entirely in the overlay — no window is summoned.
  const toggleHelperExpanded = (id: string): void => {
    const next = helperExpandedRef.current === id ? null : id;
    helperExpandedRef.current = next;
    setHelperExpanded(next);
    helpersRef.current?.setPinned(next);
  };

  // M15: state-aware hover hint copy (null = suppressed: non-idle states,
  // captions in progress — an error caption is never replaced). The clock and
  // lastSpokeAt ref are deliberately sampled at render time: the "want more?"
  // recency variant only needs to be right when the hint (re)appears, and
  // every render that matters is already driven by hover-state changes.
  /* eslint-disable react-hooks/refs, react-hooks/purity */
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
          helperBuddyHover: helperHover !== null, // M19: the card IS the hint
        })
      : null;
  /* eslint-enable react-hooks/refs, react-hooks/purity */

  return (
    <>
      <div className="edge-pulse" data-active={capturing ? '' : undefined} />
      <BuddyIsland
        surface={displaySurface}
        assistantState={assistantState}
        capturing={capturing}
        helperBuddies={helperBuddies}
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
        <HelperBuddyCluster
          view={helperView}
          anchor={cluster.anchor}
          dir={cluster.dir}
          vdir={cluster.vdir}
          visible={buddyVisible && mode === 'rest' && !dragging}
          interactive={interactive}
          hoveredKey={helperHover}
          expandedKey={helperExpanded}
          now={nowTick}
          browserPreviews={browserPreviews}
          cardRef={cardRef}
          onHelperBuddyClick={(id) => {
            const helperBuddy = helperBuddies.find((candidate) => candidate.id === id);
            if (helperBuddy?.status === 'waiting_approval') {
              clicky.sendHelperBuddyClick(id);
              return;
            }
            const expanding = helperExpandedRef.current !== id;
            toggleHelperExpanded(id);
            if (
              expanding &&
              helperBuddy?.unseen === true &&
              (helperBuddy.status === 'done' || helperBuddy.status === 'failed')
            ) {
              void clicky
                .markHelperBuddySeen(id)
                .catch((error: unknown) =>
                  console.error('[overlay] failed to mark helper buddy as seen', error),
                );
            }
          }}
          onHelperBuddyCancel={(id) => clicky.sendHelperBuddyCancel(id)}
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
