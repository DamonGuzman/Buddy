/**
 * All main→panel IPC wiring in one hook: boot-time state fetches, push
 * subscriptions, and the glue that drives the audio engines (playback deltas
 * + epoch floor, mic capture start/stop). App stays layout + routing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clicky } from '../clicky';
import { audioPlayer, micCapture } from '../audio/engines';
import type { AssistantState, RuntimeFlags, SessionStatus, Settings } from '../../../shared/types';

export interface PanelWiringDeps {
  /** Mic capture start reported an error (or cleared it). */
  onMicError: (err: string | null) => void;
}

export interface PanelWiring {
  assistantState: AssistantState;
  session: SessionStatus | null;
  settings: Settings | null;
  runtime: RuntimeFlags | null;
  /** Current mic preference (a live ref read — no resubscribe on change). */
  getMicDeviceId: () => string;
}

export function usePanelWiring({ onMicError }: PanelWiringDeps): PanelWiring {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // M11 addition (orchestrator-approved): hookAlive + dev flags from main.
  const [runtime, setRuntime] = useState<RuntimeFlags | null>(null);

  // Capture needs the *current* mic preference without resubscribing.
  const micDeviceIdRef = useRef('');
  useEffect(() => {
    micDeviceIdRef.current = settings?.micDeviceId ?? '';
  }, [settings]);
  const getMicDeviceId = useCallback((): string => micDeviceIdRef.current, []);

  useEffect(() => {
    void clicky.getSettings().then(setSettings);
    // M11: tolerate an older preload (crash-recreate races) — best-effort.
    try {
      void clicky.getRuntime().then(setRuntime);
    } catch {
      /* runtime flags are progressive enhancement */
    }

    const offs = [
      clicky.onAssistantState(setAssistantState),
      clicky.onSessionStatus(setSession),
      clicky.onSettings(setSettings),
      clicky.onRuntime(setRuntime),
      // M17: merge the Codex sign-in snapshot into settings (the "ChatGPT"
      // settings card reads it) — lower latency than waiting for the next
      // panel:settings, and reflects the CLI's auth.json rotating live.
      clicky.onCodexSignin((state) =>
        setSettings((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                codexSignedIn: state.signedIn,
                codexValid: state.valid,
                codexPlanType: state.planType,
              },
        ),
      ),
      clicky.onAudioOutput((delta) => audioPlayer.enqueue(delta)),
      // F1 (M2): the playback-epoch floor rides along with the command.
      clicky.onPlayback(({ command, epoch }) => audioPlayer.control(command, epoch)),
      clicky.onCaptureCommand(({ command }) => {
        if (command === 'start') {
          void micCapture.start(micDeviceIdRef.current).then(() => {
            onMicError(micCapture.error());
          });
        } else {
          micCapture.stop();
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [onMicError]);

  return {
    assistantState,
    session,
    settings,
    runtime,
    getMicDeviceId,
  };
}
