import { clicky } from '../clicky';
import { ChatGptCard } from './settings/ChatGptCard';
import { MicrophoneCard } from './settings/MicrophoneCard';
import { OpenAiCard } from './settings/OpenAiCard';
import { VoiceCard } from './settings/VoiceCard';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { PatchSettings } from './settings/patch';
import type { MicDevice, Settings } from '../../../shared/types';

interface SettingsViewProps {
  settings: Settings;
  micDevices: MicDevice[];
  micError: string | null;
}

/** Settings: API key, model, voice, captions, mic, hotkey, agent-mode teaser. */
export function SettingsView({
  settings,
  micDevices,
  micError,
}: SettingsViewProps): React.JSX.Element {
  const patch: PatchSettings = (p) => clicky.setSettings(p);

  return (
    <ScrollArea className="min-h-0 flex-1" data-settings-scroll>
      <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-4">
        <OpenAiCard settings={settings} onPatch={patch} />
        <ChatGptCard settings={settings} onPatch={patch} />
        <VoiceCard settings={settings} onPatch={patch} />
        <MicrophoneCard
          settings={settings}
          micDevices={micDevices}
          micError={micError}
          onPatch={patch}
        />
        <div className="flex items-center gap-2.5 rounded-lg border border-dashed px-3.5 py-2.5 text-xs text-muted-foreground">
          <span>🪄</span>
          <span>agent mode is ready — say “buddy, agent…” to send off research.</span>
        </div>
      </div>
    </ScrollArea>
  );
}
