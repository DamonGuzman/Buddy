import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OverlayHoverHintRenderState } from '../../shared/types';
import { hasNativeGlass } from '../native-glass-mode';
import { clicky } from './clicky';
import './hover-hint.css';

if (hasNativeGlass(window.location.search)) {
  document.documentElement.dataset['nativeGlass'] = 'true';
}

function App(): React.JSX.Element | null {
  const [state, setState] = useState<OverlayHoverHintRenderState | null>(null);

  useEffect(() => {
    let pushed = false;
    const unsubscribe = clicky.onUpdate((next) => {
      pushed = true;
      setState(next);
    });
    void clicky.getState().then((initial) => {
      if (!pushed) setState(initial);
    });
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    if (state === null) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => clicky.painted(state.revision));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== 0) cancelAnimationFrame(secondFrame);
    };
  }, [state]);

  if (state === null) return null;
  return (
    <div
      className="hover-hint-surface"
      data-fading={state.fading ? '' : undefined}
      data-horizontal={state.placement.horizontal}
      data-vertical={state.placement.vertical}
    >
      <div>{state.text}</div>
      {state.sub !== undefined && <div className="hover-hint-sub">{state.sub}</div>}
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
