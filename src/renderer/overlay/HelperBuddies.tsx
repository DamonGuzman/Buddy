/**
 * M19 helper buddies: presentational components for the overlay. Each running
 * helper buddy is a tiny pastel triangle
 * that pops out of the mascot into a small arc beside it; hovering one shows
 * a warm, plain-language card, and clicking it (M22) expands the card
 * into the helper's full status — activity log, findings, places checked.
 * More than MAX_HELPER_SPRITES helper buddies fold into a "+N" pebble whose card
 * lists everyone.
 *
 * Pure view: all state (which helpers, which is hovered, anchor, orientation)
 * comes in as props from main.tsx; view-model logic lives in helper-buddies-ui.ts.
 * Everything animates on transform/opacity only, and animations are gated on
 * the cluster's [data-visible] so hidden overlays burn nothing.
 */

import { useEffect, useState } from 'react';
import {
  HELPER_BUDDY_CARD_EXPANDED_W,
  HELPER_BUDDY_CARD_GAP,
  HELPER_BUDDY_CARD_W,
  OVERFLOW_KEY,
  canCancelHelperBuddy,
  elapsedPhrase,
  expandedFindings,
  helperPhase,
  helperSlots,
  helperStatus,
  helperTint,
  recentSteps,
  sourceHosts,
  sourcesPhrase,
  timeAgoPhrase,
  truncate,
} from './helper-buddies-ui';
import type { HelperView } from './helper-buddies-ui';
import type { Vec } from './hover';
import { TriangleSvg } from './TriangleSvg';
import type { HelperBuddyBrowserPreview, HelperBuddySummary } from '../../shared/types';

export interface HelperBuddyClusterProps {
  view: HelperView;
  /** Buddy rest center, window-local DIP. */
  anchor: Vec;
  /** +1 = helpers extend right of the buddy, -1 = left. */
  dir: 1 | -1;
  /** -1 = helpers arc upward, +1 = downward (buddy resting near the top). */
  vdir: 1 | -1;
  /** Fade the whole cluster (buddy hidden / flying / being dragged). */
  visible: boolean;
  /** The overlay is click-through-lifted: clicks will actually land. */
  interactive: boolean;
  /** Hovered helper: a helper-buddy id, OVERFLOW_KEY, or null. */
  hoveredKey: string | null;
  /** M22: helper buddy whose card is click-expanded to full status, or null. */
  expandedKey: string | null;
  /** Clock for elapsed phrases (ticked by main.tsx while a card is open). */
  now: number;
  /** Latest ephemeral frame for each helper with an active browser surface. */
  browserPreviews: readonly HelperBuddyBrowserPreview[];
  /** Measured by main.tsx to grow the interactive hover region. */
  cardRef: React.RefObject<HTMLDivElement | null>;
  onHelperBuddyClick: (id: string) => void;
  onHelperBuddyCancel: (id: string) => void;
}

