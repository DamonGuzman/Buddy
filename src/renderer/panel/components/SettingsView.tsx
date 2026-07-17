import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clicky } from '../clicky';
import { ChatGptCard } from './settings/ChatGptCard';
import { MicrophoneCard } from './settings/MicrophoneCard';
import { OpenAiCard } from './settings/OpenAiCard';
import { FirecrawlCard } from './settings/FirecrawlCard';
import { VoiceCard } from './settings/VoiceCard';
import { BuddyBrowserCard } from './settings/BuddyBrowserCard';
import { PermissionCard } from './PermissionCard';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { actionableErrorIdentity } from '../actionable-error-state';
import {
  SETTINGS_TARGET_LABEL,
  settingsTargetForPatch,
  visibleSettingsSection,
} from './settings/error-routing';
import type { PatchSettings } from './settings/patch';
import type {
  ActionableErrorState,
  ActionableErrorTarget,
  MicDevice,
  PermissionHealth,
  SessionStatus,
  Settings,
} from '../../../shared/types';

interface SettingsViewProps {
  settings: Settings;
  session: SessionStatus | null;
  actionableError: ActionableErrorState;
  micDevices: MicDevice[];
  micError: string | null;
  permissions: PermissionHealth | null;
  grantsRevision: number;
  onPermissionHealth: (health: PermissionHealth) => void;
}

/** Settings: API key, model, voice, captions, mic, hotkey, agent-mode teaser. */
export function SettingsView({
  settings,
  session,
  actionableError,
  micDevices,
  micError,
  permissions,
  grantsRevision,
  onPermissionHealth,
}: SettingsViewProps): React.JSX.Element {
  const [saveFailure, setSaveFailure] = useState<{
    revision: number;
    mainRevisionAtCreation: number;
    message: string;
    target: ActionableErrorTarget;
  } | null>(null);
  const saveFailureRevision = useRef(0);

  const patch: PatchSettings = useCallback(
    async (p) => {
      try {
        await clicky.setSettings(p);
      } catch {
        saveFailureRevision.current += 1;
        setSaveFailure({
          revision: saveFailureRevision.current,
          mainRevisionAtCreation: actionableError.revision,
          message:
            "buddy couldn't save that setting — the previous value is unchanged. try again, or restart buddy if it keeps happening.",
          target: settingsTargetForPatch(p),
        });
        return false;
      }
      setSaveFailure(null);
      return true;
    },
    [actionableError.revision],
  );

  const visibleSaveFailure =
    saveFailure !== null && actionableError.revision <= saveFailure.mainRevisionAtCreation
      ? saveFailure
      : null;

  const activeIssue = useMemo(
    () => visibleSaveFailure ?? actionableError.notice,
    [actionableError.notice, visibleSaveFailure],
  );
  const activeRevision = visibleSaveFailure
    ? `save-${visibleSaveFailure.revision}`
    : `main-${actionableError.revision}`;
  const activeSection = activeIssue
    ? visibleSettingsSection(
        activeIssue.target,
        permissions?.supported === true,
        'kind' in activeIssue ? activeIssue.kind : undefined,
      )
    : null;

  const scrollToTarget = useCallback((target: ActionableErrorTarget): void => {
    document.querySelector<HTMLElement>(`[data-settings-section="${target}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  useEffect(() => {
    if (activeSection === null) return;
    const frame = requestAnimationFrame(() => scrollToTarget(activeSection));
    return () => cancelAnimationFrame(frame);
  }, [activeRevision, activeSection, scrollToTarget]);

  useEffect(() => {
    const notice = actionableError.notice;
    if (notice?.kind === 'hotkey_dead' && permissions?.hotkeyAlive) {
      const expected = actionableErrorIdentity(actionableError);
      if (expected === null) return;
      void clicky.resolveActionableError(expected).catch((error: unknown) => {
        console.warn('[settings] failed to resolve permission error state:', error);
      });
    }
  }, [actionableError, permissions]);

  const dismissActiveIssue = (): void => {
    if (visibleSaveFailure !== null) {
      setSaveFailure(null);
      return;
    }
    const expected = actionableErrorIdentity(actionableError);
    if (expected === null) return;
    void clicky.dismissActionableError(expected).catch((error: unknown) => {
      console.warn('[settings] failed to dismiss actionable error state:', error);
    });
  };

  const sectionClass = (target: ActionableErrorTarget): string =>
    cn(
      'rounded-lg transition-shadow',
      activeIssue?.target === target &&
        'ring-2 ring-destructive/65 ring-offset-2 ring-offset-background',
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {activeIssue ? (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2.5 text-xs"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium text-destructive">needs your attention</div>
            <div className="mt-0.5 leading-relaxed text-foreground/90">{activeIssue.message}</div>
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            {activeSection !== null ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => scrollToTarget(activeSection)}
              >
                show {SETTINGS_TARGET_LABEL[activeSection]}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={dismissActiveIssue}
            >
              dismiss for now
            </Button>
          </div>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1" data-settings-scroll>
        <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-4">
          {permissions?.supported ? (
            <div data-settings-section="permissions" className={sectionClass('permissions')}>
              <PermissionCard health={permissions} onHealth={onPermissionHealth} />
            </div>
          ) : null}
          <div data-settings-section="openai" className={sectionClass('openai')}>
            <OpenAiCard settings={settings} session={session} onPatch={patch} />
          </div>
          <div data-settings-section="firecrawl" className={sectionClass('firecrawl')}>
            <FirecrawlCard settings={settings} onPatch={patch} />
          </div>
          <div data-settings-section="chatgpt" className={sectionClass('chatgpt')}>
            <ChatGptCard settings={settings} onPatch={patch} />
          </div>
          <BuddyBrowserCard grantsRevision={grantsRevision} />
          <div data-settings-section="voice" className={sectionClass('voice')}>
            <VoiceCard settings={settings} onPatch={patch} />
          </div>
          <div data-settings-section="microphone" className={sectionClass('microphone')}>
            <MicrophoneCard
              settings={settings}
              micDevices={micDevices}
              micError={micError}
              onPatch={patch}
            />
          </div>
          <div className="flex items-center gap-2.5 rounded-lg border border-dashed px-3.5 py-2.5 text-xs text-muted-foreground">
            <span>🪄</span>
            <span>
              {settings.firecrawlApiKeyPresent && !settings.firecrawlApiKeyUnreadable
                ? 'agent mode is ready — say “buddy, agent…” to send off research.'
                : 'add a Firecrawl key above to give helper buddies live web research.'}
            </span>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
