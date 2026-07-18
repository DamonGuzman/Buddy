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
import { ComputerUseApprovalCard } from './components/ComputerUseApprovalCard';
import { SettingsView } from './components/SettingsView';
import { useComputerUseApproval } from './hooks/use-computer-use';

export function App(): React.JSX.Element {
  const [micError, setMicError] = useState<string | null>(null);
  const computerUse = useComputerUseApproval();
  const currentApproval = computerUse.approvals[0] ?? null;

  const {
    assistantState,
    session,
    settings,
    runtime,
    permissions,
    actionableError,
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
        {currentApproval ? (
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            <ComputerUseApprovalCard
              key={currentApproval.approvalId}
              request={currentApproval}
              pendingCount={computerUse.approvals.length}
              resolving={computerUse.resolving}
              actingInPlace={computerUse.actingInPlace}
              error={computerUse.error}
              onResolve={(helperBuddyId, approvalId, verdict) =>
                void computerUse.resolve(helperBuddyId, approvalId, verdict)
              }
              onShowBrowser={(helperBuddyId, approvalId) =>
                void computerUse.showBrowser(helperBuddyId, approvalId)
              }
              onFinishInBrowser={(helperBuddyId, approvalId) =>
                void computerUse.finishInBrowser(helperBuddyId, approvalId)
              }
            />
          </div>
        ) : settings ? (
          <SettingsView
            settings={settings}
            session={session}
            actionableError={actionableError}
            micDevices={micDevices}
            micError={micError}
            permissions={permissions}
            grantsRevision={computerUse.grantsRevision}
            onPermissionHealth={setPermissions}
          />
        ) : null}
      </main>
    </div>
  );
}
