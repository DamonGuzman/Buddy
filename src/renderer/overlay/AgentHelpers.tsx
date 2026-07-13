/**
 * M19 agent helpers: presentational components for the overlay's background-
 * agent representation. Each running agent is a tiny pastel "helper buddy"
 * that pops out of the mascot into a small arc beside it; hovering one shows
 * a warm, plain-language agent card. More than MAX_HELPER_SPRITES agents fold
 * into a "+N" pebble whose card lists everyone.
 *
 * Pure view: all state (which agents, which is hovered, anchor, orientation)
 * comes in as props from main.tsx; view-model logic lives in agents-ui.ts.
 * Everything animates on transform/opacity only, and animations are gated on
 * the cluster's [data-visible] so hidden overlays burn nothing.
 */

import { useEffect, useState } from 'react';
import {
  AGENT_CARD_GAP,
  AGENT_CARD_W,
  OVERFLOW_KEY,
  elapsedPhrase,
  helperSlots,
  helperStatus,
  helperTint,
  sourcesPhrase,
  truncate,
} from './agents-ui';
import type { HelperView } from './agents-ui';
import type { Vec } from './hover';
import type { AgentSummary } from '../../shared/types';

export interface AgentClusterProps {
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
  /** Hovered helper: an agent id, OVERFLOW_KEY, or null. */
  hoveredKey: string | null;
  /** Clock for elapsed phrases (ticked by main.tsx while a card is open). */
  now: number;
  /** Measured by main.tsx to grow the interactive hover region. */
  cardRef: React.RefObject<HTMLDivElement | null>;
  onAgentClick: (id: string) => void;
  onAgentCancel: (id: string) => void;
}

