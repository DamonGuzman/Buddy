import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentSummary, AssistantState, OverlayDisplaySurface } from '../../shared/types';
import { resolveIslandActivity } from './island-state';

const RESULT_REVEAL_MS = 4500;

interface BuddyIslandProps {
  surface: OverlayDisplaySurface;
  assistantState: AssistantState;
  capturing: boolean;
  agents: AgentSummary[];
  visible: boolean;
}

/** A visual-only status surface; the hosting BrowserWindow remains click-through. */
export function BuddyIsland(props: BuddyIslandProps): React.JSX.Element | null {
  const unseenCount = props.agents.filter((agent) => agent.unseen).length;
  const previousUnseen = useRef(unseenCount);
  const [revealNewResult, setRevealNewResult] = useState(false);

  useEffect(() => {
    if (unseenCount <= previousUnseen.current) {
      previousUnseen.current = unseenCount;
      return;
    }
    previousUnseen.current = unseenCount;
    setRevealNewResult(true);
    const timer = window.setTimeout(() => setRevealNewResult(false), RESULT_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [unseenCount]);

  const activity = useMemo(
    () =>
      resolveIslandActivity({
        assistantState: props.assistantState,
        capturing: props.capturing,
        agents: props.agents,
        revealNewResult,
      }),
    [props.assistantState, props.capturing, props.agents, revealNewResult],
  );

  if (props.surface.kind === 'off') return null;
  const style = {
    '--island-notch-width': `${props.surface.notchWidth}px`,
    '--island-notch-height': `${props.surface.notchHeight}px`,
    '--island-menu-height': `${props.surface.menuBarHeight}px`,
  } as CSSProperties;

  return (
    <div
      className="buddy-island"
      data-surface={props.surface.kind}
      data-visible={props.visible && activity !== null ? '' : undefined}
      data-kind={activity?.kind}
      style={style}
      aria-hidden="true"
    >
      <div className="buddy-island-shell">
        <span className="buddy-island-orb">
          <span />
          <span />
          <span />
        </span>
        {activity?.kind !== 'result-dot' && (
          <span className="buddy-island-label">{activity?.label}</span>
        )}
      </div>
    </div>
  );
}
