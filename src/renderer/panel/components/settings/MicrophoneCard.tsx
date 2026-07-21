import { SettingsCard } from './SettingsCard';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { PatchSettings } from './patch';
import type { MicDevice, Settings } from '../../../../shared/types';

interface MicrophoneCardProps {
  settings: Settings;
  micDevices: MicDevice[];
  micError: string | null;
  onPatch: PatchSettings;
}

/** Input device picker, full-realtime-mode toggle, and the hotkey display. */
export function MicrophoneCard({
  settings,
  micDevices,
  micError,
  onPatch,
}: MicrophoneCardProps): React.JSX.Element {
  return (
    <SettingsCard title="microphone">
      <div className="flex min-h-8 items-center gap-2.5">
        <Label htmlFor="mic" className="flex-1 text-xs font-normal text-muted-foreground">
          input device
        </Label>
        <Select
          value={settings.micDeviceId === '' ? '__default__' : settings.micDeviceId}
          onValueChange={(value) =>
            void onPatch({ micDeviceId: value === '__default__' ? '' : value })
          }
        >
          <SelectTrigger id="mic" size="sm" className="max-w-[190px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* Radix Select forbids value="" — '' (system default) is mapped to a sentinel. */}
            <SelectItem value="__default__" className="text-xs">
              system default
            </SelectItem>
            {micDevices
              .filter((d) => d.deviceId !== '' && d.deviceId !== 'default')
              .map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId} className="text-xs">
                  {d.label || 'microphone'}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>
      {micError ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground/80">
          couldn&rsquo;t reach a microphone ({micError.toLowerCase()}) — tap the hotkey or click
          buddy to type instead.
        </p>
      ) : null}
      <div className="flex min-h-7 items-center gap-2.5 pt-2.5">
        <Label
          htmlFor="full-realtime-mode"
          className="flex-1 text-xs font-normal text-muted-foreground"
        >
          full realtime mode
        </Label>
        <Switch
          id="full-realtime-mode"
          checked={settings.fullRealtimeMode}
          onCheckedChange={(checked) => void onPatch({ fullRealtimeMode: checked })}
        />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        keeps the mic open and uses voice activity detection for a natural back-and-forth. a fresh
        screen capture is attached to every speech turn.
      </p>
      <div className="flex min-h-7 items-center gap-2.5">
        <Label className="flex-1 text-xs font-normal text-muted-foreground">
          {settings.fullRealtimeMode ? 'start / stop realtime' : 'push to talk'}
        </Label>
        <Kbd className="bg-muted px-2 text-foreground">{settings.hotkeyLabel}</Kbd>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        {settings.fullRealtimeMode
          ? 'press once to activate; press again to deactivate. fixed for now.'
          : 'hold both keys and talk; let go to send. fixed for now.'}
      </p>
    </SettingsCard>
  );
}