export function AgentCluster({
  view,
  anchor,
  dir,
  vdir,
  visible,
  interactive,
  hoveredKey,
  now,
  cardRef,
  onAgentClick,
  onAgentCancel,
}: AgentClusterProps): React.JSX.Element {
  const slotCount = view.shown.length + (view.overflow.length > 0 ? 1 : 0);
  const slots = helperSlots(slotCount, dir, vdir);
  const hoveredAgent =
    hoveredKey !== null && hoveredKey !== OVERFLOW_KEY
      ? [...view.shown, ...view.overflow].find((a) => a.id === hoveredKey) ?? null
      : null;

  return (
    <div
      className="agent-cluster"
      data-visible={visible ? '' : undefined}
      data-interactive={interactive ? '' : undefined}
      style={{ transform: `translate3d(${anchor.x}px, ${anchor.y}px, 0)` }}
    >
      {view.shown.map((agent, i) => (
        <HelperSprite
          key={agent.id}
          agent={agent}
          slot={slots[i] ?? { x: 0, y: 0 }}
          index={i}
          hovered={hoveredKey === agent.id}
          onClick={onAgentClick}
        />
      ))}
      {view.overflow.length > 0 && (
        <OverflowPebble
          slot={slots[view.shown.length] ?? { x: 0, y: 0 }}
          count={view.overflow.length}
          hovered={hoveredKey === OVERFLOW_KEY}
        />
      )}
      {hoveredAgent !== null && (
        <AgentCard
          agent={hoveredAgent}
          dir={dir}
          vdir={vdir}
          now={now}
          interactive={interactive}
          cardRef={cardRef}
          onClick={onAgentClick}
          onCancel={onAgentCancel}
        />
      )}
      {hoveredKey === OVERFLOW_KEY && (
        <OverflowCard
          agents={view.overflow}
          dir={dir}
          vdir={vdir}
          cardRef={cardRef}
          onClick={onAgentClick}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HelperSprite({
  agent,
  slot,
  index,
  hovered,
  onClick,
}: {
  agent: AgentSummary;
  slot: Vec;
  index: number;
  hovered: boolean;
  onClick: (id: string) => void;
}): React.JSX.Element {
  // Birth animation: mount at the buddy center, then glide to the slot on the
  // next frame (CSS transitions on the outer translate + inner pop-scale).
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const tint = helperTint(agent.id);
  const kind = helperStatus(agent).kind;
  const pos = arrived ? slot : { x: 0, y: 0 };
  return (
    <div
      className="helper"
      data-status={agent.status}
      data-arrived={arrived ? '' : undefined}
      data-hovered={hovered ? '' : undefined}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      onClick={() => onClick(agent.id)}
    >
      <div
        className="helper-bob"
        style={{ animationDelay: `${(index % 3) * -1.05}s`, ['--helper-glow' as never]: tint.glow }}
      >
        <HelperSvg id={agent.id} tint={tint} />
      </div>
      {(kind === 'done' || kind === 'trouble') && (
        <span className="helper-badge" data-kind={kind}>
          {kind === 'done' ? '✓' : '!'}
        </span>
      )}
    </div>
  );
}

/** A 22px sibling of BuddySvg with a per-agent gradient (unique defs id). */
function HelperSvg({ id, tint }: { id: string; tint: { light: string; dark: string } }): React.JSX.Element {
  const gid = `helper-grad-${id}`;
  return (
    <svg className="helper-svg" width={22} height={22} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tint.light} />
          <stop offset="1" stopColor={tint.dark} />
        </linearGradient>
      </defs>
      <path
        d="M20 7 L34 32.5 L6 32.5 Z"
        fill={`url(#${gid})`}
        stroke={`url(#${gid})`}
        strokeWidth={7}
        strokeLinejoin="round"
      />
      <g className="helper-eyes">
        <circle cx={14.8} cy={24.5} r={3.1} fill="#ffffff" />
        <circle cx={25.2} cy={24.5} r={3.1} fill="#ffffff" />
        <circle cx={15.5} cy={25.1} r={1.55} fill="#1f2b3f" />
        <circle cx={25.9} cy={25.1} r={1.55} fill="#1f2b3f" />
      </g>
    </svg>
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
function cardStyle(dir: 1 | -1, vdir: 1 | -1): React.CSSProperties {
  return {
    width: AGENT_CARD_W,
    ...(dir === 1 ? { left: AGENT_CARD_GAP } : { right: AGENT_CARD_GAP }),
    ...(vdir === -1 ? { bottom: -14 } : { top: -14 }),
  };
}

function AgentCard({
  agent,
  dir,
  vdir,
  now,
  interactive,
  cardRef,
  onClick,
  onCancel,
}: {
  agent: AgentSummary;
  dir: 1 | -1;
  vdir: 1 | -1;
  now: number;
  interactive: boolean;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onClick: (id: string) => void;
  onCancel: (id: string) => void;
}): React.JSX.Element {
  const tint = helperTint(agent.id);
  const status = helperStatus(agent);
  const sources = sourcesPhrase(agent);
  return (
    <div
      ref={cardRef}
      className="agent-card"
      style={cardStyle(dir, vdir)}
      onClick={() => onClick(agent.id)}
    >
      <div className="agent-card-head">
        <span className="agent-card-dot" style={{ background: tint.dark }} />
        <span className="agent-card-name">little helper</span>
        <span className="agent-card-pill" data-kind={status.kind}>
          {status.pill}
        </span>
      </div>
      <div className="agent-card-task">“{truncate(agent.task, 110)}”</div>
      <div className="agent-card-line">
        {status.kind === 'working' && (
          <span className="agent-card-dots">
            <span />
            <span />
            <span />
          </span>
        )}
        {status.line}
      </div>
      <div className="agent-card-meta">
        {elapsedPhrase(agent, now)}
        {sources !== null && ` · ${sources}`}
      </div>
      {(status.cta !== null || agent.status === 'running') && (
        <div className="agent-card-actions">
          {status.cta !== null && <span className="agent-card-cta">{status.cta}</span>}
          {agent.status === 'running' && interactive && (
            <span
              className="agent-card-stop"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(agent.id);
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

function OverflowCard({
  agents,
  dir,
  vdir,
  cardRef,
  onClick,
}: {
  agents: AgentSummary[];
  dir: 1 | -1;
  vdir: 1 | -1;
  cardRef: React.RefObject<HTMLDivElement | null>;
  onClick: (id: string) => void;
}): React.JSX.Element {
  const rows = agents.slice(0, 5);
  return (
    <div ref={cardRef} className="agent-card" style={cardStyle(dir, vdir)}>
      <div className="agent-card-head">
        <span className="agent-card-name">the rest of my helpers</span>
      </div>
      {rows.map((agent) => {
        const status = helperStatus(agent);
        return (
          <div key={agent.id} className="agent-row" onClick={() => onClick(agent.id)}>
            <span className="agent-card-dot" style={{ background: helperTint(agent.id).dark }} />
            <span className="agent-row-task">{truncate(agent.task, 46)}</span>
            <span className="agent-card-pill" data-kind={status.kind}>
              {status.pill}
            </span>
          </div>
        );
      })}
      {agents.length > rows.length && (
        <div className="agent-card-meta">…and {agents.length - rows.length} more in the panel</div>
      )}
      <div className="agent-card-cta">click one to see it in the panel</div>
    </div>
  );
}
