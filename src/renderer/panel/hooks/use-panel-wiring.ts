/**
 * All main→panel IPC wiring in one hook: boot-time state fetches, push
 * subscriptions, and the glue that drives the audio engines (playback deltas
 * + epoch floor, mic capture start/stop). App stays layout + routing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clicky } from '../clicky';
import { audioPlayer, micCapture } from '../audio/engines';
import {
  actionableErrorIdentity,
  EMPTY_ACTIONABLE_ERROR_STATE,
  mergeActionableErrorState,
} from '../actionable-error-state';
import type {
  ActionableErrorState,
  AssistantState,
  PermissionHealth,
  RuntimeFlags,
  SessionStatus,
  Settings,
} from '../../../shared/types';

export interface PanelWiringDeps {
  /** Mic capture start reported an error (or cleared it). */
  onMicError: (err: string | null) => void;
}

export interface PanelWiring {
  assistantState: AssistantState;
  session: SessionStatus | null;
  settings: Settings | null;
  runtime: RuntimeFlags | null;
  permissions: PermissionHealth | null;
  actionableError: ActionableErrorState;
  setPermissions: (health: PermissionHealth) => void;
  /** Current mic preference (a live ref read — no resubscribe on change). */
  getMicDeviceId: () => string;
}

export function usePanelWiring({ onMicError }: PanelWiringDeps): PanelWiring {
  const [assistantState, setAssistantState] = useState<AssistantState>('idle');
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // M11 addition (orchestrator-approved): hookAlive + dev flags from main.
  const [runtime, setRuntime] = useState<RuntimeFlags | null>(null);
  const [permissions, setPermissions] = useState<PermissionHealth | null>(null);
  const [actionableError, setActionableError] = useState<ActionableErrorState>(
    EMPTY_ACTIONABLE_ERROR_STATE,
  );
  const actionableErrorRef = useRef<ActionableErrorState>(EMPTY_ACTIONABLE_ERROR_STATE);

  const mergeActionableError = useCallback((incoming: ActionableErrorState): void => {
    setActionableError((current) => {
      const merged = mergeActionableErrorState(current, incoming);
      actionableErrorRef.current = merged;
      return merged;
    });
  }, []);

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
      void clicky.getPermissionHealth().then(setPermissions);
      void clicky.getActionableError().then(mergeActionableError);
    } catch {
      /* runtime flags are progressive enhancement */
    }

    const offs = [
      clicky.onAssistantState(setAssistantState),
      clicky.onSessionStatus(setSession),
      clicky.onSettings(setSettings),
      clicky.onRuntime(setRuntime),
      clicky.onPermissions(setPermissions),
      clicky.onActionableError(mergeActionableError),
      // M17: merge the Codex sign-in snapshot into settings (the "ChatGPT"
      // settings card reads it) — lower latency than waiting for the next
      // panel:settings, and reflects the CLI's auth.json rotating live.
      clicky.onCodexSignin((state) => {
        setSettings((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                codexSignedIn: state.signedIn,
                codexValid: state.valid,
                codexPlanType: state.planType,
              },
        );
        if (state.signedIn && state.valid) {
          const expected = actionableErrorIdentity(actionableErrorRef.current, [
            'helper_buddy_not_signed_in',
          ]);
          if (expected !== null) {
            void clicky.resolveActionableError(expected).catch((error: unknown) => {
              console.warn('[chatgpt] failed to resolve sign-in error state:', error);
            });
          }
        }
      }),
      clicky.onAudioOutput((delta) => audioPlayer.enqueue(delta)),
      // F1 (M2): the playback-epoch floor rides along with the command.
      clicky.onPlayback(({ command, epoch }) => audioPlayer.control(command, epoch)),
      clicky.onCaptureCommand(({ command }) => {
        if (command === 'start') {
          const expected = actionableErrorIdentity(actionableErrorRef.current, ['mic_unavailable']);
          void micCapture.start(micDeviceIdRef.current).then((result) => {
            onMicError(micCapture.error());
            if (
              expected !== null &&
              (result.status === 'started' || result.status === 'already-running')
            ) {
              void clicky.resolveActionableError(expected).catch((error: unknown) => {
                console.warn('[mic] failed to resolve microphone error state:', error);
              });
            }
          });
        } else {
          micCapture.stop();
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [mergeActionableError, onMicError]);

  return {
    assistantState,
    session,
    settings,
    runtime,
    permissions,
    actionableError,
    setPermissions,
    getMicDeviceId,
  };
}
