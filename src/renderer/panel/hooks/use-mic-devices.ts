/**
 * Mic device list + one-time permission pre-warm. Merges the renderer's own
 * enumerateDevices() with main's best-effort list, refreshes on devicechange,
 * and reports pre-warm failures through `onMicError`.
 */

import { useEffect, useState } from 'react';
import { clicky } from '../clicky';
import { micCapture } from '../audio/engines';
import type { MicDevice } from '../../../shared/types';

async function enumerateMics(): Promise<MicDevice[]> {
  const seen = new Map<string, MicDevice>();
  try {
    const local = await navigator.mediaDevices.enumerateDevices();
    for (const d of local) {
      if (d.kind !== 'audioinput') continue;
      seen.set(d.deviceId, { deviceId: d.deviceId, label: d.label });
    }
  } catch (err) {
    console.warn('[mic] enumerateDevices failed:', err);
  }
  try {
    for (const d of await clicky.listMics()) {
      if (!seen.has(d.deviceId)) seen.set(d.deviceId, d);
    }
  } catch {
    /* main-side list is best-effort */
  }
  return [...seen.values()];
}

export function useMicDevices(onMicError: (err: string | null) => void): MicDevice[] {
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);

  useEffect(() => {
    const refresh = (): void => {
      void enumerateMics().then(setMicDevices);
    };
    // prewarm() is idempotent — repeat mounts (StrictMode) share one attempt.
    void micCapture.prewarm().then((ok) => {
      onMicError(ok ? null : micCapture.error());
      refresh();
    });
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [onMicError]);

  return micDevices;
}
