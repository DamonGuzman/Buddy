/**
 * M19 agent helpers: presentational components for the overlay's background-
 * agent representation. Each running agent is a tiny pastel "helper buddy"
 * that pops out of the mascot into a small arc beside it; hovering one shows
 * a warm, plain-language agent card, and clicking it (M22) expands the card
 * into the helper's full status — activity log, findings, places checked.
 * More than MAX_HELPER_SPRITES agents fold into a "+N" pebble whose card
 * lists everyone.
 *
 * Pure view: all state (which agents, which is hovered, anchor, orientation)
 * comes in as props from main.tsx; view-model logic lives in agents-ui.ts.
 * Everything animates on transform/opacity only, and animations are gated on
 * the cluster's [data-visible] so hidden overlays burn nothing.
 */

import { useEffect, useState } from 'react';
import {
  AGENT_CARD_EXPANDED_W,
  AGENT_CARD_GAP,
  AGENT_CARD_W,
  OVERFLOW_KEY,
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
} from './agents-ui';
import type { HelperView } from './agents-ui';
import type { Vec } from './hover';
import { TriangleSvg } from './TriangleSvg';
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
  /** M22: agent whose card is click-expanded to its full status, or null. */
  expandedKey: string | null;
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
  expandedKey,
  now,
  cardRef,
  onAgentClick,
  onAgentCancel,
}: AgentClusterProps): React.JSX.Element {
  const slotCount = view.shown.length + (view.overflow.length > 0 ? 1 : 0);
  const slots = helperSlots(slotCount, dir, vdir);
  const all = [...view.shown, ...view.overflow];
  // M22: an expanded (clicked) card wins over the plain hover card — it may
  // belong to an overflow agent while `hoveredKey` is the pebble.
  const expandedAgent =
    expandedKey !== null ? (all.find((a) => a.id === expandedKey) ?? null) : null;
  const hoveredAgent =
    expandedAgent === null && hoveredKey !== null && hoveredKey !== OVERFLOW_KEY
      ? (all.find((a) => a.id === hoveredKey) ?? null)
      : null;
  const cardAgent = expandedAgent ?? hoveredAgent;
  const keepKey = expandedKey ?? hoveredKey ?? undefined;

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
          hovered={hoveredKey === agent.id || expandedKey === agent.id}
          departing={helperPhase(agent, now, keepKey) === 'departing'}
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
      {cardAgent !== null && (
        <AgentCard
          agent={cardAgent}
          expanded={expandedAgent !== null}
          dir={dir}
          vdir={vdir}
          now={now}
          interactive={interactive}
          cardRef={cardRef}
          onClick={onAgentClick}
          onCancel={onAgentCancel}
        />
      )}
      {expandedAgent === null && hoveredKey === OVERFLOW_KEY && (
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
  departing,
  onClick,
}: {
  agent: AgentSummary;
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
  const tint = helperTint(agent.id);
  const kind = helperStatus(agent).kind;
  const pos = arrived && !departing ? slot : { x: 0, y: 0 };
  return (
    <div
      className="helper"
      data-status={agent.status}
      data-arrived={arrived ? '' : undefined}
      data-departing={departing ? '' : undefined}
      data-hovered={hovered ? '' : undefined}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      onClick={() => onClick(agent.id)}
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
        <HelperSvg id={agent.id} tint={tint} />
      </div>
      {(kind === 'done' || kind === 'trouble') && (
        <span className="helper-badge" data-kind={kind}>
          {kind === 'done' ? '✓' : '!'}
        </span>
      )}
      {agent.status === 'done' && (
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

/** A 22px sibling of BuddySvg with a per-agent gradient (unique defs id). */
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
    width: expanded ? AGENT_CARD_EXPANDED_W : AGENT_CARD_W,
    ...(dir === 1 ? { left: AGENT_CARD_GAP } : { right: AGENT_CARD_GAP }),
    ...(vdir === -1 ? { bottom: -14 } : { top: -14 }),
  };
}

function AgentCard({
  agent,
  expanded,
  dir,
  vdir,
  now,
  interactive,
  cardRef,
  onClick,
  onCancel,
}: {
  agent: AgentSummary;
  /** M22: full-status view (clicked) — activity log, findings, sources. */
  expanded: boolean;
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
  const findings = expanded ? expandedFindings(agent) : null;
  // The full findings replace the one-line recap; trouble lines stay.
  const showLine = !(expanded && status.kind === 'done' && findings !== null);
  const cta = expanded ? 'click to tuck this away' : status.cta;
  return (
    <div
      ref={cardRef}
      className="agent-card"
      data-expanded={expanded ? '' : undefined}
      style={cardStyle(dir, vdir, expanded)}
      onClick={() => onClick(agent.id)}
    >
      <div className="agent-card-head">
        <span className="agent-card-dot" style={{ background: tint.dark }} />
        <span className="agent-card-name">little helper</span>
        <span className="agent-card-pill" data-kind={status.kind}>
          {status.pill}
        </span>
      </div>
      <div className="agent-card-task">“{truncate(agent.task, expanded ? 200 : 110)}”</div>
      {showLine && (
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
      )}
      {expanded && <ExpandedDetail agent={agent} findings={findings} now={now} />}
      <div className="agent-card-meta">
        {elapsedPhrase(agent, now)}
        {!expanded && sources !== null && ` · ${sources}`}
      </div>
      {(cta !== null || agent.status === 'running') && (
        <div className="agent-card-actions">
          {cta !== null && <span className="agent-card-cta">{cta}</span>}
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

/** M22: the expanded card's body — everything the buddy knows about the run. */
function ExpandedDetail({
  agent,
  findings,
  now,
}: {
  agent: AgentSummary;
  findings: string | null;
  now: number;
}): React.JSX.Element {
  const steps = recentSteps(agent);
  const { hosts, more } = sourceHosts(agent);
  return (
    <>
      {steps.length > 0 && (
        <div className="agent-card-detail">
          <div className="agent-card-section">what i’ve been up to</div>
          {steps.map((step, i) => (
            <div key={`${step.at}-${i}`} className="agent-step">
              <span className="agent-step-label">{truncate(step.label, 64)}</span>
              <span className="agent-step-time">{timeAgoPhrase(step.at, now)}</span>
            </div>
          ))}
        </div>
      )}
      {findings !== null && (
        <div className="agent-card-detail">
          <div className="agent-card-section">what i found</div>
          <div className="agent-card-findings">{findings}</div>
        </div>
      )}
      {hosts.length > 0 && (
        <div className="agent-card-detail">
          <div className="agent-card-section">places i checked</div>
          <div className="agent-card-hosts">
            {hosts.join(' · ')}
            {more > 0 && ` · +${more} more`}
          </div>
        </div>
      )}
    </>
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
        <div className="agent-card-meta">…and {agents.length - rows.length} more</div>
      )}
      <div className="agent-card-cta">click one for the whole story</div>
    </div>
  );
}
