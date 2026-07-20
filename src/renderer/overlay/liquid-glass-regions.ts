import type { OverlayGlassRegion } from '../../shared/types';

const REGION_SELECTOR = '[data-liquid-glass-region]';

/** Keep native popup backgrounds aligned with mounted renderer surfaces. */
export function observeLiquidGlassRegions(
  enabled: boolean,
  send: (regions: OverlayGlassRegion[]) => void,
): () => void {
  if (!enabled) return () => undefined;

  let frame: number | null = null;
  let settleTimer: number | null = null;
  let lastPayload = '';
  const observed = new Set<Element>();

  const sync = (): void => {
    frame = null;
    const elements = [...document.querySelectorAll<HTMLElement>(REGION_SELECTOR)];
    for (const element of observed) {
      if (!elements.includes(element as HTMLElement)) {
        resizeObserver.unobserve(element);
        observed.delete(element);
      }
    }
    for (const element of elements) {
      if (!observed.has(element)) {
        observed.add(element);
        resizeObserver.observe(element);
      }
    }
    const regions = elements.flatMap((element): OverlayGlassRegion[] => {
      const id = element.dataset['liquidGlassRegion'];
      const rect = element.getBoundingClientRect();
      if (!id || rect.width <= 0 || rect.height <= 0) return [];
      return [
        {
          id,
          x: quarter(rect.x),
          y: quarter(rect.y),
          width: quarter(rect.width),
          height: quarter(rect.height),
          cornerRadius: Number(element.dataset['liquidGlassRadius'] ?? 16),
          // AppKit controls the blur/refraction strength for regular glass.
          // This stronger neutral tint keeps white popup copy readable over
          // high-detail desktop content without flattening the glass effect.
          tintColor: '#1118278f',
        },
      ];
    });
    const payload = JSON.stringify(regions);
    if (payload !== lastPayload) {
      lastPayload = payload;
      send(regions);
    }
  };

  const scheduleImmediate = (): void => {
    if (frame === null) frame = requestAnimationFrame(sync);
  };
  const schedule = (): void => {
    scheduleImmediate();
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      scheduleImmediate();
    }, 400);
  };
  const resizeObserver = new ResizeObserver(scheduleImmediate);
  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-expanded', 'data-fading'],
  });
  window.addEventListener('resize', scheduleImmediate);
  schedule();

  return () => {
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('resize', scheduleImmediate);
    if (frame !== null) cancelAnimationFrame(frame);
    if (settleTimer !== null) window.clearTimeout(settleTimer);
    send([]);
  };
}

function quarter(value: number): number {
  return Math.round(value * 4) / 4;
}
