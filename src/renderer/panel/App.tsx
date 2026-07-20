/**
 * Settings app (M21: the control panel is gone). This window has two jobs:
 * hosting the audio engines while HIDDEN (usePanelWiring — main keeps the
 * renderer alive, unthrottled, from app start so mic capture and voice
 * playback work the moment the hotkey goes down), and showing the settings
 * surface when opened from the tray. The old chat panel — transcript,
 * composer, helper-buddy view — was retired in favor of the whisper composer and
 * the overlay's caption bubbles / helper sprites.
 */

import { useState } from 'react';
import { useMicDevices } from './hooks/use-mic-devices';
import { usePanelWiring } from './hooks/use-panel-wiring';
import { Header } from './components/Header';
import { SettingsView } from './components/SettingsView';

export function App(): React.JSX.Element {
  const [micError, setMicError] = useState<string | null>(null);

  const {
    assistantState,
    session,
    settings,
    runtime,
    permissions,
    actionableError,
    grantsRevision,
    setPermissions,
  } = usePanelWiring({
    onMicError: setMicError,
  });
  const canPrewarmMic =
    permissions?.supported !== true || permissions.grants.microphone === 'granted';
  const micDevices = useMicDevices(setMicError, canPrewarmMic);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <Header
        assistantState={assistantState}
        session={session}
        devFlags={runtime?.devFlags ?? []}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        {settings ? (
          <SettingsView
            settings={settings}
            session={session}
            actionableError={actionableError}
            micDevices={micDevices}
            micError={micError}
            permissions={permissions}
            grantsRevision={grantsRevision}
            onPermissionHealth={setPermissions}
          />
        ) : null}
      </main>
    </div>
  );
}
