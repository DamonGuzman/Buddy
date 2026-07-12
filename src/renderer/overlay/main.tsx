/**
 * Overlay renderer: the buddy (friendly blue triangle), caption bubble, and
 * listening/thinking/capture indicators. M1 shows the buddy at its rest
 * position (bottom-right) with a state dot so launch is visually verifiable.
 * The bezier flight animation lands in the overlay milestone.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { clicky } from './clicky';
import type { AssistantState } from '../../shared/types';

const STATE_COLORS: Record<AssistantState, string> = {
  idle: '#3b82f6',
  listening: '#22c55e',
  thinking: '#eab308',
  speaking: '#8b5cf6',
  error: '#ef4444',
};

function Buddy(): React.JSX.Element {
  const [state, setState] = useState<AssistantState>('idle');
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    void clicky.getAssistantState().then(setState);
    const offState = clicky.onAssistantState(setState);
    const offCapture = clicky.onCaptureIndicator(({ active }) => setCapturing(active));
    const offPointer = clicky.onPointer(() => {
      // TODO(overlay milestone): quadratic-bezier flight to cmd.points.
    });
    const offCaption = clicky.onCaption(() => {
      // TODO(overlay milestone): caption bubble.
    });
    return () => {
      offState();
      offCapture();
      offPointer();
      offCaption();
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        right: 48,
        bottom: 48,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {capturing && (
        <div
          style={{
            fontFamily: 'system-ui, sans-serif',
            fontSize: 11,
            color: '#fff',
            background: 'rgba(239, 68, 68, 0.9)',
            borderRadius: 8,
            padding: '2px 8px',
          }}
        >
          sharing screen
        </div>
      )}
      {/* the buddy: a friendly blue triangle at rest */}
      <div
        style={{
          width: 0,
          height: 0,
          borderLeft: '18px solid transparent',
          borderRight: '18px solid transparent',
          borderBottom: `32px solid ${STATE_COLORS[state]}`,
          filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.35))',
        }}
        title={`clicky (screen ${clicky.screenIndex})`}
      />
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: STATE_COLORS[state],
          opacity: state === 'idle' ? 0.5 : 1,
        }}
      />
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Buddy />
    </StrictMode>,
  );
}