export function HelperBuddyCluster({
  view,
  anchor,
  dir,
  vdir,
  visible,
  interactive,
  hoveredKey,
  expandedKey,
  now,
  browserPreviews,
  cardRef,
  onHelperBuddyClick,
  onHelperBuddyCancel,
}: HelperBuddyClusterProps): React.JSX.Element {
  const slotCount = view.shown.length + (view.overflow.length > 0 ? 1 : 0);
  const slots = helperSlots(slotCount, dir, vdir);
  const all = [...view.shown, ...view.overflow];
  // M22: an expanded (clicked) card wins over the plain hover card — it may
  // belong to an overflow helper buddy while `hoveredKey` is the pebble.
  const expandedHelperBuddy =
    expandedKey !== null ? (all.find((a) => a.id === expandedKey) ?? null) : null;
  const hoveredHelperBuddy =
    expandedHelperBuddy === null && hoveredKey !== null && hoveredKey !== OVERFLOW_KEY
      ? (all.find((a) => a.id === hoveredKey) ?? null)
      : null;
  const cardHelperBuddy = expandedHelperBuddy ?? hoveredHelperBuddy;
  const browserPreview =
    cardHelperBuddy === null
      ? null
      : (browserPreviews.find((preview) => preview.helperBuddyId === cardHelperBuddy.id) ?? null);
  const keepKey = expandedKey ?? hoveredKey ?? undefined;

  return (
    <div
      className="helper-buddy-cluster"
      data-visible={visible ? '' : undefined}
      data-interactive={interactive ? '' : undefined}
      style={{ transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0)` }}
    >
      {view.shown.map((helperBuddy, i) => (
        <HelperSprite
          key={helperBuddy.id}
          helperBuddy={helperBuddy}
          slot={slots[i] ?? { x: 0, y: 0 }}
          index={i}
          hovered={hoveredKey === helperBuddy.id || expandedKey === helperBuddy.id}
          departing={helperPhase(helperBuddy, now, keepKey) === 'departing'}
          onClick={onHelperBuddyClick}
        />
      ))}
      {view.overflow.length > 0 && (
        <OverflowPebble
          slot={slots[view.shown.length] ?? { x: 0, y: 0 }}
          count={view.overflow.length}
          hovered={hoveredKey === OVERFLOW_KEY}
        />
      )}
      {cardHelperBuddy !== null && (
        <div
          className="helper-buddy-surfaces"
          data-direction={dir === 1 ? 'right' : 'left'}
          data-vertical={vdir === -1 ? 'above' : 'below'}
          style={surfaceStyle(dir, vdir)}
        >
          <HelperBuddyCard
            helperBuddy={cardHelperBuddy}
            expanded={expandedHelperBuddy !== null}
            now={now}
            interactive={interactive}
            cardRef={cardRef}
            onClick={onHelperBuddyClick}
            onCancel={onHelperBuddyCancel}
          />
          {browserPreview !== null && (
            <BrowserPreview preview={browserPreview} direction={dir === 1 ? 'right' : 'left'} />
          )}
        </div>
      )}
      {expandedHelperBuddy === null && hoveredKey === OVERFLOW_KEY && (
        <OverflowCard
          helperBuddies={view.overflow}
          dir={dir}
          vdir={vdir}
          cardRef={cardRef}
          onClick={onHelperBuddyClick}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HelperSprite({
  helperBuddy,
  slot,
  index,
  hovered,
  departing,
  onClick,
}: {
  helperBuddy: HelperBuddySummary;
  slot: Vec;
  index: number;
  hovered: boolean;
  /** Last leg of the linger: glide back into the buddy and shrink away. */
  departing: boolean;
  onClick: (id: string) => void;
}): React.JSX.Element {
  // Birth animation: mount at the buddy center, then glide to the slot on the
  // next frame (CSS transitions on the outer translate + inner pop-scale).
  // Departure is the reverse — back to the buddy center, scaled away.
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const tint = helperTint(helperBuddy.id);
  const kind = helperStatus(helperBuddy).kind;
  const pos = arrived && !departing ? slot : { x: 0, y: 0 };
  return (
    <div
      className="helper"
      data-status={helperBuddy.status}
      data-arrived={arrived ? '' : undefined}
      data-departing={departing ? '' : undefined}
      data-hovered={hovered ? '' : undefined}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      onClick={() => onClick(helperBuddy.id)}
    >
      <div
        className="helper-bob"
        style={
          {
            animationDelay: `${(index % 3) * -1.05}s`,
            '--helper-glow': tint.glow,
          } as React.CSSProperties
        }
      >
        <HelperSvg id={helperBuddy.id} tint={tint} />
      </div>
      {(kind === 'approval' || kind === 'done' || kind === 'trouble') && (
        <span className="helper-badge" data-kind={kind}>
          {kind === 'approval' ? '?' : kind === 'done' ? '✓' : '!'}
        </span>
      )}
      {helperBuddy.status === 'done' && (
        <span className="helper-burst" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}

/** A 22px sibling of BuddySvg with a per-helper-buddy gradient (unique defs id). */
function HelperSvg({
  id,
  tint,
}: {
  id: string;
  tint: { light: string; dark: string };
}): React.JSX.Element {
  return (
    <TriangleSvg
      svgClassName="helper-svg"
      size={22}
      gradientId={`helper-grad-${id}`}
      gradientTop={tint.light}
      gradientBottom={tint.dark}
      eyesClassName="helper-eyes"
      pupilFill="#1f2b3f"
    />
  );
}

function OverflowPebble({
  slot,
  count,
  hovered,
}: {
  slot: Vec;
  count: number;
  hovered: boolean;
}): React.JSX.Element {
  return (
    <div
      className="helper helper-more"
      data-hovered={hovered ? '' : undefined}
      style={{ transform: `translate3d(${slot.x}px, ${slot.y}px, 0)` }}
    >
      <span className="helper-more-chip">+{count}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Anchor the card on the screen-center side of the cluster. */
function cardStyle(dir: 1 | -1, vdir: 1 | -1, expanded = false): React.CSSProperties {
  return {
    width: expanded ? HELPER_BUDDY_CARD_EXPANDED_W : HELPER_BUDDY_CARD_W,
    ...(dir === 1 ? { left: HELPER_BUDDY_CARD_GAP } : { right: HELPER_BUDDY_CARD_GAP }),
    ...(vdir === -1 ? { bottom: -14 } : { top: -14 }),
  };
}

/** Anchor the detached card + browser companion on the roomy side of Buddy. */
function surfaceStyle(dir: 1 | -1, vdir: 1 | -1): React.CSSProperties {
  return {
    ...(dir === 1 ? { left: HELPER_BUDDY_CARD_GAP } : { right: HELPER_BUDDY_CARD_GAP }),
    ...(vdir === -1 ? { bottom: -14 } : { top: -14 }),
  };
}

function HelperBuddyCard({
  helperBuddy,
  expanded,
  now,
  interactive,
  cardRef,
  onClick,
  onCancel,
}: {
  helperBuddy: HelperBuddySummary;
  /** M22: full-status view (clicked) — activity log, findings, sources. */
  expanded: boolean;
  now: number;
  interactive: boolean;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onClick: (id: string) => void;
  onCancel: (id: string) => void;
}): React.JSX.Element {
  const tint = helperTint(helperBuddy.id);
  const status = helperStatus(helperBuddy);
  const sources = sourcesPhrase(helperBuddy);
  const findings = expanded ? expandedFindings(helperBuddy) : null;
  // The full findings replace the one-line recap; trouble lines stay.
  const showLine = !(expanded && status.kind === 'done' && findings !== null);
  const cta = expanded ? 'click to tuck this away' : status.cta;
  return (
    <div
      ref={cardRef}
      className="helper-buddy-card"
      data-liquid-glass-region="helper-card"
      data-liquid-glass-radius="16"
      data-expanded={expanded ? '' : undefined}
      style={{ width: expanded ? HELPER_BUDDY_CARD_EXPANDED_W : HELPER_BUDDY_CARD_W }}
      onClick={() => onClick(helperBuddy.id)}
    >
      <div className="helper-buddy-card-head">
        <span className="helper-buddy-card-dot" style={{ background: tint.dark }} />
        <span className="helper-buddy-card-name">helper buddy</span>
        <span className="helper-buddy-card-pill" data-kind={status.kind}>
          {status.pill}
        </span>
      </div>
      <div className="helper-buddy-card-task">
        “{truncate(helperBuddy.task, expanded ? 200 : 110)}”
      </div>
      {showLine && (
        <div className="helper-buddy-card-line">
          {status.kind === 'working' && (
            <span className="helper-buddy-card-dots">
              <span />
              <span />
              <span />
            </span>
          )}
          {status.line}
        </div>
      )}
      {expanded && <ExpandedDetail helperBuddy={helperBuddy} findings={findings} now={now} />}
      <div className="helper-buddy-card-meta">
        {elapsedPhrase(helperBuddy, now)}
        {!expanded && sources !== null && ` · ${sources}`}
      </div>
      {(cta !== null || canCancelHelperBuddy(helperBuddy)) && (
        <div className="helper-buddy-card-actions">
          {cta !== null && <span className="helper-buddy-card-cta">{cta}</span>}
          {canCancelHelperBuddy(helperBuddy) && interactive && (
            <span
              className="helper-buddy-card-stop"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(helperBuddy.id);
              }}
            >
              stop
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Detached companion window for the helper's still-active hidden browser. */
function BrowserPreview({
  preview,
  direction,
}: {
  preview: HelperBuddyBrowserPreview;
  /** Side of the buddy that holds the card; the connector points back toward it. */
  direction: 'left' | 'right';
}): React.JSX.Element {
  const tint = helperTint(preview.helperBuddyId);
  return (
    <div
      className="helper-buddy-browser-preview"
      data-liquid-glass-region="helper-browser-preview"
      data-liquid-glass-radius="15"
      data-direction={direction}
      aria-label="live browser preview"
      style={
        {
          '--helper-browser-accent': tint.dark,
          '--helper-browser-glow': tint.glow,
        } as React.CSSProperties
      }
    >
      <div className="helper-buddy-browser-preview-head">
        <span className="helper-buddy-browser-preview-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>browser</span>
        <span className="helper-buddy-browser-preview-state">
          <span className="helper-buddy-browser-preview-live" />
          live
        </span>
      </div>
      <div className="helper-buddy-browser-preview-frame">
        <img src={preview.imageDataUrl} alt="" draggable={false} />
      </div>
    </div>
  );
}

/** M22: the expanded card's body — everything the buddy knows about the run. */
function ExpandedDetail({
  helperBuddy,
  findings,
  now,
}: {
  helperBuddy: HelperBuddySummary;
  findings: string | null;
  now: number;
}): React.JSX.Element {
  const steps = recentSteps(helperBuddy);
  const { hosts, more } = sourceHosts(helperBuddy);
  return (
    <>
      {steps.length > 0 && (
        <div className="helper-buddy-card-detail">
          <div className="helper-buddy-card-section">what i’ve been up to</div>
          {steps.map((step, i) => (
            <div key={`${step.at}-${i}`} className="helper-buddy-step">
              <span className="helper-buddy-step-label">{truncate(step.label, 64)}</span>
              <span className="helper-buddy-step-time">{timeAgoPhrase(step.at, now)}</span>
            </div>
          ))}
        </div>
      )}
      {findings !== null && (
        <div className="helper-buddy-card-detail">
          <div className="helper-buddy-card-section">what i found</div>
          <div className="helper-buddy-card-findings">{findings}</div>
        </div>
      )}
      {hosts.length > 0 && (
        <div className="helper-buddy-card-detail">
          <div className="helper-buddy-card-section">places i checked</div>
          <div className="helper-buddy-card-hosts">
            {hosts.join(' · ')}
            {more > 0 && ` · +${more} more`}
          </div>
        </div>
      )}
    </>
  );
}

function OverflowCard({
  helperBuddies,
  dir,
  vdir,
  cardRef,
  onClick,
}: {
  helperBuddies: HelperBuddySummary[];
  dir: 1 | -1;
  vdir: 1 | -1;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onClick: (id: string) => void;
}): React.JSX.Element {
  const rows = helperBuddies.slice(0, 5);
  return (
    <div
      ref={cardRef}
      className="helper-buddy-card"
      data-liquid-glass-region="helper-card"
      data-liquid-glass-radius="16"
      style={cardStyle(dir, vdir)}
    >
      <div className="helper-buddy-card-head">
        <span className="helper-buddy-card-name">the rest of my helper buddies</span>
      </div>
      {rows.map((helperBuddy) => {
        const status = helperStatus(helperBuddy);
        return (
          <div
            key={helperBuddy.id}
            className="helper-buddy-row"
            onClick={() => onClick(helperBuddy.id)}
          >
            <span
              className="helper-buddy-card-dot"
              style={{ background: helperTint(helperBuddy.id).dark }}
            />
            <span className="helper-buddy-row-task">{truncate(helperBuddy.task, 46)}</span>
            <span className="helper-buddy-card-pill" data-kind={status.kind}>
              {status.pill}
            </span>
          </div>
        );
      })}
      {helperBuddies.length > rows.length && (
        <div className="helper-buddy-card-meta">…and {helperBuddies.length - rows.length} more</div>
      )}
      <div className="helper-buddy-card-cta">click one for the whole story</div>
    </div>
  );
}
