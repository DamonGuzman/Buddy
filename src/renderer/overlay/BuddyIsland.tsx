import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { HelperBuddySummary, AssistantState, OverlayDisplaySurface } from '../../shared/types';
import { resolveIslandActivity } from './island-state';

const RESULT_REVEAL_MS = 4500;

interface BuddyIslandProps {
  surface: OverlayDisplaySurface;
  assistantState: AssistantState;
  capturing: boolean;
  helperBuddies: HelperBuddySummary[];
  visible: boolean;
}

/** A visual-only status surface; the hosting BrowserWindow remains click-through. */
export function BuddyIsland(props: BuddyIslandProps): React.JSX.Element | null {
  const unseenCount = props.helperBuddies.filter((helperBuddy) => helperBuddy.unseen).length;
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
        helperBuddies: props.helperBuddies,
        revealNewResult,
      }),
    [props.assistantState, props.capturing, props.helperBuddies, revealNewResult],
  );

  if (props.surface.kind === 'off') return null;
  const style = {
    '--island-notch-width': `${props.surface.notchWidth}px`,
    '--island-notch-height': `${props.surface.notchHeight}px`,
    '--island-menu-height': `${props.surface.menuBarHeight}px`,
  } as CSSProperties;

  const orb = (
    <span className="buddy-island-orb">
      <span />
      <span />
      <span />
    </span>
  );

  return (
    <div
      className="buddy-island"
      data-surface={props.surface.kind}
      data-visible={props.visible && activity !== null ? '' : undefined}
      data-kind={activity?.kind}
      style={style}
      aria-hidden="true"
    >
      {props.surface.kind === 'notch' ? (
        // Two wings flank the physical notch: orb left, label right. Both stay
        // mounted so state changes animate; CSS retracts the label wing when
        // the activity collapses to the persistent result dot. The cover paints
        // the notch bounding box black so the cutout's rounded corners never
        // show a seam against the wings' flat edges.
        <>
          <div className="buddy-island-notch-cover" />
          <div className="buddy-island-wing" data-side="left">
            {orb}
          </div>
          <div className="buddy-island-wing" data-side="right">
            <span className="buddy-island-label">{activity?.label}</span>
          </div>
        </>
      ) : (
        <div className="buddy-island-shell">
          {orb}
          {activity?.kind !== 'result-dot' && (
            <span className="buddy-island-label">{activity?.label}</span>
          )}
        </div>
      )}
    </div>
  );
}
