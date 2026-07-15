import { SettingsCard } from './SettingsCard';
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
import type { Settings } from '../../../../shared/types';

const VOICES = [
  'marin',
  'cedar',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
] as const;

interface VoiceCardProps {
  settings: Settings;
  onPatch: PatchSettings;
}

/** Voice picker + on-screen captions toggle. */
export function VoiceCard({ settings, onPatch }: VoiceCardProps): React.JSX.Element {
  return (
    <SettingsCard title={<>voice &amp; captions</>}>
      <div className="flex min-h-8 items-center gap-2.5">
        <Label htmlFor="voice" className="flex-1 text-xs font-normal text-muted-foreground">
          voice
        </Label>
        <Select value={settings.voice} onValueChange={(value) => void onPatch({ voice: value })}>
          <SelectTrigger id="voice" size="sm" className="max-w-[190px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VOICES.map((v) => (
              <SelectItem key={v} value={v} className="text-xs">
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-h-7 items-center gap-2.5">
        <Label htmlFor="captions" className="flex-1 text-xs font-normal text-muted-foreground">
          captions on screen
        </Label>
        <Switch
          id="captions"
          checked={settings.captionsEnabled}
          onCheckedChange={(checked) => void onPatch({ captionsEnabled: checked })}
        />
      </div>
    </SettingsCard>
  );
}
